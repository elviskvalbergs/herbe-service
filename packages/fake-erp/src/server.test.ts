import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeErpServer } from './server'

let server: Awaited<ReturnType<typeof startFakeErpServer>>

beforeAll(async () => {
  server = await startFakeErpServer({ port: 0 })
})

afterAll(async () => {
  await server.close()
})

describe('fake ERP server', () => {
  it('returns CUVc rows with @sequence as the high-water mark', async () => {
    const res = await fetch(`${server.url}/api/1/CUVc?updates_after=0`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.CUVc.length).toBe(2)
    expect(body['@sequence']).toBe(1002)
  })

  it('rejects updates_after on SVOVc with 404, matching the confirmed real-ERP behavior', async () => {
    const res = await fetch(`${server.url}/api/1/SVOVc?updates_after=0`)
    expect(res.status).toBe(404)
  })

  it('serves SVOSerVc rows on a full fetch but 404s updates_after (no-delta register)', async () => {
    const full = await fetch(`${server.url}/api/1/SVOSerVc`)
    const body = await full.json()
    expect(full.status).toBe(200)
    expect(body.data.SVOSerVc.length).toBe(3)

    const delta = await fetch(`${server.url}/api/1/SVOSerVc?updates_after=0`)
    expect(delta.status).toBe(404)
  })

  it('returns 204 empty body for deletes_after on any register (confirmed unreliable)', async () => {
    const res = await fetch(`${server.url}/api/1/CUVc?deletes_after=0`)
    expect(res.status).toBe(204)
  })
})
