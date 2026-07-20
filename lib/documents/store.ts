// lib/documents/store.ts
//
// WS12 document + template store (docs/superpowers/plans/
// 2026-07-20-service-phase1-ws12-documents.md decisions 3/4). ALL reads and
// writes of documents/document_templates go through this module: bytes live
// as Postgres bytea for now (decision 3 — no media/storage infra exists),
// and this being the single touch point is what makes the later Supabase
// Storage swap a one-module change.
//
// The invariant this store owns (doc 12 §Numbering): a document number is
// assigned exactly once — at the first successful render (version 1) — and
// every re-render copies that number verbatim into a new version row. The
// series counter must NEVER advance for version > 1.
import { and, asc, desc, eq, isNotNull, max, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import type { DocumentRow, DocumentTemplateRow } from '@/drizzle/schema'
import { assignNumber } from './number-series'

type Db = PostgresJsDatabase<typeof schema>

/** Listing shape — everything except the (potentially large) byte columns. */
export type DocumentMeta = Omit<DocumentRow, 'docxBytes' | 'pdfBytes'>
export type DocumentTemplateMeta = Omit<DocumentTemplateRow, 'docx'>

// ——— documents ———————————————————————————————————————————————————————————

export interface InsertRenderedDocumentInput {
  tenantId: string
  docType: string
  orderId: string
  /** The merge context the render used, stored verbatim (doc 12 §Versioning). */
  contextSnapshot: object
  /** Null/absent = rendered with the built-in report. */
  templateId?: string | null
  templateVersion?: number | null
  docxBytes?: Buffer | null
  pdfBytes?: Buffer | null
  /** Drives rendered_at and — for version 1 only — the number's year. */
  now: Date
}

const documentMetaColumns = {
  id: schema.documents.id,
  tenantId: schema.documents.tenantId,
  docType: schema.documents.docType,
  orderId: schema.documents.orderId,
  number: schema.documents.number,
  seriesId: schema.documents.seriesId,
  version: schema.documents.version,
  templateId: schema.documents.templateId,
  templateVersion: schema.documents.templateVersion,
  contextSnapshot: schema.documents.contextSnapshot,
  renderedAt: schema.documents.renderedAt,
  createdAt: schema.documents.createdAt,
}

/**
 * Insert a successful render as the next version of (tenant, docType,
 * order). Version 1 assigns a fresh number from the series; every later
 * version copies number + seriesId from the version-1 row and never touches
 * the counter. Wrapped in db.transaction so the number assignment commits
 * (or rolls back) together with the document row — when called with an
 * outer tx, drizzle-orm/postgres-js composes this as a SAVEPOINT rather
 * than a second top-level transaction (see lib/sync/push/enqueue.ts).
 *
 * Concurrency: two simultaneous renders of the same order can both compute
 * the same next version; the (tenant, doc_type, order_id, version) unique
 * constraint fails one of them and its savepoint/transaction rolls back —
 * including any counter increment — so the render job just retries.
 */
export async function insertRenderedDocument(
  db: Db,
  input: InsertRenderedDocumentInput,
): Promise<DocumentRow> {
  return db.transaction(async (tx) => {
    const versions = await tx
      .select({
        number: schema.documents.number,
        seriesId: schema.documents.seriesId,
        version: schema.documents.version,
      })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.tenantId, input.tenantId),
          eq(schema.documents.docType, input.docType),
          eq(schema.documents.orderId, input.orderId),
        ),
      )
      .orderBy(asc(schema.documents.version))

    let number: string
    let seriesId: string
    let version: number
    if (versions.length === 0) {
      // First final render: assign the immutable number (UTC year so the
      // result doesn't depend on the server's local timezone).
      ;({ number, seriesId } = await assignNumber(tx, {
        tenantId: input.tenantId,
        docType: input.docType,
        year: input.now.getUTCFullYear(),
      }))
      version = 1
    } else {
      // Number immutability: copy from the min-version row (version 1),
      // never re-assign — even across a year boundary.
      number = versions[0].number
      seriesId = versions[0].seriesId
      version = versions[versions.length - 1].version + 1
    }

    const [row] = await tx
      .insert(schema.documents)
      .values({
        tenantId: input.tenantId,
        docType: input.docType,
        orderId: input.orderId,
        number,
        seriesId,
        version,
        templateId: input.templateId ?? null,
        templateVersion: input.templateVersion ?? null,
        contextSnapshot: input.contextSnapshot,
        docxBytes: input.docxBytes ?? null,
        pdfBytes: input.pdfBytes ?? null,
        renderedAt: input.now,
      })
      .returning()
    return row
  })
}

export interface DocumentKeyInput {
  tenantId: string
  docType: string
  orderId: string
}

export async function getLatestDocument(
  db: Db,
  { tenantId, docType, orderId }: DocumentKeyInput,
): Promise<DocumentRow | null> {
  const [row] = await db
    .select()
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.tenantId, tenantId),
        eq(schema.documents.docType, docType),
        eq(schema.documents.orderId, orderId),
      ),
    )
    .orderBy(desc(schema.documents.version))
    .limit(1)
  return row ?? null
}

