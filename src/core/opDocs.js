// Token-level documentation for a content-stream operation: what each operand means *in this line*.
import { tokToString, tokBytes } from './contentStream.js'
import { splitCodes } from './fonts.js'

const OPERANDS = {
  w: ['Line width in user-space units (0 = thinnest line the device can draw)'],
  J: ['Line cap: 0 butt · 1 round · 2 projecting square'],
  j: ['Line join: 0 miter · 1 round · 2 bevel'],
  M: ['Miter limit: max ratio of miter length to line width before a bevel is used'],
  d: ['Dash array: lengths of alternating dashes and gaps ([] = solid line)', 'Dash phase: distance into the pattern at which to start'],
  ri: ['Rendering intent name'],
  i: ['Flatness tolerance (0–100): how precisely curves are approximated'],
  gs: ['Name of an ExtGState resource (opacity, blend mode, line settings…) in /Resources /ExtGState'],
  cm: ['a – horizontal scale (× cos θ for rotation)', 'b – rotation / vertical skew (sin θ)', 'c – rotation / horizontal skew (−sin θ)', 'd – vertical scale (× cos θ)', 'e – horizontal translation: moves everything right by this many units', 'f – vertical translation: moves everything up by this many units'],
  m: ['x – start point of a new sub-path', 'y – start point of a new sub-path'],
  l: ['x – end point of the straight line', 'y – end point of the straight line'],
  c: ['x1 – first control point', 'y1 – first control point', 'x2 – second control point', 'y2 – second control point', 'x3 – end point of the curve', 'y3 – end point of the curve'],
  v: ['x2 – second control point', 'y2 – second control point', 'x3 – end point', 'y3 – end point'],
  y: ['x1 – first control point', 'y1 – first control point', 'x3 – end point (also the second control point)', 'y3 – end point'],
  re: ['x – lower-left corner', 'y – lower-left corner', 'width (negative = extends to the left)', 'height (negative = extends downward)'],
  Tc: ['Character spacing: extra space after every glyph (unscaled text-space units)'],
  Tw: ['Word spacing: extra space after every single-byte space (code 32)'],
  Tz: ['Horizontal scaling in percent (100 = normal width)'],
  TL: ['Leading: line distance used by T*, \' and "'],
  Tf: ['Font resource name (from /Resources /Font)', 'Font size in text-space units'],
  Tr: ['Rendering mode: 0 fill · 1 stroke · 2 fill+stroke · 3 invisible · 4–6 same + add to clip · 7 clip only'],
  Ts: ['Text rise: moves the baseline up (superscript) or down (subscript)'],
  Td: ['tx – horizontal offset from the start of the current line', 'ty – vertical offset from the start of the current line'],
  TD: ['tx – horizontal offset from the start of the current line', 'ty – vertical offset (also sets leading to −ty)'],
  Tm: ['a – horizontal text scale', 'b – rotation/skew', 'c – rotation/skew', 'd – vertical text scale', 'e – x position of the text origin', 'f – y position of the text origin (baseline)'],
  Tj: ['Text string: character codes to show with the current font'],
  "'": ['Text string shown on the next line'],
  '"': ['Word spacing (sets Tw)', 'Character spacing (sets Tc)', 'Text string shown on the next line'],
  TJ: ['Array: strings are shown; numbers shift the next glyph by −n/1000 of the font size (negative numbers move right)'],
  d0: ['wx – glyph width', 'wy – must be 0'],
  d1: ['wx – glyph width', 'wy – must be 0', 'llx – glyph bounding box', 'lly', 'urx', 'ury'],
  CS: ['Stroking colour space (DeviceRGB, DeviceGray, DeviceCMYK, Pattern or a /ColorSpace resource)'],
  cs: ['Fill colour space (DeviceRGB, DeviceGray, DeviceCMYK, Pattern or a /ColorSpace resource)'],
  G: ['Stroking gray level: 0 = black … 1 = white'],
  g: ['Fill gray level: 0 = black … 1 = white'],
  RG: ['Stroking red component (0–1)', 'Stroking green component (0–1)', 'Stroking blue component (0–1)'],
  rg: ['Fill red component (0–1)', 'Fill green component (0–1)', 'Fill blue component (0–1)'],
  K: ['Stroking cyan (0–1)', 'Stroking magenta (0–1)', 'Stroking yellow (0–1)', 'Stroking black (0–1)'],
  k: ['Fill cyan (0–1)', 'Fill magenta (0–1)', 'Fill yellow (0–1)', 'Fill black (0–1)'],
  sh: ['Shading resource name (/Resources /Shading)'],
  Do: ['XObject resource name (/Resources /XObject): an image or form'],
  MP: ['Marked-content tag'],
  DP: ['Marked-content tag', 'Property list (inline dictionary or /Properties resource name)'],
  BMC: ['Marked-content tag (e.g. /Artifact, /Span, /OC for layers)'],
  BDC: ['Marked-content tag (e.g. /Span, /P, /OC for layers, /Artifact)', 'Property list (inline dictionary such as <</MCID 3>> or a /Properties resource name)'],
}

