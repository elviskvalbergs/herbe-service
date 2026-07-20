// lib/documents/docx/engine.test.ts
//
// WS12 Task 4 — DOCX merge engine. Templates are built programmatically via
// buildDocxFixture, rendered, then the result is re-opened with pizzip and
// assertions run on word/document.xml. All localized expectations are
// generated through Intl with the SAME options the engine uses — never
// hand-typed literals (lv currency output contains non-breaking spaces).
import PizZip from 'pizzip'
import { describe, expect, it } from 'vitest'
import {
  DocxRenderError,
  renderDocx,
  validateTemplate,
  type ValidationIssue,
} from './engine'
import { buildDocxFixture } from './fixture'
import { parseImageDimensions, UnsupportedImageError } from './image-size'

// ——— helpers ————————————————————————————————————————————————————————————

function unzip(docx: Buffer): PizZip {
  return new PizZip(docx)
}

function documentXml(docx: Buffer): string {
  return unzip(docx).file('word/document.xml')!.asText()
}

function unescapeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

/** All <w:t> text content, in document order. */
function documentText(docx: Buffer): string {
  return [...documentXml(docx).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
    .map((m) => unescapeXml(m[1]))
    .join('')
}

/** Minimal well-formedness check: every open tag closes, in order. */
function assertWellFormedXml(xml: string): void {
  const body = xml.replace(/^<\?xml[^>]*\?>/, '')
  const stack: string[] = []
  const tagRe = /<(\/)?([A-Za-z0-9:_.-]+)(?:"[^"]*"|'[^']*'|[^"'>])*?(\/)?>/g
  for (const match of body.matchAll(tagRe)) {
    const [, closing, name, selfClosing] = match
    if (closing) {
      expect(stack.pop(), `closing </${name}>`).toBe(name)
    } else if (!selfClosing) {
      stack.push(name)
    }
  }
  expect(stack).toEqual([])
}

function renderText(paragraphs: string[], context: object, locale?: string): string {
  const { docx } = renderDocx({ template: buildDocxFixture(paragraphs), context, locale })
  return documentText(docx)
}

function issueTypes(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => issue.type)
}

/** A real 1x1 transparent PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** PNG signature + IHDR header with the given dimensions (header-only). */
function fakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

/** JPEG SOI + APP0 + SOF0 header with the given dimensions (header-only). */
function fakeJpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof0 = Buffer.alloc(2 + 2 + 5)
  sof0[0] = 0xff
  sof0[1] = 0xc0
  sof0.writeUInt16BE(7, 2) // segment length (excl. marker)
  sof0[4] = 8 // precision
  sof0.writeUInt16BE(height, 5)
  sof0.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0])
}

// ——— placeholders & dot-paths ————————————————————————————————————————————

describe('renderDocx placeholders', () => {
  it('merges a simple placeholder and a dot-path', () => {
    const text = renderText(
      ['Order {order.number} for {customer.name}'],
      { order: { number: 'SR-2026-00001' }, customer: { name: 'Burti SIA' } },
    )
    expect(text).toBe('Order SR-2026-00001 for Burti SIA')
  })

  it('renders a missing leaf as empty string (nullGetter)', () => {
    const text = renderText(
      ['A{customer.vatNumber}B{missing.deep.path}C'],
      { customer: { name: 'x' } },
    )
    expect(text).toBe('ABC')
  })

  it('output is a valid zip whose document.xml is well-formed XML', () => {
    const { docx } = renderDocx({
      template: buildDocxFixture(['Hello {name}', '{#rows}{n}{/rows}']),
      context: { name: 'x', rows: [{ n: '1' }, { n: '2' }] },
    })
    assertWellFormedXml(documentXml(docx))
  })
})

// ——— formatter pipes —————————————————————————————————————————————————————

