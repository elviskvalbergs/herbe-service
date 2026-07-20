// components/push-toggle.tsx
//
// WS1 Task 10 (docs/superpowers/sdd/task-10-brief.md): Web Push opt-in, the
// client half of Task 9's POST /api/push/subscribe + /unsubscribe. Same
// split as components/conflict-inbox.tsx: `enablePush`/`disablePush`/
// `getPushSubscriptionStatus` are plain async functions with no hooks —
// directly callable in tests against mocked navigator/Notification globals —
// and `PushToggleView` is a plain, props-driven function with no hooks —
// directly callable and inspectable the same way ConflictInboxList is.
// `PushToggle` (default export, 'use client') wires both together with
// useState/useEffect, which needs a real React renderer this project's
// Vitest setup doesn't have (no jsdom/@testing-library — see
// app/layout.test.tsx) — untested by direct invocation for the same reason
// ConflictInbox/CompanySwitcher's stateful wrappers aren't.
'use client'

import { useEffect, useState } from 'react'

// Web Push wants the VAPID public key as raw bytes for
// `applicationServerKey`, not the base64url string it's generated/shared as
// (VAPID_PUBLIC_KEY / NEXT_PUBLIC_VAPID_PUBLIC_KEY). Standard transform.
// Return type pinned to the ArrayBuffer-backed overload (not the bare
// `Uint8Array`, which widens to `Uint8Array<ArrayBufferLike>` and therefore
// includes SharedArrayBuffer) — PushSubscriptionOptionsInit's
// `applicationServerKey: BufferSource` requires the narrower type.
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

export type PushActionResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'permission-denied' | 'request-failed'; message: string }

export type PushSubscriptionStatus = 'unsupported' | 'subscribed' | 'unsubscribed' | 'denied'

const UNSUPPORTED_MESSAGE = 'Push notifications are not supported in this browser.'

function pushUnsupported(): boolean {
  return typeof navigator === 'undefined' || !('serviceWorker' in navigator) || typeof Notification === 'undefined'
}

// Read on mount: what does this browser/user already have set up? Distinct
// from Notification.permission alone — permission can be granted without a
// subscribe() call ever having completed/persisted.
export async function getPushSubscriptionStatus(): Promise<PushSubscriptionStatus> {
  if (pushUnsupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  return subscription ? 'subscribed' : 'unsubscribed'
}

export async function enablePush(vapidPublicKey: string): Promise<PushActionResult> {
  if (pushUnsupported()) {
    return { ok: false, reason: 'unsupported', message: UNSUPPORTED_MESSAGE }
  }

  let permission = Notification.permission
  if (permission === 'default') {
    permission = await Notification.requestPermission()
  }
  if (permission !== 'granted') {
    return {
      ok: false,
      reason: 'permission-denied',
      message: 'Notification permission was denied. Enable it in your browser settings to turn this on.',
    }
  }

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    })
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    })
    if (!res.ok) {
      return { ok: false, reason: 'request-failed', message: `Could not save subscription (HTTP ${res.status}).` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: 'request-failed', message: err instanceof Error ? err.message : String(err) }
  }
}

export async function disablePush(): Promise<PushActionResult> {
  if (pushUnsupported()) {
    return { ok: false, reason: 'unsupported', message: UNSUPPORTED_MESSAGE }
  }

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return { ok: true }

    const endpoint = subscription.endpoint
    await subscription.unsubscribe()
    const res = await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    })
    if (!res.ok) {
      return { ok: false, reason: 'request-failed', message: `Could not remove subscription (HTTP ${res.status}).` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: 'request-failed', message: err instanceof Error ? err.message : String(err) }
  }
}

export interface PushToggleViewProps {
  status: PushSubscriptionStatus | 'checking'
  busy: boolean
  error: string | null
  onEnable: () => void
  onDisable: () => void
}

export function PushToggleView({ status, busy, error, onEnable, onDisable }: PushToggleViewProps) {
  if (status === 'checking') return null

  if (status === 'unsupported') {
    return <p className="text-sm text-[var(--fg-muted)]">{UNSUPPORTED_MESSAGE}</p>
  }

  if (status === 'denied') {
    return (
      <p className="text-sm text-[var(--fg-muted)]">
        Notifications are blocked. Enable them in your browser&apos;s site settings to turn this on.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={status === 'subscribed' ? onDisable : onEnable}
        disabled={busy}
        className="self-start text-sm font-semibold underline disabled:opacity-50"
      >
        {status === 'subscribed' ? 'Turn off push notifications' : 'Turn on push notifications'}
      </button>
      {error ? <p className="text-xs text-[var(--sync-conflict)]">{error}</p> : null}
    </div>
  )
}

export function PushToggle({ vapidPublicKey }: { vapidPublicKey: string }) {
  // A missing key is known synchronously from the prop (server-read env var,
  // constant for the component's lifetime) — derived via the lazy
  // initializer rather than set from inside the effect below, so there's no
  // synchronous setState-during-effect (react-hooks/set-state-in-effect).
  const [status, setStatus] = useState<PushSubscriptionStatus | 'checking'>(() =>
    vapidPublicKey ? 'checking' : 'unsupported',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!vapidPublicKey) return
    let cancelled = false
    getPushSubscriptionStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
    return () => {
      cancelled = true
    }
  }, [vapidPublicKey])

  async function handleEnable() {
    setBusy(true)
    setError(null)
    const result = await enablePush(vapidPublicKey)
    setBusy(false)
    if (result.ok) {
      setStatus('subscribed')
    } else {
      setError(result.message)
      if (result.reason === 'permission-denied') setStatus('denied')
    }
  }

  async function handleDisable() {
    setBusy(true)
    setError(null)
    const result = await disablePush()
    setBusy(false)
    if (result.ok) {
      setStatus('unsubscribed')
    } else {
      setError(result.message)
    }
  }

  return <PushToggleView status={status} busy={busy} error={error} onEnable={handleEnable} onDisable={handleDisable} />
}
