import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

  it('pushCreate throws until Task 13 implements the outbox push', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    await expect(adapter.pushCreate('CUVc', {})).rejects.toThrow('Not implemented')
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
