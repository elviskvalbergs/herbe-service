// lib/security/tokens.ts
//
// Scoped bearer-token primitives for the /api/ext/v1 read API
// (docs/08-suite-integration.md §4 "Technical contract": "hashed scoped
// bearer tokens per company connection"). Pure — no DB access. The raw
// token is shown to the admin once at mint time; only its hash is ever
// persisted (lib/api/ext/tokens-store.ts).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Generates a new raw bearer token: 32 random bytes, base64url-encoded. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Hashes a raw token to its stored form: sha256 hex digest (64 chars). */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/**
 * Constant-time string compare. Length-checks before calling
 * `timingSafeEqual` (which throws on mismatched buffer lengths), returning
 * false on a length mismatch instead.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
