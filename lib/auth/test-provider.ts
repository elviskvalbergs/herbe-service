// lib/auth/test-provider.ts
export function isTestAuthEnabled(): boolean {
  if (process.env.TEST_AUTH !== '1') return false
  // On Vercel, VERCEL_ENV ('production' | 'preview' | 'development') is authoritative.
  // Vercel sets NODE_ENV=production on PREVIEW deploys too, so a NODE_ENV check would
  // wrongly disable test-login in Preview — where Task 19's Playwright suite needs it.
  // Only consult NODE_ENV when VERCEL_ENV is absent (local / CI / self-hosted).
  if (process.env.VERCEL_ENV) {
    return process.env.VERCEL_ENV !== 'production'
  }
  return process.env.NODE_ENV !== 'production'
}
