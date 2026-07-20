// lib/documents/docx/image-module.ts
//
// Minimal docxtemplater module for {%logo}-style inline images, written
// in-house (plan decision 2: the official image module is paid, the free
// fork unmaintained). Scope is deliberately tiny:
//   - inline PNG/JPEG only, sourced from the images map given to renderDocx
//     (never from the merge context),
//   - fixed display size: natural size at 96dpi, capped at ~40mm wide,
//     aspect ratio preserved (dimensions read from the image header),
//   - absent image renders as empty text and touches nothing in the zip.
//
// How it hooks into docxtemplater 3.x (verified against the installed
// package):
//   - matchers() registers the '%' prefix, so "{%logo}" parses into a
//     placeholder part with module = LOGO_IMAGE_MODULE and value = "logo".
//   - optionsTransformer() appends the .rels + [Content_Types].xml files to
//     options.xmlFileNames; docxtemplater then parses them into DOM
//     documents and writes them back into the zip on syncZip() after
//     render — that write-back is what persists our added relationships.
//   - set({zip, xmlDocuments}) hands us the live PizZip instance and those
//     parsed DOMs during compile.
//   - render(part) writes the binary under word/media/, registers the
//     relationship + content-type default, and emits the <w:drawing> run.
//     The tag sits inside a <w:t>, so the emitted XML first closes the
//     current run and reopens a fresh one after the drawing — the same
//     splice technique docxtemplater's own Render module uses for \n
//     linebreaks.
import type PizZip from 'pizzip'
import { parseImageDimensions } from './image-size'

export const LOGO_IMAGE_MODULE = 'herbe/logo-image'

/** Image names templates may reference; v1 ships tenant logo only. */
export const KNOWN_IMAGE_NAMES: readonly string[] = ['logo']

const IMAGE_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'

const EMU_PER_PIXEL = 9525 // 914400 EMU/inch at 96 dpi
const MAX_WIDTH_EMU = 40 * 36000 // ~40mm

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
}

