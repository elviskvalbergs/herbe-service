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

      const rows = (body?.data as Record<string, unknown>[]) ?? []
      const cursor = String(body?.['@sequence'] ?? sinceCursor)

      return { upserts: rows, deletedRefs: [], cursor }
    },

    async pushCreate(): Promise<{ erpRef: string }> {
      throw new Error('Not implemented — see Task 13 (Service Order outbox push)')
    },

    async probeIncrementalSupport(register: string): Promise<boolean> {
      const { status } = await fetchRegisterJson(config, register, { updates_after: '0' })
      return status !== 404
    },
  }
}

registerAdapter('standard_books', createStandardBooksAdapter)
