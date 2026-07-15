import { registerAdapter, ErpPermanentError, type ChangeSet, type ErpAdapter } from '@herbe/erp-core'
import { standardBooksConfigSchema } from './config-schema'
import { fetchRegisterJson } from './fetch-json'

export function createStandardBooksAdapter(rawConfig: unknown): ErpAdapter {
  const config = standardBooksConfigSchema.parse(rawConfig)

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

      // Standard Books nests rows under `data.<Register>` (verified live) —
      // NOT a flat `data` array. Mirror the portal's extractRegisterRows,
      // with a `data.rows` fallback.
      const container = (body?.data ?? {}) as Record<string, unknown>
      const direct = container[register]
      const rows: Record<string, unknown>[] = Array.isArray(direct)
        ? (direct as Record<string, unknown>[])
        : Array.isArray((container as { rows?: unknown }).rows)
          ? ((container as { rows: Record<string, unknown>[] }).rows)
          : []
      const cursor = String(body?.['@sequence'] ?? sinceCursor)

      return { upserts: rows, deletedRefs: [], cursor }
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
