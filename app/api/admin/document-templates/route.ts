// app/api/admin/document-templates/route.ts
//
// WS12 admin template API (docs/superpowers/plans/
// 2026-07-20-service-phase1-ws12-documents.md decision 9):
//   POST — upload a DOCX template; runs the engine's upload-time validation
//          and refuses (422) a template with hard errors, so a broken
//          template can never reach the render queue.
//   GET  — list a tenant's templates (metadata only — the docx bytes never
//          leave the store).
//
// Mirrors app/api/admin/push-retry/route.ts's guard shape EXACTLY: the single
// ADMIN_MIGRATIONS_SECRET bearer via constant-time bearerMatches, fail-closed
// 401 when the secret is unset (a missing secret is never "no auth"), UUID_RE
// on id params, and static error strings — never String(err) — so this route
// can't leak internals to the admin secret's caller-facing response.
import { db } from '@/lib/db'
import { bearerMatches } from '@/lib/api/cronAuth'
import type { OrderReportContext } from '@/lib/documents/context'
import { validateTemplate } from '@/lib/documents/docx/engine'
import { insertTemplate, listTemplates } from '@/lib/documents/store'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function authorized(request: Request): boolean {
  const secret = process.env.ADMIN_MIGRATIONS_SECRET
  if (!secret) return false
  const header = request.headers.get('authorization')
  return bearerMatches(header, secret)
}

// A representative merge context for upload-time dot-path validation. v1 has
// exactly one context shape (order_report, lib/documents/context.ts); a future
// docType would branch here. Covers the common placeholders + one loop body so
// a template that references the documented field catalog validates clean.
const SAMPLE_ORDER_REPORT_CONTEXT: OrderReportContext = {
  order: {
    id: '00000000-0000-4000-8000-000000000001',
    number: 'SR-2026-00001',
    status: 'Work done',
    description: 'Sample service order',
    priority: 'normal',
    requestedAt: '2026-07-20T08:00:00.000Z',
    promisedDate: '2026-07-25T00:00:00.000Z',
    siteName: 'Sample Site',
    contactName: 'Sample Contact',
  },
  customer: { id: '00000000-0000-4000-8000-000000000002', name: 'Sample Customer' },
  serviceItems: [
    {
      id: '00000000-0000-4000-8000-000000000003',
      name: 'AHU-01',
      serial: 'SN-1',
      symptom: 'Rattling noise',
      workType: 'maintenance',
      chargeType: 'contract',
    },
  ],
  worksheetSections: [
    {
      technicians: [{ id: '00000000-0000-4000-8000-000000000004', name: 'tech@example.test' }],
      crew: false,
      workDescription: 'Replaced filter',
      fault: 'Clogged filter',
      cause: 'Overdue service',
      remedy: 'New filter installed',
      signedOnSite: true,
      rows: [
        {
          description: 'Filter F7',
          quantity: 2,
          unit: 'pcs',
          serial: 'FLT-9',
          chargeType: 'invoiceable',
          price: 15.5,
          sum: 31,
        },
      ],
      timeTotalMinutes: 90,
      workMinutes: 60,
      travelMinutes: 30,
      distanceKm: 12,
    },
  ],
  totals: { timeTotalMinutes: 90, distanceKm: 12, rowCount: 1 },
  computed: {},
  meta: { worksheetCount: 1, tenantId: '00000000-0000-4000-8000-000000000005', orderId: '00000000-0000-4000-8000-000000000001' },
}

function sampleContextFor(_docType: string): object {
  return SAMPLE_ORDER_REPORT_CONTEXT
}

/** Buffer.from(…, 'base64') is lenient (silently drops non-alphabet chars); a
 *  canonical round-trip rejects non-base64 input as a 400 instead of letting
 *  garbage fall through to a confusing "not a DOCX" 422. */
function decodeBase64(input: string): Buffer | null {
  const buffer = Buffer.from(input, 'base64')
  if (buffer.toString('base64') !== input) return null
  return buffer
}

interface CreateTemplateBody {
  tenantId?: unknown
  docType?: unknown
  name?: unknown
  docxBase64?: unknown
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: CreateTemplateBody
  try {
    body = await request.json()
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON body' }, { status: 400 })
  }

  const { tenantId, docType, name, docxBase64 } = body
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    return Response.json({ status: 'error', message: 'tenantId (uuid) is required' }, { status: 400 })
  }
  if (typeof docType !== 'string' || docType.length === 0) {
    return Response.json({ status: 'error', message: 'docType is required' }, { status: 400 })
  }
  if (typeof name !== 'string' || name.length === 0) {
    return Response.json({ status: 'error', message: 'name is required' }, { status: 400 })
  }
  if (typeof docxBase64 !== 'string' || docxBase64.length === 0) {
    return Response.json({ status: 'error', message: 'docxBase64 is required' }, { status: 400 })
  }

  const docx = decodeBase64(docxBase64)
  if (!docx) {
    return Response.json({ status: 'error', message: 'docxBase64 must be valid base64' }, { status: 400 })
  }

  // Garbage / non-DOCX bytes do NOT crash here: validateTemplate compiles the
  // zip and reports syntax issues rather than throwing.
  const validation = validateTemplate({ template: docx, sampleContext: sampleContextFor(docType) })
  if (!validation.ok) {
    return Response.json({ status: 'invalid', errors: validation.errors }, { status: 422 })
  }

  const template = await insertTemplate(db, { tenantId, docType, name, docx })
  return Response.json(
    {
      status: 'ok',
      template: {
        id: template.id,
        docType: template.docType,
        name: template.name,
        version: template.version,
        active: template.active,
        createdAt: template.createdAt,
      },
    },
    { status: 201 },
  )
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const tenantId = new URL(request.url).searchParams.get('tenantId')
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return Response.json({ status: 'error', message: 'tenantId (uuid) is required' }, { status: 400 })
  }

  const templates = await listTemplates(db, { tenantId })
  return Response.json({ status: 'ok', templates })
}
