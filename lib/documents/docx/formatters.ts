// lib/documents/docx/formatters.ts
//
// Formatter pipes for DOCX template placeholders — the `| date` in
// {order.requestedAt | date}. All localized output goes through Intl with
// the tenant locale (phase-1 tenant locales: en/et/fi/lv/lt/no/sv, but any
// locale Intl accepts works). Dates format in UTC on purpose: the merge
// context carries ISO timestamps and the rendered document must not depend
// on the server's timezone.

export const DEFAULT_LOCALE = 'en'

/** A template references a formatter that does not exist. */
export class UnknownFormatterError extends Error {
  constructor(
    readonly formatter: string,
    /** The full raw tag the formatter appeared in, e.g. "name | nope". */
    readonly tag: string,
  ) {
    super(`unknown formatter "${formatter}" in tag "${tag}"`)
    this.name = 'UnknownFormatterError'
  }
}

/** A value reached a formatter that cannot represent it (e.g. NaN | date). */
export class FormatterInputError extends Error {
  constructor(
    readonly formatter: string,
    readonly value: unknown,
  ) {
    super(`value ${JSON.stringify(value)} cannot be formatted with "${formatter}"`)
    this.name = 'FormatterInputError'
  }
}

type Formatter = (value: unknown, locale: string) => string

function toDate(value: unknown, formatter: string): Date {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : new Date(NaN)
  if (Number.isNaN(date.getTime())) throw new FormatterInputError(formatter, value)
  return date
}

function toNumber(value: unknown, formatter: string): number {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN
  if (Number.isNaN(num)) throw new FormatterInputError(formatter, value)
  return num
}

const FORMATTERS: Record<string, Formatter> = {
  date: (value, locale) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
      toDate(value, 'date'),
    ),
  datetime: (value, locale) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(toDate(value, 'datetime')),
  number: (value, locale) => new Intl.NumberFormat(locale).format(toNumber(value, 'number')),
  // EUR is hardcoded for v1: every pilot tenant invoices in euros. A tenant
  // currency setting can replace the constant later without touching any
  // template ({rows.sum | currency} stays valid).
  currency: (value, locale) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(
      toNumber(value, 'currency'),
    ),
  upper: (value) => String(value).toUpperCase(),
  lower: (value) => String(value).toLowerCase(),
}

export function isKnownFormatter(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FORMATTERS, name)
}

/** Apply one named formatter. Caller guarantees `value` is non-nullish. */
export function applyFormatter(value: unknown, name: string, locale: string, tag: string): string {
  const formatter = FORMATTERS[name]
  /* v8 ignore next 2 — unreachable: createParser rejects unknown formatter
     names before it ever builds a get() that calls applyFormatter */
  if (!formatter) throw new UnknownFormatterError(name, tag)
  return formatter(value, locale)
}