const hex2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
export function colorOf(op, args) {
  const v = args.filter((a) => a.t === 'num').map((a) => parseFloat(a.v))
  if ((op === 'rg' || op === 'RG' || ((op === 'sc' || op === 'scn' || op === 'SC' || op === 'SCN') && v.length === 3)) && v.length >= 3) return '#' + v.slice(0, 3).map(hex2).join('')
  if ((op === 'g' || op === 'G' || ((op === 'sc' || op === 'scn' || op === 'SC' || op === 'SCN') && v.length === 1)) && v.length >= 1) return '#' + hex2(v[0]).repeat(3)
  if ((op === 'k' || op === 'K' || ((op === 'sc' || op === 'scn' || op === 'SC' || op === 'SCN') && v.length === 4)) && v.length >= 4) {
    const [c, m, y, k] = v
    return '#' + [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)].map(hex2).join('')
  }
  return null
}

function matrixSummary(vals) {
  const [a, b, c, d, e, f] = vals
  const sx = Math.hypot(a, b), sy = Math.hypot(c, d)
  const rot = (Math.atan2(b, a) * 180) / Math.PI
  const r = (x) => Math.round(x * 1000) / 1000
  return `→ scale ${r(sx)} × ${r(sy)}${Math.abs(rot) > 0.01 ? `, rotation ${r(rot)}°` : ''}, origin moved to (${r(e)}, ${r(f)})`
}

const fmtCode = (c, len) => '0x' + c.toString(16).toUpperCase().padStart(len * 2, '0')

/** Describe glyphs in a string token. */
export function glyphsOf(tok, font) {
  const bytes = tokBytes(tok)
  return splitCodes(font, bytes).map((g) => {
    const uni = font ? font.toUnicode(g.code) : String.fromCharCode(g.code)
    const name = font ? font.glyphName(g.code) : null
    return { ...g, uni, name, width: font ? font.widthOf(g.code) : null, label: fmtCode(g.code, g.end - g.start) }
  })
}

function stringDoc(tok, font, fontName, size) {
  const gl = glyphsOf(tok, font)
  const text = gl.map((g) => g.uni ?? '�').join('')
  const unknown = gl.filter((g) => g.uni == null).length
  let s = `Text string (${gl.length} glyph${gl.length === 1 ? '' : 's'}${fontName ? `, font /${fontName}${size ? ' ' + size + 'pt' : ''}` : ''})`
  s += `\nDecoded: “${text}”`
  if (unknown) s += `\n${unknown} code(s) have no Unicode mapping (no ToUnicode entry)`
  if (font && font.composite) s += `\nComposite font: ${font.codeLen(tokBytes(tok), 0)}-byte codes (CIDs)`
  s += `\nCodes: ${gl.slice(0, 24).map((g) => g.label + (g.uni ? `=${g.uni}` : '')).join(' ')}${gl.length > 24 ? ' …' : ''}`
  return s
}

/**
 * Layout an op as text with per-token spans and documentation.
 * helpers: { font(name) → fontInfo, fontLabel(name) → string, xobject(name) → string }
 * returns { text, tokens: [{ key, start, end, text, doc, kind, color?, glyphs? }] }
 */
