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
}

export type ErpAdapterFactory = (config: unknown) => ErpAdapter
