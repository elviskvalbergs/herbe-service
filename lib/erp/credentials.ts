/**
 * Encrypt/decrypt the `erp_companies.api_creds_encrypted` blob. On-disk
 * layout is `keyId(16) || nonce(12) || ciphertext` — ported from
 * herbe-portal's lib/erp/credentials.ts (the encrypt side lives at
 * app/api/admin/erp-companies/route.ts there) so both apps use the same
 * packing convention.
 *
 * decryptErpCredentials throws on any decoding failure so callers can
 * surface a clear "no creds / stale format" message rather than silently
 * falling back to anonymous calls.
 */

import { ALGO_VERSION, decrypt, encrypt } from '@/lib/security/envelope'

const KEY_ID_BYTES = 16
const NONCE_BYTES = 12

export class ErpCredentialsError extends Error {
  readonly code: 'missing' | 'corrupt' | 'stale_format'
  constructor(code: 'missing' | 'corrupt' | 'stale_format', message: string) {
    super(message)
    this.code = code
    this.name = 'ErpCredentialsError'
  }
}

export function decryptErpCredentials(blob: Buffer | null): Record<string, unknown> {
  if (!blob) {
    throw new ErpCredentialsError(
      'missing',
      'No credentials on file. Save username + password on the ERP company first.',
    )
  }
  if (blob.length < KEY_ID_BYTES + NONCE_BYTES) {
    throw new ErpCredentialsError('corrupt', `credentials blob too short (${blob.length} bytes)`)
  }
  const keyId = blob.subarray(0, KEY_ID_BYTES).toString('utf8')
  if (!/^[0-9a-f]{16}$/.test(keyId)) {
    throw new ErpCredentialsError(
      'stale_format',
      'credentials were stored in a pre-fix format and can no longer be decrypted — open the form and save the username + password again',
    )
  }
  const nonce = blob.subarray(KEY_ID_BYTES, KEY_ID_BYTES + NONCE_BYTES)
  const ciphertext = blob.subarray(KEY_ID_BYTES + NONCE_BYTES)
  const plaintext = decrypt({ keyId, nonce, ciphertext, algoVersion: ALGO_VERSION }).toString('utf8')
  return JSON.parse(plaintext) as Record<string, unknown>
}

export function encryptErpCredentials(obj: Record<string, unknown>): Buffer {
  // Canonical packed layout: [keyId(16)] [nonce(12)] [ciphertext+tag] —
  // matches decryptErpCredentials above and the portal's write side.
  const blob = encrypt(JSON.stringify(obj))
  return Buffer.concat([Buffer.from(blob.keyId, 'utf8'), blob.nonce, blob.ciphertext])
}
