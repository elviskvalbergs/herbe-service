// lib/offline/sync-client.test.ts
//
// fake-indexeddb + a mocked global fetch — no real network, no Postgres.
// pullDelta is the one piece of real logic in the offline shell (Dexie
// upsert + cursor plumbing), so it's TDD'd here per Task 16's coverage
// requirement (lib/offline/** must stay under the real, tested global floor,
// unlike the thin client page component).
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflineDb } from './db'
import { pullDelta } from './sync-client'

describe('pullDelta', () => {
  let db: OfflineDb

  beforeEach(() => {
    db = new OfflineDb()
  })

  afterEach(async () => {
    await db.delete()
  })

  it('upserts customers from the delta endpoint and returns the new cursor', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [{ id: 'c1', erpRef: 'CUST001', name: 'Test Client', changeSeq: '5' }],
        cursor: '5',
      }),
    }) as never

    const result = await pullDelta(db, { sinceCursor: '0' })

    expect(result.cursor).toBe('5')
    const stored = await db.customers.get('c1')
    expect(stored?.name).toBe('Test Client')
  })

  it('requests the delta scoped to the given cursor, without a client-supplied tenantId (Task 16b: server derives tenant from the session)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ data: [], cursor: '9' }),
    })
    global.fetch = fetchMock as never

    await pullDelta(db, { sinceCursor: '7' })

    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('after=7')
    expect(String(url)).not.toContain('tenantId')
  })

  it('upserts multiple rows and overwrites an existing row with the same id', async () => {
    await db.customers.put({ id: 'c1', erpRef: 'CUST001', name: 'Stale Name', changeSeq: '1' })

    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [
          { id: 'c1', erpRef: 'CUST001', name: 'Fresh Name', changeSeq: '5' },
          { id: 'c2', erpRef: 'CUST002', name: 'Second Client', changeSeq: '6' },
        ],
        cursor: '6',
      }),
    }) as never

    const result = await pullDelta(db, { sinceCursor: '1' })

    expect(result.cursor).toBe('6')
    expect((await db.customers.get('c1'))?.name).toBe('Fresh Name')
    expect((await db.customers.get('c2'))?.name).toBe('Second Client')
    expect(await db.customers.count()).toBe(2)
  })

  it('returns the unchanged cursor and writes nothing when the delta is empty', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ data: [], cursor: '3' }),
    }) as never

    const result = await pullDelta(db, { sinceCursor: '3' })

    expect(result.cursor).toBe('3')
    expect(await db.customers.count()).toBe(0)
  })
})
