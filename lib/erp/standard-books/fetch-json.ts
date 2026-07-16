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

// POST layer for pushCreate/pushUpdate — same auth/URL/error mapping as
// fetchRegisterJson, verbatim payload, no register-specific shaping (that's
// the adapter's job).
export async function postRegisterJson(
  config: StandardBooksConfig,
  register: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await requestJson(
    registerUrl(config, register),
    {
      method: 'POST',
      headers: { Authorization: authHeader(config), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    register,
  )

  return { status: res.status, body: await res.json().catch(() => null) }
}
