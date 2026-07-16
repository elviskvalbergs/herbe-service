// lib/erp/standard-books/excellent-api.test.ts
//
// WS4 outbound slice, Decision 9: unit tests for the WebExcellentAPI
// getrecordlinks client. Uses a plain Node http server rather than
// Hono/fake-erp — this is a one-off XML endpoint, not a REST register — so
// status codes and raw response bytes are fully controlled, including a
// genuine binary LE-uint32 ID byte sequence a JSON/text fixture couldn't
// represent.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchRecordLinks } from './excellent-api'
import type { StandardBooksConfig } from './config-schema'

let server: Server | undefined
let serverUrl = ''

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      const port = typeof address === 'object' && address ? address.port : 0
      serverUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }
})

function configFor(baseUrl: string): StandardBooksConfig {
  return {
    baseUrl,
    companyNumber: '1',
    auth: { kind: 'basic', username: 'test', password: 'test' },
  }
}

// Real getrecordlinks XML shape (confirmed against the HAL source,
// EXCAPI_GetRecordLinkList — see the comment at the top of excellent-api.ts):
// <data><res regname='LinkVc'/><LinkVc><ID>…</ID><VcName>…</VcName>…</LinkVc>…</data>
function linkVcXml(entries: string): string {
  return `<data><res regname='LinkVc'></res>${entries}</data>`
}

