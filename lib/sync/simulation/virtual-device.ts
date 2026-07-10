// lib/sync/simulation/virtual-device.ts
//
// An in-process client with its own local store + offline outbox: queues
// ops while offline, then replays them in order once "back online". This
// is the harness shape for the sync simulation suite — see
// lib/sync/simulation/scenarios/offline-day-replay.test.ts for the one
// scenario Phase 0 can actually exercise.
export interface OutboxOp {
  id: string
  entity: string
  op: 'create' | 'update' | 'delete'
  payload: Record<string, unknown>
  baseVersion: number
}

export class VirtualDevice {
  readonly tenantId: string
  readonly localStore = new Map<string, unknown>()
  readonly pendingOps: OutboxOp[] = []

  constructor(opts: { tenantId: string }) {
    this.tenantId = opts.tenantId
  }

  queueOp(op: OutboxOp): void {
    this.pendingOps.push(op)
  }

  async replay(): Promise<OutboxOp[]> {
    const applied: OutboxOp[] = []
    while (this.pendingOps.length > 0) {
      const op = this.pendingOps.shift()!
      // Phase 0: applies to the in-memory local store only, proving ordering.
      // Task 13's real outbox endpoint is wired in once it exists — this
      // harness intentionally doesn't call the network yet.
      this.localStore.set(op.id, op.payload)
      applied.push(op)
    }
    return applied
  }

  async pull(_sinceCursor: string): Promise<void> {
    // Stub: wired to the real domain delta endpoint (Task 12) once it
    // exists. Deliberately a no-op in Phase 0 — see plan Task 9.
  }
}
