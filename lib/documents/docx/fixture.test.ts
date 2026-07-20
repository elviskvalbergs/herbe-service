// lib/documents/docx/fixture.test.ts
//
// buildDocxFixture is test support for the whole WS12 suite (engine tests
// here, admin test-render tests later), so it gets its own contract tests:
// the produced buffer must be a real, minimal DOCX that pizzip can reopen
// and that the merge engine accepts as a template.
import PizZip from 'pizzip'
import { describe, expect, it } from 'vitest'
import { renderDocx } from './engine'
import { buildDocxFixture } from './fixture'

function extractText(documentXml: string): string {
  return [...documentXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
    .map((m) =>
      m[1]
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&amp;', '&'),
    )
    .join('')
}

describe('buildDocxFixture', () => {
  it('returns a Buffer containing the four minimal DOCX entries', () => {
    const docx = buildDocxFixture(['Hello'])
    expect(Buffer.isBuffer(docx)).toBe(true)
    const zip = new PizZip(docx)
    for (const name of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/_rels/document.xml.rels',
      'word/document.xml',
    ]) {
      expect(zip.file(name), name).not.toBeNull()
    }
  })

  it('renders one <w:p> per paragraph string, in order', () => {
    const zip = new PizZip(buildDocxFixture(['first', 'second', 'third']))
    const xml = zip.file('word/document.xml')!.asText()
    expect(xml.match(/<w:p>/g)).toHaveLength(3)
    expect(xml.indexOf('first')).toBeLessThan(xml.indexOf('second'))
    expect(xml.indexOf('second')).toBeLessThan(xml.indexOf('third'))
  })

  it('escapes XML special characters but leaves template tags intact', () => {
    const zip = new PizZip(buildDocxFixture(['a < b & c > d', '{customer.name}']))
    const xml = zip.file('word/document.xml')!.asText()
    expect(xml).toContain('a &lt; b &amp; c &gt; d')
    expect(xml).toContain('{customer.name}')
    expect(extractText(xml)).toContain('a < b & c > d')
  })

  it('is accepted by renderDocx as a template', () => {
    const template = buildDocxFixture(['Hello {name}!'])
    const { docx } = renderDocx({ template, context: { name: 'Vija' } })
    const xml = new PizZip(docx).file('word/document.xml')!.asText()
    expect(extractText(xml)).toContain('Hello Vija!')
  })
})
