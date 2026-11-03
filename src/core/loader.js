// Parse a PDF while keeping large binary streams on disk.
// During parsing, stream data above a threshold is not copied; afterwards image / font-program /
// embedded-file streams become slices of the original File (disk-backed Blobs), everything else
// (content streams, CMaps, XMP…) is materialised in memory because it is edited synchronously.
import { PDFParser, PDFObjectStreamParser, PDFXRefStreamParser, PDFRawStream, PDFDict, PDFName, PDFRef } from 'pdf-lib'
import { LazyContents } from './lazy.js'

class Marker { constructor(start, end) { this.start = start; this.end = end; this.length = end - start } }

const FONT_FILE_KEYS = ['FontFile', 'FontFile2', 'FontFile3']

/** Binary data that is never parsed as PDF syntax: images, font programs, embedded files. */
function shouldOffload(stream, fontPrograms) {
  const d = stream.dict
  const sub = d.lookup(PDFName.of('Subtype'))
  const type = d.lookup(PDFName.of('Type'))
  if (sub instanceof PDFName && sub.decodeText() === 'Image') return true
  if (type instanceof PDFName && type.decodeText() === 'EmbeddedFile') return true
  if (fontPrograms.has(stream)) return true
  return d.has(PDFName.of('Length1')) || d.has(PDFName.of('Length2'))
}

/**
 * opts: { file (File|Blob, the source of `bytes`), threshold (bytes) }
 * returns { ctx, offloaded: { count, bytes } }
 */
export async function parsePdf(bytes, opts = {}) {
  const threshold = opts.threshold ?? 256 * 1024
  const file = opts.file || null
  const parser = PDFParser.forBytesWithOptions(bytes, 2000, false, false)
  const main = parser.bytes
  const origSlice = main.slice.bind(main)
  if (file && threshold > 0) {
    main.slice = (start, end) => (end - start >= threshold ? new Marker(start, end) : origSlice(start, end))
  }
  const materialise = (raw) => { if (raw && raw.contents instanceof Marker) raw.contents = bytes.slice(raw.contents.start, raw.contents.end) }
  const origObjStm = PDFObjectStreamParser.forStream
  const origXRef = PDFXRefStreamParser.forStream
  PDFObjectStreamParser.forStream = (raw, ...a) => { materialise(raw); return origObjStm(raw, ...a) }
  PDFXRefStreamParser.forStream = (raw, ...a) => { materialise(raw); return origXRef(raw, ...a) }
  let ctx
  try {
    ctx = await parser.parseDocument()
  } finally {
    PDFObjectStreamParser.forStream = origObjStm
    PDFXRefStreamParser.forStream = origXRef
    main.slice = origSlice
  }
  const offloaded = { count: 0, bytes: 0 }
  if (file) {
    // font programs are referenced from font descriptors
    const fontPrograms = new Set()
    for (const [, o] of ctx.enumerateIndirectObjects()) {
      if (!(o instanceof PDFDict)) continue
      for (const k of FONT_FILE_KEYS) {
        const r = o.get(PDFName.of(k))
        const s = r instanceof PDFRef ? ctx.lookup(r) : null
        if (s) fontPrograms.add(s)
      }
    }
    for (const [, o] of ctx.enumerateIndirectObjects()) {
      if (!(o instanceof PDFRawStream) || !(o.contents instanceof Marker)) continue
      const m = o.contents
      if (shouldOffload(o, fontPrograms)) {
        o.contents = new LazyContents(file.slice(m.start, m.end), 'file')
        offloaded.count++
        offloaded.bytes += m.length
      } else materialise(o)
    }
  }
  return { ctx, offloaded }
}
