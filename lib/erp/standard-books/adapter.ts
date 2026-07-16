import { registerAdapter, ErpPermanentError, type ChangeSet, type ErpAdapter } from '@herbe/erp-core'
import { standardBooksConfigSchema } from './config-schema'
import { fetchRegisterJson, postRegisterJson, patchRegisterJson } from './fetch-json'

// Standard Books nests rows under `data.<Register>` (verified live) — NOT a
// flat `data` array. Mirrors the portal's extractRegisterRows, with a
// `data.rows` fallback. Shared by pullChanges and pullFullList.
function extractRows(body: Record<string, unknown> | null, register: string): Record<string, unknown>[] {
  const container = (body?.data ?? {}) as Record<string, unknown>
  const direct = container[register]
  if (Array.isArray(direct)) return direct as Record<string, unknown>[]
  const rowsFallback = (container as { rows?: unknown }).rows
  return Array.isArray(rowsFallback) ? (rowsFallback as Record<string, unknown>[]) : []
}

// Per-register identity field, used by listLiveRefs to derive the erpRef that
// key-sweep reconciles stored rows against. Extend cautiously — a register
// mapped here must key its domain table on this exact field.
const REF_FIELD: Record<string, string> = {
  CUVc: 'Code',
  INVc: 'Code',
  SVOSerVc: 'SerialNr',
}

// Registers the outbound write surface supports (Decision 8, WS4 Task 3).
// Anything else is a caller bug, not an ERP-side error.
const WRITABLE_REGISTERS = new Set(['SVOVc', 'WSVc'])

function assertWritableRegister(method: string, register: string): void {
  if (!WRITABLE_REGISTERS.has(register)) {
    throw new Error(`${method} not supported for register ${register} (only SVOVc, WSVc)`)
  }
}

export function createStandardBooksAdapter(rawConfig: unknown): ErpAdapter {
  const config = standardBooksConfigSchema.parse(rawConfig)

  async function pullFullList(register: string): Promise<Record<string, unknown>[]> {
    const { body } = await fetchRegisterJson(config, register, {})
    return extractRows(body, register)
  }

  return {
    capabilities: () => ({
      supportsIncrementalSync: true,
      supportsDeletesFeed: false, // confirmed unreliable — never advertise this as true
      supportsDocumentFetch: false, // HansaWorld: WebExcellentAPI presence, probed per-connection in Task 21b
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),

    async pullChanges(register: string, sinceCursor: string): Promise<ChangeSet<Record<string, unknown>>> {
      const { status, body } = await fetchRegisterJson(config, register, { updates_after: sinceCursor })

      if (status === 404) {
        throw new ErpPermanentError(
          `${register} does not support updates_after — use windowed scan + key-sweep instead`,
        )
      }

      const rows = extractRows(body, register)
      const cursor = String(body?.['@sequence'] ?? sinceCursor)

      return { upserts: rows, deletedRefs: [], cursor }
    },

    pullFullList,

    async listLiveRefs(register: string): Promise<string[]> {
      const refField = REF_FIELD[register]
      if (!refField) {
        throw new Error(`listLiveRefs: no REF_FIELD mapping for register ${register}`)
      }
      const rows = await pullFullList(register)
      const refs: string[] = []
      for (const row of rows) {
        const value = row[refField]
        if (value === null || value === undefined) continue
        const ref = String(value)
        if (ref) refs.push(ref)
      }
      return refs
    },

    async pushCreate(register: string, payload: Record<string, unknown>): Promise<{ erpRef: string }> {
      assertWritableRegister('pushCreate', register)

      const { body } = await postRegisterJson(config, register, payload)
      // Found live in Task 7: a successful create's response is enveloped
      // exactly like a GET (`data.<Register>: [record]`), NOT a flat
      // top-level record — reuse the same extraction as every read path.
      // Per the demo-probe caveat (docs/19-demo-probe-results.md §10): a 200
      // with an echoed, unassigned payload is NOT a success signal — only a
      // non-empty SerNr/@url proves the record persisted. Empty is returned
      // as data, not thrown — the caller (push saga) decides how to react
      // (Decision 3's persistence-verification rule).
      const [created] = extractRows(body, register)
      const erpRef = created?.SerNr ?? created?.['@url'] ?? ''

      return { erpRef: String(erpRef) }
    },

    async pushUpdate(register: string, recordRef: string, payload: Record<string, unknown>): Promise<void> {
      assertWritableRegister('pushUpdate', register)

      // recordRef is the URL segment identifying the record to update
      // (PATCH /api/<company>/<Register>/<recordRef>) — never embedded in
      // the body, so any SerNr the caller's payload happens to carry is
      // simply ignored (buildFormBody drops nothing, but the URL wins).
      const { status, body } = await patchRegisterJson(config, register, recordRef, payload)

      if (status >= 400) {
        throw new ErpPermanentError(`pushUpdate ${register} returned ${status}`)
      }

      // Same envelope as pushCreate (data.<Register>: [record]) — see above.
      const [updated] = extractRows(body, register)
      const returnedSerNr = updated?.SerNr
      if (returnedSerNr !== undefined && returnedSerNr !== null && String(returnedSerNr) !== recordRef) {
        // Wrong-record safety check: an update-by-key POST that echoes back
        // a different record is never a successful update, whatever the
        // HTTP status said.
        throw new ErpPermanentError(
          `pushUpdate ${register} echoed SerNr ${String(returnedSerNr)}, expected ${recordRef} — refusing to treat as success`,
        )
      }
    },

    async fetchRecords(register: string, params: Record<string, string>): Promise<Record<string, unknown>[]> {
      const { status, body } = await fetchRegisterJson(config, register, params)

      if (status >= 400) {
        throw new ErpPermanentError(`fetchRecords ${register} returned ${status}`)
      }

      return extractRows(body, register)
    },

    async probeIncrementalSupport(register: string): Promise<boolean> {
      const { status } = await fetchRegisterJson(config, register, { updates_after: '0' })
      return status !== 404
    },
  }
}

registerAdapter('standard_books', createStandardBooksAdapter)
