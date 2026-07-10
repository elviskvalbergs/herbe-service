import { describe, expect, it } from 'vitest'
import { bearerMatches } from './cronAuth'

describe('bearerMatches', () => {
  it('returns false when the header is null', () => {
    expect(bearerMatches(null, 'the-secret')).toBe(false)
  })

  it('returns false when the header is missing the Bearer prefix', () => {
    expect(bearerMatches('the-secret', 'the-secret')).toBe(false)
  })

  it('returns false when the secret is wrong', () => {
    expect(bearerMatches('Bearer wrong-secret', 'the-secret')).toBe(false)
  })

  it('returns false when the header is a different length than expected (short-circuits before timingSafeEqual)', () => {
    expect(bearerMatches('Bearer x', 'the-secret')).toBe(false)
  })

  it('returns true when the header matches exactly', () => {
    expect(bearerMatches('Bearer the-secret', 'the-secret')).toBe(true)
  })
})
