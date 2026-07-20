// lib/documents/docx/image-size.ts
//
// Pixel dimensions straight from the image header — PNG IHDR or JPEG SOFn —
// so the logo module can emit a correctly-proportioned <wp:extent> without
// pulling in an image library. Only PNG and JPEG are supported (plan
// decision 2: "fixed-size PNG/JPEG only").

export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedImageError'
  }
}

export interface ImageDimensions {
  width: number
  height: number
  type: 'png' | 'jpeg'
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function parsePng(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), type: 'png' }
}

/** SOF markers carrying dimensions: C0–CF except C4 (DHT), C8 (JPG), CC (DAC). */
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function parseJpeg(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let i = 2
  while (i + 9 <= buffer.length) {
    if (buffer[i] !== 0xff) return null // lost marker sync — corrupt stream
    const marker = buffer[i + 1]
    if (marker === 0xff) {
      i += 1 // fill byte before a marker
      continue
    }
    if (isSofMarker(marker)) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7), type: 'jpeg' }
    }
    // Every other segment carries a 2-byte length (excluding the marker).
    i += 2 + buffer.readUInt16BE(i + 2)
  }
  return null
}

export function parseImageDimensions(buffer: Buffer): ImageDimensions {
  const dimensions = parsePng(buffer) ?? parseJpeg(buffer)
  if (!dimensions) {
    throw new UnsupportedImageError('image is not a parseable PNG or JPEG')
  }
  return dimensions
}
