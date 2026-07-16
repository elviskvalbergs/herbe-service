import { describe, expect, it } from 'vitest'
import { getDummyPasswordHash, hashPassword, verifyPassword } from './password'

describe('hashPassword / verifyPassword', () => {
  it('round-trips: a hashed password verifies against the original', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword(hash, 'wrong password')).toBe(false)
  })

  it('returns false (not throw) for a malformed hash', async () => {
    expect(await verifyPassword('not-a-real-argon2-hash', 'anything')).toBe(false)
  })

  it('produces a different hash string each time (random salt), both still verifying', async () => {
    const a = await hashPassword('same input')
    const b = await hashPassword('same input')
    expect(a).not.toBe(b)
    expect(await verifyPassword(a, 'same input')).toBe(true)
    expect(await verifyPassword(b, 'same input')).toBe(true)
  })
})

describe('getDummyPasswordHash', () => {
  it('memoizes: returns the exact same hash on repeated calls', async () => {
    const first = await getDummyPasswordHash()
    const second = await getDummyPasswordHash()
    expect(first).toBe(second)
  })

  it('never verifies against a real-looking password', async () => {
    const dummy = await getDummyPasswordHash()
    expect(await verifyPassword(dummy, 'correct horse battery staple')).toBe(false)
  })
})
