// lib/documents/builtin-report.test.ts
//
// WS12 Task 5 — built-in themed order report (plan decision 6). The fixture
// is a hand-built OrderReportContext literal (typechecked against the real
// interface) with a solo section AND a crew section, rows with and without
// prices, and hostile HTML in text fields. All localized expectations are
// generated through Intl with the same options the renderer uses — never
// hand-typed literals (lv output contains non-breaking spaces).
import { describe, expect, it } from 'vitest'
import type { OrderReportContext } from './context'
import {
  renderBuiltinOrderReportHtml,
  type TenantBranding,
} from './builtin-report'
import { getReportLabels } from './report-labels'

const GENERATED_AT = new Date('2026-07-20T10:30:00.000Z')

function makeContext(): OrderReportContext {
  return {
    order: {
      id: 'ord-1',
      number: 'SR-2026-00042',
      status: 'Completed',
      description: 'Annual maintenance <script>alert("xss")</script> visit',
      priority: 'high',
      requestedAt: '2026-06-01T08:00:00.000Z',
      promisedDate: '2026-06-15T00:00:00.000Z',
      siteName: 'Main plant',
      contactName: 'Anna Ozola',
    },
    customer: { id: 'cust-1', name: 'Acme & Sons Ltd' },
    serviceItems: [
      { id: 'si-1', name: 'Compressor X100', serial: 'SN-001', chargeType: 'billable' },
      { id: 'si-2', name: 'Pump P2', chargeType: 'warranty' },
    ],
    worksheetSections: [
      {
        technicians: [{ id: 'u1', name: 'tech1@example.com' }],
        crew: false,
        workDescription: 'Replaced the intake filter',
        fault: 'Clogged filter',
        cause: 'Dust build-up',
        remedy: 'Filter replaced',
        signedOnSite: true,
        rows: [
          {
            description: 'Filter element',
            quantity: 2,
            unit: 'pcs',
            chargeType: 'billable',
            price: 1234.5,
            sum: 2469,
          },
          { description: 'Labour', chargeType: 'billable' },
        ],
        timeTotalMinutes: 150,
        workMinutes: 120,
        travelMinutes: 30,
        distanceKm: 42.5,
      },
      {
        technicians: [
          { id: 'u2', name: 'tech2@example.com' },
          { id: 'u3', name: 'tech3@example.com' },
        ],
        crew: true,
        workDescription: 'Crane inspection',
        fault: '',
        cause: '',
        remedy: '',
        signedOnSite: false,
        rows: [],
        timeTotalMinutes: 60,
        workMinutes: 60,
        travelMinutes: 0,
        distanceKm: 0,
      },
    ],
    totals: { timeTotalMinutes: 210, distanceKm: 42.5, rowCount: 2 },
    computed: {},
    meta: { worksheetCount: 3, tenantId: 't1', orderId: 'ord-1' },
  }
}

function render(options?: {
  branding?: TenantBranding | null
  context?: OrderReportContext
}): string {
  return renderBuiltinOrderReportHtml({
    context: options?.context ?? makeContext(),
    branding: options?.branding,
    tenantName: 'Herbe Test OÜ',
    generatedAt: GENERATED_AT,
  })
}

