// lib/documents/docx/engine.ts
//
// WS12 DOCX merge engine (plan decision 2): docxtemplater ^3 (MIT core) +
// pizzip, wrapped completely — neither dependency appears in any exported
// type, and callers never see a docxtemplater error. Context is any JSON
// object (OrderReportContext is just the first producer).
//
// Template language (docs/12-documents-templates.md §Template anatomy):
//   {customer.name}                  dot-paths into the context
//   {order.requestedAt | date}       formatter pipes (date, datetime,
//                                    number, currency, upper, lower),
//                                    localized via Intl with `locale`
//   {#rows}…{/rows}                  loops over arrays (docxtemplater
//                                    sections); booleans/empty arrays hide
//                                    the section, {^tag} inverts
//   {%logo}                          inline image from the images map
//                                    (LogoImageModule, in-house)
// Missing leaf values render as '' (nullGetter); hard template errors throw
// DocxRenderError carrying structured issues.
import Docxtemplater from 'docxtemplater'
import PizZip from 'pizzip'
import { DEFAULT_LOCALE, UnknownFormatterError } from './formatters'
import { KNOWN_IMAGE_NAMES, LOGO_IMAGE_MODULE, LogoImageModule } from './image-module'
import { createParser, parseTag, resolveThroughScopes } from './parser'

// ——— public types ————————————————————————————————————————————————————————

export type ValidationIssueType =
  | 'syntax'
  | 'unknown-field'
  | 'unknown-formatter'
  | 'unknown-image'
  | 'render'

export interface ValidationIssue {
  type: ValidationIssueType
  /** The offending tag as written in the template ('' when not tag-scoped). */
  tag: string
  message: string
}

/** Hard render/compile failure; `issues` carries the structured report. */
export class DocxRenderError extends Error {
  constructor(
    message: string,
    readonly issues: ValidationIssue[],
  ) {
    super(message)
    this.name = 'DocxRenderError'
  }
}

export interface RenderDocxImages {
  logo?: Buffer
}

export interface RenderDocxInput {
  template: Buffer
  /** Merge context — any JSON-serializable object. */
  context: object
  /** BCP-47 locale driving Intl formatters; default 'en'. */
  locale?: string
  images?: RenderDocxImages
}

export interface RenderDocxResult {
  docx: Buffer
}

export interface ValidateTemplateInput {
  template: Buffer
  /** A representative context; dot-paths are checked against its shape. */
  sampleContext: object
}

export interface ValidateTemplateResult {
  ok: boolean
  errors: ValidationIssue[]
}

// ——— docxtemplater error mapping —————————————————————————————————————————

const SCOPE_PARSER_ERROR_IDS = new Set([
  'scopeparser_compilation_failed',
  'scopeparser_execution_failed',
])

interface DocxtemplaterErrorLike {
  message?: string
  properties?: {
    id?: string
    errors?: unknown[]
    explanation?: string
    xtag?: string
    context?: string
    rootError?: unknown
  }
}

function issueFromSingleError(error: unknown): ValidationIssue {
  const { message, properties } = (error ?? {}) as DocxtemplaterErrorLike
  const tag = properties?.xtag ?? properties?.context ?? ''
  const explanation = properties?.explanation ?? message ?? 'template error'
  if (properties?.id && SCOPE_PARSER_ERROR_IDS.has(properties.id)) {
    if (properties.rootError instanceof UnknownFormatterError) {
      return {
        type: 'unknown-formatter',
        tag: properties.rootError.tag,
        message: properties.rootError.message,
      }
    }
    return { type: 'render', tag, message: explanation }
  }
  // Everything else docxtemplater throws at compile/render is a template
  // problem: unclosed/unopened/duplicate tags, unbalanced loops, raw-tag
  // placement, corrupt characters …
  if (properties?.id) return { type: 'syntax', tag, message: explanation }
  /* v8 ignore next 3 — defensive: every error docxtemplater collects carries
     a properties.id; kept for errors thrown by future custom modules */
  return { type: 'render', tag, message: explanation }
}

function issuesFromError(error: unknown): ValidationIssue[] {
  const { properties } = (error ?? {}) as DocxtemplaterErrorLike
  /* v8 ignore next 6 — defensive: docxtemplater's verifyErrors always wraps
     compile/render failures in a multi_error; the single-error fallback only
     fires on internal misuse errors we do not know how to trigger */
  const errors =
    properties?.id === 'multi_error' && Array.isArray(properties.errors)
      ? properties.errors
      : [error]
  return errors.map(issueFromSingleError)
}

// ——— internal: compile ———————————————————————————————————————————————————

/**
 * Records the final per-file postparsed part tree for validateTemplate.
 * docxtemplater broadcasts it to every module via set({inspect: …}) — the
 * same channel its own InspectModule uses (which we cannot ship: it
 * requires lodash, a dependency this repo does not carry).
 */
interface CollectedPart {
  type: string
  value: string
  module?: string
  subparsed?: CollectedPart[]
}

