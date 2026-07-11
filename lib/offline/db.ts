// lib/offline/db.ts
//
// Local IndexedDB cache (via Dexie) for offline-first display of domain data
// synced down through the delta endpoints (Task 16, docs/... PWA shell).
// Phase-0 scope: customers only, upsert-only (no scope-exit purge — that's
// Task 22).
import Dexie, { type Table } from 'dexie'

export interface CustomerRecord {
  id: string
  erpRef: string
  name: string
  changeSeq: string
}

export class OfflineDb extends Dexie {
  customers!: Table<CustomerRecord, string>

  constructor() {
    super('herbe-service')
    this.version(1).stores({
      customers: 'id, erpRef, changeSeq',
    })
  }
}
