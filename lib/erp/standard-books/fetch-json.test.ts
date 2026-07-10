import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErpTransientError } from '@herbe/erp-core'
import { fetchRegisterJson } from './fetch-json'
import type { StandardBooksConfig } from './config-schema'

const config: StandardBooksConfig = {
  baseUrl: 'http://localhost:9999',
  companyNumber: '1',
  auth: { kind: 'basic', username: 'test', password: 'test' },
}

describe('fetchRegisterJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('wraps a network failure as ErpTransientError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await expect(fetchRegisterJson(config, 'CUVc', {})).rejects.toThrow(ErpTransientError)
  })

  it('wraps a 5xx response as ErpTransientError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))

    await expect(fetchRegisterJson(config, 'CUVc', {})).rejects.toThrow(ErpTransientError)
  })

  it('returns a null body for a 204 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))

    const result = await fetchRegisterJson(config, 'CUVc', {})
    expect(result).toEqual({ status: 204, body: null })
  })

  it('returns a null body when a 4xx response fails to parse as JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 400,
        json: () => Promise.reject(new Error('invalid json')),
      }),
    )

    const result = await fetchRegisterJson(config, 'CUVc', {})
    expect(result).toEqual({ status: 400, body: null })
  })
})
