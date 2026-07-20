// app/api/admin/document-templates/test-render/route.ts
//
// WS12 admin test-render route (docs/superpowers/plans/
// 2026-07-20-service-phase1-ws12-documents.md decision 9): dry-runs a stored
// template against a REAL order — build merge context, validate the template's
// dot-paths against it, render the DOCX, and (only when a converter is
// configured) convert to PDF — and returns the validation report plus byte
// SIZES. It NEVER returns the actual file bytes (decision 9): an admin can see
// a template works and how big the output is, not exfiltrate a rendered order.
//
// Same guard idiom as the sibling document-templates route / push-retry:
// ADMIN_MIGRATIONS_SECRET bearer via bearerMatches, fail-closed 401 when unset,
// UUID_RE on every id, static error strings.
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { bearerMatches } from '@/lib/api/cronAuth'
import type { TenantBranding } from '@/lib/documents/builtin-report'
import { buildOrderReportContext, OrderNotFoundError } from '@/lib/documents/context'
import { convertDocxToPdf, getGotenbergConfig } from '@/lib/documents/convert/gotenberg'
import { DocxRenderError, renderDocx, validateTemplate } from '@/lib/documents/docx/engine'
import { getTemplateById } from '@/lib/documents/store'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function authorized(request: Request): boolean {
  const secret = process.env.ADMIN_MIGRATIONS_SECRET
  if (!secret) return false
  const header = request.headers.get('authorization')
  return bearerMatches(header, secret)
}

interface TestRenderBody {
  tenantId?: unknown
  templateId?: unknown
  orderId?: unknown
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: TestRenderBody
  try {
    body = await request.json()
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON body' }, { status: 400 })
  }

  const { tenantId, templateId, orderId } = body
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    return Response.json({ status: 'error', message: 'tenantId (uuid) is required' }, { status: 400 })
  }
  if (typeof templateId !== 'string' || !UUID_RE.test(templateId)) {
    return Response.json({ status: 'error', message: 'templateId (uuid) is required' }, { status: 400 })
  }
  if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) {
    return Response.json({ status: 'error', message: 'orderId (uuid) is required' }, { status: 400 })
  }

  const template = await getTemplateById(db, { tenantId, id: templateId })
  if (!template) {
    return Response.json({ status: 'error', message: 'template not found' }, { status: 404 })
  }

  let context
  try {
    context = await buildOrderReportContext(db, { tenantId, orderId })
  } catch (err) {
    if (err instanceof OrderNotFoundError) {
      return Response.json({ status: 'error', message: 'order not found' }, { status: 404 })
    }
    throw err
  }

  const validation = validateTemplate({ template: template.docx, sampleContext: context })

  // Locale from tenant branding, exactly as the render engine resolves it.
  const [tenant] = await db
    .select({ branding: schema.tenants.branding })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
  const branding = (tenant?.branding ?? null) as TenantBranding | null

  let docx: Buffer
  try {
    ;({ docx } = renderDocx({ template: template.docx, context, locale: branding?.locale, images: {} }))
  } catch (err) {
    if (err instanceof DocxRenderError) {
      return Response.json({ status: 'invalid', errors: err.issues }, { status: 422 })
    }
    throw err
  }

  // Convert only when a converter is configured (decision 1's graceful
  // degradation): an unset GOTENBERG_URL reports converterConfigured:false
  // rather than failing the dry-run.
  const config = getGotenbergConfig()
  let pdfBytes: number | null = null
  if (config) {
    const pdf = await convertDocxToPdf({ docx, config })
    pdfBytes = pdf.length
  }

  return Response.json({
    status: 'ok',
    validation: { ok: validation.ok, errors: validation.errors },
    docxBytes: docx.length,
    pdfBytes,
    converterConfigured: config !== null,
  })
}
