// lib/auth/test-provider.ts
export function isTestAuthEnabled(): boolean {
  if (process.env.TEST_AUTH !== '1') return false
  if (process.env.VERCEL_ENV === 'production') return false
  if (process.env.NODE_ENV === 'production') return false
  return true
}
