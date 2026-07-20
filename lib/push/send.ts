// lib/push/send.ts
//
// WS1 Task 9 (push infra, docs/superpowers/sdd/task-9-brief.md): sends a Web
// Push message to every subscription a user has, via the `web-push`
// package. VAPID keys are read from process.env at call time (not at
// module load), so a missing/misconfigured key throws from the call site
// instead of silently no-op-ing whatever imported this module first.
//
// A subscription whose push service responds 404/410 (Gone — the browser
// unsubscribed, or the push service expired it) is deleted here as part of
// the same call: standard Web Push hygiene, so a dead endpoint isn't
// retried forever. Any other per-subscription failure (e.g. a transient 5xx)
// is counted but does not stop delivery to the user's remaining
// subscriptions, and does not delete the row.
import webpush from 'web-push'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

export interface SendPushResult {
  sent: number
  removed: number
  failed: number
}

function vapidDetails(): { subject: string; publicKey: string; privateKey: string } {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT
  if (!publicKey || !privateKey || !subject) {
    throw new Error('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must all be set')
  }
  return { subject, publicKey, privateKey }
}

export async function sendPushToUser(db: Db, userId: string, payload: unknown): Promise<SendPushResult> {
  const { subject, publicKey, privateKey } = vapidDetails()
  webpush.setVapidDetails(subject, publicKey, privateKey)

  const subscriptions = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId))

  const body = JSON.stringify(payload)
  let sent = 0
  let removed = 0
  let failed = 0

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        body,
      )
      sent++
    } catch (err) {
      const statusCode = (err as { statusCode?: number } | undefined)?.statusCode
      if (statusCode === 404 || statusCode === 410) {
        await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, subscription.id))
        removed++
      } else {
        failed++
      }
    }
  }

  return { sent, removed, failed }
}
