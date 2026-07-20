// lib/documents/convert/gotenberg.ts
//
// Gotenberg HTTP client (ADR 0004, plan decision 1): one stateless service
// converts both the built-in HTML report (Chromium route) and merged DOCX
// templates (LibreOffice route) to PDF. Uses Node's global fetch/FormData/
// Blob — no HTTP client dependency.
//
// Error taxonomy — the render engine keys its retry behavior off these types:
//   ConverterUnavailableError  GOTENBERG_URL unset, or network-level failure
//                              (ECONNREFUSED/DNS). Job stays queued, retried.
//   ConverterTimeoutError      no response (or body stalled) within timeoutMs.
//                              Also retryable-stay-queued.
//   ConverterHttpError         Gotenberg answered non-2xx — likely a bad
//                              document; retried with backoff but expected to
//                              dead-letter. Carries status + ≤500-char body
//                              snippet.
//   ConverterBadOutputError    2xx but the body is empty or not %PDF- — a
//                              broken conversion, treated like an HTTP error.
//
// Configuration contract: getGotenbergConfig() is the soft check (null when
// unset — callers that degrade gracefully use it); requireGotenberg() is the
// throwing helper for call sites that must have a converter (the render
// engine calls it per job so an unset env surfaces as the retryable
// ConverterUnavailableError, not a crash).

export interface GotenbergConfig {
  /** Base URL, no trailing slash (e.g. http://gotenberg:3000). */
  url: string
}

export class ConverterUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ConverterUnavailableError'
  }
}

export class ConverterHttpError extends Error {
  constructor(
    readonly status: number,
    /** First ≤500 chars of the error response body. */
    readonly bodySnippet: string,
  ) {
    super(`Gotenberg responded ${status}: ${bodySnippet}`)
    this.name = 'ConverterHttpError'
  }
}

export class ConverterTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Gotenberg request timed out after ${timeoutMs}ms`)
    this.name = 'ConverterTimeoutError'
  }
}

export class ConverterBadOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConverterBadOutputError'
  }
}

/** Reads GOTENBERG_URL; null when unset/empty. Trailing slashes trimmed. */
export function getGotenbergConfig(
  env: Record<string, string | undefined> = process.env,
): GotenbergConfig | null {
  const raw = env.GOTENBERG_URL?.trim()
  if (!raw) return null
  return { url: raw.replace(/\/+$/, '') }
}

/** Like getGotenbergConfig, but throws ConverterUnavailableError when unset. */
export function requireGotenberg(
  env: Record<string, string | undefined> = process.env,
): GotenbergConfig {
  const config = getGotenbergConfig(env)
  if (!config) {
    throw new ConverterUnavailableError('GOTENBERG_URL is not configured')
  }
  return config
}

const DEFAULT_TIMEOUT_MS = 30_000
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PDF_MAGIC = Buffer.from('%PDF-')

/** AbortSignal.timeout aborts with a DOMException named TimeoutError; Node's
 *  DOMException is not an Error instance, so match on the name. */
function isAbortLike(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    ((error as { name: unknown }).name === 'TimeoutError' ||
      (error as { name: unknown }).name === 'AbortError')
  )
}

function mapNetworkError(error: unknown, config: GotenbergConfig, timeoutMs: number): Error {
  if (isAbortLike(error)) return new ConverterTimeoutError(timeoutMs)
  return new ConverterUnavailableError(`Gotenberg at ${config.url} is unreachable`, {
    cause: error,
  })
}

interface PostFileInput {
  config: GotenbergConfig
  path: string
  filename: string
  contentType: string
  content: string | Buffer
  timeoutMs: number
}

async function postFileForPdf({
  config,
  path,
  filename,
  contentType,
  content,
  timeoutMs,
}: PostFileInput): Promise<Buffer> {
  const form = new FormData()
  const part = typeof content === 'string' ? content : new Uint8Array(content)
  form.append('files', new Blob([part], { type: contentType }), filename)

  let response: Response
  try {
    response = await fetch(`${config.url}${path}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw mapNetworkError(error, config, timeoutMs)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ConverterHttpError(response.status, text.slice(0, 500))
  }

  let pdf: Buffer
  try {
    pdf = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    // The signal also covers the body read — a stalled 2xx stream times out.
    throw mapNetworkError(error, config, timeoutMs)
  }

  if (pdf.length === 0) {
    throw new ConverterBadOutputError('Gotenberg returned 2xx with an empty body')
  }
  if (!pdf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new ConverterBadOutputError(
      `Gotenberg returned 2xx but the body is not a PDF (starts with ${JSON.stringify(
        pdf.subarray(0, 16).toString('latin1'),
      )})`,
    )
  }
  return pdf
}

export interface ConvertHtmlToPdfInput {
  /** A complete standalone HTML document (inline CSS only). */
  html: string
  config: GotenbergConfig
  timeoutMs?: number
}

/** HTML → PDF via Gotenberg's Chromium route. */
export async function convertHtmlToPdf({
  html,
  config,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ConvertHtmlToPdfInput): Promise<Buffer> {
  return postFileForPdf({
    config,
    path: '/forms/chromium/convert/html',
    filename: 'index.html',
    contentType: 'text/html',
    content: html,
    timeoutMs,
  })
}

export interface ConvertDocxToPdfInput {
  docx: Buffer
  config: GotenbergConfig
  timeoutMs?: number
}

/** DOCX → PDF via Gotenberg's LibreOffice route. */
export async function convertDocxToPdf({
  docx,
  config,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ConvertDocxToPdfInput): Promise<Buffer> {
  return postFileForPdf({
    config,
    path: '/forms/libreoffice/convert',
    filename: 'document.docx',
    contentType: DOCX_MIME,
    content: docx,
    timeoutMs,
  })
}
