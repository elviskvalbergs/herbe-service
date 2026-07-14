// tests/unit/security/tokens.test.ts
//
// Task 4 (docs/superpowers/sdd/task-4-brief.md): pure unit tests for the
// token primitives in lib/security/tokens.ts. No DB — see
// tests/unit/api/ext/tokens-store.test.ts for the DB-backed store tests.
import { describe, expect, it } from 'vitest'
import { constantTimeEqual, generateToken, hashToken } from '@/lib/security/tokens'

describe('generateToken', () => {
  it('returns a base64url string', () => {
    const token = generateToken()
    expect(typeof token).toBe('string')
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('two calls produce different tokens', () => {
    expect(generateToken()).not.toBe(generateToken())
  })
})

describe('hashToken', () => {
  it('produces a 64-character lowercase hex digest', () => {
    const hash = hashToken(generateToken())
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', () => {
    const raw = generateToken()
    expect(hashToken(raw)).toBe(hashToken(raw))
  })

  it('differs for different inputs', () => {
    expect(hashToken(generateToken())).not.toBe(hashToken(generateToken()))
  })
})

describe('constantTimeEqual', () => {
  it('returns true for equal strings', () => {
    const raw = generateToken()
    expect(constantTimeEqual(raw, raw)).toBe(true)
  })

  it('returns false for different strings of equal length', () => {
    const a = 'a'.repeat(32)
    const b = 'b'.repeat(32)
    expect(constantTimeEqual(a, b)).toBe(false)
  })

  it('returns false for different-length strings without throwing', () => {
    expect(() => constantTimeEqual('short', 'a-much-longer-string')).not.toThrow()
    expect(constantTimeEqual('short', 'a-much-longer-string')).toBe(false)
  })
})
