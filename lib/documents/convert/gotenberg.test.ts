// lib/documents/convert/gotenberg.test.ts
//
// WS12 Task 5 — Gotenberg HTTP client. Every test spins a real node:http
// server on an ephemeral port (no mocking libraries): requests are captured
// raw so the multipart body, path, and per-part headers can be asserted
// exactly as Gotenberg would see them.
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDocxFixture } from '../docx/fixture'
import {
  ConverterBadOutputError,
  ConverterHttpError,
  ConverterTimeoutError,
  ConverterUnavailableError,
  convertDocxToPdf,
  convertHtmlToPdf,
  getGotenbergConfig,
  requireGotenberg,
} from './gotenberg'

// ——— stub server helper ——————————————————————————————————————————————————

interface CapturedRequest {
  method: string
  url: string
  contentType: string
  body: Buffer
}

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

/** Start an http server on an ephemeral port; `respond` runs after the full
 *  request body arrived (never respond = hang, for timeout tests). */
async function startStub(
  respond: (res: ServerResponse) => void,
): Promise<{ url: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        contentType: req.headers['content-type'] ?? '',
        body: Buffer.concat(chunks),
      })
      respond(res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, requests }
}

const FAKE_PDF = '%PDF-1.7\nfake pdf bytes for tests'

function servePdf(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/pdf' })
  res.end(FAKE_PDF)
}

/** A closed port: listen on an ephemeral port, then close before use. */
async function closedPortUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return `http://127.0.0.1:${port}`
}

// ——— getGotenbergConfig / requireGotenberg ———————————————————————————————

describe('getGotenbergConfig', () => {
  it('returns null when GOTENBERG_URL is unset', () => {
    expect(getGotenbergConfig({})).toBeNull()
  })

  it('returns null when GOTENBERG_URL is empty or whitespace', () => {
    expect(getGotenbergConfig({ GOTENBERG_URL: '' })).toBeNull()
    expect(getGotenbergConfig({ GOTENBERG_URL: '   ' })).toBeNull()
  })

  it('returns the url with trailing slashes trimmed', () => {
    expect(getGotenbergConfig({ GOTENBERG_URL: 'http://gotenberg:3000/' })).toEqual({
      url: 'http://gotenberg:3000',
    })
    expect(getGotenbergConfig({ GOTENBERG_URL: 'http://gotenberg:3000' })).toEqual({
      url: 'http://gotenberg:3000',
    })
  })
})

describe('requireGotenberg', () => {
  it('throws ConverterUnavailableError when unconfigured', () => {
    expect(() => requireGotenberg({})).toThrowError(ConverterUnavailableError)
  })

  it('returns the config when set', () => {
    expect(requireGotenberg({ GOTENBERG_URL: 'http://x:3000' })).toEqual({ url: 'http://x:3000' })
  })
})

// ——— convertHtmlToPdf ————————————————————————————————————————————————————

