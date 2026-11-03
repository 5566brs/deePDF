// Give pdf.js-converted fonts a Unicode cmap so exported text is real, editable text.
// pdf.js maps PDF character codes to private-use code points in the fonts it builds; we add
// Unicode → glyph mappings (from the PDF's ToUnicode / encoding) next to the existing ones.
import { parse as parseOT } from 'opentype.js'
import { PDFDict } from './pdfobj.js'
import { N, deref, nameStr } from './pdfobj.js'
import { fontInfo } from './fonts.js'

const strip = (n) => String(n || '').replace(/^[A-Z]{6}\+/, '')

/** Index of PDF font dictionaries by BaseFont. */
export function fontDictIndex(ctx) {
  const idx = new Map()
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    if (!(o instanceof PDFDict)) continue
    if (nameStr(deref(ctx, o.get(N('Type')))) !== 'Font') continue
    const st = nameStr(deref(ctx, o.get(N('Subtype'))))
    if (st === 'CIDFontType0' || st === 'CIDFontType2') continue
    const bf = nameStr(deref(ctx, o.get(N('BaseFont')))) || ''
    for (const k of [bf, strip(bf)]) { if (!idx.has(k)) idx.set(k, []); idx.get(k).push(o) }
  }
  return idx
}

/* ---------- binary helpers ---------- */
function u16(v, o, x) { v.setUint16(o, x) }
function u32(v, o, x) { v.setUint32(o, x >>> 0) }

function buildCmap(map /* Map codepoint → gid */) {
  const cps = [...map.keys()].filter((c) => c >= 0 && c <= 0x10ffff).sort((a, b) => a - b)
  const bmp = cps.filter((c) => c < 0xffff)
  // format 4 (BMP), one segment per code point + terminator
  const segs = bmp.length + 1
  const f4len = 16 + segs * 8
  // format 12
  const f12len = 16 + cps.length * 12
  const total = 4 + 3 * 8 + f4len + f12len
  const buf = new ArrayBuffer(total)
  const v = new DataView(buf)
  u16(v, 0, 0); u16(v, 2, 3)
  const off4 = 4 + 3 * 8, off12 = off4 + f4len
  // encoding records (sorted by platform, encoding)
  u16(v, 4, 0); u16(v, 6, 4); u32(v, 8, off12) // Unicode full
  u16(v, 12, 3); u16(v, 14, 1); u32(v, 16, off4) // Windows BMP
  u16(v, 20, 3); u16(v, 22, 10); u32(v, 24, off12) // Windows full
  // format 4
  let o = off4
  u16(v, o, 4); u16(v, o + 2, f4len); u16(v, o + 4, 0)
  u16(v, o + 6, segs * 2)
  const es = Math.floor(Math.log2(segs))
  u16(v, o + 8, 2 * 2 ** es); u16(v, o + 10, es); u16(v, o + 12, 2 * segs - 2 * 2 ** es)
  const endO = o + 14, startO = endO + segs * 2 + 2, deltaO = startO + segs * 2, rangeO = deltaO + segs * 2
  bmp.forEach((c, i) => {
    u16(v, endO + i * 2, c); u16(v, startO + i * 2, c)
    u16(v, deltaO + i * 2, (map.get(c) - c) & 0xffff); u16(v, rangeO + i * 2, 0)
  })
  const last = segs - 1
  u16(v, endO + last * 2, 0xffff); u16(v, startO + last * 2, 0xffff); u16(v, deltaO + last * 2, 1); u16(v, rangeO + last * 2, 0)
  // format 12
  o = off12
  u16(v, o, 12); u16(v, o + 2, 0); u32(v, o + 4, f12len); u32(v, o + 8, 0); u32(v, o + 12, cps.length)
  cps.forEach((c, i) => { const p = o + 16 + i * 12; u32(v, p, c); u32(v, p + 4, c); u32(v, p + 8, map.get(c)) })
  return new Uint8Array(buf)
}

