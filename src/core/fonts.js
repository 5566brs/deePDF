// Font information for content-stream interpretation:
// code splitting (1/2-byte), glyph widths (incl. standard-14 AFM metrics), ascent/descent,
// code → Unicode (ToUnicode CMap, encodings + Differences), and Unicode → code for editing.
import { Font as StdFont, Encodings } from '@pdf-lib/standard-fonts'
import {
  PDFDict, PDFArray, PDFStream, PDFName, N, deref, nameStr, numVal, numArray, decodeStream, latin1, stringBytes,
} from './pdfobj.js'

/* ---------- glyph names ---------- */

const NAME_TO_UNI = new Map()
const WINANSI_CODE_TO_NAME = new Array(256)
for (const enc of [Encodings.Symbol, Encodings.ZapfDingbats, Encodings.WinAnsi]) {
  for (const [cp, [code, name]] of Object.entries(enc.unicodeMappings)) {
    if (!NAME_TO_UNI.has(name)) NAME_TO_UNI.set(name, String.fromCodePoint(+cp))
    if (enc === Encodings.WinAnsi) WINANSI_CODE_TO_NAME[code] = name
  }
}
for (const [cp, [, name]] of Object.entries(Encodings.WinAnsi.unicodeMappings)) NAME_TO_UNI.set(name, String.fromCodePoint(+cp))
const HEBREW = ['alef', 'bet', 'gimel', 'dalet', 'he', 'vav', 'zayin', 'het', 'tet', 'yod', 'finalkaf', 'kaf', 'lamed', 'finalmem', 'mem', 'finalnun', 'nun', 'samekh', 'ayin', 'finalpe', 'pe', 'finaltsadi', 'tsadi', 'qof', 'resh', 'shin', 'tav']
HEBREW.forEach((n, i) => {
  const ch = String.fromCharCode(0x05d0 + i)
  NAME_TO_UNI.set(n, ch)
  NAME_TO_UNI.set(n + 'hebrew', ch)
  NAME_TO_UNI.set('afii' + (57664 + i), ch)
})
NAME_TO_UNI.set('afii57636', '₪')
NAME_TO_UNI.set('afii57645', '־')
NAME_TO_UNI.set('afii57658', '׃')

export function glyphNameToUnicode(name) {
  if (!name) return null
  if (NAME_TO_UNI.has(name)) return NAME_TO_UNI.get(name)
  let m = name.match(/^uni([0-9A-Fa-f]{4,})$/)
  if (m) {
    let s = ''
    for (let i = 0; i + 4 <= m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].substr(i, 4), 16))
    return s
  }
  m = name.match(/^u([0-9A-Fa-f]{4,6})$/)
  if (m) return String.fromCodePoint(parseInt(m[1], 16))
  const base = name.split('.')[0].split('_')[0]
  if (base !== name) return glyphNameToUnicode(base)
  return null
}

// StandardEncoding differs from WinAnsi mainly in quotes; the rest of 32..126 is ASCII.
function standardEncodingName(code) {
  if (code === 39) return 'quoteright'
  if (code === 96) return 'quoteleft'
  if (code >= 32 && code < 127) return WINANSI_CODE_TO_NAME[code]
  return null
}

/* ---------- standard 14 ---------- */

