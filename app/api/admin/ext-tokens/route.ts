// app/api/admin/ext-tokens/route.ts
//
// POST /api/admin/ext-tokens — minimal admin path to mint an /api/ext/v1
// bearer token (Task 10, docs/superpowers/sdd/task-10-brief.md). No admin
// UI: an operator/ops-script hits this directly. Mirrors
// app/api/admin/run-migrations/route.ts's guard/error shape exactly — same
// constant-time `bearerMatches` check, same plain-text 401.
//
// Uses its own secret (ADMIN_EXT_TOKENS_SECRET) rather than reusing
// ADMIN_MIGRATIONS_SECRET: least privilege — this route mints live
// customer-facing bearer credentials, a different blast radius than
// triggering a schema migration, so the two shouldn't share a secret.
//
// The admin secret is not tenant-scoped, so tenantId is never accepted as
// input — it's derived from the given erpCompanyId row. That way an admin
// can only mint a token for a company that actually exists, and can never
// mismatch a tenant/company pair.
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { bearerMatches } from '@/lib/api/cronAuth'
import { mintExtToken } from '@/lib/api/ext/tokens-store'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function authorized(request: Request): boolean {
  const secret = process.env.ADMIN_EXT_TOKENS_SECRET
  if (!secret) return false
  const header = request.headers.get('authorization')
  return bearerMatches(header, secret)
}

interface MintRequestBody {
  erpCompanyId?: unknown
  name?: unknown
  customerCodes?: unknown
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: MintRequestBody
  try {
    body = await request.json()
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON body' }, { status: 400 })
  }

  const { erpCompanyId, name, customerCodes } = body
  if (typeof erpCompanyId !== 'string' || !UUID_RE.test(erpCompanyId) || typeof name !== 'string' || name.length === 0) {
    return Response.json({ status: 'error', message: 'erpCompanyId (uuid) and name are required' }, { status: 400 })
  }
  if (customerCodes !== undefined && (!Array.isArray(customerCodes) || !customerCodes.every((c) => typeof c === 'string'))) {
    return Response.json({ status: 'error', message: 'customerCodes must be an array of strings' }, { status: 400 })
  }

  try {
    const [erpCompany] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.id, erpCompanyId))
    if (!erpCompany) {
      return Response.json({ status: 'error', message: 'erpCompany not found' }, { status: 404 })
    }

    const { id, raw } = await mintExtToken(db, {
      tenantId: erpCompany.tenantId,
      erpCompanyId,
      name,
      customerCodes: customerCodes as string[] | undefined,
    })
    return Response.json({ id, token: raw })
  } catch (err) {
    console.error('POST /api/admin/ext-tokens failed', err)
    return Response.json({ error: 'internal_error', code: 'internal_error' }, { status: 500 })
  }
}
