// lib/documents/number-series.ts
//
// WS12 document number series (docs/superpowers/plans/
// 2026-07-20-service-phase1-ws12-documents.md decision 4, doc 12
// §Numbering): per-(tenant, docType) counter behind
// `<prefix>-<year>-<counter padded 5>` numbers, e.g. SR-2026-00142.
// Counter is monotonic, no yearly reset (deferred).
//
// Race safety is the point of this module:
//   - Seeding uses INSERT … ON CONFLICT (tenant_id, doc_type) DO NOTHING,
//     so two concurrent first callers both proceed against one series row.
//   - Assignment is a single atomic UPDATE … SET next_counter =
//     next_counter + 1 … RETURNING next_counter - 1 — RETURNING evaluates
//     the post-update row, so `next_counter - 1` is exactly the value this
//     caller claimed. No SELECT-then-UPDATE two-step; concurrent callers
//     serialize on the row lock and each get a distinct counter.
import { and, eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

// Default prefixes seeded on first use (plan decision 4). Unmapped docTypes
// fall back to uppercase initials of the underscore-separated words
// ('delivery_note' → 'DN'), else 'DOC'.
export const DEFAULT_PREFIXES: Record<string, string> = {
  order_report: 'SR',
  order_confirmation: 'OC',
}

export function defaultPrefixFor(docType: string): string {
  const mapped = DEFAULT_PREFIXES[docType]
  if (mapped) return mapped
  const initials = docType
    .split('_')
    .map((word) => word.charAt(0).toUpperCase())
    .join('')
  return initials || 'DOC'
}

export function formatDocumentNumber(prefix: string, year: number, counter: number): string {
  return `${prefix}-${year}-${String(counter).padStart(5, '0')}`
}

export interface AssignNumberInput {
  tenantId: string
  docType: string
  year: number
}

export async function assignNumber(
  db: Db,
  { tenantId, docType, year }: AssignNumberInput,
): Promise<{ number: string; seriesId: string }> {
  // Auto-seed. ON CONFLICT DO NOTHING makes the first-use race safe: the
  // loser of a concurrent seed waits on the unique index, then no-ops and
  // increments the winner's row below.
  await db
    .insert(schema.documentNumberSeries)
    .values({ tenantId, docType, prefix: defaultPrefixFor(docType) })
    .onConflictDoNothing({
      target: [schema.documentNumberSeries.tenantId, schema.documentNumberSeries.docType],
    })

  const [row] = await db
    .update(schema.documentNumberSeries)
    .set({ nextCounter: sql`${schema.documentNumberSeries.nextCounter} + 1` })
    .where(
      and(
        eq(schema.documentNumberSeries.tenantId, tenantId),
        eq(schema.documentNumberSeries.docType, docType),
      ),
    )
    .returning({
      seriesId: schema.documentNumberSeries.id,
      prefix: schema.documentNumberSeries.prefix,
      assigned: sql<number>`${schema.documentNumberSeries.nextCounter} - 1`,
    })

  /* v8 ignore next 5 — unreachable: the seed above guarantees the row exists */
  if (!row) {
    throw new Error(
      `document_number_series row missing after seed for tenant ${tenantId}, docType ${docType}`,
    )
  }

  return { number: formatDocumentNumber(row.prefix, year, row.assigned), seriesId: row.seriesId }
}
