// tests/e2e/app-shell.spec.ts
//
// Task 11 smoke journey (docs/superpowers/sdd/task-11-brief.md): the
// manifest is genuinely installable, technician/dispatcher land on their
// real shells via the actual role-based routing in app/page.tsx (not a
// mock), and a reload while offline still renders app shell chrome instead
// of a blank screen. Runs against a built server (see playwright.config.ts)
// so next-pwa's service worker actually exists.
import { test, expect, type Page } from '@playwright/test'
import { PERSONAS } from '../../lib/seed/personas'
import { E2E_TENANT_ID, E2E_COMPANY_ID } from './global-setup'

// Reuses this repo's own test-login convention (app/api/test/login/route.ts)
// rather than driving a real magic-link email round trip — signIn() sets the
// session cookie on the response, and page.request shares the page's
// context's cookie jar, so the subsequent page.goto() carries the session.
async function signInAs(page: Page, personaKey: keyof typeof PERSONAS) {
  const res = await page.request.post('/api/test/login', {
    data: { personaKey, tenantId: E2E_TENANT_ID },
  })
  expect(res.ok(), `test-login for ${personaKey} failed: ${res.status()} ${await res.text()}`).toBeTruthy()
}

test.describe('manifest', () => {
  test('is served with real, installable icons', async ({ page }) => {
    const res = await page.request.get('/manifest.json')
    expect(res.ok()).toBeTruthy()
    const manifest = await res.json()

    expect(Array.isArray(manifest.icons)).toBe(true)
    expect(manifest.icons.length).toBeGreaterThan(0)

    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes)
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']))

    // Not just referenced — each icon file must actually be served, since an
    // empty/broken icons list is exactly the bug this task fixed (Task 1's
    // manifest.json shipped with `icons: []`, which would make this
    // assertion falsely pass against a merely-non-empty-looking list).
    for (const icon of manifest.icons as Array<{ src: string; type: string }>) {
      const iconRes = await page.request.get(icon.src)
      expect(iconRes.ok(), `icon ${icon.src} did not load`).toBeTruthy()
      expect(iconRes.headers()['content-type']).toContain('image/png')
    }
  })
})

test.describe('role-based shell routing', () => {
  test('technician lands on the field shell', async ({ page }) => {
    await signInAs(page, 'tech')
    await page.goto('/')

    await expect(page).toHaveURL(/\/today$/)
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()
  })

  test('dispatcher lands on the office shell', async ({ page }) => {
    await signInAs(page, 'dispatch')
    await page.goto('/')

    await expect(page).toHaveURL(new RegExp(`/c/${E2E_COMPANY_ID}$`))
    await expect(page.getByRole('complementary', { name: 'Office' })).toBeVisible()
  })
})

test.describe('offline resilience', () => {
  test('reloading while offline still renders field shell chrome', async ({ page, context }) => {
    await signInAs(page, 'tech')
    await page.goto('/today')
    await expect(page).toHaveURL(/\/today$/)

    // Let the service worker install, activate, and claim this page.
    // next-pwa/workbox is generated with skipWaiting + clientsClaim
    // (verified directly in the built public/sw.js), so this resolves on the
    // very first load without needing a second navigation.
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, { timeout: 20_000 })

    // A service worker never intercepts the very navigation that first
    // makes it the controller of a client — that first /today load above
    // was served straight over the network, uncached (confirmed empirically:
    // the "pages" runtime cache was still empty at this point). Reloading
    // once *while still online* is what actually round-trips this URL
    // through the SW's fetch handler and populates the "pages" NetworkFirst
    // cache — only after that does an offline reload have anything to fall
    // back to.
    await page.reload()
    await expect(page).toHaveURL(/\/today$/)

    await context.setOffline(true)
    try {
      await page.reload()
      // Not a blank screen: the field tab bar chrome must still render,
      // served from the SW's "pages" NetworkFirst runtime cache even though
      // the network is down — even if the data on the page is stale/empty.
      await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()
    } finally {
      await context.setOffline(false)
    }
  })
})