const STD_ALIASES = {
  Arial: 'Helvetica', 'Arial,Bold': 'Helvetica-Bold', 'Arial-Bold': 'Helvetica-Bold', 'Arial,Italic': 'Helvetica-Oblique',
  'Arial-Italic': 'Helvetica-Oblique', 'Arial,BoldItalic': 'Helvetica-BoldOblique', 'Arial-BoldItalic': 'Helvetica-BoldOblique',
  ArialMT: 'Helvetica', 'Arial-BoldMT': 'Helvetica-Bold', 'Arial-ItalicMT': 'Helvetica-Oblique', 'Arial-BoldItalicMT': 'Helvetica-BoldOblique',
  TimesNewRoman: 'Times-Roman', TimesNewRomanPSMT: 'Times-Roman', 'TimesNewRoman,Bold': 'Times-Bold', 'TimesNewRomanPS-BoldMT': 'Times-Bold',
  'TimesNewRoman,Italic': 'Times-Italic', 'TimesNewRomanPS-ItalicMT': 'Times-Italic', 'TimesNewRomanPS-BoldItalicMT': 'Times-BoldItalic',
  CourierNew: 'Courier', CourierNewPSMT: 'Courier', 'CourierNew,Bold': 'Courier-Bold', 'CourierNewPS-BoldMT': 'Courier-Bold',
}
const STD_NAMES = new Set(['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Symbol', 'ZapfDingbats'])
const stdCache = new Map()
function stdFont(baseFont) {
  if (!baseFont) return null
  let name = baseFont.replace(/^[A-Z]{6}\+/, '')
  name = STD_ALIASES[name] || name
  if (!STD_NAMES.has(name)) return null
  if (!stdCache.has(name)) stdCache.set(name, StdFont.load(name))
  return stdCache.get(name)
}

/* ---------- CMap parsing (ToUnicode + embedded encodings) ---------- */

function hexToInt(h) { return parseInt(h, 16) }
function utf16HexToString(h) {
  let s = ''
  for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 4), 16))
  if (h.length % 4 === 2) s += String.fromCharCode(parseInt(h.substr(h.length - 2), 16))
  return s
}

export function parseToUnicode(text) {
  const map = new Map()
  const ranges = [] // codespace ranges {lo, hi, bytes}
  let m
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/g
  while ((m = cs.exec(text))) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g
    let r
    while ((r = re.exec(m[1]))) ranges.push({ lo: hexToInt(r[1]), hi: hexToInt(r[2]), bytes: r[1].length / 2 })
  }
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g
  while ((m = bfchar.exec(text))) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g
    let r
    while ((r = re.exec(m[1]))) map.set(hexToInt(r[1]), utf16HexToString(r[2]))
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g
  while ((m = bfrange.exec(text))) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g
    let r
    while ((r = re.exec(m[1]))) {
      const lo = hexToInt(r[1]), hi = hexToInt(r[2])
      if (hi - lo > 0xffff) continue
      if (r[3] !== undefined) {
        const base = r[3]
        const lastLen = Math.min(4, base.length)
        const prefix = base.slice(0, base.length - lastLen)
        const start = hexToInt(base.slice(base.length - lastLen))
        for (let c = lo; c <= hi; c++) map.set(c, utf16HexToString(prefix + (start + c - lo).toString(16).padStart(lastLen, '0')))
      } else {
        const items = [...r[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1])
        items.forEach((h, k) => { if (lo + k <= hi) map.set(lo + k, utf16HexToString(h)) })
      }
    }
  }
  return { map, ranges }
}

/* ---------- font info ---------- */

const infoCache = new WeakMap()

/**
 * Info for a font dictionary.
 * { type, baseFont, twoByte, codeLen(bytes, i), widthOf(code), ascent, descent, fontMatrix,
 *   toUnicode(code) → string|null, encode(text) → {bytes, missing[]}, glyphName(code), embedded, hasToUnicode }
 */
export function fontInfo(ctx, fontDict) {
  if (!(fontDict instanceof PDFDict)) return null
  const cached = infoCache.get(fontDict)
  if (cached && cached.rev === ctx.__rev) return cached
  const info = buildFontInfo(ctx, fontDict)
  info.rev = ctx.__rev
  infoCache.set(fontDict, info)
  return info
}

