// Glyph extraction: pdf.js converts every embedded font (Type1, CFF, TrueType, OpenType) to OpenType
// and tells us which font character each PDF character code uses. opentype.js reads the outlines.
import { parse as parseOT } from 'opentype.js'
import { richDoc, pageFonts } from './preview.js'

const otCache = new WeakMap()

function stripSubset(n) { return String(n || '').replace(/^[A-Z]{6}\+/, '') }

/** Find the pdf.js font object for a PDF font (matched by name; falls back to the only/first font). */
export async function findPdfjsFont(pageIndex, baseFont) {
  const doc = await richDoc()
  const fonts = await pageFonts(doc, pageIndex)
  const want = stripSubset(baseFont)
  return fonts.find((f) => stripSubset(f.name) === want) ||
    fonts.find((f) => stripSubset(f.name).replace(/[-,].*$/, '') === want.replace(/[-,].*$/, '')) || null
}

function otFont(f) {
  if (otCache.has(f)) return otCache.get(f)
  let ot = null
  try {
    const d = f.data
    ot = parseOT(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))
  } catch (e) { ot = { error: String(e.message || e) } }
  otCache.set(f, ot)
  return ot
}

/**
 * List glyphs of a pdf.js font: one entry per PDF character code.
 * { code, fontChar, glyph (opentype), name, unicodeGuess, width }
 */
export function listGlyphs(f) {
  if (!f || f.isType3Font) return { error: 'Type3 font: glyphs are content streams (see /CharProcs in the Objects tab)' }
  if (!f.data) return { error: f.missingFile ? 'Font program is not embedded and no substitute data is available' : 'No font data' }
  const ot = otFont(f)
  if (!ot || ot.error) return { error: 'Could not read font outlines: ' + (ot?.error || 'unknown') }
  const out = []
  const map = f.toFontChar instanceof Map ? f.toFontChar : new Map(Object.entries(f.toFontChar || {}).map(([k, v]) => [+k, v]))
  for (const [code, fc] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    const ch = String.fromCodePoint(fc)
    const glyph = ot.charToGlyph(ch)
    if (!glyph || glyph.index === 0) continue
    out.push({ code, fontChar: fc, glyph, name: glyph.name || null, width: glyph.advanceWidth, unitsPerEm: ot.unitsPerEm })
  }
  return { glyphs: out, unitsPerEm: ot.unitsPerEm, fontName: f.name, substitute: !!f.missingFile }
}

/** SVG (as string) of a single glyph, in font units, y up → flipped. */
export function glyphSVG(g, { size = 0, fill = '#000', padding = 0.05 } = {}) {
  const upm = g.unitsPerEm || 1000
  const path = g.glyph.getPath(0, 0, upm) // opentype: y down, baseline at 0
  const bb = path.getBoundingBox()
  const adv = g.glyph.advanceWidth || upm
  const x1 = Math.min(0, bb.x1), x2 = Math.max(adv, bb.x2)
  const y1 = Math.min(-upm * 0.8, bb.y1), y2 = Math.max(upm * 0.25, bb.y2)
  const pad = upm * padding
  const vb = [x1 - pad, y1 - pad, x2 - x1 + 2 * pad, y2 - y1 + 2 * pad].map((v) => Math.round(v * 100) / 100)
  const d = path.toPathData(2)
  const dims = size ? ` height="${size}" width="${Math.round((size * vb[2]) / vb[3])}"` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}"${dims}><path d="${d}" fill="${fill}"/></svg>`
}

/** All glyphs as one SVG sheet with labels. */
export function glyphSheetSVG(list, cols = 12) {
  const cell = 120
  const rows = Math.ceil(list.length / cols)
  let body = ''
  list.forEach((g, i) => {
    const x = (i % cols) * cell, y = Math.floor(i / cols) * cell
    const upm = g.unitsPerEm || 1000
    const path = g.glyph.getPath(0, 0, upm)
    const s = (cell * 0.6) / upm
    body += `<g transform="translate(${x + cell * 0.2} ${y + cell * 0.72}) scale(${s})"><path d="${path.toPathData(1)}"/></g>`
    body += `<text x="${x + 4}" y="${y + cell - 6}" font-size="10" font-family="monospace" fill="#666">0x${g.code.toString(16).toUpperCase()}${g.name ? ' ' + g.name : ''}</text>`
    body += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="none" stroke="#ddd"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * cell}" viewBox="0 0 ${cols * cell} ${rows * cell}"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`
}
