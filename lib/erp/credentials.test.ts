// lib/erp/credentials.test.ts
import { beforeAll, describe, expect, it } from 'vitest'
import { decryptErpCredentials, encryptErpCredentials, ErpCredentialsError } from './credentials'

beforeAll(() => {
  process.env.MASTER_ENCRYPTION_KEY = 'test-only-throwaway-key-not-a-real-secret-value'
})

describe('encryptErpCredentials / decryptErpCredentials', () => {
  it('round-trips an object through encrypt -> decrypt', () => {
    const blob = encryptErpCredentials({ username: 'svc', password: 'hunter2' })

    expect(decryptErpCredentials(blob)).toEqual({ username: 'svc', password: 'hunter2' })
  })

  it('throws ErpCredentialsError("missing") for a null blob', () => {
    try {
      decryptErpCredentials(null)
      expect.fail('expected decryptErpCredentials to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ErpCredentialsError)
      expect((e as ErpCredentialsError).code).toBe('missing')
    }
  })

  it('throws ErpCredentialsError("corrupt") for a buffer shorter than keyId+nonce', () => {
    const tooShort = Buffer.alloc(10) // < 16 (keyId) + 12 (nonce)

    try {
      decryptErpCredentials(tooShort)
      expect.fail('expected decryptErpCredentials to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ErpCredentialsError)
      expect((e as ErpCredentialsError).code).toBe('corrupt')
    }
  })

  it('throws ErpCredentialsError("stale_format") for a non-hex 16-byte keyId', () => {
    const blob = encryptErpCredentials({ username: 'svc', password: 'hunter2' })
    const badKeyId = Buffer.from('z'.repeat(16), 'utf8') // 16 bytes, not [0-9a-f]
    const tampered = Buffer.concat([badKeyId, blob.subarray(16)])

    try {
      decryptErpCredentials(tampered)
      expect.fail('expected decryptErpCredentials to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ErpCredentialsError)
      expect((e as ErpCredentialsError).code).toBe('stale_format')
    }
  })
})