describe('renderDocx formatter pipes', () => {
  const requestedAt = '2026-03-07T10:30:00.000Z'

  it('formats | date per locale (lv vs en differ)', () => {
    const expectFor = (locale: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(requestedAt),
      )
    const en = renderText(['{order.requestedAt | date}'], { order: { requestedAt } }, 'en')
    const lv = renderText(['{order.requestedAt | date}'], { order: { requestedAt } }, 'lv')
    expect(en).toBe(expectFor('en'))
    expect(lv).toBe(expectFor('lv'))
    expect(en).not.toBe(lv)
  })

  it('formats | datetime with a time component', () => {
    const expected = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(requestedAt))
    expect(renderText(['{order.requestedAt | datetime}'], { order: { requestedAt } }, 'en')).toBe(
      expected,
    )
  })

  it('formats | number per locale (decimal comma in lv, point in en)', () => {
    const value = 1234.5
    const en = renderText(['{totals.timeTotalMinutes | number}'], { totals: { timeTotalMinutes: value } }, 'en')
    const lv = renderText(['{totals.timeTotalMinutes | number}'], { totals: { timeTotalMinutes: value } }, 'lv')
    expect(en).toBe(new Intl.NumberFormat('en').format(value))
    expect(lv).toBe(new Intl.NumberFormat('lv').format(value))
    expect(en).not.toBe(lv)
    expect(en).toContain('.')
    expect(lv).toContain(',')
  })

  it('formats | currency as EUR per locale (NBSP-safe: expectation built via Intl)', () => {
    const value = 1234.5
    const en = renderText(['{rows.sum | currency}'], { rows: { sum: value } }, 'en')
    const lv = renderText(['{rows.sum | currency}'], { rows: { sum: value } }, 'lv')
    expect(en).toBe(new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }).format(value))
    expect(lv).toBe(new Intl.NumberFormat('lv', { style: 'currency', currency: 'EUR' }).format(value))
    expect(en).not.toBe(lv)
  })

  it('applies | upper and | lower', () => {
    expect(renderText(['{name | upper} {name | lower}'], { name: 'Vija' })).toBe('VIJA vija')
  })

  it('missing value piped through a formatter still renders empty', () => {
    expect(renderText(['A{order.missing | date}B'], { order: {} })).toBe('AB')
  })

  it('| number accepts numeric strings (drizzle numeric columns)', () => {
    expect(renderText(['{qty | number}'], { qty: '12.5' }, 'en')).toBe(
      new Intl.NumberFormat('en').format(12.5),
    )
  })

  it('| date accepts Date instances, not only ISO strings', () => {
    const date = new Date('2026-07-01T00:00:00.000Z')
    expect(renderText(['{at | date}'], { at: date }, 'en')).toBe(
      new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(date),
    )
  })

  it('reports unformattable input as a render issue', () => {
    const contexts = [
      { at: 'not a date', qty: 'not a number' },
      { at: { nested: true }, qty: true }, // non-string/number inputs
    ]
    for (const context of contexts) {
      for (const paragraphs of [['{at | date}'], ['{qty | number}']]) {
        let caught: unknown
        try {
          renderDocx({ template: buildDocxFixture(paragraphs), context })
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(DocxRenderError)
        expect(issueTypes((caught as DocxRenderError).issues)).toContain('render')
      }
    }
  })

  it('throws a typed DocxRenderError for an unknown formatter', () => {
    let caught: unknown
    try {
      renderDocx({ template: buildDocxFixture(['{name | nope}']), context: { name: 'x' } })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DocxRenderError)
    const issues = (caught as DocxRenderError).issues
    expect(issueTypes(issues)).toContain('unknown-formatter')
    expect(issues.find((i) => i.type === 'unknown-formatter')?.tag).toBe('name | nope')
  })
})

// ——— loops & conditionals ————————————————————————————————————————————————

