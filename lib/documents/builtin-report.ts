// lib/documents/builtin-report.ts
//
// WS12 built-in themed order report (plan decision 6): a PURE function from
// merge context + tenant branding to a complete standalone HTML document
// string. No React, no external assets — inline <style> only, because the
// output goes straight into Gotenberg's Chromium route. Deterministic:
// generatedAt is a parameter, never Date.now().
//
// Theming comes from tenants.branding (nullable jsonb): locale drives the
// labels (lib/documents/report-labels.ts) and all Intl formatting;
// accentColor colors headings and rules; logoUrl becomes an <img src> —
// the remote fetch happens inside Gotenberg's Chromium when the PDF is
// rendered, and a broken/unreachable URL simply shows nothing (alt="").
// footerText lands in the footer next to the generatedAt stamp.
//
// EVERY interpolated value goes through escapeHtml — context text is
// technician-entered and branding is tenant-entered; neither is trusted.
import type { OrderReportContext, OrderReportRow, OrderReportSection } from './context'
import { getReportLabels, type ReportLabels } from './report-labels'

/** Mirrors the tenants.branding jsonb shape (plan decision 6). */
export interface TenantBranding {
  locale?: string
  logoUrl?: string
  accentColor?: string
  footerText?: string
}

export interface RenderBuiltinOrderReportHtmlInput {
  context: OrderReportContext
  branding?: TenantBranding | null
  tenantName: string
  generatedAt: Date
}

// ——— helpers ————————————————————————————————————————————————————————————

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Escaped text with newlines preserved as <br> (crew sections concatenate
 *  distinct values with '\n\n'). */
function textBlock(value: string): string {
  return escapeHtml(value).replaceAll('\n', '<br>')
}

// accentColor is interpolated into the <style> block where HTML-escaping
// does not apply, so it is allow-listed instead: plain CSS color tokens
// only ('#ff6600', 'rgb(1,2,3)', 'rebeccapurple'). Anything else falls
// back to the neutral herbe default.
const SAFE_CSS_COLOR = /^[#a-zA-Z0-9(),.%\s-]{1,64}$/
const DEFAULT_ACCENT = '#1f2937'

function resolveAccent(accentColor: string | undefined): string {
  if (accentColor && SAFE_CSS_COLOR.test(accentColor)) return accentColor.trim()
  return DEFAULT_ACCENT
}

/** Intl throws RangeError on structurally invalid tags — branding is a raw
 *  jsonb column, so fall back to 'en' instead of failing the render. */
function resolveIntlLocale(locale: string | undefined): string {
  if (!locale) return 'en'
  try {
    new Intl.NumberFormat(locale)
    return locale
  } catch {
    return 'en'
  }
}

interface Formatters {
  date: (iso: string) => string
  datetime: (date: Date) => string
  money: (value: number) => string
  qty: (value: number) => string
  km: (value: number) => string
}

function makeFormatters(locale: string): Formatters {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' })
  const datetime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  })
  const money = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const qty = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  const km = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  return {
    date: (iso) => date.format(new Date(iso)),
    datetime: (value) => datetime.format(value),
    money: (value) => money.format(value),
    qty: (value) => qty.format(value),
    km: (value) => km.format(value),
  }
}

