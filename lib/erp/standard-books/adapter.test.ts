import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { startFakeErpServer } from '@herbe/fake-erp'
import { createStandardBooksAdapter } from './adapter'

let server: Awaited<ReturnType<typeof startFakeErpServer>>

beforeAll(async () => {
  server = await startFakeErpServer({ port: 0 })
})

afterAll(async () => {
  await server.close()
})

describe('Standard Books adapter — CUVc pull', () => {
  it('pulls customers and returns the new cursor from @sequence', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const result = await adapter.pullChanges('CUVc', '0')

    expect(result.upserts.length).toBe(2)
    expect(result.cursor).toBe('1002')
    expect(result.deletedRefs).toEqual([])
  })

  it('surfaces the confirmed-unsupported updates_after on SVOVc as a typed permanent error, not a crash', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    await expect(adapter.pullChanges('SVOVc', '0')).rejects.toMatchObject({
      name: 'ErpPermanentError',
    })
  })
})

describe('Standard Books adapter — capabilities and pushCreate stub', () => {
  it('reports supportsDocumentFetch false and supportsIncrementalSync true', () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    expect(adapter.capabilities()).toEqual({
      supportsIncrementalSync: true,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    })
  })

  it('pushCreate stays unsupported for registers outside the SVOVc/WSVc allowlist', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    await expect(adapter.pushCreate('CUVc', {})).rejects.toThrow(
      'pushCreate not supported for register CUVc (only SVOVc, WSVc)',
    )
  })
})

describe('Standard Books adapter — pushCreate SVOVc (Task 13)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the erpRef from a real assigned SerNr', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ SerNr: '230022' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createStandardBooksAdapter({
      baseUrl: 'http://localhost:9999',
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const result = await adapter.pushCreate('SVOVc', { CustCode: 'CUST001' })

    expect(result).toEqual({ erpRef: '230022' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9999/api/1/SVOVc',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('falls back to @url when SerNr is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ '@url': '/api/1/SVOVc/230022' }), { status: 200 })),
    )

    const adapter = createStandardBooksAdapter({
      baseUrl: 'http://localhost:9999',
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const result = await adapter.pushCreate('SVOVc', { CustCode: 'CUST001' })

    expect(result).toEqual({ erpRef: '/api/1/SVOVc/230022' })
  })

  it('returns an empty erpRef (not an error) when the ERP echoes back a 200 with neither SerNr nor @url — the confirmed silent-no-op case', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ '@url': '' }), { status: 200 })))

    const adapter = createStandardBooksAdapter({
      baseUrl: 'http://localhost:9999',
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const result = await adapter.pushCreate('SVOVc', { CustCode: 'CUST001' })

    expect(result).toEqual({ erpRef: '' })
  })

  it('returns an empty erpRef when the response body fails to parse as JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200, json: () => Promise.reject(new Error('invalid json')) }),
    )

    const adapter = createStandardBooksAdapter({
      baseUrl: 'http://localhost:9999',
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const result = await adapter.pushCreate('SVOVc', { CustCode: 'CUST001' })

    expect(result).toEqual({ erpRef: '' })
  })
})

