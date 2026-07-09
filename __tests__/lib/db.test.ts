import { afterEach, describe, expect, it, vi } from 'vitest'

describe('lib/db', () => {
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('throws when DATABASE_URL is unset', async () => {
    vi.stubEnv('DATABASE_URL', '')
    await expect(import('@/lib/db')).rejects.toThrow('DATABASE_URL must be set')
  })

  it('constructs the sql client and drizzle db when DATABASE_URL is set', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/testdb')
    const mod = await import('@/lib/db')
    expect(mod.sql).toBeDefined()
    expect(mod.db).toBeDefined()
  })
})
