import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErpTransientError } from '@herbe/erp-core'
import { fetchRegisterJson, postRegisterJson, patchRegisterJson } from './fetch-json'
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

// Regression coverage for the wire-format bug found live in WS4 Task 7:
// postRegisterJson/patchRegisterJson previously sent a flat JSON body, which
// the real Standard Books REST API never parses as field data (it expects
// form-urlencoded set_field./set_row_field.<n>. pairs per docs/09-REST-API-
// REFERENCE.md) — every write landed with no fields set, so e.g. CustCode
// read back blank and failed the ERP's own "code not registered" check,
// even for a value proven valid via a live GET (HTTP 200, XML error body).
describe('postRegisterJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends a form-urlencoded body with set_field./set_row_field.<n>. pairs, never JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ SerNr: 5005 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await postRegisterJson(config, 'SVOVc', {
      CustCode: 'CUST003',
      TransDate: '2026-07-16',
      rows: [{ ArtCode: 'VIJ1', SerialNr: '1111' }],
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:9999/api/1/SVOVc')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' })
    expect(init.body).toBe(
      'set_field.CustCode=CUST003&set_field.TransDate=2026-07-16&set_row_field.0.ArtCode=VIJ1&set_row_field.0.SerialNr=1111',
    )
  })
})

describe('patchRegisterJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('PATCHes /api/<company>/<register>/<recordRef> with a form-urlencoded body, never embedding SerNr in it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ SerNr: 5001 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await patchRegisterJson(config, 'SVOVc', '5001', { CustComplaint2: 'hello' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:9999/api/1/SVOVc/5001')
    expect(init.method).toBe('PATCH')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' })
    expect(init.body).toBe('set_field.CustComplaint2=hello')
  })
})
