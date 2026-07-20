// tests/gotenberg/gotenberg-live.test.ts
//
// Gated live smoke against a REAL Gotenberg container: proves both convert
// routes (Chromium HTML→PDF, LibreOffice DOCX→PDF) produce actual PDFs.
// Gated exactly like tests/live: excluded from default runs in
// vitest.config.ts unless RUN_GOTENBERG_TESTS is set, plus the
// describe.skipIf below. Run it with `pnpm test:gotenberg` against a local
// container:
//
//   docker run -d --rm -p 3000:3000 gotenberg/gotenberg:8
//   GOTENBERG_URL=http://127.0.0.1:3000 pnpm test:gotenberg
import { describe, expect, it } from 'vitest'
import { convertDocxToPdf, convertHtmlToPdf, getGotenbergConfig } from '@/lib/documents/convert/gotenberg'
import { buildDocxFixture } from '@/lib/documents/docx/fixture'

describe.skipIf(!process.env.RUN_GOTENBERG_TESTS)('gotenberg live smoke', () => {
  function config() {
    const config = getGotenbergConfig()
    if (!config) {
      throw new Error('RUN_GOTENBERG_TESTS is set but GOTENBERG_URL is not — point it at a running Gotenberg')
    }
    return config
  }

  it('converts HTML to a real PDF via the Chromium route', async () => {
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>smoke</title>' +
      '<style>h1{color:#1f2937}</style></head>' +
      '<body><h1>herbe gotenberg smoke</h1><p>HTML→PDF via /forms/chromium/convert/html.</p></body></html>'

    const pdf = await convertHtmlToPdf({ html, config: config() })

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1000)
  }, 60_000)

  it('converts DOCX to a real PDF via the LibreOffice route', async () => {
    const docx = buildDocxFixture([
      'herbe gotenberg smoke',
      'DOCX→PDF via /forms/libreoffice/convert.',
    ])

    const pdf = await convertDocxToPdf({ docx, config: config() })

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1000)
  }, 120_000) // LibreOffice cold start can be slow on first conversion
})