describe('convertHtmlToPdf', () => {
  it('POSTs multipart html to /forms/chromium/convert/html and returns the PDF buffer', async () => {
    const { url, requests } = await startStub(servePdf)
    const html = '<!DOCTYPE html><html><body><p>Hello Gotenberg</p></body></html>'

    const pdf = await convertHtmlToPdf({ html, config: { url } })

    expect(pdf).toBeInstanceOf(Buffer)
    expect(pdf.toString()).toBe(FAKE_PDF)
    expect(requests).toHaveLength(1)
    const req = requests[0]
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/forms/chromium/convert/html')
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/)
    const body = req.body.toString('latin1')
    expect(body).toContain('name="files"')
    expect(body).toContain('filename="index.html"')
    expect(body).toContain('Content-Type: text/html')
    expect(body).toContain(html)
  })

  it('throws ConverterHttpError with status and body snippet on non-2xx', async () => {
    const { url } = await startStub((res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('conversion blew up')
    })

    const error = await convertHtmlToPdf({ html: '<p>x</p>', config: { url } }).catch((e) => e)
    expect(error).toBeInstanceOf(ConverterHttpError)
    expect((error as ConverterHttpError).status).toBe(500)
    expect((error as ConverterHttpError).bodySnippet).toContain('conversion blew up')
  })

  it('truncates the error body snippet to 500 chars', async () => {
    const { url } = await startStub((res) => {
      res.writeHead(422)
      res.end('x'.repeat(2000))
    })

    const error = await convertHtmlToPdf({ html: '<p>x</p>', config: { url } }).catch((e) => e)
    expect(error).toBeInstanceOf(ConverterHttpError)
    expect((error as ConverterHttpError).status).toBe(422)
    expect((error as ConverterHttpError).bodySnippet).toHaveLength(500)
  })

  it('throws ConverterUnavailableError (with cause) when the connection is refused', async () => {
    const url = await closedPortUrl()

    const error = await convertHtmlToPdf({ html: '<p>x</p>', config: { url } }).catch((e) => e)
    expect(error).toBeInstanceOf(ConverterUnavailableError)
    expect((error as Error).cause).toBeDefined()
  })

  it('throws ConverterTimeoutError when the server never responds', async () => {
    const { url } = await startStub(() => {
      /* hang — never respond */
    })

    const error = await convertHtmlToPdf({
      html: '<p>x</p>',
      config: { url },
      timeoutMs: 100,
    }).catch((e) => e)
    expect(error).toBeInstanceOf(ConverterTimeoutError)
  })

  it('throws ConverterTimeoutError when the response body stalls mid-stream', async () => {
    const { url } = await startStub((res) => {
      res.writeHead(200, { 'Content-Type': 'application/pdf' })
      res.write('%PDF-') // headers + partial body, then stall
    })

    const error = await convertHtmlToPdf({
      html: '<p>x</p>',
      config: { url },
      timeoutMs: 100,
    }).catch((e) => e)
    expect(error).toBeInstanceOf(ConverterTimeoutError)
  })

  it('throws ConverterBadOutputError when a 2xx body is not a PDF', async () => {
    const { url } = await startStub((res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>surprise, an error page</html>')
    })

    await expect(convertHtmlToPdf({ html: '<p>x</p>', config: { url } })).rejects.toThrowError(
      ConverterBadOutputError,
    )
  })

  it('throws ConverterBadOutputError when a 2xx body is empty', async () => {
    const { url } = await startStub((res) => {
      res.writeHead(200)
      res.end()
    })

    await expect(convertHtmlToPdf({ html: '<p>x</p>', config: { url } })).rejects.toThrowError(
      ConverterBadOutputError,
    )
  })
})

// ——— convertDocxToPdf ————————————————————————————————————————————————————

describe('convertDocxToPdf', () => {
  it('POSTs multipart docx to /forms/libreoffice/convert and returns the PDF buffer', async () => {
    const { url, requests } = await startStub(servePdf)
    const docx = buildDocxFixture(['gotenberg docx smoke paragraph'])

    const pdf = await convertDocxToPdf({ docx, config: { url } })

    expect(pdf.toString()).toBe(FAKE_PDF)
    expect(requests).toHaveLength(1)
    const req = requests[0]
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/forms/libreoffice/convert')
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/)
    const body = req.body.toString('latin1')
    expect(body).toContain('name="files"')
    expect(body).toContain('filename="document.docx"')
    expect(body).toContain(
      'Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    // The raw DOCX bytes travel unmodified inside the multipart body.
    expect(req.body.includes(docx)).toBe(true)
  })

  it('propagates typed HTTP errors like the html path', async () => {
    const { url } = await startStub((res) => {
      res.writeHead(400)
      res.end('bad document')
    })

    const error = await convertDocxToPdf({
      docx: buildDocxFixture(['x']),
      config: { url },
    }).catch((e) => e)
    expect(error).toBeInstanceOf(ConverterHttpError)
    expect((error as ConverterHttpError).status).toBe(400)
  })
})
