// lib/documents/docx/parser.ts
//
// The custom docxtemplater `parser` option: resolves dot-paths
// ({customer.name}) into the merge context and applies formatter pipes
// ({order.requestedAt | date}). Kept docxtemplater-agnostic where possible —
// parseTag / resolvePath / resolveThroughScopes are reused by
// validateTemplate's own tag walker.
import {
  applyFormatter,
  DEFAULT_LOCALE,
  isKnownFormatter,
  UnknownFormatterError,
} from './formatters'

export interface ParsedTag {
  /** Dot-path before the first pipe ('.' = current scope). */
  path: string
  /** Formatter names after the path, in application order. */
  formatters: string[]
}

/** Split "order.requestedAt | date | upper" into path + formatter chain. */
export function parseTag(raw: string): ParsedTag {
  const [path = '', ...formatters] = raw.split('|').map((segment) => segment.trim())
  return { path, formatters }
}

/** Resolve a dot-path in one scope object; undefined when any hop is missing. */
export function resolvePath(scope: unknown, path: string): unknown {
  if (path === '.') return scope
  let current = scope
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Resolve through a scope chain, innermost first — mirrors docxtemplater's
 * parent-scope fallback so validateTemplate judges paths the same way the
 * renderer would.
 */
export function resolveThroughScopes(scopes: unknown[], path: string): unknown {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const value = resolvePath(scopes[i], path)
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Build the docxtemplater `parser` option for one render.
 *
 * docxtemplater calls this factory once per placeholder at compile time
 * (Render#postparse — nested loop bodies included), so an unknown formatter
 * anywhere in the template fails compilation before any data is merged.
 */
export function createParser(locale: string = DEFAULT_LOCALE) {
  return (tag: string) => {
    const { path, formatters } = parseTag(tag)
    for (const name of formatters) {
      if (!isKnownFormatter(name)) throw new UnknownFormatterError(name, tag)
    }
    return {
      get(scope: unknown): unknown {
        let value = resolvePath(scope, path)
        // Missing/null leaf: return undefined so docxtemplater falls back to
        // the parent scope and finally to nullGetter ('') — formatters never
        // see nullish input.
        if (value == null) return undefined
        for (const name of formatters) value = applyFormatter(value, name, locale, tag)
        return value
      },
    }
  }
}
