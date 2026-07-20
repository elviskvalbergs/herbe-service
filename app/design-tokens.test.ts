import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, 'design-tokens.css'), 'utf8')

// Strip CSS comments before asserting on forbidden patterns, so the
// Principle 6 rule can be documented in a comment (as it is, near the top
// of the file) without the grep-style check tripping over its own
// documentation.
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('design-tokens.css', () => {
  it('never sets a circular/pill border-radius outside a comment (Principle 6)', () => {
    expect(cssWithoutComments).not.toMatch(/border-radius:\s*(50%|9999px)/)
  })

  it('documents the Principle 6 rule it is locked against', () => {
    // the rule text itself is expected to live in a comment (excluded above)
    expect(css).toMatch(/border-radius:\s*50%/)
    expect(css).toMatch(/border-radius:\s*9999px/)
  })

  it('defines the herbe.service product accent from an existing categorical token', () => {
    expect(css).toContain('--product-service: var(--cat-amber);')
  })

  it('defines the field density tier reusing existing radii, not new ones', () => {
    expect(css).toMatch(/--ui-field-btn-h:\s*56px/)
    expect(css).toMatch(/--ui-field-btn-h-sm:\s*48px/)
    expect(css).toMatch(/--ui-field-input-h:\s*56px/)
    expect(css).toMatch(/--ui-field-body:\s*17px/)
    expect(css).toMatch(/--ui-field-radius-btn:\s*var\(--radius-lg\);/)
    expect(css).toMatch(/--ui-field-radius-card:\s*var\(--radius-xl\);/)
  })

  it('defines a sunlight scheme distinct from the dark theme attribute', () => {
    expect(css).toContain('[data-scheme="sunlight"]')
    expect(css).toContain('[data-theme="dark"]')
  })

  it('defines all four sync-state tokens mapped onto status tokens', () => {
    expect(css).toMatch(/--sync-local:\s*var\(--status-neutral\)/)
    expect(css).toMatch(/--sync-pending:\s*var\(--status-warning\)/)
    expect(css).toMatch(/--sync-synced:\s*var\(--status-success\)/)
    expect(css).toMatch(/--sync-conflict:\s*var\(--status-danger\)/)
  })

  it('defines all four charge-type badge tokens', () => {
    for (const name of ['invoiceable', 'warranty', 'contract', 'goodwill']) {
      expect(css).toContain(`--charge-${name}:`)
    }
  })

  it('defines all three work-entry-mode tokens', () => {
    for (const name of ['booking', 'prepared-ahead', 'walk-up']) {
      expect(css).toContain(`--work-entry-${name}:`)
    }
  })

  it('defines all four revision-state badge tokens', () => {
    for (const name of ['signed', 'superseded', 'resign-requested', 'proceed-audited']) {
      expect(css).toContain(`--revision-${name}:`)
    }
  })

  it('defines print tokens under an @media print block', () => {
    const printBlockMatch = css.match(/@media print\s*{[\s\S]*}/)
    expect(printBlockMatch).not.toBeNull()
    const printBlock = printBlockMatch![0]
    expect(printBlock).toContain('--print-page-margin')
    expect(printBlock).toContain('--print-table-border')
    expect(printBlock).toMatch(/--print-severity-success:\s*var\(--status-success\)/)
    expect(printBlock).toMatch(/--print-severity-warning:\s*var\(--status-warning\)/)
    expect(printBlock).toMatch(/--print-severity-danger:\s*var\(--status-danger\)/)
    expect(printBlock).toMatch(/--print-severity-info:\s*var\(--status-info\)/)
  })

  it('self-hosts every Poppins weight/style referenced by the wordmark and body font', () => {
    for (const weight of [300, 400, 500, 600, 700, 800, 900]) {
      expect(css).toMatch(new RegExp(`font-weight:\\s*${weight};`))
    }
    expect(css).toContain("src: url('/fonts/Poppins-Regular.ttf') format('truetype');")
  })
})
