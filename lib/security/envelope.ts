import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM envelope encryption, ported from herbe-portal's
 * lib/security/envelope.ts. Keeps the same env var name
 * (MASTER_ENCRYPTION_KEY), key derivation, ALGO_VERSION, and packing shape
 * (keyId stamped per blob, auth tag appended to the ciphertext) so both apps
 * share one encryption convention.
 *
 * Portal's version also carries a multi-key rotation registry
 * (registerKey/setCurrentKey) for its rotate-master-key.ts script; that
 * script doesn't exist here, so it's left out until this service needs it.
 */

export type EncryptedBlob = {
  ciphertext: Buffer
  nonce: Buffer
  keyId: string
  algoVersion: number
}

export const ALGO_VERSION = 1
const ALGO = 'aes-256-gcm'
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16

/**
 * Derive a 32-byte AES key from the raw env value. The env var can be either
 * a 64-char hex string (preferred in production) or any string of >=32
 * chars, which we SHA-256 down to 32 bytes so the module never fails at
 * runtime just because the operator picked a long passphrase.
 */
function deriveKey(raw: string): Buffer {
  const trimmed = raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }
  return createHash('sha256').update(trimmed, 'utf8').digest()
}

function computeKeyId(keyBytes: Buffer): string {
  return createHash('sha256').update(keyBytes).digest('hex').slice(0, 16)
}

/**
 * In-memory registry of known keys, indexed by keyId. Populated lazily from
 * MASTER_ENCRYPTION_KEY on first use.
 */
const keyRegistry = new Map<string, Buffer>()
let currentKeyId: string | null = null

function ensureLoaded(): { keyId: string; key: Buffer } {
  if (currentKeyId !== null) {
    const k = keyRegistry.get(currentKeyId)
    if (!k) throw new Error('envelope: current key missing from registry')
    return { keyId: currentKeyId, key: k }
  }
  const raw = process.env.MASTER_ENCRYPTION_KEY
  if (!raw) throw new Error('envelope: MASTER_ENCRYPTION_KEY is not set')
  const key = deriveKey(raw)
  const keyId = computeKeyId(key)
  keyRegistry.set(keyId, key)
  currentKeyId = keyId
  return { keyId, key }
}

export function encrypt(plaintext: Buffer | string): EncryptedBlob {
  const { keyId, key } = ensureLoaded()
  const pt = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGO, key, nonce)
  const body = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()
  // Store auth tag appended to the ciphertext so callers can persist a
  // single column without tracking a separate tag field.
  return {
    ciphertext: Buffer.concat([body, tag]),
    nonce,
    keyId,
    algoVersion: ALGO_VERSION,
  }
}

export function decrypt(record: EncryptedBlob): Buffer {
  if (record.algoVersion !== ALGO_VERSION) {
    throw new Error(`envelope: unsupported algoVersion ${record.algoVersion}`)
  }
  // Warm the registry so the current key is always available, then resolve
  // this row's key by its stamped id.
  ensureLoaded()
  const key = keyRegistry.get(record.keyId)
  if (!key) {
    throw new Error(`envelope: unknown keyId ${record.keyId}`)
  }
  const ct = record.ciphertext
  if (ct.length < AUTH_TAG_BYTES) {
    throw new Error('envelope: ciphertext too short')
  }
  const body = ct.subarray(0, ct.length - AUTH_TAG_BYTES)
  const tag = ct.subarray(ct.length - AUTH_TAG_BYTES)
  const decipher = createDecipheriv(ALGO, key, record.nonce)
  decipher.setAuthTag(tag)
  // `final()` throws if the GCM tag mismatches — i.e. tampered ciphertext,
  // tampered nonce, or wrong key. Surfaces to the caller as a standard error.
  return Buffer.concat([decipher.update(body), decipher.final()])
}
