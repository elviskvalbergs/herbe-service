// app/(office)/c/[companyId]/office-stub-pages.test.tsx
//
// Covers the 8 office-shell nav-section stubs (Dispatch/Orders/Worksheets/
// Customers/Service items/Stock/Reports/Settings) Task 6 creates as honest
// "coming soon" chrome. Unlike app/(field)'s stub pages (each redirects on
// its own missing session — that shell's layout is deliberately hook-free),
// these have no auth/DB logic of their own: the parent layout.tsx gates the
// whole route segment once (see that file's header comment for why), so
// each stub page here is a synchronous, dependency-free component — no test
// database, no auth mocking, just the returned element tree.
import { describe, expect, it } from 'vitest'

const STUB_PAGES = [
  { name: 'DispatchPage', modulePath: './dispatch/page', title: 'Dispatch' },
  { name: 'OrdersPage', modulePath: './orders/page', title: 'Orders' },
  { name: 'WorksheetsPage', modulePath: './worksheets/page', title: 'Worksheets' },
  { name: 'CustomersPage', modulePath: './customers/page', title: 'Customers' },
  { name: 'ServiceItemsPage', modulePath: './service-items/page', title: 'Service items' },
  { name: 'StockPage', modulePath: './stock/page', title: 'Stock' },
  { name: 'ReportsPage', modulePath: './reports/page', title: 'Reports' },
  { name: 'SettingsPage', modulePath: './settings/page', title: 'Settings / Admin' },
] as const

describe.each(STUB_PAGES)('$name (office shell nav-section stub)', ({ modulePath, title }) => {
  it('renders an honest coming-soon placeholder with no auth/DB logic of its own', async () => {
    const { default: Page } = await import(/* @vite-ignore */ modulePath)

    const element = Page() as { type: string; props: { children: [{ props: { children: string } }, { props: { children: string } }] } }
    const [heading, body] = element.props.children

    expect(element.type).toBe('main')
    expect(heading.props.children).toBe(title)
    expect(body.props.children).toBe('Coming soon.')
  })
})
