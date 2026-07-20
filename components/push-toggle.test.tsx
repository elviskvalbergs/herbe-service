import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  disablePush,
  enablePush,
  getPushSubscriptionStatus,
  PushToggleView,
  urlBase64ToUint8Array,
} from './push-toggle'

// `enablePush`/`disablePush`/`getPushSubscriptionStatus` are plain async
// functions with no hooks (see push-toggle.tsx's header comment) — testable
// directly against mocked `navigator.serviceWorker`/`Notification` globals,
// same as this project's other non-hook logic. `PushToggle` (the 'use
// client' wrapper with useState/useEffect) needs a real React renderer this
// project's Vitest setup doesn't have (no jsdom/@testing-library — see
// app/layout.test.tsx) and is therefore not exercised here, same as
// ConflictInbox/CompanySwitcher's stateful wrappers.

type El<P> = { type: unknown; props: P }

const VAPID_KEY = 'BKYFL3Vkw_yokcOKtZaVPd6AovnX-ttdG5LIdbyq_LMlXS1nOr8axumUPaC1pZIkFIxqShu7M9DY9QVniUP7YJ8'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url string (using both "-" and "_") into its known raw bytes', () => {
    // '-_--Dg8' is the base64url (no padding) form of bytes
    // [251, 255, 190, 14, 15] — standard base64 '+/++Dg8=', independently
    // computed, not derived from the function under test.
    const bytes = urlBase64ToUint8Array('-_--Dg8')
    expect(Array.from(bytes)).toEqual([251, 255, 190, 14, 15])
  })
})

describe('getPushSubscriptionStatus', () => {
  it('reports "unsupported" when there is no serviceWorker on navigator', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('Notification', { permission: 'default' })

    await expect(getPushSubscriptionStatus()).resolves.toBe('unsupported')
  })

  it('reports "denied" when Notification.permission is denied', async () => {
    vi.stubGlobal('navigator', { serviceWorker: {} })
    vi.stubGlobal('Notification', { permission: 'denied' })

    await expect(getPushSubscriptionStatus()).resolves.toBe('denied')
  })

  it('reports "subscribed" when a subscription already exists', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue({ endpoint: 'x' }) } }),
      },
    })
    vi.stubGlobal('Notification', { permission: 'granted' })

    await expect(getPushSubscriptionStatus()).resolves.toBe('subscribed')
  })

  it('reports "unsubscribed" when permission is granted but there is no subscription yet', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } }) },
    })
    vi.stubGlobal('Notification', { permission: 'granted' })

    await expect(getPushSubscriptionStatus()).resolves.toBe('unsubscribed')
  })
})

describe('enablePush', () => {
  it('subscribes with the given applicationServerKey and posts the subscription when permission is already granted', async () => {
    const subscriptionJSON = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }
    const subscribe = vi.fn().mockResolvedValue({ toJSON: () => subscriptionJSON })
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe } }) } })
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const result = await enablePush(VAPID_KEY)

    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_KEY),
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscriptionJSON),
    })
    expect(result).toEqual({ ok: true })
  })

  it('requests permission first when it is still "default", then subscribes if granted', async () => {
    const subscribe = vi.fn().mockResolvedValue({ toJSON: () => ({ endpoint: 'x', keys: { p256dh: 'p', auth: 'a' } }) })
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe } }) } })
    const requestPermission = vi.fn().mockResolvedValue('granted')
    vi.stubGlobal('Notification', { permission: 'default', requestPermission })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const result = await enablePush(VAPID_KEY)

    expect(requestPermission).toHaveBeenCalled()
    expect(subscribe).toHaveBeenCalled()
    expect(result).toEqual({ ok: true })
  })

  it('does not call subscribe and reports permission-denied when permission is denied', async () => {
    const subscribe = vi.fn()
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe } }) } })
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn() })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await enablePush(VAPID_KEY)

    expect(subscribe).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('permission-denied')
      expect(result.message.length).toBeGreaterThan(0)
    }
  })

  it('does not call subscribe and reports permission-denied when requestPermission resolves to denied', async () => {
    const subscribe = vi.fn()
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe } }) } })
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn().mockResolvedValue('denied') })

    const result = await enablePush(VAPID_KEY)

    expect(subscribe).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      reason: 'permission-denied',
      message: expect.any(String),
    })
  })

  it('reports "unsupported" when there is no serviceWorker support at all', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('Notification', { permission: 'granted' })

    const result = await enablePush(VAPID_KEY)

    expect(result).toEqual({ ok: false, reason: 'unsupported', message: expect.any(String) })
  })

  it('reports request-failed when the subscribe POST responds non-ok', async () => {
    const subscribe = vi.fn().mockResolvedValue({ toJSON: () => ({ endpoint: 'x', keys: { p256dh: 'p', auth: 'a' } }) })
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe } }) } })
    vi.stubGlobal('Notification', { permission: 'granted' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    const result = await enablePush(VAPID_KEY)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('request-failed')
  })
})