describe('fetchRecordLinks — XML parsing', () => {
  it('parses multiple LinkVc blocks with decimal IDs', async () => {
    const xml = linkVcXml(
      '<LinkVc><ID>230015</ID><VcName>WSVc</VcName></LinkVc>' +
        '<LinkVc><ID>500123</ID><VcName>IVVc</VcName></LinkVc>',
    )
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(xml)
    })

    const links = await fetchRecordLinks(configFor(serverUrl), 'SVOVc', '230015')

    expect(links).toEqual([
      { register: 'WSVc', id: '230015' },
      { register: 'IVVc', id: '500123' },
    ])
  })

  it('decodes a raw little-endian uint32 ID (binary, not a decimal string)', async () => {
    const value = 500123
    const idBytes = Buffer.alloc(4)
    idBytes.writeUInt32LE(value, 0)
    const body = Buffer.concat([
      Buffer.from(`<data><res regname='LinkVc'></res><LinkVc><ID>`, 'latin1'),
      idBytes,
      Buffer.from(`</ID><VcName>IVVc</VcName></LinkVc></data>`, 'latin1'),
    ])

    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(body)
    })

    const links = await fetchRecordLinks(configFor(serverUrl), 'SVOVc', '230015')

    expect(links).toEqual([{ register: 'IVVc', id: String(value) }])
  })

  it('skips a LinkVc entry with an empty VcName', async () => {
    const xml = linkVcXml(
      '<LinkVc><ID>1</ID><VcName></VcName></LinkVc>' + '<LinkVc><ID>2</ID><VcName>IVVc</VcName></LinkVc>',
    )
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(xml)
    })

    const links = await fetchRecordLinks(configFor(serverUrl), 'SVOVc', '1')

    expect(links).toEqual([{ register: 'IVVc', id: '2' }])
  })

  it('returns an empty array when the record has no links at all (zero LinkVc blocks, still HTTP 200)', async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(linkVcXml(''))
    })

    const links = await fetchRecordLinks(configFor(serverUrl), 'SVOVc', '1')

    expect(links).toEqual([])
  })

  it('skips a LinkVc entry with an empty ID', async () => {
    const xml = linkVcXml(
      '<LinkVc><ID></ID><VcName>IVVc</VcName></LinkVc>' + '<LinkVc><ID>2</ID><VcName>IVVc</VcName></LinkVc>',
    )
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(xml)
    })

    const links = await fetchRecordLinks(configFor(serverUrl), 'SVOVc', '1')

    expect(links).toEqual([{ register: 'IVVc', id: '2' }])
  })

  it('skips a LinkVc entry whose binary ID is not exactly 4 bytes (undecodable)', async () => {
    const body = Buffer.concat([
      Buffer.from(`<data><res regname='LinkVc'></res><LinkVc><ID>`, 'latin1'),
      Buffer.from([0xff, 0x01, 0x02]), // 3 raw binary bytes — not a valid LE-uint32 width
      Buffer.from(
        `</ID><VcName>IVVc</VcName></LinkVc><LinkVc><ID>3</ID><VcName>WSVc</VcName></LinkVc></data>`,
        'latin1',
      ),
    ])

    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(body)
    })

    const links = await fetchRecordLinks(configFor(serverUrl), 'SVOVc', '1')

    expect(links).toEqual([{ register: 'WSVc', id: '3' }])
  })

  it('skips a LinkVc entry whose 4-byte binary ID decodes to zero (undecodable)', async () => {
    const zeroIdBytes = Buffer.from([0x00, 0x00, 0x00, 0x00]) // all-NUL: hasBinary true (control chars), LE value 0
    const body = Buffer.concat([
      Buffer.from(`<data><res regname='LinkVc'></res><LinkVc><ID>`, 'latin1'),
      zeroIdBytes,
      Buffer.from(
        `</ID><VcName>IVVc</VcName></LinkVc><LinkVc><ID>4</ID><VcName>WSVc</VcName></LinkVc></data>`,
        'latin1',
      ),
    ])

    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(body)
    })

    const links = await fetchRecordLinks(configFor(serverUrl), 'SVOVc', '1')

    expect(links).toEqual([{ register: 'WSVc', id: '4' }])
  })

  it('preserves an ID containing only whitelisted control characters (tab/newline/CR) as-is, not as binary', async () => {
    const body = Buffer.concat([
      Buffer.from(`<data><res regname='LinkVc'></res><LinkVc><ID>1\t2\n`, 'latin1'),
      Buffer.from(`</ID><VcName>IVVc</VcName></LinkVc></data>`, 'latin1'),
    ])

    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(body)
    })

    const links = await fetchRecordLinks(configFor(serverUrl), 'SVOVc', '1')

    expect(links).toEqual([{ register: 'IVVc', id: '1\t2' }])
  })

  it('tolerates raw control characters elsewhere in the XML without breaking LinkVc parsing', async () => {
    const body = Buffer.concat([
      Buffer.from(`<data><res regname='LinkVc'></res><LinkVc><ID>7</ID><VcName>IVVc</VcName><Comment>`, 'latin1'),
      Buffer.from([0x01, 0x02, 0x1f]),
      Buffer.from(`</Comment></LinkVc></data>`, 'latin1'),
    ])

    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(body)
    })

    const links = await fetchRecordLinks(configFor(serverUrl), 'SVOVc', '1')

    expect(links).toEqual([{ register: 'IVVc', id: '7' }])
  })

  it('sends the documented query params (action=action&register=getrecordlinks&id&regname&compno) and Basic auth', async () => {
    let capturedUrl: string | undefined
    let capturedAuth: string | undefined
    await startServer((req, res) => {
      capturedUrl = req.url
      capturedAuth = req.headers.authorization
      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end(linkVcXml(''))
    })

    await fetchRecordLinks(configFor(serverUrl), 'SVOVc', '230015')

    expect(capturedUrl).toContain('/WebExcellentAPI.hal?')
    expect(capturedUrl).toContain('action=action')
    expect(capturedUrl).toContain('register=getrecordlinks')
    expect(capturedUrl).toContain('id=230015')
    expect(capturedUrl).toContain('regname=SVOVc')
    expect(capturedUrl).toContain('compno=1')
    expect(capturedAuth).toBe('Basic ' + Buffer.from('test:test').toString('base64'))
  })
})

describe('fetchRecordLinks — error mapping', () => {
  it('throws ErpTransientError on a 500 response', async () => {
    await startServer((_req, res) => {
      res.writeHead(500)
      res.end('boom')
    })

    await expect(fetchRecordLinks(configFor(serverUrl), 'SVOVc', '1')).rejects.toMatchObject({
      name: 'ErpTransientError',
    })
  })

  it('throws ErpPermanentError on a 404 response', async () => {
    await startServer((_req, res) => {
      res.writeHead(404)
      res.end('not found')
    })

    await expect(fetchRecordLinks(configFor(serverUrl), 'SVOVc', '1')).rejects.toMatchObject({
      name: 'ErpPermanentError',
    })
  })

  it('throws ErpPermanentError on a 400 response', async () => {
    await startServer((_req, res) => {
      res.writeHead(400)
      res.end('bad request')
    })

    await expect(fetchRecordLinks(configFor(serverUrl), 'SVOVc', '1')).rejects.toMatchObject({
      name: 'ErpPermanentError',
    })
  })

  it('throws ErpTransientError on a network error (nothing listening)', async () => {
    await expect(fetchRecordLinks(configFor('http://127.0.0.1:1'), 'SVOVc', '1')).rejects.toMatchObject({
      name: 'ErpTransientError',
    })
  })
})
