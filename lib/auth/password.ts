import argon2 from 'argon2'

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

let dummyHashPromise: Promise<string> | null = null

// Timing-parity decoy for authorizeCredentials (Task 3): computed once via
// the SAME hashPassword function used for real passwords, so a "no such
// user" / "no password set" path costs exactly one real argon2.verify call,
// identical to a real wrong-password path — no branch-timing signal for
// account enumeration.
export function getDummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('dummy-password-for-timing-parity-never-matches-anything')
  return dummyHashPromise
}