interface TemplatePart {
  type: string
  value: string
  module?: string
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function drawingRunXml(input: {
  relationshipId: string
  cx: number
  cy: number
  docPrId: number
  name: string
}): string {
  const { relationshipId, cx, cy, docPrId } = input
  const name = escapeXmlAttribute(input.name)
  const drawing =
    '<w:drawing>' +
    `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${docPrId}" name="${name}"/>` +
    '<wp:cNvGraphicFramePr/>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    '<pic:blipFill>' +
    `<a:blip r:embed="${relationshipId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
    '<a:stretch><a:fillRect/></a:stretch>' +
    '</pic:blipFill>' +
    '<pic:spPr>' +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    '</pic:spPr>' +
    '</pic:pic>' +
    '</a:graphicData>' +
    '</a:graphic>' +
    '</wp:inline>' +
    '</w:drawing>'
  // Splice out of the enclosing <w:t>: close it and its run, emit the
  // drawing in a run of its own, reopen a text run for whatever follows.
  return `</w:t></w:r><w:r>${drawing}</w:r><w:r><w:t xml:space="preserve">`
}

export class LogoImageModule {
  name = 'HerbeLogoImageModule'

  private zip: PizZip | null = null
  private xmlDocuments: Record<string, Document> = {}
  private imageCount = 0

  // The engine creates a fresh instance per render/validate call, so the
  // module never needs docxtemplater's clone()-for-reattachment protocol.
  constructor(private readonly images: Record<string, Buffer>) {}

  optionsTransformer(
    options: { xmlFileNames?: string[] },
    docxtemplater: { zip: PizZip },
  ): { xmlFileNames?: string[] } {
    const extra = docxtemplater.zip
      .file(/(\.xml\.rels|\[Content_Types\]\.xml)$/)
      .map((file) => file.name)
    options.xmlFileNames = (options.xmlFileNames ?? []).concat(extra)
    return options
  }

  set(options: { zip?: PizZip; xmlDocuments?: Record<string, Document> }): void {
    if (options.zip) this.zip = options.zip
    if (options.xmlDocuments) this.xmlDocuments = options.xmlDocuments
  }

  matchers(): [string, string][] {
    return [['%', LOGO_IMAGE_MODULE]]
  }

  render(part: TemplatePart, options: { filePath: string }): { value: string; errors: unknown[] } | null {
    if (part.type !== 'placeholder' || part.module !== LOGO_IMAGE_MODULE) return null
    const buffer = this.images[part.value]
    // Unknown name or image not provided: render nothing. validateTemplate
    // is where unknown image names get reported.
    if (!buffer) return { value: '', errors: [] }
    /* v8 ignore next 2 — unreachable: docxtemplater always set()s the zip
       during compile, before any render call */
    if (!this.zip) return { value: '', errors: [] }

    const { width, height, type } = parseImageDimensions(buffer)
    const naturalCx = width * EMU_PER_PIXEL
    const cx = Math.min(naturalCx, MAX_WIDTH_EMU)
    const cy = Math.round((height * cx) / width)

    this.imageCount += 1
    const mediaPath = `word/media/herbe-image-${this.imageCount}.${type}`
    const relationshipId = this.addRelationship(options.filePath, mediaPath)
    // No .rels part for this file (never the case for word/document.xml,
    // which the fixture and any real template always relate): skip cleanly.
    if (!relationshipId) return { value: '', errors: [] }

    this.zip.file(mediaPath, buffer)
    this.ensureContentTypeDefault(type)
    return {
      value: drawingRunXml({
        relationshipId,
        cx,
        cy,
        // Unique within everything WE emit; docPr id clashes with drawings
        // already present in an uploaded template are repaired by Word.
        docPrId: this.imageCount,
        name: part.value,
      }),
      errors: [],
    }
  }

  /** Add an image relationship to the rels part of `sourceFile`; returns its Id. */
  private addRelationship(sourceFile: string, mediaPath: string): string | null {
    const lastSlash = sourceFile.lastIndexOf('/')
    const dir = lastSlash === -1 ? '' : sourceFile.slice(0, lastSlash)
    const baseName = lastSlash === -1 ? sourceFile : sourceFile.slice(lastSlash + 1)
    const relsPath = `${dir ? `${dir}/` : ''}_rels/${baseName}.rels`
    const relsDocument = this.xmlDocuments[relsPath]
    if (!relsDocument) return null

    const existing = relsDocument.getElementsByTagName('Relationship')
    let maxId = 0
    for (let i = 0; i < existing.length; i++) {
      const match = /^rId(\d+)$/.exec(existing[i].getAttribute('Id') ?? '')
      if (match) maxId = Math.max(maxId, Number(match[1]))
    }
    const relationshipId = `rId${maxId + 1}`

    /* v8 ignore next 2 — the absolute-target fallback needs a templated file
       outside word/, which never carries our media paths in practice */
    const target = dir && mediaPath.startsWith(`${dir}/`) ? mediaPath.slice(dir.length + 1) : `/${mediaPath}`
    const relationship = relsDocument.createElement('Relationship')
    relationship.setAttribute('Id', relationshipId)
    relationship.setAttribute('Type', IMAGE_RELATIONSHIP_TYPE)
    relationship.setAttribute('Target', target)
    relsDocument.documentElement.appendChild(relationship)
    return relationshipId
  }

  private ensureContentTypeDefault(extension: 'png' | 'jpeg'): void {
    const contentTypes = this.xmlDocuments['[Content_Types].xml']
    /* v8 ignore next 2 — unreachable: docxtemplater cannot even detect the
       file type of a zip that lacks [Content_Types].xml */
    if (!contentTypes) return
    const defaults = contentTypes.getElementsByTagName('Default')
    for (let i = 0; i < defaults.length; i++) {
      if ((defaults[i].getAttribute('Extension') ?? '').toLowerCase() === extension) return
    }
    const defaultElement = contentTypes.createElement('Default')
    defaultElement.setAttribute('Extension', extension)
    defaultElement.setAttribute('ContentType', CONTENT_TYPE_BY_EXTENSION[extension])
    contentTypes.documentElement.appendChild(defaultElement)
  }
}
