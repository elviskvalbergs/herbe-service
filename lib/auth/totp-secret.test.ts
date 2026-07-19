import { beforeAll, describe, expect, it } from 'vitest'
import { decryptMfaSecret, encryptMfaSecret } from './totp-secret'

beforeAll(() => {
  process.env.MASTER_ENCRYPTION_KEY ||= '0123456789abcdef'.repeat(4)
})

describe('encryptMfaSecret / decryptMfaSecret', () => {
  it('round-trips secretBase32 and recoveryHashes', () => {
    const original = { secretBase32: 'JBSWY3DPEHPK3PXP', recoveryHashes: ['hash-one', 'hash-two'] }
    const packed = encryptMfaSecret(original)
    expect(decryptMfaSecret(packed)).toEqual(original)
  })

  it('produces a different packed blob each time (random nonce), both still decrypting to the same value', () => {
    const original = { secretBase32: 'JBSWY3DPEHPK3PXP', recoveryHashes: [] }
    const a = encryptMfaSecret(original)
    const b = encryptMfaSecret(original)
    expect(a).not.toBe(b)
    expect(decryptMfaSecret(a)).toEqual(original)
    expect(decryptMfaSecret(b)).toEqual(original)
  })
})
