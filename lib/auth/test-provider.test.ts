// lib/auth/test-provider.test.ts
//
// Uses vi.stubEnv/vi.unstubAllEnvs (matching lib/db.test.ts's convention)
// rather than direct `process.env.NODE_ENV = ...` assignment: @types/node
// types NODE_ENV as a readonly property, so a direct assignment fails
// `tsc --noEmit` (TS2540). vi.stubEnv sidesteps this since it's a function
// call, not a property write on the readonly-typed object.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTestAuthEnabled } from './test-provider'

describe('isTestAuthEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is false when TEST_AUTH is unset', () => {
    vi.stubEnv('TEST_AUTH', undefined)
    expect(isTestAuthEnabled()).toBe(false)
  })

  it('is false in production even if TEST_AUTH=1 (double guard)', () => {
    vi.stubEnv('TEST_AUTH', '1')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(isTestAuthEnabled()).toBe(false)
  })

  it('is false when NODE_ENV=production even without VERCEL_ENV', () => {
    vi.stubEnv('TEST_AUTH', '1')
    vi.stubEnv('VERCEL_ENV', undefined)
    vi.stubEnv('NODE_ENV', 'production')
    expect(isTestAuthEnabled()).toBe(false)
  })

  it('is true on preview with TEST_AUTH=1', () => {
    vi.stubEnv('TEST_AUTH', '1')
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('NODE_ENV', 'test')
    expect(isTestAuthEnabled()).toBe(true)
  })
})
