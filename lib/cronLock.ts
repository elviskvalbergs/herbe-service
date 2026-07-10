import { sql } from '@/lib/db'

// Table-based cron lock (Supabase-pooler-safe): the pooler doesn't hold
// Postgres advisory locks reliably across requests, so cron_locks is a real
// table instead. The lock expires automatically after ttlSecs if the holder
// crashes before releasing it. Adapted from herbe-calendar's lib/cronLock.ts
// (node-postgres pool -> postgres.js `sql` tagged template).

export async function acquireCronLock(key: string, ttlSecs: number): Promise<boolean> {
  const rows = await sql<{ key: string }[]>`
    INSERT INTO cron_locks (key, locked_at, expires_at)
    VALUES (${key}, now(), now() + (${ttlSecs} * INTERVAL '1 second'))
    ON CONFLICT (key) DO UPDATE
      SET locked_at  = now(),
          expires_at = now() + (${ttlSecs} * INTERVAL '1 second')
    WHERE cron_locks.expires_at < now()
    RETURNING key
  `
  return rows.length > 0
}

export async function releaseCronLock(key: string): Promise<void> {
  await sql`DELETE FROM cron_locks WHERE key = ${key}`.catch(() => {})
}
