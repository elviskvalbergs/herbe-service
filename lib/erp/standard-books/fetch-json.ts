import { ErpTransientError } from '@herbe/erp-core'
import type { StandardBooksConfig } from './config-schema'

function registerUrl(config: StandardBooksConfig, register: string): string {
  return `${config.baseUrl}/api/${config.companyNumber}/${register}`
}

function authHeader(config: StandardBooksConfig): string {
  return `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64')}`
}

// Shared network/status mapping for both the GET and POST layers: a network
// failure or a 5xx response is always retryable (ErpTransientError) — never
// register- or verb-specific, so it lives in one place for both callers.
async function requestJson(input: string | URL, init: RequestInit, register: string): Promise<Response> {
  let res: Response
  try {
    res = await fetch(input, init)
  } catch (err) {
    throw new ErpTransientError(`Network error calling ${register}`, err)
  }

  if (res.status >= 500) {
    throw new ErpTransientError(`${register} returned ${res.status}`)
  }

  return res
}

export async function fetchRegisterJson(
  config: StandardBooksConfig,
  register: string,
  params: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const url = new URL(registerUrl(config, register))
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  const res = await requestJson(url, { headers: { Authorization: authHeader(config), Accept: 'application/json' } }, register)

  if (res.status === 204) {
    return { status: 204, body: null }
  }

  if (res.status >= 400) {
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  return { status: res.status, body: await res.json() }
}

// Standard Books REST write convention (confirmed against the official REST
// API reference, docs/09-REST-API-REFERENCE.md "POST - Create Records" /
// "PATCH - Update Records" — NOT a JSON body): header fields are posted as
// `set_field.<Field>=<value>`, row fields as
// `set_row_field.<rowIndex>.<Field>=<value>`, form-urlencoded and joined
// with `&`. Found live in Task 7 (WS4 outbound slice): pushCreate previously
// sent a flat JSON body, which the real ERP never actually parsed as field
// data — every create landed with no fields set, so CustCode read back
// blank and failed the M4Code "Kods nav reģistrēts" (code not registered)
// check on save (HTTP 200, XML error body, error code 1120) even for a
// customer code proven to exist via a live GET. The fake-ERP mock passed
// throughout WS4 tasks 2-6 because it simply echoed back whatever shape it
// was sent — it was never checked against the real wire contract until this
// task's live run.
const SET_FIELD_PREFIX = 'set_field'
const SET_ROW_FIELD_PREFIX = 'set_row_field'

function buildFormBody(payload: Record<string, unknown>): string {
  const pairs: string[] = []

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'rows' || value === undefined || value === null) continue
    pairs.push(`${SET_FIELD_PREFIX}.${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }

  const rows = Array.isArray(payload.rows) ? (payload.rows as Record<string, unknown>[]) : []
  rows.forEach((row, index) => {
    for (const [key, value] of Object.entries(row)) {
      if (value === undefined || value === null) continue
      pairs.push(`${SET_ROW_FIELD_PREFIX}.${index}.${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    }
  })

  return pairs.join('&')
}

function writeHeaders(config: StandardBooksConfig): HeadersInit {
  return {
    Authorization: authHeader(config),
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  }
}

// POST layer for pushCreate — create only (no SerNr; the REST create
// auto-assigns via NextSerNr, docs/19-demo-probe-results.md §10). Same
// auth/error mapping as fetchRegisterJson.
export async function postRegisterJson(
  config: StandardBooksConfig,
  register: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await requestJson(
    registerUrl(config, register),
    { method: 'POST', headers: writeHeaders(config), body: buildFormBody(payload) },
    register,
  )

  return { status: res.status, body: await res.json().catch(() => null) }
}

// PATCH layer for pushUpdate — update-by-key: recordRef is the URL segment
// identifying the record (docs/09-REST-API-REFERENCE.md "PATCH - Update
// Records": `PATCH /api/<company>/<Register>/<SerNr>`), never embedded in
// the body.
export async function patchRegisterJson(
  config: StandardBooksConfig,
  register: string,
  recordRef: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await requestJson(
    `${registerUrl(config, register)}/${recordRef}`,
    { method: 'PATCH', headers: writeHeaders(config), body: buildFormBody(payload) },
    register,
  )

  return { status: res.status, body: await res.json().catch(() => null) }
}
