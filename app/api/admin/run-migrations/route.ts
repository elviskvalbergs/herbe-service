import { runMigrations } from '@/scripts/migrate'

export async function POST(request: Request) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.ADMIN_MIGRATIONS_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    await runMigrations()
    return Response.json({ status: 'ok' })
  } catch (err) {
    return Response.json({ status: 'error', message: String(err) }, { status: 500 })
  }
}