export async function listDocumentsForOrder(
  db: Db,
  { tenantId, orderId }: { tenantId: string; orderId: string },
): Promise<DocumentMeta[]> {
  return db
    .select(documentMetaColumns)
    .from(schema.documents)
    .where(and(eq(schema.documents.tenantId, tenantId), eq(schema.documents.orderId, orderId)))
    .orderBy(asc(schema.documents.docType), asc(schema.documents.version))
}

export async function getDocumentPdf(
  db: Db,
  { tenantId, documentId }: { tenantId: string; documentId: string },
): Promise<{ number: string; version: number; pdfBytes: Buffer } | null> {
  const [row] = await db
    .select({
      number: schema.documents.number,
      version: schema.documents.version,
      pdfBytes: schema.documents.pdfBytes,
    })
    .from(schema.documents)
    .where(and(eq(schema.documents.id, documentId), eq(schema.documents.tenantId, tenantId)))
  // A row without pdf bytes is a miss for a PDF getter.
  if (!row || row.pdfBytes == null) return null
  return { number: row.number, version: row.version, pdfBytes: row.pdfBytes }
}

/**
 * "Does this order have a rendered report PDF?" — the /api/ext reportPdf
 * flag (Task 7). Single cheap probe against documents_tenant_order_idx;
 * SELECT 1 … LIMIT 1 is planner-equivalent to EXISTS.
 */
export async function orderHasRenderedReport(
  db: Db,
  { tenantId, orderId }: { tenantId: string; orderId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(schema.documents)
    .where(
      and(
        eq(schema.documents.tenantId, tenantId),
        eq(schema.documents.orderId, orderId),
        eq(schema.documents.docType, 'order_report'),
        isNotNull(schema.documents.pdfBytes),
      ),
    )
    .limit(1)
  return row !== undefined
}

// ——— templates ———————————————————————————————————————————————————————————

const templateMetaColumns = {
  id: schema.documentTemplates.id,
  tenantId: schema.documentTemplates.tenantId,
  docType: schema.documentTemplates.docType,
  name: schema.documentTemplates.name,
  version: schema.documentTemplates.version,
  active: schema.documentTemplates.active,
  createdAt: schema.documentTemplates.createdAt,
}

/** Selection v1 (plan decision 4): newest active for (tenant, docType) —
 *  highest version first, created_at breaking ties across names. */
export async function getActiveTemplate(
  db: Db,
  { tenantId, docType }: { tenantId: string; docType: string },
): Promise<DocumentTemplateRow | null> {
  const [row] = await db
    .select()
    .from(schema.documentTemplates)
    .where(
      and(
        eq(schema.documentTemplates.tenantId, tenantId),
        eq(schema.documentTemplates.docType, docType),
        eq(schema.documentTemplates.active, true),
      ),
    )
    .orderBy(desc(schema.documentTemplates.version), desc(schema.documentTemplates.createdAt))
    .limit(1)
  return row ?? null
}

export interface InsertTemplateInput {
  tenantId: string
  docType: string
  name: string
  docx: Buffer
  active?: boolean
}

/**
 * Insert a template as the next version of (tenant, docType, name). The
 * max+1 read and the insert share a transaction; there is no unique
 * constraint on the triple, so two truly concurrent same-name uploads could
 * both land on the same version — acceptable for an admin-driven, secret-
 * gated upload path (getActiveTemplate's created_at tiebreak still picks a
 * deterministic winner).
 */
export async function insertTemplate(db: Db, input: InsertTemplateInput): Promise<DocumentTemplateRow> {
  return db.transaction(async (tx) => {
    const [{ maxVersion }] = await tx
      .select({ maxVersion: max(schema.documentTemplates.version) })
      .from(schema.documentTemplates)
      .where(
        and(
          eq(schema.documentTemplates.tenantId, input.tenantId),
          eq(schema.documentTemplates.docType, input.docType),
          eq(schema.documentTemplates.name, input.name),
        ),
      )
    const [row] = await tx
      .insert(schema.documentTemplates)
      .values({
        tenantId: input.tenantId,
        docType: input.docType,
        name: input.name,
        version: (maxVersion ?? 0) + 1,
        docx: input.docx,
        active: input.active ?? true,
      })
      .returning()
    return row
  })
}

export async function listTemplates(
  db: Db,
  { tenantId }: { tenantId: string },
): Promise<DocumentTemplateMeta[]> {
  return db
    .select(templateMetaColumns)
    .from(schema.documentTemplates)
    .where(eq(schema.documentTemplates.tenantId, tenantId))
    .orderBy(
      asc(schema.documentTemplates.docType),
      asc(schema.documentTemplates.name),
      asc(schema.documentTemplates.version),
    )
}

export async function getTemplateById(
  db: Db,
  { tenantId, id }: { tenantId: string; id: string },
): Promise<DocumentTemplateRow | null> {
  const [row] = await db
    .select()
    .from(schema.documentTemplates)
    .where(and(eq(schema.documentTemplates.id, id), eq(schema.documentTemplates.tenantId, tenantId)))
  return row ?? null
}
