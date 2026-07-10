import { timingSafeEqual } from 'node:crypto'
import { runMigrations } from '@/scripts/migrate'

// Constant-time bearer check — this route triggers schema migrations, so the
// secret compare must not leak length/prefix via timing (Task 4 review fix).
// Task 12 introduces a shared `bearerMatches` helper; adopt it there.
function authorized(request: Request): boolean {
  const secret = process.env.ADMIN_MIGRATIONS_SECRET
  if (!secret) return false
  const header = request.headers.get('authorization')
  if (!header) return false
  const expected = `Bearer ${secret}`
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    await runMigrations()
    return Response.json({ status: 'ok' })
  } catch (err) {
    return Response.json({ status: 'error', message: String(err) }, { status: 500 })
  }
}