describe('renderBuiltinOrderReportHtml', () => {
  it('produces a standalone, balanced HTML document', () => {
    const html = render()
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html.match(/<html/g)).toHaveLength(1)
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
    expect(html).toContain('<style>')
    // Self-contained: no external stylesheets or scripts.
    expect(html).not.toContain('<link')
    expect(html).not.toContain('<script')
  })

  it('escapes every interpolated value — hostile description is neutralized', () => {
    const html = render()
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
    expect(html).toContain('Acme &amp; Sons Ltd')
  })

  it('renders the order block: number, status, customer, site, contact', () => {
    const html = render()
    const labels = getReportLabels('en')
    expect(html).toContain('SR-2026-00042')
    expect(html).toContain('Completed')
    expect(html).toContain('Main plant')
    expect(html).toContain('Anna Ozola')
    expect(html).toContain(labels.customer)
    expect(html).toContain(labels.site)
    expect(html).toContain(labels.contact)
  })

  it('omits the order-number row when order.number is empty', () => {
    const context = makeContext()
    context.order.number = ''
    const html = render({ context })
    expect(html).not.toContain('SR-2026-00042')
    // The en "Order" label only appears alongside a number.
    expect(html).not.toContain(`${getReportLabels('en').order}:`)
  })

  it('formats dates via Intl with the branding locale', () => {
    const html = render({ branding: { locale: 'et' } })
    const expected = new Intl.DateTimeFormat('et', {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(new Date('2026-06-01T08:00:00.000Z'))
    expect(html).toContain(expected)
  })

  it('lists both technician names in a crew section and shows the crew badge', () => {
    const html = render()
    expect(html).toContain('tech2@example.com')
    expect(html).toContain('tech3@example.com')
    expect(html).toContain(getReportLabels('en').crew)
  })

  it('renders section rows with locale-formatted money and empty cells for missing prices', () => {
    const html = render({ branding: { locale: 'lv' } })
    const money = (value: number): string =>
      new Intl.NumberFormat('lv', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
        value,
      )
    // lv decimal comma (and nbsp group separator) — generated, not hand-typed.
    expect(money(1234.5)).toContain(',')
    expect(html).toContain(money(1234.5))
    expect(html).toContain(money(2469))
    expect(html).toContain('Filter element')
    expect(html).toContain('Labour')
  })

  it('renders per-locale labels (en vs et vs lv)', () => {
    const en = render()
    const et = render({ branding: { locale: 'et' } })
    const lv = render({ branding: { locale: 'lv' } })
    expect(en).toContain(getReportLabels('en').serviceReport)
    expect(et).toContain(getReportLabels('et').serviceReport)
    expect(lv).toContain(getReportLabels('lv').serviceReport)
    expect(getReportLabels('et').serviceReport).not.toBe(getReportLabels('en').serviceReport)
    expect(getReportLabels('lv').serviceReport).not.toBe(getReportLabels('en').serviceReport)
  })

  it('falls back to en labels (and a valid Intl locale) for an unknown locale', () => {
    const html = render({ branding: { locale: 'xx-INVALID-!!' } })
    expect(html).toContain(getReportLabels('en').serviceReport)
  })

  it('shows work/travel time split and distance per section, and the totals block', () => {
    const html = render()
    const labels = getReportLabels('en')
    expect(html).toContain(labels.workTime)
    expect(html).toContain(labels.travelTime)
    expect(html).toContain(labels.distance)
    expect(html).toContain(labels.totalTime)
    expect(html).toContain('2 h 0 min') // solo section work time (120 min)
    expect(html).toContain('3 h 30 min') // totals (210 min)
  })

  it('marks the signed-on-site section', () => {
    const html = render()
    expect(html).toContain(getReportLabels('en').signedOnSite)
  })

  it('applies branding.accentColor in the style block', () => {
    const html = render({ branding: { accentColor: '#ff6600' } })
    expect(html).toContain('#ff6600')
  })

  it('rejects an unsafe accentColor and keeps the neutral default', () => {
    const html = render({ branding: { accentColor: '</style><script>' } })
    expect(html).not.toContain('</style><script>')
  })

  it('renders the logo img only when branding.logoUrl is set', () => {
    const without = render()
    const with_ = render({ branding: { logoUrl: 'https://cdn.example.com/logo.png' } })
    expect(without).not.toContain('<img')
    expect(with_).toContain('<img')
    expect(with_).toContain('https://cdn.example.com/logo.png')
  })

  it('renders footerText and the generatedAt stamp in the footer', () => {
    const html = render({ branding: { footerText: 'Herbe Test OÜ · Reg 12345678' } })
    const stamp = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(GENERATED_AT)
    expect(html).toContain('Herbe Test OÜ · Reg 12345678')
    expect(html).toContain(getReportLabels('en').generated)
    expect(html).toContain(stamp)
  })

  it('renders a valid document with a "no worksheets" state when sections are empty', () => {
    const context = makeContext()
    context.worksheetSections = []
    context.totals = { timeTotalMinutes: 0, distanceKm: 0, rowCount: 0 }
    const html = render({ context })
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
    expect(html).toContain(getReportLabels('en').noWorksheets)
  })

  it('is deterministic for identical inputs', () => {
    expect(render()).toBe(render())
  })
})

describe('getReportLabels', () => {
  it('has complete label sets for all 7 locales', () => {
    const en = getReportLabels('en')
    for (const locale of ['en', 'et', 'fi', 'lv', 'lt', 'no', 'sv']) {
      const labels = getReportLabels(locale)
      expect(Object.keys(labels).sort()).toEqual(Object.keys(en).sort())
      for (const value of Object.values(labels)) {
        expect(value).toBeTruthy()
      }
    }
  })

  it('falls back to en for unknown or missing locales', () => {
    expect(getReportLabels('de')).toEqual(getReportLabels('en'))
    expect(getReportLabels(undefined)).toEqual(getReportLabels('en'))
  })

  it('normalizes region subtags (lv-LV → lv)', () => {
    expect(getReportLabels('lv-LV')).toEqual(getReportLabels('lv'))
  })
})
