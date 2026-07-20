// lib/documents/render/engine.ts
//
// WS12 render engine (docs/superpowers/plans/
// 2026-07-20-service-phase1-ws12-documents.md decisions 1/2/6): per tick,
// claim due render jobs and turn each into a documents row — merge context,
// active-template-else-builtin render, Gotenberg PDF conversion, versioned
// insert. Every job runs in its own try/catch (the WS4 per-group isolation
// idiom): one job's failure never aborts the others in the same tick.
//
// NO ERP involvement anywhere in this path — documents never call the ERP
// in Phase 1 (plan §ERP touch).
//
// Failure taxonomy: EVERYTHING — OrderNotFoundError (order soft-deleted
// after enqueue), converter unavailable/timeout/HTTP/bad-output,
// DocxRenderError, unexpected bugs — goes through markJobFailed's backoff
// (2^attempts minutes, dead at 8). A converter that is merely unconfigured
// (GOTENBERG_URL unset) therefore leaves jobs queued and retrying, never
// blocking approvals (plan decision 1's graceful degradation).
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'
import { buildOrderReportContext } from '../context'
import { renderBuiltinOrderReportHtml, type TenantBranding } from '../builtin-report'
import { convertDocxToPdf, convertHtmlToPdf, requireGotenberg } from '../convert/gotenberg'
import { renderDocx } from '../docx/engine'
import { getActiveTemplate, insertRenderedDocument } from '../store'
import { claimDueJobs, markJobDone, markJobFailed } from './store'

type Db = PostgresJsDatabase<typeof schema>

export interface RenderJobResult {
  jobId: string
  orderId: string
  status: 'rendered' | 'failed' | 'dead'
  documentId?: string
  number?: string
  error?: string
}

export interface RenderTickSummary {
  claimed: number
  rendered: number
  failed: number
  dead: number
  results: RenderJobResult[]
}

export interface ProcessRenderJobsOpts {
  /** Drives generatedAt, rendered_at, and the retry backoff — one clock per
   *  tick, injectable for deterministic tests. */
  now?: Date
  limit?: number
  /** Environment for the Gotenberg config (GOTENBERG_URL). */
  env?: Record<string, string | undefined>
}

export async function processRenderJobs(
  db: Db,
  { now = new Date(), limit = 5, env = process.env }: ProcessRenderJobsOpts = {},
): Promise<RenderTickSummary> {
  const jobs = await claimDueJobs(db, { now, limit })

  const summary: RenderTickSummary = {
    claimed: jobs.length,
    rendered: 0,
    failed: 0,
    dead: 0,
    results: [],
  }

  for (const job of jobs) {
    try {
      const { documentId, number } = await renderJob(db, job, now, env)
      await markJobDone(db, job.id)
      summary.rendered++
      summary.results.push({ jobId: job.id, orderId: job.orderId, status: 'rendered', documentId, number })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const failed = await markJobFailed(db, { id: job.id, error: message, now })
      const status = failed.status === 'dead' ? 'dead' : 'failed'
      if (status === 'dead') summary.dead++
      else summary.failed++
      summary.results.push({ jobId: job.id, orderId: job.orderId, status, error: message })
    }
  }

  return summary
}

async function renderJob(
  db: Db,
  job: schema.DocumentRenderJobRow,
  now: Date,
  env: Record<string, string | undefined>,
): Promise<{ documentId: string; number: string }> {
  const [tenant] = await db
    .select({ name: schema.tenants.name, branding: schema.tenants.branding })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, job.tenantId))
  const branding = (tenant.branding ?? null) as TenantBranding | null

  // Throws OrderNotFoundError when the order was (soft-)deleted after the
  // enqueue → failed path. An order whose approved worksheets have all
  // vanished (context.worksheetSections empty) still RENDERS: an approved
  // worksheet enqueued this job, so emptiness is transient/rare, and the
  // built-in report explicitly states "no worksheets" rather than the job
  // dying on a state the operator can't see.
  const context = await buildOrderReportContext(db, { tenantId: job.tenantId, orderId: job.orderId })

  const template = await getActiveTemplate(db, { tenantId: job.tenantId, docType: job.docType })

  let docxBytes: Buffer | null = null
  let pdfBytes: Buffer
  if (template) {
    // Logo-in-docx from branding.logoUrl is NOT fetched in v1 — the images
    // map stays empty, so a {%logo} tag renders as nothing. There is no
    // media infra to source the bytes from, and a remote fetch inside a
    // render job is deferred (the built-in HTML path gets the logo for free
    // because Gotenberg's Chromium fetches the <img src> itself).
    const { docx } = renderDocx({
      template: template.docx,
      context,
      locale: branding?.locale,
      images: {},
    })
    docxBytes = docx
    // requireGotenberg per job: an unset GOTENBERG_URL surfaces as the
    // retryable ConverterUnavailableError, not a crash of the whole tick.
    pdfBytes = await convertDocxToPdf({ docx, config: requireGotenberg(env) })
  } else {
    // No custom template → the built-in themed report. v1 only enqueues
    // docType 'order_report'; a template-less 'order_confirmation' job would
    // fall through here too (no built-in exists for it — plan decision 12).
    const html = renderBuiltinOrderReportHtml({
      context,
      branding,
      tenantName: tenant.name,
      generatedAt: now,
    })
    pdfBytes = await convertHtmlToPdf({ html, config: requireGotenberg(env) })
  }

  // insertRenderedDocument runs its own transaction: the number assignment
  // commits atomically with the document row (never a burned number without
  // a document, never a document without its number).
  const doc = await insertRenderedDocument(db, {
    tenantId: job.tenantId,
    docType: job.docType,
    orderId: job.orderId,
    contextSnapshot: context,
    templateId: template?.id ?? null,
    templateVersion: template?.version ?? null,
    docxBytes,
    pdfBytes,
    now,
  })
  return { documentId: doc.id, number: doc.number }
}
