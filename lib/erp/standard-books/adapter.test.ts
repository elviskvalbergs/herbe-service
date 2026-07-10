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

  it('pushCreate stays unimplemented for registers other than SVOVc in Phase 0', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    await expect(adapter.pushCreate('CUVc', {})).rejects.toThrow('pushCreate not implemented for CUVc in Phase 0')
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
