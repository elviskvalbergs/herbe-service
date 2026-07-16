import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

  it('filters rows by filter.<Field> with an exact string match', async () => {
    const res = await fetch(`${server.url}/api/1/CUVc?filter.Code=CUST001`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.CUVc).toHaveLength(1)
    expect(body.data.CUVc[0].Code).toBe('CUST001')
  })

  it('composes multiple filter.<Field> params as AND', async () => {
    const res = await fetch(`${server.url}/api/1/SVOVc?filter.CustCode=CUST001&filter.DoneMark=1`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.SVOVc.map((r: { SerNr: number }) => r.SerNr)).toEqual([5001])
  })

  it('returns an empty array in the envelope when a filter matches nothing', async () => {
    const res = await fetch(`${server.url}/api/1/CUVc?filter.Code=NOPE`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.CUVc).toEqual([])
  })
})

// Standard Books REST write convention (docs/09-REST-API-REFERENCE.md,
// confirmed live in WS4 Task 7): writes are form-urlencoded
// `set_field.<Field>=<value>` pairs, never a JSON body.
function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `set_field.${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

describe('fake ERP server — POST writes', () => {
  let writeServer: Awaited<ReturnType<typeof startFakeErpServer>>

  beforeEach(async () => {
    writeServer = await startFakeErpServer({ port: 0 })
  })

  afterEach(async () => {
    await writeServer.close()
  })

  it('create assigns an incrementing SerNr and the record appears on a later GET', async () => {
    const res = await fetch(`${writeServer.url}/api/1/SVOVc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ CustCode: 'CUST003' }),
    })
    const body = await res.json()

    // Same data.<Register> envelope as a GET response (confirmed live, Task 7).
    expect(res.status).toBe(200)
    expect(body.data.SVOVc).toHaveLength(1)
    expect(body.data.SVOVc[0].SerNr).toBe(5005) // max fixture SerNr (5004) + 1
    expect(body.data.SVOVc[0].CustCode).toBe('CUST003')

    const getRes = await fetch(`${writeServer.url}/api/1/SVOVc`)
    const getBody = await getRes.json()
    expect(
      getBody.data.SVOVc.some((r: { SerNr: number; CustCode: string }) => r.SerNr === 5005 && r.CustCode === 'CUST003'),
    ).toBe(true)
  })

  it('a second create increments from the first created record, not just the fixtures', async () => {
    await fetch(`${writeServer.url}/api/1/SVOVc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ CustCode: 'CUST003' }),
    })
    const res = await fetch(`${writeServer.url}/api/1/SVOVc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ CustCode: 'CUST004' }),
    })
    const body = await res.json()

    expect(body.data.SVOVc[0].SerNr).toBe(5006)
  })

  it('create reconstructs row fields from set_row_field.<n>.<Field> pairs', async () => {
    const res = await fetch(`${writeServer.url}/api/1/SVOVc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'set_field.CustCode=CUST003&set_row_field.0.ArtCode=VIJ1&set_row_field.0.SerialNr=1111',
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.SVOVc[0].rows).toEqual([{ ArtCode: 'VIJ1', SerialNr: '1111' }])
  })
})

describe('fake ERP server — PATCH updates', () => {
  let writeServer: Awaited<ReturnType<typeof startFakeErpServer>>

  beforeEach(async () => {
    writeServer = await startFakeErpServer({ port: 0 })
  })

  afterEach(async () => {
    await writeServer.close()
  })

  it('update-by-key merges the payload into the existing record', async () => {
    const res = await fetch(`${writeServer.url}/api/1/SVOVc/5001`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ DoneMark: '0' }),
    })
    const body = await res.json()

    // Same data.<Register> envelope as a create response (confirmed live, Task 7).
    expect(res.status).toBe(200)
    expect(body.data.SVOVc[0].SerNr).toBe(5001)
    expect(body.data.SVOVc[0].DoneMark).toBe('0')
    expect(body.data.SVOVc[0].CustCode).toBe('CUST001') // untouched fields survive the merge

    const getRes = await fetch(`${writeServer.url}/api/1/SVOVc`)
    const getBody = await getRes.json()
    const updated = getBody.data.SVOVc.find((r: { SerNr: number }) => r.SerNr === 5001)
    expect(updated.DoneMark).toBe('0')
  })

  it('update with an unknown SerNr echoes the payload back and stores nothing', async () => {
    const res = await fetch(`${writeServer.url}/api/1/SVOVc/99999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ CustCode: 'GHOST' }),
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.SVOVc).toEqual([{ SerNr: 99999, CustCode: 'GHOST' }])

    const getRes = await fetch(`${writeServer.url}/api/1/SVOVc`)
    const getBody = await getRes.json()
    expect(getBody.data.SVOVc.some((r: { SerNr: number }) => r.SerNr === 99999)).toBe(false)
  })
})

