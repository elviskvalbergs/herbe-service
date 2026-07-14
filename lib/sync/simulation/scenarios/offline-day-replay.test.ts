// lib/sync/simulation/scenarios/offline-day-replay.test.ts
//
// Phase 0 scope: VirtualDevice.replay() applies queued ops to its own
// in-memory localStore only, to prove ordering. It does not talk to
// Postgres or any route handler, so this test needs no test database —
// see the "Test Database Harness" section of the plan and Task 9's report
// for why the DB setup shown in the brief was dropped.
//
// The full scenario suite (crew-job non-interference, scope-exit purge,
// sequence-reset-mid-poll) is deferred: it depends on Phase 1 entities and
// the delta/outbox endpoints (Tasks 12/13) that don't exist yet. This file
// covers only the "offline-a-day-then-replay" scenario the harness can
// actually exercise today.
import { describe, expect, it } from 'vitest'
import { VirtualDevice } from '../virtual-device'

describe('virtual device offline-then-replay', () => {
  it('queues ops while offline and applies them in order on replay', async () => {
    const device = new VirtualDevice({ tenantId: '11111111-0000-0000-0000-000000000001' })

    device.queueOp({ id: 'op-1', entity: 'note', op: 'create', payload: { text: 'first' }, baseVersion: 0 })
    device.queueOp({ id: 'op-2', entity: 'note', op: 'create', payload: { text: 'second' }, baseVersion: 0 })

    expect(device.pendingOps.length).toBe(2)

    const applied = await device.replay()

    expect(applied.map((a) => a.id)).toEqual(['op-1', 'op-2'])
    expect(device.pendingOps.length).toBe(0)
    expect(device.localStore.get('op-1')).toEqual({ text: 'first' })
    expect(device.localStore.get('op-2')).toEqual({ text: 'second' })
  })

  it('replay is a no-op when there are no pending ops', async () => {
    const device = new VirtualDevice({ tenantId: '11111111-0000-0000-0000-000000000001' })

    const applied = await device.replay()

    expect(applied).toEqual([])
    expect(device.localStore.size).toBe(0)
  })

  it('pull() is a documented stub that does not touch local state (wired to the real delta endpoint later)', async () => {
    const device = new VirtualDevice({ tenantId: '11111111-0000-0000-0000-000000000001' })
    device.queueOp({ id: 'op-1', entity: 'note', op: 'create', payload: { text: 'first' }, baseVersion: 0 })

    await device.pull('0')

    expect(device.pendingOps.length).toBe(1)
    expect(device.localStore.size).toBe(0)
  })
})
