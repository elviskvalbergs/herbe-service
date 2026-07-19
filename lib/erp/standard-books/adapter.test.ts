import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
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
    // Found live in Task 7: a successful create's response is enveloped
    // exactly like a GET (data.<Register>: [record]), not a flat top-level
    // record.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: { SVOVc: [{ SerNr: '230022' }] } }), { status: 200 }))
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
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { SVOVc: [{ '@url': '/api/1/SVOVc/230022' }] } }), { status: 200 }),
      ),
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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { SVOVc: [{ '@url': '' }] } }), { status: 200 })),
    )

    const adapter = createStandardBooksAdapter({
      baseUrl: 'http://localhost:9999',
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const result = await adapter.pushCreate('SVOVc', { CustCode: 'CUST001' })

    expect(result).toEqual({ erpRef: '' })
  })

  it('returns an empty erpRef when the ERP responds 200 with no data envelope at all (e.g. an error body)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { '@code': '1071' } }), { status: 200 })),
    )

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

  it('pushUpdate throws ErpPermanentError on an unknown SerNr — the ERP echoes 200 with the requested SerNr but stores nothing', async () => {
    // Real-ERP behavior (docs/09, WS4 Task 7 live probe): a PATCH against a
    // nonexistent record still returns HTTP 200 with the submitted payload
    // echoed back and the requested SerNr merged in — the pre-existing
    // echoed-SerNr-mismatch check can't catch this, because the echoed SerNr
    // *matches* recordRef. Only a read-back GET reveals the no-op. The fake
    // ERP's updateRecord models this exactly (store.ts: no match -> echo,
    // stored: false).
    writeServer = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(writeServer.url)

    await expect(adapter.pushUpdate('SVOVc', '999999', { CustComplaint2: 'ghost update' })).rejects.toMatchObject({
      name: 'ErpPermanentError',
      message: expect.stringContaining('record not found on read-back'),
    })
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
    // Same data.<Register> envelope as a create response (see pushCreate
    // tests above) — confirmed live in Task 7.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { SVOVc: [{ SerNr: 9999 }] } }), { status: 200 })),
    )
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

describe('Standard Books adapter — invoiced-status readback capability + getRecordLinks (WS4 Task 8)', () => {
  it('reports supportsInvoiceStatusReadback true only when features.invoiceReadback is exactly true', () => {
    const off = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })
    expect(off.capabilities().supportsInvoiceStatusReadback).toBe(false)

    const onWithFeature = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
      features: { invoiceReadback: true },
    })
    expect(onWithFeature.capabilities().supportsInvoiceStatusReadback).toBe(true)

    const featureExplicitlyFalse = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
      features: { invoiceReadback: false },
    })
    expect(featureExplicitlyFalse.capabilities().supportsInvoiceStatusReadback).toBe(false)
  })

  describe('getRecordLinks delegation', () => {
    let halServer: Server | undefined
    let halUrl = ''

    function startHalServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
      return new Promise((resolve) => {
        halServer = createServer(handler)
        halServer.listen(0, '127.0.0.1', () => {
          const address = halServer!.address()
          const port = typeof address === 'object' && address ? address.port : 0
          halUrl = `http://127.0.0.1:${port}`
          resolve()
        })
      })
    }

    afterEach(async () => {
      if (halServer) {
        await new Promise<void>((resolve) => halServer!.close(() => resolve()))
        halServer = undefined
      }
    })

    it('delegates to fetchRecordLinks and returns the parsed LinkVc entries', async () => {
      await startHalServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/xml' })
        res.end(`<data><res regname='LinkVc'></res><LinkVc><ID>500123</ID><VcName>IVVc</VcName></LinkVc></data>`)
      })

      const adapter = createStandardBooksAdapter({
        baseUrl: halUrl,
        companyNumber: '1',
        auth: { kind: 'basic', username: 'test', password: 'test' },
      })

      const links = await adapter.getRecordLinks('SVOVc', '230015')

      expect(links).toEqual([{ register: 'IVVc', id: '500123' }])
    })

    it('propagates fetchRecordLinks error mapping (ErpTransientError on 500)', async () => {
      await startHalServer((_req, res) => {
        res.writeHead(500)
        res.end('boom')
      })

      const adapter = createStandardBooksAdapter({
        baseUrl: halUrl,
        companyNumber: '1',
        auth: { kind: 'basic', username: 'test', password: 'test' },
      })

      await expect(adapter.getRecordLinks('SVOVc', '1')).rejects.toMatchObject({ name: 'ErpTransientError' })
    })
  })
})
