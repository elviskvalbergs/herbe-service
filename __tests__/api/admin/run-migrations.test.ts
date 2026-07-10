import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/scripts/migrate', () => ({
  runMigrations: vi.fn(),
}))

import { runMigrations } from '@/scripts/migrate'
import { POST } from '@/app/api/admin/run-migrations/route'

const runMigrationsMock = vi.mocked(runMigrations)

function makeRequest(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/run-migrations', {
    method: 'POST',
    headers,
  })
}

describe('POST /api/admin/run-migrations', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    runMigrationsMock.mockReset()
  })

  it('returns 401 and does not call runMigrations when the bearer header is missing', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')

    const res = await POST(makeRequest())

    expect(res.status).toBe(401)
    expect(runMigrationsMock).not.toHaveBeenCalled()
  })

  it('returns 401 and does not call runMigrations when the bearer is wrong', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')

    const res = await POST(makeRequest({ authorization: 'Bearer wrong-secret' }))

    expect(res.status).toBe(401)
    expect(runMigrationsMock).not.toHaveBeenCalled()
  })

  it('returns 401 when ADMIN_MIGRATIONS_SECRET is unset', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', '')

    const res = await POST(makeRequest({ authorization: 'Bearer anything' }))

    expect(res.status).toBe(401)
    expect(runMigrationsMock).not.toHaveBeenCalled()
  })

  it('calls runMigrations and returns {status: "ok"} with the correct bearer', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    runMigrationsMock.mockResolvedValueOnce(undefined)

    const res = await POST(makeRequest({ authorization: 'Bearer the-secret' }))
    const body = await res.json()

    expect(runMigrationsMock).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok' })
  })
})
