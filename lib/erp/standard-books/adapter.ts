import { registerAdapter, ErpPermanentError, type ChangeSet, type ErpAdapter } from '@herbe/erp-core'
import { standardBooksConfigSchema } from './config-schema'
import { fetchRegisterJson } from './fetch-json'

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
      if (register !== 'SVOVc') {
        throw new Error(`pushCreate not implemented for ${register} in Phase 0`)
      }

      const authHeader = `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64')}`
      const url = `${config.baseUrl}/api/${config.companyNumber}/SVOVc`

      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const body = await res.json().catch(() => null)
      // Per the demo-probe caveat (docs/19-demo-probe-results.md §10): a 200
      // with an echoed, unassigned payload is NOT a success signal — only a
      // non-empty SerNr/@url proves the record persisted.
      const erpRef = body?.SerNr ?? body?.['@url'] ?? ''

      return { erpRef: String(erpRef) }
    },

    async probeIncrementalSupport(register: string): Promise<boolean> {
      const { status } = await fetchRegisterJson(config, register, { updates_after: '0' })
      return status !== 404
    },
  }
}

registerAdapter('standard_books', createStandardBooksAdapter)