/** Locale-neutral duration: 150 → '2 h 30 min', 45 → '45 min'. */
function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`
}

// ——— fragments ——————————————————————————————————————————————————————————

function kvRow(label: string, value: string): string {
  return `<tr><th>${escapeHtml(label)}:</th><td>${escapeHtml(value)}</td></tr>`
}

function orderBlock(context: OrderReportContext, labels: ReportLabels, fmt: Formatters): string {
  const { order, customer } = context
  const rows: string[] = []
  if (order.number !== '') rows.push(kvRow(labels.order, order.number))
  rows.push(kvRow(labels.status, order.status))
  rows.push(kvRow(labels.customer, customer.name))
  if (order.siteName !== '') rows.push(kvRow(labels.site, order.siteName))
  if (order.contactName !== '') rows.push(kvRow(labels.contact, order.contactName))
  if (order.requestedAt) rows.push(kvRow(labels.requested, fmt.date(order.requestedAt)))
  if (order.promisedDate) rows.push(kvRow(labels.promised, fmt.date(order.promisedDate)))
  const description =
    order.description !== ''
      ? `<p class="order-description">${textBlock(order.description)}</p>`
      : ''
  return `<section class="order"><table class="kv">${rows.join('')}</table>${description}</section>`
}

function serviceItemsBlock(context: OrderReportContext, labels: ReportLabels): string {
  if (context.serviceItems.length === 0) return ''
  const rows = context.serviceItems
    .map((item) => {
      const serial = item.serial ? ` <span class="muted">(${escapeHtml(labels.serial)} ${escapeHtml(item.serial)})</span>` : ''
      return `<li>${escapeHtml(item.name)}${serial}</li>`
    })
    .join('')
  return `<section class="service-items"><h2>${escapeHtml(labels.serviceItems)}</h2><ul>${rows}</ul></section>`
}

function rowsTable(rows: OrderReportRow[], labels: ReportLabels, fmt: Formatters): string {
  if (rows.length === 0) return ''
  const body = rows
    .map((row) => {
      const cells = [
        `<td>${escapeHtml(row.description)}${row.serial ? ` <span class="muted">${escapeHtml(row.serial)}</span>` : ''}</td>`,
        `<td class="num">${row.quantity !== undefined ? escapeHtml(fmt.qty(row.quantity)) : ''}</td>`,
        `<td>${row.unit !== undefined ? escapeHtml(row.unit) : ''}</td>`,
        `<td class="num">${row.price !== undefined ? escapeHtml(fmt.money(row.price)) : ''}</td>`,
        `<td class="num">${row.sum !== undefined ? escapeHtml(fmt.money(row.sum)) : ''}</td>`,
      ]
      return `<tr>${cells.join('')}</tr>`
    })
    .join('')
  return (
    `<h3>${escapeHtml(labels.materialsAndServices)}</h3>` +
    '<table class="rows"><thead><tr>' +
    `<th>${escapeHtml(labels.description)}</th>` +
    `<th class="num">${escapeHtml(labels.qty)}</th>` +
    `<th>${escapeHtml(labels.unit)}</th>` +
    `<th class="num">${escapeHtml(labels.price)}</th>` +
    `<th class="num">${escapeHtml(labels.sum)}</th>` +
    `</tr></thead><tbody>${body}</tbody></table>`
  )
}

function sectionBlock(
  section: OrderReportSection,
  labels: ReportLabels,
  fmt: Formatters,
): string {
  const technicians = section.technicians.map((t) => escapeHtml(t.name)).join(', ')
  const crewBadge = section.crew ? ` <span class="badge">${escapeHtml(labels.crew)}</span>` : ''
  const heading = `<h2>${escapeHtml(labels.technicians)}: ${technicians}${crewBadge}</h2>`

  const paragraphs = (
    [
      [labels.workDescription, section.workDescription],
      [labels.fault, section.fault],
      [labels.cause, section.cause],
      [labels.remedy, section.remedy],
    ] as const
  )
    .filter(([, value]) => value !== '')
    .map(
      ([label, value]) =>
        `<h3>${escapeHtml(label)}</h3><p>${textBlock(value)}</p>`,
    )
    .join('')

  const timeParts = [
    `${escapeHtml(labels.workTime)}: ${formatMinutes(section.workMinutes)}`,
    `${escapeHtml(labels.travelTime)}: ${formatMinutes(section.travelMinutes)}`,
    `${escapeHtml(labels.distance)}: ${escapeHtml(fmt.km(section.distanceKm))} km`,
  ]
  const signed = section.signedOnSite
    ? `<p class="signed">✓ ${escapeHtml(labels.signedOnSite)}</p>`
    : ''

  return (
    `<section class="worksheet">${heading}${paragraphs}` +
    rowsTable(section.rows, labels, fmt) +
    `<p class="time-split">${timeParts.join(' · ')}</p>${signed}</section>`
  )
}

function totalsBlock(context: OrderReportContext, labels: ReportLabels, fmt: Formatters): string {
  return (
    `<section class="totals"><h2>${escapeHtml(labels.total)}</h2><table class="kv">` +
    kvRow(labels.totalTime, formatMinutes(context.totals.timeTotalMinutes)) +
    kvRow(labels.distance, `${fmt.km(context.totals.distanceKm)} km`) +
    '</table></section>'
  )
}

function styleBlock(accent: string): string {
  return `<style>
  @page { margin: 18mm 15mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 12px; color: #1a1a1a; margin: 0; }
  header { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px solid ${accent}; padding-bottom: 10px; margin-bottom: 16px; }
  header .tenant { font-size: 14px; font-weight: 600; }
  header img.logo { max-height: 40px; }
  h1 { color: ${accent}; font-size: 20px; margin: 0; }
  h2 { color: ${accent}; font-size: 14px; margin: 18px 0 6px; }
  h3 { font-size: 12px; margin: 10px 0 2px; }
  p { margin: 2px 0 8px; }
  table.kv { border-collapse: collapse; }
  table.kv th { text-align: left; padding: 1px 12px 1px 0; font-weight: 600; white-space: nowrap; vertical-align: top; }
  table.kv td { padding: 1px 0; }
  table.rows { width: 100%; border-collapse: collapse; margin: 4px 0 8px; }
  table.rows th, table.rows td { border-bottom: 1px solid #d5d5d5; padding: 3px 6px; text-align: left; }
  table.rows thead th { border-bottom: 2px solid ${accent}; }
  .num { text-align: right; }
  .muted { color: #666; }
  .badge { display: inline-block; background: ${accent}; color: #fff; font-size: 10px; padding: 1px 6px; border-radius: 3px; vertical-align: middle; }
  .signed { font-weight: 600; }
  .empty { color: #666; font-style: italic; }
  section.worksheet { border-top: 1px solid #e2e2e2; margin-top: 12px; }
  section.totals { border-top: 2px solid ${accent}; margin-top: 16px; }
  footer { margin-top: 24px; border-top: 1px solid #d5d5d5; padding-top: 6px; font-size: 10px; color: #666; }
  </style>`
}

// ——— renderer ———————————————————————————————————————————————————————————

export function renderBuiltinOrderReportHtml({
  context,
  branding,
  tenantName,
  generatedAt,
}: RenderBuiltinOrderReportHtmlInput): string {
  const labels = getReportLabels(branding?.locale)
  const locale = resolveIntlLocale(branding?.locale)
  const fmt = makeFormatters(locale)
  const accent = resolveAccent(branding?.accentColor)

  const title =
    context.order.number !== ''
      ? `${labels.serviceReport} ${context.order.number}`
      : labels.serviceReport

  // Remote logo: fetched by Gotenberg's Chromium at PDF time; a broken URL
  // renders as nothing (empty alt, no layout dependency).
  const logo = branding?.logoUrl
    ? `<img class="logo" src="${escapeHtml(branding.logoUrl)}" alt="">`
    : ''

  const sections =
    context.worksheetSections.length > 0
      ? context.worksheetSections.map((s) => sectionBlock(s, labels, fmt)).join('')
      : `<p class="empty">${escapeHtml(labels.noWorksheets)}</p>`

  const footerText = branding?.footerText ? `${escapeHtml(branding.footerText)} · ` : ''
  const footer = `<footer>${footerText}${escapeHtml(labels.generated)} ${escapeHtml(
    fmt.datetime(generatedAt),
  )}</footer>`

  return (
    '<!DOCTYPE html>\n' +
    `<html lang="${escapeHtml(locale)}">` +
    `<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${styleBlock(accent)}</head>` +
    '<body>' +
    `<header><div><div class="tenant">${escapeHtml(tenantName)}</div><h1>${escapeHtml(title)}</h1></div>${logo}</header>` +
    orderBlock(context, labels, fmt) +
    serviceItemsBlock(context, labels) +
    sections +
    totalsBlock(context, labels, fmt) +
    footer +
    '</body></html>'
  )
}
