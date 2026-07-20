// lib/erp/standard-books/excellent-api.ts
//
// WebExcellentAPI client — WS4 outbound slice, Decision 9
// (docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md). v1
// needs exactly one read action (`getrecordlinks`), so this is a minimal,
// copy-first port of the portal's fuller session/window-action client
// (herbe-portal/lib/erp/standard-books/excellent-api-client/index.ts) — no
// session cookie capture, no window-state assertions, no maintenance-window
// checks, no base64/document extraction. Only what a single GET needs.
//
// Confirmed against the actual HAL source (halocron:
// product-bks/hal_bks/Tools/ExcellentAPI.hal `WebExcellentAPI` +
// ExcellentAPI_Attachments.hal `EXCAPI_GetRecordLinkList`, 2026-07-16):
// the dispatcher reads `register=getrecordlinks` (not `action=getrecordlinks`
// — `action` is always the literal string `action` for this whole family of
// calls) plus `id`/`regname`/`compno`, and always answers HTTP 200 with
// `<data><res regname='LinkVc'/><LinkVc><ID>…</ID><VcName>…</VcName>…</LinkVc>…</data>`
// (zero `<LinkVc>` blocks when the record has no links — not an error, not a
// non-200). The `/app/docs/10-WEB-EXCELLENT-API.md` reference doc describes a
// different `<link><regname>/<sernr>` shape for this same endpoint — that's
// stale/aspirational, not what the HAL handler actually emits; matches this
// project's repeated finding that HAL reference docs drift from the real
// wire format (see docs/19-demo-probe-results.md §5 on RLinkVc).
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici'
import { ErpPermanentError, ErpTransientError } from '@herbe/erp-core'
import type { StandardBooksConfig } from './config-schema'

// Force HTTP/1.1 — the ERP's WebExcellentAPI.hal servlet 403s with an empty
// body when HTTP/2 is negotiated via ALPN (portal finding, reconfirmed
// docs/19-demo-probe-results.md §8). curl defaults to HTTP/1.1 and works;
// undici/fetch negotiates HTTP/2 by default and breaks.
//
// Uses undici's OWN `fetch`, not the platform global — passing an `undici`
// package `Agent` as `dispatcher` into Node's built-in global fetch (which
// bundles its own, possibly differently-versioned, internal undici) throws
// `UND_ERR_INVALID_ARG: invalid onError method` on newer Node runtimes
// (reproduced on Node 26 during this task). Pairing undici's fetch with its
// own Agent keeps both sides on the same implementation always.
const HAL_AGENT = new UndiciAgent({ allowH2: false })

// ---- XML helpers ----
// Ported verbatim from herbe-portal's
// lib/erp/standard-books/registers/activities.ts (xmlAll/xmlFirst/decodeLinkId).

function xmlAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
  const results: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) results.push(m[1].trim())
  }
  return results
}

function xmlFirst(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)
  return m?.[1]?.trim() ?? ''
}

// Some ERP registers encode the linked record ID as a raw 4-byte
// little-endian integer in the XML text rather than as a decimal string.
// Reading the response as latin1 (see fetchRecordLinks below) lets those
// bytes survive intact as latin1 chars; detect non-ASCII/control-character
// content here and re-interpret it as an LE uint32.
function decodeLinkId(raw: string): string {
  if (!raw) return raw
  const bytes = Array.from(raw, (c) => c.charCodeAt(0))
  const hasBinary = bytes.some((b) => b > 0x7e || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d))
  if (!hasBinary) return raw
  if (bytes.length === 4) {
    const [b0, b1, b2, b3] = bytes as [number, number, number, number]
    const val = (b0 | (b1 << 8) | (b2 << 16) | (b3 * 0x1000000)) >>> 0
    return val > 0 ? String(val) : ''
  }
  return ''
}

export interface RecordLink {
  register: string
  id: string
}

function authHeader(config: StandardBooksConfig): string {
  return 'Basic ' + Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64')
}

export async function fetchRecordLinks(
  config: StandardBooksConfig,
  register: string,
  serNr: string,
): Promise<RecordLink[]> {
  const base = config.baseUrl.replace(/\/$/, '')
  const url = new URL(`${base}/WebExcellentAPI.hal`)
  url.searchParams.set('action', 'action')
  url.searchParams.set('register', 'getrecordlinks')
  url.searchParams.set('id', serNr)
  url.searchParams.set('regname', register)
  url.searchParams.set('compno', config.companyNumber)

  let res: Awaited<ReturnType<typeof undiciFetch>>
  try {
    res = await undiciFetch(url, {
      headers: { Authorization: authHeader(config), Accept: 'text/xml, application/xml, */*' },
      dispatcher: HAL_AGENT,
    })
  } catch (err) {
    throw new ErpTransientError(
      `getrecordlinks ${register}/${serNr} failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }

  if (res.status >= 500) {
    throw new ErpTransientError(`getrecordlinks ${register}/${serNr} returned ${res.status}`)
  }
  if (res.status >= 400) {
    throw new ErpPermanentError(`getrecordlinks ${register}/${serNr} returned ${res.status}`)
  }

  // Read as latin1, not utf-8 — see decodeLinkId above: a binary LE-uint32
  // ID's raw bytes must survive as latin1 chars, which a utf-8 decode would
  // mangle (replacement chars on invalid byte sequences).
  const text = Buffer.from(await res.arrayBuffer()).toString('latin1')

  const links: RecordLink[] = []
  for (const linkXml of xmlAll(text, 'LinkVc')) {
    const vcName = xmlFirst(linkXml, 'VcName')
    const id = decodeLinkId(xmlFirst(linkXml, 'ID'))
    if (!vcName || !id) continue // skip undecodable ID / empty VcName entries
    links.push({ register: vcName, id })
  }
  return links
}