describe('fake ERP server — failure modes', () => {
  it('noop-create mode (server-level option): 200, payload echoed, no SerNr, nothing stored', async () => {
    const modeServer = await startFakeErpServer({ port: 0, mode: 'noop-create' })
    try {
      const res = await fetch(`${modeServer.url}/api/1/SVOVc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ CustCode: 'CUST999' }),
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body).toEqual({ CustCode: 'CUST999' })
      expect(body.SerNr).toBeUndefined()

      const getRes = await fetch(`${modeServer.url}/api/1/SVOVc`)
      const getBody = await getRes.json()
      expect(getBody.data.SVOVc).toHaveLength(4) // unchanged from fixtures
    } finally {
      await modeServer.close()
    }
  })

  it('noop-create mode via the x-fake-erp-mode header on an otherwise normal server', async () => {
    const normalServer = await startFakeErpServer({ port: 0 })
    try {
      const res = await fetch(`${normalServer.url}/api/1/SVOVc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-fake-erp-mode': 'noop-create' },
        body: formBody({ CustCode: 'CUST999' }),
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body).toEqual({ CustCode: 'CUST999' })
    } finally {
      await normalServer.close()
    }
  })

  it('http-500 mode (server-level option): every POST fails', async () => {
    const errorServer = await startFakeErpServer({ port: 0, mode: 'http-500' })
    try {
      const res = await fetch(`${errorServer.url}/api/1/SVOVc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ CustCode: 'CUST999' }),
      })
      expect(res.status).toBe(500)
    } finally {
      await errorServer.close()
    }
  })

  it('http-500 mode via the x-fake-erp-mode header on an otherwise normal server', async () => {
    const normalServer = await startFakeErpServer({ port: 0 })
    try {
      const res = await fetch(`${normalServer.url}/api/1/SVOVc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-fake-erp-mode': 'http-500' },
        body: formBody({ CustCode: 'CUST999' }),
      })
      expect(res.status).toBe(500)
    } finally {
      await normalServer.close()
    }
  })

  it('http-500 mode also fails PATCH updates', async () => {
    const errorServer = await startFakeErpServer({ port: 0, mode: 'http-500' })
    try {
      const res = await fetch(`${errorServer.url}/api/1/SVOVc/5001`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ DoneMark: '1' }),
      })
      expect(res.status).toBe(500)
    } finally {
      await errorServer.close()
    }
  })

  it('modes and record stores do not leak across server instances', async () => {
    const errorServer = await startFakeErpServer({ port: 0, mode: 'http-500' })
    const normalServer = await startFakeErpServer({ port: 0 })
    try {
      const errorRes = await fetch(`${errorServer.url}/api/1/SVOVc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ CustCode: 'A' }),
      })
      const normalRes = await fetch(`${normalServer.url}/api/1/SVOVc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody({ CustCode: 'B' }),
      })
      const normalBody = await normalRes.json()

      expect(errorRes.status).toBe(500)
      expect(normalRes.status).toBe(200)
      expect(normalBody.data.SVOVc[0].SerNr).toBe(5005) // unaffected by the error server's mode or requests
    } finally {
      await errorServer.close()
      await normalServer.close()
    }
  })
})