describe('Standard Books adapter — write surface (WS4 Task 3: pushCreate WSVc, pushUpdate, fetchRecords)', () => {
  let writeServer: Awaited<ReturnType<typeof startFakeErpServer>> | undefined

  afterEach(async () => {
    await writeServer?.close()
    writeServer = undefined
    vi.unstubAllGlobals()
  })

  function adapterFor(url: string) {
    return createStandardBooksAdapter({
      baseUrl: url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })
  }

  it('pushCreate assigns a SerNr for WSVc — the allowlist now covers both write registers', async () => {
    writeServer = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(writeServer.url)

    const result = await adapter.pushCreate('WSVc', { SVONr: 5001, EMCode: 'TECH1' })

    expect(result.erpRef).toBe('9004') // max fixture WSVc SerNr (9003) + 1
  })

  it('pushCreate under noop-create mode returns an empty erpRef, not a throw', async () => {
    writeServer = await startFakeErpServer({ port: 0, mode: 'noop-create' })
    const adapter = adapterFor(writeServer.url)

    const result = await adapter.pushCreate('SVOVc', { CustCode: 'CUST001' })

    expect(result).toEqual({ erpRef: '' })
  })

  it('pushCreate under http-500 mode throws ErpTransientError', async () => {
    writeServer = await startFakeErpServer({ port: 0, mode: 'http-500' })
    const adapter = adapterFor(writeServer.url)

    await expect(adapter.pushCreate('SVOVc', { CustCode: 'CUST001' })).rejects.toMatchObject({
      name: 'ErpTransientError',
    })
  })

  it('pushUpdate round-trips a field change, readable back via the numeric SerNr filter', async () => {
    writeServer = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(writeServer.url)

    await adapter.pushUpdate('SVOVc', '5001', { CustComplaint2: 'Updated via pushUpdate' })

    const rows = await adapter.fetchRecords('SVOVc', { 'filter.SerNr': '5001' })

    expect(rows).toHaveLength(1)
    expect(rows[0].CustComplaint2).toBe('Updated via pushUpdate')
  })

  it('pushUpdate rejects an unsupported register before making any request', async () => {
    writeServer = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(writeServer.url)

    await expect(adapter.pushUpdate('CUVc', '1', {})).rejects.toThrow(
      'pushUpdate not supported for register CUVc (only SVOVc, WSVc)',
    )
  })

  it('pushUpdate under http-500 mode throws ErpTransientError', async () => {
    writeServer = await startFakeErpServer({ port: 0, mode: 'http-500' })
    const adapter = adapterFor(writeServer.url)

    await expect(adapter.pushUpdate('SVOVc', '5001', { CustComplaint2: 'x' })).rejects.toMatchObject({
      name: 'ErpTransientError',
    })
  })

  it('pushUpdate throws ErpPermanentError on a 4xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'bad request' }), { status: 400 })),
    )
    const adapter = adapterFor('http://localhost:9999')

    await expect(adapter.pushUpdate('SVOVc', '5001', { CustComplaint2: 'x' })).rejects.toMatchObject({
      name: 'ErpPermanentError',
    })
  })

  it('pushUpdate throws ErpPermanentError when the ERP echoes back a different record than requested', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ SerNr: 9999 }), { status: 200 })))
    const adapter = adapterFor('http://localhost:9999')

    await expect(adapter.pushUpdate('SVOVc', '5001', { CustComplaint2: 'x' })).rejects.toMatchObject({
      name: 'ErpPermanentError',
    })
  })

  it('fetchRecords returns matching rows for a filter', async () => {
    writeServer = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(writeServer.url)

    const rows = await adapter.fetchRecords('CUVc', { 'filter.Code': 'CUST001' })

    expect(rows).toHaveLength(1)
    expect(rows[0].Code).toBe('CUST001')
  })

  it('fetchRecords returns an empty array when the filter matches nothing', async () => {
    writeServer = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(writeServer.url)

    const rows = await adapter.fetchRecords('CUVc', { 'filter.Code': 'NOPE' })

    expect(rows).toEqual([])
  })

  it('fetchRecords returns an empty array on a 204 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    const adapter = adapterFor('http://localhost:9999')

    const rows = await adapter.fetchRecords('CUVc', {})

    expect(rows).toEqual([])
  })

  it('fetchRecords throws ErpPermanentError on a 4xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'bad request' }), { status: 400 })),
    )
    const adapter = adapterFor('http://localhost:9999')

    await expect(adapter.fetchRecords('CUVc', {})).rejects.toMatchObject({ name: 'ErpPermanentError' })
  })
})

describe('Standard Books adapter — pullFullList (no-delta full pull)', () => {
  it('pulls CUVc with no updates_after param and returns all fixture rows', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const rows = await adapter.pullFullList('CUVc')

    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.Code).sort()).toEqual(['CUST001', 'CUST002'])
  })

  it('pulls SVOSerVc (no-delta register) with no updates_after param and returns all fixture rows', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const rows = await adapter.pullFullList('SVOSerVc')

    expect(rows.length).toBe(3)
    expect(rows.map((r) => r.SerialNr).sort()).toEqual(['FAKE-SN-0001', 'FAKE-SN-0002', 'FAKE-SN-0003'])
  })

  describe('data.rows fallback (no <Register> key nested under data)', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('falls back to data.rows when the register-named key is absent', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ data: { rows: [{ Code: 'FALLBACK001' }] }, '@sequence': 9 }), {
            status: 200,
          }),
        ),
      )

      const adapter = createStandardBooksAdapter({
        baseUrl: 'http://localhost:9999',
        companyNumber: '1',
        auth: { kind: 'basic', username: 'test', password: 'test' },
      })

      const rows = await adapter.pullFullList('CUVc')

      expect(rows).toEqual([{ Code: 'FALLBACK001' }])
    })
  })
})

describe('Standard Books adapter — listLiveRefs (RefListingAdapter for key-sweep)', () => {
  it('returns the SerialNr of every live SVOSerVc row', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const refs = await adapter.listLiveRefs('SVOSerVc')

    expect(new Set(refs)).toEqual(new Set(['FAKE-SN-0001', 'FAKE-SN-0002', 'FAKE-SN-0003']))
  })

  it('returns the Code of every live CUVc row', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const refs = await adapter.listLiveRefs('CUVc')

    expect(new Set(refs)).toEqual(new Set(['CUST001', 'CUST002']))
  })

  it('throws for a register with no REF_FIELD mapping', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    await expect(adapter.listLiveRefs('WSVc')).rejects.toThrow(
      'listLiveRefs: no REF_FIELD mapping for register WSVc',
    )
  })
})

describe('Standard Books adapter — capability probe', () => {
  it('marks CUVc as supporting incremental sync after a successful updates_after probe', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const result = await adapter.probeIncrementalSupport('CUVc')
    expect(result).toBe(true)
  })

  it('marks SVOVc as not supporting incremental sync after a 404 probe (confirmed real-ERP behavior)', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const result = await adapter.probeIncrementalSupport('SVOVc')
    expect(result).toBe(false)
  })
})