function checksum(bytes) {
  const padded = new Uint8Array((bytes.length + 3) & ~3)
  padded.set(bytes)
  const v = new DataView(padded.buffer)
  let s = 0
  for (let i = 0; i < padded.length; i += 4) s = (s + v.getUint32(i)) >>> 0
  return s
}

function replaceTable(font, tag, data) {
  const v = new DataView(font.buffer, font.byteOffset, font.byteLength)
  const numTables = v.getUint16(4)
  const tables = []
  for (let i = 0; i < numTables; i++) {
    const r = 12 + i * 16
    const t = String.fromCharCode(font[r], font[r + 1], font[r + 2], font[r + 3])
    const off = v.getUint32(r + 8), len = v.getUint32(r + 12)
    tables.push({ tag: t, data: t === tag ? data : font.subarray(off, off + len) })
  }
  if (!tables.some((t) => t.tag === tag)) tables.push({ tag, data })
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1))
  const n = tables.length
  let size = 12 + n * 16
  for (const t of tables) size += (t.data.length + 3) & ~3
  const out = new Uint8Array(size)
  const ov = new DataView(out.buffer)
  out.set(font.subarray(0, 4), 0)
  const es = Math.floor(Math.log2(n))
  ov.setUint16(4, n); ov.setUint16(6, 16 * 2 ** es); ov.setUint16(8, es); ov.setUint16(10, n * 16 - 16 * 2 ** es)
  let off = 12 + n * 16
  tables.forEach((t, i) => {
    const r = 12 + i * 16
    for (let k = 0; k < 4; k++) out[r + k] = t.tag.charCodeAt(k)
    ov.setUint32(r + 4, checksum(t.data)); ov.setUint32(r + 8, off); ov.setUint32(r + 12, t.data.length)
    out.set(t.data, off)
    off += (t.data.length + 3) & ~3
  })
  return out
}

function b64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/**
 * For a pdf.js font object, build an @font-face rule whose cmap also maps real Unicode,
 * and a translation fontChar → Unicode character for text content.
 */
export function remapFont(ctx, index, f) {
  if (!f || !f.data || f.isType3Font) return null
  const cands = index.get(f.name) || index.get(strip(f.name)) || []
  if (!cands.length) return null
  const info = fontInfo(ctx, cands[0])
  if (!info) return null
  let ot
  try { const d = f.data; ot = parseOT(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) } catch { return null }
  const toFontChar = f.toFontChar instanceof Map ? f.toFontChar : new Map(Object.entries(f.toFontChar || {}).map(([k, v]) => [+k, v]))
  const cmap = new Map()
  // keep the original mappings
  const glyphIndexMap = ot.tables.cmap && ot.tables.cmap.glyphIndexMap ? ot.tables.cmap.glyphIndexMap : {}
  for (const [cp, gid] of Object.entries(glyphIndexMap)) cmap.set(+cp, gid)
  const translate = new Map()
  const taken = new Map()
  for (const [code, fc] of toFontChar) {
    const uni = info.toUnicode(code)
    if (!uni) continue
    const cps = [...uni]
    if (cps.length !== 1) continue
    const ucp = cps[0].codePointAt(0)
    if (ucp < 0x20 || (ucp >= 0xe000 && ucp <= 0xf8ff)) continue
    const gid = ot.charToGlyphIndex(String.fromCodePoint(fc))
    if (!gid) continue
    if (taken.has(ucp) && taken.get(ucp) !== gid) continue // same character, different glyph: keep private-use code
    if (cmap.has(ucp) && cmap.get(ucp) !== gid && !taken.has(ucp)) continue
    cmap.set(ucp, gid)
    taken.set(ucp, gid)
    translate.set(String.fromCodePoint(fc), uni)
  }
  if (!translate.size) return null
  let data
  try { data = replaceTable(f.data, 'cmap', buildCmap(cmap)) } catch { return null }
  const mime = f.mimetype || 'font/opentype'
  const rule = `@font-face {font-family:"${f.loadedName}";src:url(data:${mime};base64,${b64(data)})}`
  return { rule, translate }
}
