import { ErpTransientError } from '@herbe/erp-core'
import type { StandardBooksConfig } from './config-schema'

export async function fetchRegisterJson(
  config: StandardBooksConfig,
  register: string,
  params: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const url = new URL(`${config.baseUrl}/api/${config.companyNumber}/${register}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  const authHeader = `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64')}`

  let res: Response
  try {
    res = await fetch(url, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    })
  } catch (err) {
    throw new ErpTransientError(`Network error calling ${register}`, err)
  }

  if (res.status === 204) {
    return { status: 204, body: null }
  }

  if (res.status >= 500) {
    throw new ErpTransientError(`${register} returned ${res.status}`)
  }

  if (res.status >= 400) {
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  return { status: res.status, body: await res.json() }
}
