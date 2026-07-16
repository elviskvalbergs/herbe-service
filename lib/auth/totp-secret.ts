import { ALGO_VERSION, decrypt, encrypt } from '@/lib/security/envelope'

const KEY_ID_BYTES = 16
const NONCE_BYTES = 12

export interface StoredMfaSecret {
  secretBase32: string
  recoveryHashes: string[]
}

// Same packing convention as lib/erp/credentials.ts's encryptErpCredentials:
// keyId(16) || nonce(12) || ciphertext, base64-encoded into one text column.
export function encryptMfaSecret(secret: StoredMfaSecret): string {
  const blob = encrypt(JSON.stringify(secret))
  return Buffer.concat([Buffer.from(blob.keyId, 'utf8'), blob.nonce, blob.ciphertext]).toString('base64')
}

export function decryptMfaSecret(packedBase64: string): StoredMfaSecret {
  const packed = Buffer.from(packedBase64, 'base64')
  const keyId = packed.subarray(0, KEY_ID_BYTES).toString('utf8')
  const nonce = packed.subarray(KEY_ID_BYTES, KEY_ID_BYTES + NONCE_BYTES)
  const ciphertext = packed.subarray(KEY_ID_BYTES + NONCE_BYTES)
  const plaintext = decrypt({ keyId, nonce, ciphertext, algoVersion: ALGO_VERSION }).toString('utf8')
  return JSON.parse(plaintext) as StoredMfaSecret
}