describe('renderDocx loops and conditionals', () => {
  it('repeats a section once per array element', () => {
    const text = renderText(
      ['{#rows}{description};{/rows}'],
      { rows: [{ description: 'a' }, { description: 'b' }, { description: 'c' }] },
    )
    expect(text).toBe('a;b;c;')
  })

  it('renders nothing for an empty array', () => {
    expect(renderText(['X{#rows}{description}{/rows}Y'], { rows: [] })).toBe('XY')
  })

  it('hides a section on false and shows it on true (boolean condition)', () => {
    const paragraphs = ['{#warranty}covered by warranty{/warranty}done']
    expect(renderText(paragraphs, { warranty: false })).toBe('done')
    expect(renderText(paragraphs, { warranty: true })).toBe('covered by warrantydone')
  })

  it('resolves nested loop paths ({#worksheetSections}{#rows}…)', () => {
    const text = renderText(
      ['{#worksheetSections}{#rows}{description},{/rows}|{/worksheetSections}'],
      {
        worksheetSections: [
          { rows: [{ description: 'r1' }, { description: 'r2' }] },
          { rows: [{ description: 'r3' }] },
        ],
      },
    )
    expect(text).toBe('r1,r2,|r3,|')
  })

  it('renders {.} as the current scope for primitive arrays', () => {
    expect(renderText(['{#tags}{.};{/tags}'], { tags: ['a', 'b'] })).toBe('a;b;')
  })

  it('scopes into an object section', () => {
    expect(renderText(['{#customer}{name}{/customer}'], { customer: { name: 'Burti' } })).toBe(
      'Burti',
    )
  })

  it('falls back to the parent scope inside a loop', () => {
    const text = renderText(
      ['{#rows}{description}-{order.number} {/rows}'],
      { order: { number: 'SR-1' }, rows: [{ description: 'a' }, { description: 'b' }] },
    )
    expect(text).toBe('a-SR-1 b-SR-1 ')
  })
})

// ——— images ({%logo}) ————————————————————————————————————————————————————