export function layoutOp(o, detail = {}, helpers = {}) {
  const tokens = []
  let text = ''
  if (o.inline) {
    const d = o.inline.dict.map(([k, v]) => '/' + k + ' ' + tokToString(v)).join(' ')
    text = `BI ${d} ID …${o.inline.data.length} bytes… EI`
    tokens.push({ key: 'inline', start: 0, end: text.length, text, doc: 'Inline image: dictionary entries (abbreviated keys: /W width, /H height, /BPC bits, /CS colour space, /F filter) followed by the image data', kind: 'op' })
    return { text, tokens }
  }
  const names = OPERANDS[o.op] || []
  const font = detail.font && helpers.font ? helpers.font(detail.font) : null
  const vals = o.args.map((a) => (a.t === 'num' ? parseFloat(a.v) : NaN))
  const color = colorOf(o.op, o.args)

  o.args.forEach((a, k) => {
    if (text) text += ' '
    const key = 'a' + k
    let doc = names[k] || (['sc', 'scn', 'SC', 'SCN'].includes(o.op) ? (a.t === 'name' ? 'Pattern resource name' : `Colour component ${k + 1} in the current colour space`) : `Operand ${k + 1}`)
    if (a.t === 'arr') {
      const start = text.length
      text += '['
      const children = []
      a.v.forEach((el, j) => {
        if (j) text += ' '
        const s = text.length
        const t = tokToString(el)
        text += t
        let edoc
        if (o.op === 'TJ' && (el.t === 'str' || el.t === 'hex')) edoc = stringDoc(el, font, detail.font, detail.size)
        else if (o.op === 'TJ' && el.t === 'num') {
          const n = parseFloat(el.v)
          const pts = (-n / 1000) * (detail.size || 0) * (detail.Th || 1)
          edoc = `Position adjustment ${n}: moves the next glyph ${pts >= 0 ? 'right' : 'left'} by ${Math.abs(n) / 1000} em${detail.size ? ` = ${Math.round(Math.abs(pts) * 1000) / 1000} text units at ${detail.size}pt` : ''}${n < -150 ? '\n(large gap: usually a word space)' : ''}`
        } else if (o.op === 'd') edoc = `${j % 2 ? 'Gap' : 'Dash'} length ${el.v}`
        else edoc = `Element ${j + 1}`
        children.push({ key: `${key}.${j}`, start: s, end: text.length, text: t, doc: edoc, kind: el.t, glyphs: (el.t === 'str' || el.t === 'hex') ? glyphsOf(el, font) : undefined, tok: el })
      })
      text += ']'
      tokens.push({ key, start, end: text.length, text: text.slice(start), doc, kind: 'arr', children })
      tokens.push(...children)
      return
    }
    const start = text.length
    const t = tokToString(a)
    text += t
    if (a.t === 'str' || a.t === 'hex') doc = (names[k] ? names[k] + '\n' : '') + stringDoc(a, font, detail.font, detail.size)
    if (o.op === 'Tf' && k === 0 && helpers.fontLabel) doc += '\n' + helpers.fontLabel(a.v)
    if (o.op === 'Do' && helpers.xobject) doc += '\n' + helpers.xobject(a.v)
    if ((o.op === 'cm' || o.op === 'Tm') && vals.length >= 6 && vals.every(isFinite)) doc += '\n' + matrixSummary(vals)
    if (color && a.t === 'num') doc += `\nResulting colour ${color}`
    if (a.t === 'num' && (o.op === 'J' || o.op === 'j' || o.op === 'Tr')) {
      const opts = { J: ['butt', 'round', 'projecting square'], j: ['miter', 'round', 'bevel'], Tr: ['fill', 'stroke', 'fill + stroke', 'invisible', 'fill + clip', 'stroke + clip', 'fill + stroke + clip', 'clip'] }[o.op]
      if (opts[vals[k]]) doc += `\nCurrent value ${vals[k]} = ${opts[vals[k]]}`
    }
    tokens.push({ key, start, end: text.length, text: t, doc, kind: a.t, color: color && a.t === 'num' ? color : undefined, glyphs: (a.t === 'str' || a.t === 'hex') ? glyphsOf(a, font) : undefined, tok: a })
  })
  if (o.op) {
    if (text) text += ' '
    const start = text.length
    text += o.op
    tokens.push({ key: 'op', start, end: text.length, text: o.op, doc: helpers.opDoc ? helpers.opDoc(o.op) : o.op, kind: 'op' })
  }
  return { text, tokens }
}

/** Token at a caret position (prefers the innermost). */
export function tokenAt(layout, pos) {
  let best = null
  for (const t of layout.tokens) {
    if (pos >= t.start && pos <= t.end && (!best || t.end - t.start < best.end - best.start)) best = t
  }
  return best
}

/** Byte index inside a string token for a caret offset inside its source text. */
export function byteAtCaret(tok, caretInTok) {
  if (tok.t === 'hex') return Math.max(0, Math.floor((caretInTok - 1) / 2))
  // literal: walk escapes
  const raw = tok.v
  let pos = 1, bytes = 0
  for (let i = 0; i < raw.length && pos < caretInTok; i++, pos++) {
    if (raw[i] === '\\') {
      const nx = raw[i + 1]
      if (nx >= '0' && nx <= '7') { let k = 1; while (k < 3 && raw[i + 1 + k] >= '0' && raw[i + 1 + k] <= '7') k++; i += k; pos += k }
      else if (nx === '\n' || nx === '\r') { i++; pos++; continue }
      else { i++; pos++ }
    }
    bytes++
  }
  return bytes
}