function buildFontInfo(ctx, fd) {
  const type = nameStr(deref(ctx, fd.get(N('Subtype')))) || 'Type1'
  const baseFont = nameStr(deref(ctx, fd.get(N('BaseFont')))) || ''
  const composite = type === 'Type0'
  let descendant = null
  if (composite) {
    const desc = deref(ctx, fd.get(N('DescendantFonts')))
    const d0 = desc instanceof PDFArray ? deref(ctx, desc.get(0)) : null
    if (d0 instanceof PDFDict) descendant = d0
  }
  const descriptor = deref(ctx, (descendant || fd).get(N('FontDescriptor')))
  const fdesc = descriptor instanceof PDFDict ? descriptor : null
  const std = stdFont(baseFont)

  // ToUnicode
  let tu = null
  const tuObj = deref(ctx, fd.get(N('ToUnicode')))
  if (tuObj instanceof PDFStream) {
    try { tu = parseToUnicode(latin1(decodeStream(ctx, tuObj).bytes)) } catch { tu = null }
  }

  // Encoding / Differences (simple fonts)
  const codeToName = new Array(256)
  let symbolic = false
  if (!composite) {
    const flags = fdesc ? numVal(deref(ctx, fdesc.get(N('Flags')))) || 0 : 0
    symbolic = !!(flags & 4) || /Symbol|Dingbats/.test(baseFont)
    const enc = deref(ctx, fd.get(N('Encoding')))
    let baseEnc = nameStr(enc) || (enc instanceof PDFDict ? nameStr(deref(ctx, enc.get(N('BaseEncoding')))) : null)
    for (let c = 0; c < 256; c++) codeToName[c] = baseEnc === 'WinAnsiEncoding' || baseEnc === 'MacRomanEncoding' || (!baseEnc && type === 'TrueType') ? WINANSI_CODE_TO_NAME[c] : standardEncodingName(c)
    if (std && std.FontName === 'Symbol') for (const [cp, [code, name]] of Object.entries(Encodings.Symbol.unicodeMappings)) { void cp; codeToName[code] = name }
    if (std && std.FontName === 'ZapfDingbats') for (const [cp, [code, name]] of Object.entries(Encodings.ZapfDingbats.unicodeMappings)) { void cp; codeToName[code] = name }
    if (enc instanceof PDFDict) {
      const diffs = deref(ctx, enc.get(N('Differences')))
      if (diffs instanceof PDFArray) {
        let code = 0
        for (const x of diffs.asArray()) {
          const v = deref(ctx, x)
          if (v && v.asNumber) code = v.asNumber()
          else if (v instanceof PDFName) codeToName[code++ & 0xff] = v.decodeText()
        }
      }
    }
  }

  // widths
  let widthOf
  let fontMatrix = [0.001, 0, 0, 0.001, 0, 0]
  if (composite) {
    const dw = descendant ? numVal(deref(ctx, descendant.get(N('DW')))) ?? 1000 : 1000
    const map = new Map()
    const W = descendant ? deref(ctx, descendant.get(N('W'))) : null
    if (W instanceof PDFArray) {
      const a = W.asArray().map((x) => deref(ctx, x))
      for (let k = 0; k < a.length;) {
        const first = numVal(a[k])
        if (a[k + 1] instanceof PDFArray) {
          a[k + 1].asArray().forEach((w, j) => map.set(first + j, numVal(deref(ctx, w)) ?? dw))
          k += 2
        } else {
          const last = numVal(a[k + 1]), w = numVal(a[k + 2])
          if (last - first < 70000) for (let c = first; c <= last; c++) map.set(c, w)
          k += 3
        }
      }
    }
    widthOf = (code) => map.get(code) ?? dw
  } else {
    const fc = numVal(deref(ctx, fd.get(N('FirstChar')))) ?? 0
    const widths = numArray(ctx, fd.get(N('Widths')))
    const missing = fdesc ? numVal(deref(ctx, fdesc.get(N('MissingWidth')))) : undefined
    if (type === 'Type3') {
      fontMatrix = numArray(ctx, fd.get(N('FontMatrix'))) || fontMatrix
    }
    const scale = type === 'Type3' ? fontMatrix[0] * 1000 : 1
    widthOf = (code) => {
      if (widths && widths[code - fc] !== undefined) return widths[code - fc] * scale
      if (std) {
        const name = codeToName[code]
        if (name) { try { const w = std.getWidthOfGlyph(name); if (w !== undefined) return w } catch { /* ignore */ } }
        return std.IsFixedPitch === 'true' ? 600 : 500
      }
      return missing ?? 500
    }
  }

  let ascent = fdesc ? numVal(deref(ctx, fdesc.get(N('Ascent')))) : undefined
  let descent = fdesc ? numVal(deref(ctx, fdesc.get(N('Descent')))) : undefined
  if (!ascent && std) { ascent = std.Ascender ?? std.FontBBox[3]; descent = std.Descender ?? std.FontBBox[1] }
  if (!ascent) { const bb = fdesc ? numArray(ctx, fdesc.get(N('FontBBox'))) : null; ascent = bb ? bb[3] : 800; descent = bb ? bb[1] : -200 }
  if (type === 'Type3') {
    const bb = numArray(ctx, fd.get(N('FontBBox')))
    if (bb) { ascent = bb[3] * fontMatrix[3] * 1000; descent = bb[1] * fontMatrix[3] * 1000 }
  }
  if (descent > 0) descent = -descent

  // code length (composite: codespace ranges of encoding CMap; Identity-H → 2 bytes)
  let codespace = null
  if (composite) {
    const enc = deref(ctx, fd.get(N('Encoding')))
    if (enc instanceof PDFStream) {
      try { codespace = parseToUnicode(latin1(decodeStream(ctx, enc).bytes)).ranges } catch { /* ignore */ }
    }
    if ((!codespace || !codespace.length) && tu && tu.ranges.length) codespace = tu.ranges
    if (!codespace || !codespace.length) codespace = [{ lo: 0, hi: 0xffff, bytes: 2 }]
  }
  const codeLen = (bytes, i) => {
    if (!composite) return 1
    for (let n = 1; n <= 4; n++) {
      let v = 0
      for (let k = 0; k < n; k++) v = (v << 8) | (bytes[i + k] ?? 0)
      if (codespace.some((r) => r.bytes === n && v >= r.lo && v <= r.hi)) return n
    }
    return 2
  }

  const toUnicode = (code) => {
    if (tu && tu.map.has(code)) return tu.map.get(code)
    if (!composite) {
      const u = glyphNameToUnicode(codeToName[code])
      if (u) return u
      if (!symbolic && code >= 32 && code < 127) return String.fromCharCode(code)
    }
    return null
  }

  // reverse mapping for editing
  let reverse = null
  const encode = (text) => {
    if (!reverse) {
      reverse = new Map()
      if (tu) for (const [c, u] of tu.map) if (!reverse.has(u)) reverse.set(u, c)
      if (!composite) for (let c = 0; c < 256; c++) { const u = toUnicode(c); if (u && !reverse.has(u)) reverse.set(u, c) }
    }
    const out = []
    const missing = []
    for (const ch of text) {
      const c = reverse.get(ch)
      if (c === undefined) { missing.push(ch); continue }
      const len = composite ? (codespace.find((r) => c >= r.lo && c <= r.hi)?.bytes || 2) : 1
      for (let k = len - 1; k >= 0; k--) out.push((c >> (8 * k)) & 0xff)
    }
    return { bytes: new Uint8Array(out), missing }
  }

  const embedded = !!(fdesc && (fdesc.get(N('FontFile')) || fdesc.get(N('FontFile2')) || fdesc.get(N('FontFile3'))))
  return {
    type, baseFont, composite, twoByte: composite, codeLen, widthOf, ascent, descent, fontMatrix, toUnicode, encode,
    glyphName: (code) => (composite ? null : codeToName[code] || null), embedded, hasToUnicode: !!tu, symbolic,
    std: std ? std.FontName : null,
  }
}

/** Split string bytes into character codes. */
export function splitCodes(info, bytes) {
  const out = []
  for (let i = 0; i < bytes.length;) {
    const len = info ? info.codeLen(bytes, i) : 1
    let code = 0
    for (let k = 0; k < len; k++) code = (code << 8) | (bytes[i + k] ?? 0)
    out.push({ code, start: i, end: i + len })
    i += len
  }
  return out
}

export function decodeText(info, bytes) {
  return splitCodes(info, bytes).map((c) => (info ? info.toUnicode(c.code) : null) ?? '�').join('')
}

export { stringBytes }
