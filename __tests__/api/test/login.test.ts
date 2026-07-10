import { afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/test/login/route'

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/test/login', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/test/login', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 404 when isTestAuthEnabled() is false (guard: TEST_AUTH unset)', async () => {
    vi.stubEnv('TEST_AUTH', undefined)

    const res = await POST(makeRequest({ personaKey: 'tech' }))

    expect(res.status).toBe(404)
  })

  it('returns 404 in production even if TEST_AUTH=1 (double guard, not reachable)', async () => {
    vi.stubEnv('TEST_AUTH', '1')
    vi.stubEnv('VERCEL_ENV', 'production')

    const res = await POST(makeRequest({ personaKey: 'tech' }))

    expect(res.status).toBe(404)
  })

  it('returns 400 for an unknown personaKey when the guard is open', async () => {
    vi.stubEnv('TEST_AUTH', '1')
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('NODE_ENV', 'test')

    const res = await POST(makeRequest({ personaKey: 'not-a-real-persona' }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toEqual({ error: 'unknown persona' })
  })

  it('hits the Task-14 stub (throws) for a known persona when the guard is open', async () => {
    vi.stubEnv('TEST_AUTH', '1')
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('NODE_ENV', 'test')

    await expect(POST(makeRequest({ personaKey: 'tech' }))).rejects.toThrow(
      'Not implemented until Task 14'
    )
  })
})
