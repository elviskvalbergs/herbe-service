// lib/security/envelope.test.ts
import { beforeAll, describe, expect, it } from 'vitest'
import { ALGO_VERSION, decrypt, encrypt } from './envelope'

beforeAll(() => {
  process.env.MASTER_ENCRYPTION_KEY = 'test-only-throwaway-key-not-a-real-secret-value'
})

describe('envelope encrypt/decrypt', () => {
  it('round-trips plaintext through encrypt -> decrypt', () => {
    const blob = encrypt('hello world')

    expect(blob.algoVersion).toBe(ALGO_VERSION)
    expect(decrypt(blob).toString('utf8')).toBe('hello world')
  })

  it('round-trips a Buffer plaintext', () => {
    const original = Buffer.from([1, 2, 3, 4, 5])
    const blob = encrypt(original)

    expect(decrypt(blob)).toEqual(original)
  })

  it('throws when the ciphertext is tampered with', () => {
    const blob = encrypt('secret payload')
    const tampered = Buffer.from(blob.ciphertext)
    tampered[0] ^= 0xff

    expect(() => decrypt({ ...blob, ciphertext: tampered })).toThrow()
  })

  it('throws when the nonce is tampered with', () => {
    const blob = encrypt('secret payload')
    const tamperedNonce = Buffer.from(blob.nonce)
    tamperedNonce[0] ^= 0xff

    expect(() => decrypt({ ...blob, nonce: tamperedNonce })).toThrow()
  })

  it('throws for a ciphertext shorter than the auth tag', () => {
    const blob = encrypt('secret payload')

    expect(() => decrypt({ ...blob, ciphertext: Buffer.alloc(4) })).toThrow(/too short/)
  })

  it('throws for an unsupported algoVersion', () => {
    const blob = encrypt('secret payload')

    expect(() => decrypt({ ...blob, algoVersion: 999 })).toThrow(/unsupported algoVersion/)
  })

  it('throws for an unknown keyId', () => {
    const blob = encrypt('secret payload')

    expect(() => decrypt({ ...blob, keyId: 'deadbeefdeadbeef' })).toThrow(/unknown keyId/)
  })
})