class TagCollectorModule {
  name = 'HerbeTagCollectorModule'
  readonly postparsedByFile: Record<string, CollectedPart[]> = {}
  private currentFile = ''

  set(options: { inspect?: { filePath?: string; postparsed?: CollectedPart[] } }): void {
    if (options.inspect?.filePath) this.currentFile = options.inspect.filePath
    if (options.inspect?.postparsed) {
      this.postparsedByFile[this.currentFile] = options.inspect.postparsed
    }
  }
}

type DocxtemplaterModule = Docxtemplater<PizZip>['modules'][number]

function compileDoc(
  template: Buffer,
  locale: string,
  images: Record<string, Buffer>,
  extraModules: object[] = [],
): Docxtemplater<PizZip> {
  let zip: PizZip
  try {
    zip = new PizZip(template)
  } catch (error) {
    throw new DocxRenderError('template is not a valid DOCX (zip) file', [
      {
        type: 'syntax',
        tag: '',
        message: error instanceof Error ? error.message : String(error),
      },
    ])
  }
  try {
    // The v4 constructor compiles immediately — malformed tags throw here.
    return new Docxtemplater(zip, {
      modules: [new LogoImageModule(images), ...extraModules] as DocxtemplaterModule[],
      parser: createParser(locale),
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '',
      // We report template problems as typed ValidationIssues; keep
      // docxtemplater from also dumping them to the console.
      errorLogging: false,
    })
  } catch (error) {
    throw new DocxRenderError('template compilation failed', issuesFromError(error))
  }
}

// ——— renderDocx ——————————————————————————————————————————————————————————

export function renderDocx({
  template,
  context,
  locale = DEFAULT_LOCALE,
  images = {},
}: RenderDocxInput): RenderDocxResult {
  const imageBuffers: Record<string, Buffer> = {}
  for (const [name, buffer] of Object.entries(images)) {
    if (buffer) imageBuffers[name] = buffer
  }
  const doc = compileDoc(template, locale, imageBuffers)
  try {
    doc.render(context)
  } catch (error) {
    throw new DocxRenderError('template render failed', issuesFromError(error))
  }
  return { docx: doc.toBuffer() }
}

// ——— validateTemplate ————————————————————————————————————————————————————

// The walk only checks dot-paths and image names. Formatter pipes need no
// walking: docxtemplater compiles the parser for EVERY placeholder — nested
// loop bodies included — at construction time (Render#postparse), so an
// unknown formatter anywhere in the template already surfaced as a compile
// error before validateTemplate reaches the part tree.
function walkParts(parts: CollectedPart[], scopes: unknown[], issues: ValidationIssue[]): void {
  for (const part of parts) {
    if (part.type !== 'placeholder') continue

    if (part.module === 'loop') {
      const { path } = parseTag(part.value)
      const resolved = resolveThroughScopes(scopes, path)
      if (resolved === undefined) {
        issues.push({
          type: 'unknown-field',
          tag: part.value,
          message: `loop tag "${part.value}" does not resolve in the sample context`,
        })
        // Without a sample value there is no item shape to validate the
        // body against — skip it rather than cascade unknown-field noise.
        continue
      }
      let childScopes = scopes
      if (Array.isArray(resolved)) {
        // Loop bodies validate against the first element of the sample
        // array; an empty sample array leaves the body unvalidatable.
        if (resolved.length === 0) continue
        childScopes = [...scopes, resolved[0]]
      } else if (resolved !== null && typeof resolved === 'object') {
        childScopes = [...scopes, resolved]
      }
      // Boolean/primitive conditions keep the current scope (native
      // docxtemplater section semantics).
      if (part.subparsed) walkParts(part.subparsed, childScopes, issues)
      continue
    }

    if (part.module === LOGO_IMAGE_MODULE) {
      if (!KNOWN_IMAGE_NAMES.includes(part.value)) {
        issues.push({
          type: 'unknown-image',
          tag: part.value,
          message: `unknown image "${part.value}" (available: ${KNOWN_IMAGE_NAMES.join(', ')})`,
        })
      }
      continue
    }

    if (part.module) continue // other modules' parts — nothing to check

    const { path } = parseTag(part.value)
    if (path !== '.' && resolveThroughScopes(scopes, path) === undefined) {
      issues.push({
        type: 'unknown-field',
        tag: part.value,
        message: `placeholder "${part.value}" does not resolve in the sample context`,
      })
    }
  }
}

export function validateTemplate({
  template,
  sampleContext,
}: ValidateTemplateInput): ValidateTemplateResult {
  const collector = new TagCollectorModule()
  try {
    compileDoc(template, DEFAULT_LOCALE, {}, [collector])
  } catch (error) {
    /* v8 ignore next — defensive: compileDoc only ever throws DocxRenderError */
    if (!(error instanceof DocxRenderError)) throw error
    return { ok: false, errors: error.issues }
  }
  const issues: ValidationIssue[] = []
  for (const parts of Object.values(collector.postparsedByFile)) {
    walkParts(parts, [sampleContext], issues)
  }
  return { ok: issues.length === 0, errors: issues }
}