describe('renderDocx logo images', () => {
  const template = buildDocxFixture(['Logo: {%logo}', 'End'])

  it('inlines a PNG: media file, relationship, content type and <w:drawing>', () => {
    const { docx } = renderDocx({ template, context: {}, images: { logo: PNG_1X1 } })
    const zip = unzip(docx)

    const media = zip.file(/word\/media\/.*\.png$/)
    expect(media).toHaveLength(1)
    expect(Buffer.from(media[0].asUint8Array()).equals(PNG_1X1)).toBe(true)

    const rels = zip.file('word/_rels/document.xml.rels')!.asText()
    expect(rels).toContain('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image')
    expect(rels).toContain('Target="media/')

    const contentTypes = zip.file('[Content_Types].xml')!.asText()
    expect(contentTypes).toContain('image/png')

    const xml = documentXml(docx)
    expect(xml).toContain('<w:drawing>')
    expect(xml).toContain('r:embed=')
    assertWellFormedXml(xml)
  })

  it('caps display width at ~40mm and keeps the aspect ratio', () => {
    // 300x100 px @96dpi = 2857500 EMU wide -> capped to 1440000 (40mm),
    // height scales to 1440000 * 100/300 = 480000.
    const { docx } = renderDocx({ template, context: {}, images: { logo: fakePng(300, 100) } })
    expect(documentXml(docx)).toContain('<wp:extent cx="1440000" cy="480000"/>')
  })

  it('uses the natural size when narrower than the cap', () => {
    // 100x50 px -> 952500 x 476250 EMU, below the 40mm cap.
    const { docx } = renderDocx({ template, context: {}, images: { logo: fakePng(100, 50) } })
    expect(documentXml(docx)).toContain('<wp:extent cx="952500" cy="476250"/>')
  })

  it('supports JPEG with an image/jpeg content type', () => {
    const { docx } = renderDocx({ template, context: {}, images: { logo: fakeJpeg(60, 40) } })
    const zip = unzip(docx)
    expect(zip.file(/word\/media\/.*\.jpeg$/)).toHaveLength(1)
    expect(zip.file('[Content_Types].xml')!.asText()).toContain('image/jpeg')
    expect(documentXml(docx)).toContain('<w:drawing>')
  })

  it('renders the same image twice with distinct media files and relationship ids', () => {
    const twoLogos = buildDocxFixture(['{%logo}', 'mid', '{%logo}'])
    const { docx } = renderDocx({ template: twoLogos, context: {}, images: { logo: PNG_1X1 } })
    const zip = unzip(docx)
    expect(zip.file(/word\/media\/.*\.png$/)).toHaveLength(2)
    const rels = zip.file('word/_rels/document.xml.rels')!.asText()
    expect(rels).toContain('Id="rId1"')
    expect(rels).toContain('Id="rId2"')
    // content-type default for png registered once, not duplicated
    expect(zip.file('[Content_Types].xml')!.asText().match(/Extension="png"/g)).toHaveLength(1)
  })

  it('drops the image cleanly when the template has no rels part for document.xml', () => {
    const zip = new PizZip(buildDocxFixture(['{%logo}end']))
    zip.remove('word/_rels/document.xml.rels')
    const stripped = zip.generate({ type: 'nodebuffer' })
    const { docx } = renderDocx({ template: stripped, context: {}, images: { logo: PNG_1X1 } })
    expect(documentXml(docx)).not.toContain('<w:drawing>')
    expect(unzip(docx).file(/word\/media\//)).toHaveLength(0)
    expect(documentText(docx)).toBe('end')
  })

  it('assigns rId1 when existing relationship ids do not follow the rIdN scheme', () => {
    const zip = new PizZip(buildDocxFixture(['{%logo}']))
    zip.file(
      'word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="weird-id" Type="http://example.com/x" Target="x.xml"/>' +
        '<Relationship Type="http://example.com/y" Target="y.xml"/>' + // no Id at all
        '</Relationships>',
    )
    const patched = zip.generate({ type: 'nodebuffer' })
    const { docx } = renderDocx({ template: patched, context: {}, images: { logo: PNG_1X1 } })
    const rels = unzip(docx).file('word/_rels/document.xml.rels')!.asText()
    expect(rels).toContain('Id="weird-id"')
    expect(rels).toContain('Id="rId1"')
    expect(documentXml(docx)).toContain('r:embed="rId1"')
  })

  it('renders nothing and adds no media when the image is absent', () => {
    const { docx } = renderDocx({ template, context: {} })
    const zip = unzip(docx)
    expect(zip.file(/word\/media\//)).toHaveLength(0)
    const xml = documentXml(docx)
    expect(xml).not.toContain('<w:drawing>')
    expect(zip.file('word/_rels/document.xml.rels')!.asText()).not.toContain('relationships/image')
    expect(documentText(docx)).toBe('Logo: End')
    assertWellFormedXml(xml)
  })
})

// ——— validateTemplate ————————————————————————————————————————————————————

describe('validateTemplate', () => {
  const sampleContext = {
    customer: { name: 'Burti SIA' },
    order: { number: 'SR-1', requestedAt: '2026-03-07T00:00:00.000Z' },
    totals: { timeTotalMinutes: 90 },
    worksheetSections: [{ rows: [{ description: 'work', sum: 10 }] }],
    warranty: true,
  }

  it('accepts a clean template', () => {
    const template = buildDocxFixture([
      '{customer.name} / {order.requestedAt | date}',
      '{#worksheetSections}{#rows}{description} {sum | currency}{/rows}{/worksheetSections}',
      '{#warranty}warranty{/warranty}',
      '{%logo}',
      '{totals.timeTotalMinutes | number}',
    ])
    expect(validateTemplate({ template, sampleContext })).toEqual({ ok: true, errors: [] })
  })

  it('reports a placeholder that does not resolve in the sample context', () => {
    const result = validateTemplate({
      template: buildDocxFixture(['{customer.nope}']),
      sampleContext,
    })
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      expect.objectContaining({ type: 'unknown-field', tag: 'customer.nope' }),
    ])
  })

  it('validates loop bodies against the first array element', () => {
    const result = validateTemplate({
      template: buildDocxFixture(['{#worksheetSections}{#rows}{nope}{/rows}{/worksheetSections}']),
      sampleContext,
    })
    expect(result.errors).toEqual([expect.objectContaining({ type: 'unknown-field', tag: 'nope' })])
  })

  it('reports an unknown loop collection once and skips its body', () => {
    const result = validateTemplate({
      template: buildDocxFixture(['{#bogus}{whatever}{/bogus}']),
      sampleContext,
    })
    expect(result.errors).toEqual([expect.objectContaining({ type: 'unknown-field', tag: 'bogus' })])
  })

  it('reports an unknown formatter', () => {
    const result = validateTemplate({
      template: buildDocxFixture(['{customer.name | shout}']),
      sampleContext,
    })
    expect(result.ok).toBe(false)
    expect(issueTypes(result.errors)).toContain('unknown-formatter')
  })

  it('reports an unknown formatter inside a loop body', () => {
    const result = validateTemplate({
      template: buildDocxFixture(['{#worksheetSections}{#rows}{sum | shout}{/rows}{/worksheetSections}']),
      sampleContext,
    })
    expect(issueTypes(result.errors)).toContain('unknown-formatter')
  })

  it('reports an unknown formatter on a nested loop tag itself', () => {
    // {/} is docxtemplater's generic closing tag — it matches the piped
    // opening tag, so this fails on the formatter, not on pairing.
    const result = validateTemplate({
      template: buildDocxFixture(['{#worksheetSections}{#rows | shout}{description}{/}{/worksheetSections}']),
      sampleContext,
    })
    expect(issueTypes(result.errors)).toContain('unknown-formatter')
  })

  it('validates object sections by scoping into the object', () => {
    const result = validateTemplate({
      template: buildDocxFixture(['{#customer}{name}{/customer}']),
      sampleContext,
    })
    expect(result).toEqual({ ok: true, errors: [] })
  })

  it('reports an unclosed loop tag as a syntax issue', () => {
    const result = validateTemplate({
      template: buildDocxFixture(['{#worksheetSections}{customer.name}']),
      sampleContext,
    })
    expect(result.ok).toBe(false)
    expect(issueTypes(result.errors)).toContain('syntax')
  })

  it('reports a malformed (unclosed) placeholder as a syntax issue', () => {
    const result = validateTemplate({
      template: buildDocxFixture(['Hello {customer.name']),
      sampleContext,
    })
    expect(result.ok).toBe(false)
    expect(issueTypes(result.errors)).toContain('syntax')
  })

  it('reports an unknown image name', () => {
    const result = validateTemplate({
      template: buildDocxFixture(['{%stamp}']),
      sampleContext,
    })
    expect(result.errors).toEqual([
      expect.objectContaining({ type: 'unknown-image', tag: 'stamp' }),
    ])
  })
})

// ——— hard failures ———————————————————————————————————————————————————————

describe('renderDocx hard failures', () => {
  it('throws DocxRenderError with a syntax issue for an unclosed tag', () => {
    let caught: unknown
    try {
      renderDocx({ template: buildDocxFixture(['{#rows}no closing']), context: { rows: [] } })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DocxRenderError)
    expect(issueTypes((caught as DocxRenderError).issues)).toContain('syntax')
  })

  it('throws DocxRenderError when the template is not a zip at all', () => {
    let caught: unknown
    try {
      renderDocx({ template: Buffer.from('definitely not a docx'), context: {} })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DocxRenderError)
    expect(issueTypes((caught as DocxRenderError).issues)).toContain('syntax')
  })
})

// ——— image header parsing —————————————————————————————————————————————————

describe('parseImageDimensions', () => {
  it('reads PNG IHDR dimensions', () => {
    expect(parseImageDimensions(PNG_1X1)).toEqual({ width: 1, height: 1, type: 'png' })
    expect(parseImageDimensions(fakePng(300, 100))).toEqual({ width: 300, height: 100, type: 'png' })
  })

  it('reads JPEG SOF0 dimensions', () => {
    expect(parseImageDimensions(fakeJpeg(640, 480))).toEqual({ width: 640, height: 480, type: 'jpeg' })
  })

  it('skips JPEG fill bytes before markers', () => {
    const padded = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]), // SOI + one fill byte
      fakeJpeg(20, 10).subarray(2), // APP0 + SOF0
    ])
    expect(parseImageDimensions(padded)).toEqual({ width: 20, height: 10, type: 'jpeg' })
  })

  it('rejects a JPEG without a SOF marker and one that loses marker sync', () => {
    const noSof = fakeJpeg(1, 1).subarray(0, 20) // SOI + APP0 only
    expect(() => parseImageDimensions(noSof)).toThrow(UnsupportedImageError)
    const desynced = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(16, 0x00)])
    expect(() => parseImageDimensions(desynced)).toThrow(UnsupportedImageError)
  })

  it('rejects unsupported formats', () => {
    expect(() => parseImageDimensions(Buffer.from('GIF89a whatever'))).toThrow(UnsupportedImageError)
    expect(() => parseImageDimensions(Buffer.alloc(2))).toThrow(UnsupportedImageError)
    // PNG signature but a corrupt IHDR label
    const badPng = fakePng(1, 1)
    badPng.write('XXXX', 12, 'ascii')
    expect(() => parseImageDimensions(badPng)).toThrow(UnsupportedImageError)
  })
})
