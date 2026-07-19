// In-memory per-instance record store backing the fake ERP's write support
// (Task 2). Modeled on the real Standard Books convention: writable
// registers (SVOVc, WSVc) key rows by a numeric, auto-assigned `SerNr`.
// One store is created per `startFakeErpServer` call (see server.ts) so
// state and failure modes never leak across server instances.

export type FakeErpMode = 'noop-create' | 'http-500'

export type FakeErpRecord = Record<string, unknown>

export interface RecordStore {
  registers: Map<string, Map<number, FakeErpRecord>>
}

export function createRecordStore(): RecordStore {
  return { registers: new Map() }
}

function getRegisterMap(store: RecordStore, register: string): Map<number, FakeErpRecord> {
  let map = store.registers.get(register)
  if (!map) {
    map = new Map()
    store.registers.set(register, map)
  }
  return map
}

function collectNumbers(rows: FakeErpRecord[], field: string): number[] {
  const nums: number[] = []
  for (const row of rows) {
    const n = Number(row[field])
    if (Number.isFinite(n)) nums.push(n)
  }
  return nums
}

function nextNumber(nums: number[]): number {
  return nums.length ? Math.max(...nums) + 1 : 1
}

// GET view: fixture rows with any updated ones replaced by their stored
// version, plus every created record appended.
export function mergedRows(store: RecordStore, register: string, fixtureRows: FakeErpRecord[]): FakeErpRecord[] {
  const map = store.registers.get(register)
  if (!map || map.size === 0) return fixtureRows

  const overriddenSerNrs = new Set(map.keys())
  const base = fixtureRows.filter((row) => !overriddenSerNrs.has(Number(row.SerNr)))
  return [...base, ...map.values()]
}

// Create: SerNr = max(fixture SerNrs ∪ created SerNrs) + 1 (same for
// ServerSequence, so the GET envelope's `@sequence` high-water mark stays
// consistent once writes land).
export function createRecord(
  store: RecordStore,
  register: string,
  fixtureRows: FakeErpRecord[],
  payload: FakeErpRecord,
): FakeErpRecord {
  const map = getRegisterMap(store, register)
  const stored = [...map.values()]

  const serNr = nextNumber([...collectNumbers(fixtureRows, 'SerNr'), ...collectNumbers(stored, 'SerNr')])
  const serverSequence = nextNumber([
    ...collectNumbers(fixtureRows, 'ServerSequence'),
    ...collectNumbers(stored, 'ServerSequence'),
  ])

  const record: FakeErpRecord = { ...payload, SerNr: serNr, ServerSequence: serverSequence }
  map.set(serNr, record)
  return record
}

// Update-by-key: payload carries an existing `SerNr`. A match (in the
// created/updated store or the original fixtures) merges the payload over
// the existing record. No match: the real ERP's silent no-op — echo the
// payload back unchanged, store nothing.
export function updateRecord(
  store: RecordStore,
  register: string,
  fixtureRows: FakeErpRecord[],
  payload: FakeErpRecord,
): { record: FakeErpRecord; stored: boolean } {
  const serNr = Number(payload.SerNr)
  const map = getRegisterMap(store, register)
  const existing = map.get(serNr) ?? fixtureRows.find((row) => Number(row.SerNr) === serNr)

  if (!existing) {
    return { record: payload, stored: false }
  }

  const merged: FakeErpRecord = { ...existing, ...payload, SerNr: serNr }
  map.set(serNr, merged)
  return { record: merged, stored: true }
}