describe('disablePush', () => {
  it('unsubscribes and posts the endpoint when a subscription exists', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true)
    const getSubscription = vi.fn().mockResolvedValue({ endpoint: 'https://push.example/abc', unsubscribe })
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription } }) } })
    vi.stubGlobal('Notification', { permission: 'granted' })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const result = await disablePush()

    expect(unsubscribe).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example/abc' }),
    })
    expect(result).toEqual({ ok: true })
  })

  it('is a no-op that still reports success when there is no existing subscription', async () => {
    const getSubscription = vi.fn().mockResolvedValue(null)
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription } }) } })
    vi.stubGlobal('Notification', { permission: 'granted' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await disablePush()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true })
  })

  it('reports "unsupported" when there is no serviceWorker support at all', async () => {
    vi.stubGlobal('navigator', {})

    const result = await disablePush()

    expect(result).toEqual({ ok: false, reason: 'unsupported', message: expect.any(String) })
  })
})

describe('PushToggleView', () => {
  it('renders nothing while status is "checking"', () => {
    expect(PushToggleView({ status: 'checking', busy: false, error: null, onEnable: vi.fn(), onDisable: vi.fn() })).toBeNull()
  })

  it('shows an unsupported message and no button when the browser lacks support', () => {
    const element = PushToggleView({
      status: 'unsupported',
      busy: false,
      error: null,
      onEnable: vi.fn(),
      onDisable: vi.fn(),
    }) as El<{ children: string }>

    expect(element.type).toBe('p')
    expect(element.props.children).toMatch(/not supported/)
  })

  it('shows a blocked message when permission was denied', () => {
    const element = PushToggleView({
      status: 'denied',
      busy: false,
      error: null,
      onEnable: vi.fn(),
      onDisable: vi.fn(),
    }) as El<{ children: unknown }>

    expect(element.type).toBe('p')
  })

  it('shows an enabled "Turn on" button that calls onEnable when unsubscribed', () => {
    const onEnable = vi.fn()
    const element = PushToggleView({
      status: 'unsubscribed',
      busy: false,
      error: null,
      onEnable,
      onDisable: vi.fn(),
    }) as El<{ children: [El<{ disabled: boolean; children: string; onClick: () => void }>, unknown] }>

    const button = element.props.children[0]
    expect(button.props.children).toBe('Turn on push notifications')
    expect(button.props.disabled).toBe(false)
    button.props.onClick()
    expect(onEnable).toHaveBeenCalled()
  })

  it('shows a "Turn off" button that calls onDisable when subscribed', () => {
    const onDisable = vi.fn()
    const element = PushToggleView({
      status: 'subscribed',
      busy: false,
      error: null,
      onEnable: vi.fn(),
      onDisable,
    }) as El<{ children: [El<{ children: string; onClick: () => void }>, unknown] }>

    const button = element.props.children[0]
    expect(button.props.children).toBe('Turn off push notifications')
    button.props.onClick()
    expect(onDisable).toHaveBeenCalled()
  })

  it('disables the button while busy', () => {
    const element = PushToggleView({
      status: 'unsubscribed',
      busy: true,
      error: null,
      onEnable: vi.fn(),
      onDisable: vi.fn(),
    }) as El<{ children: [El<{ disabled: boolean }>, unknown] }>

    expect(element.props.children[0].props.disabled).toBe(true)
  })

  it('renders the error message when present', () => {
    const element = PushToggleView({
      status: 'unsubscribed',
      busy: false,
      error: 'boom',
      onEnable: vi.fn(),
      onDisable: vi.fn(),
    }) as El<{ children: [unknown, El<{ children: string }> | null] }>

    const errorParagraph = element.props.children[1]
    expect(errorParagraph).not.toBeNull()
    expect((errorParagraph as El<{ children: string }>).props.children).toBe('boom')
  })

  it('renders no error slot when error is null', () => {
    const element = PushToggleView({
      status: 'unsubscribed',
      busy: false,
      error: null,
      onEnable: vi.fn(),
      onDisable: vi.fn(),
    }) as El<{ children: [unknown, unknown] }>

    expect(element.props.children[1]).toBeNull()
  })
})
