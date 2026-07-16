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
  // Update-by-key: recordRef wins over any SerNr in payload. No persistence
  // read-back here — the saga (WS4 Decision 3) does that separately.
  pushUpdate(register: string, recordRef: string, payload: Record<string, unknown>): Promise<void>
  // Exposes the filter./fields/limit REST read surface for arbitrary
  // registers (natural-key lookups, saga read-backs).
  fetchRecords(register: string, params: Record<string, string>): Promise<Record<string, unknown>[]>
  probeIncrementalSupport(register: string): Promise<boolean>
  // No-delta full pull: GET the register with no updates_after, for registers
  // that don't support incremental sync (e.g. SVOSerVc).
  pullFullList(register: string): Promise<Record<string, unknown>[]>
  // Live identity refs for the register, for key-sweep reconciliation
  // (RefListingAdapter in lib/sync/ingest/key-sweep.ts).
  listLiveRefs(register: string): Promise<string[]>
  // WebExcellentAPI record-links read (WS4 Decision 9): resolves every record
  // linked to (register, serNr) — e.g. following a SVOVc back to a linked
  // IVVc invoice. Required on every adapter (same style as pushCreate/
  // pushUpdate/fetchRecords above); an adapter with no WebExcellentAPI tier
  // should throw ErpPermanentError rather than making this optional.
  getRecordLinks(register: string, serNr: string): Promise<{ register: string; id: string }[]>
}

export type ErpAdapterFactory = (config: unknown) => ErpAdapter
