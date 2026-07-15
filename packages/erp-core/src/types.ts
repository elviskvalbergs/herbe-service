export interface AdapterCapabilities {
  supportsIncrementalSync: boolean
  supportsDeletesFeed: boolean
  // generic engine gates rendered-document/attachment fetch on this (vendor mechanism stays in the adapter)
  supportsDocumentFetch: boolean
  supportsInvoiceStatusReadback: boolean
  supportsActivityMirror: boolean
}

export interface ChangeSet<T> {
  upserts: T[]
  deletedRefs: string[]
  cursor: string
}

export interface ErpAdapter {
  capabilities(): AdapterCapabilities
  pullChanges(register: string, sinceCursor: string): Promise<ChangeSet<Record<string, unknown>>>
  pushCreate(register: string, payload: Record<string, unknown>): Promise<{ erpRef: string }>
  probeIncrementalSupport(register: string): Promise<boolean>
  // No-delta full pull: GET the register with no updates_after, for registers
  // that don't support incremental sync (e.g. SVOSerVc).
  pullFullList(register: string): Promise<Record<string, unknown>[]>
  // Live identity refs for the register, for key-sweep reconciliation
  // (RefListingAdapter in lib/sync/ingest/key-sweep.ts).
  listLiveRefs(register: string): Promise<string[]>
}

export type ErpAdapterFactory = (config: unknown) => ErpAdapter
