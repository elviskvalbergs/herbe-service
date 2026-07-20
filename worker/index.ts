// worker/index.ts
//
// WS1 Task 10 (docs/superpowers/sdd/task-10-brief.md): bundled by
// @ducanh2912/next-pwa via its `customWorkerSrc` option, which defaults to a
// directory named "worker" relative to the repo root (verified by reading
// the installed node_modules/@ducanh2912/next-pwa/dist/index.d.ts directly —
// the task brief's `swSrc` guess was wrong, there is no such option; also
// verified end-to-end with a real `pnpm build`, see task-10-report.md).
// next-pwa auto-discovers this file ({src/,}index.{ts,js} inside that
// directory), bundles it as its own child webpack compilation, emits it as
// public/worker-<contenthash>.js, and prepends that file to the generated
// sw.js's `importScripts` array. So the listeners below run in the same
// service-worker global scope as the rest of next-pwa's generated worker —
// no next.config.ts change needed, the default `customWorkerSrc: "worker"`
// already points here.
//
// `self` in a service worker is a ServiceWorkerGlobalScope, not the DOM
// `Window` the rest of this repo's tsconfig.json assumes (`lib: ["dom",
// ...]`, needed for the app's browser-side code). lib.dom and lib.webworker
// declare incompatible globals (both define `self`/`caches`/... differently)
// and can't be combined, so rather than switch the whole project to
// lib.webworker (or add a second tsconfig just for this one file), `self`
// is re-typed locally against a small hand-written interface covering only
// the handful of Push/Notification/Clients APIs this file actually uses —
// not `any` (eslint's no-explicit-any is an error in this repo's config).
// `export {}` makes this file a module so the `declare const self` below
// shadows the ambient `Window` `self` only within this file, instead of
// conflicting with it project-wide.
export {}

interface MinimalPushMessageData {
  json(): unknown
}

interface MinimalPushEvent {
  data: MinimalPushMessageData | null
  waitUntil(promise: Promise<unknown>): void
}

interface MinimalWindowClient {
  url: string
  focus(): Promise<unknown>
}

interface MinimalNotificationClickEvent {
  notification: { close(): void; data: unknown }
  waitUntil(promise: Promise<unknown>): void
}

interface MinimalServiceWorkerGlobalScope {
  addEventListener(type: 'push', listener: (event: MinimalPushEvent) => void): void
  addEventListener(type: 'notificationclick', listener: (event: MinimalNotificationClickEvent) => void): void
  registration: {
    showNotification(title: string, options?: { body?: string; data?: unknown }): Promise<unknown>
  }
  clients: {
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<MinimalWindowClient[]>
    openWindow(url: string): Promise<unknown>
  }
}

declare const self: MinimalServiceWorkerGlobalScope

// Shape lib/push/send.ts's sendPushToUser JSON.stringifies as `payload`.
interface PushPayload {
  title: string
  body?: string
  url?: string
}

self.addEventListener('push', (event) => {
  let payload: PushPayload = { title: 'herbe.service' }
  try {
    if (event.data) {
      payload = { ...payload, ...(event.data.json() as Partial<PushPayload>) }
    }
  } catch {
    // Not JSON (shouldn't happen — sendPushToUser always JSON.stringifies) —
    // fall back to the default title with no body/url.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      data: { url: payload.url ?? '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data as { url?: string } | undefined
  const url = data?.url ?? '/'

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const existing = clientsList.find((client) => client.url === url)
      if (existing) {
        await existing.focus()
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})
