// Quick text editing: read the text of text-showing operations and write new text back through the font.
import { tokBytes, TEXT_SHOW } from './contentStream.js'
import { splitCodes, decodeText } from './fonts.js'
import { escapeLiteral, toHex } from './pdfobj.js'

const reverse = (s) => [...s].reverse().join('')

function stringToks(op) {
  if (op.op === 'TJ') return (op.args[0]?.t === 'arr' ? op.args[0].v : []).map((t, k) => ({ t, k })).filter((x) => x.t.t === 'str' || x.t.t === 'hex')
  const t = op.args[op.args.length - 1]
  return t && (t.t === 'str' || t.t === 'hex') ? [{ t, k: -1 }] : []
}

/** Text runs (one per text-showing op) between op indices from..to. */
export function textRuns(ops, details, from, to, fontOf) {
  const runs = []
  for (let i = from; i <= to; i++) {
    const op = ops[i]
    if (!TEXT_SHOW.has(op.op)) continue
    const d = details[i] || {}
    const font = d.font ? fontOf(d.font) : null
    const toks = stringToks(op)
    const segs = toks.map(({ t, k }) => ({ k, tok: t, glyphs: splitCodes(font, tokBytes(t)).length }))
    let text = toks.map(({ t }) => (font ? decodeText(font, tokBytes(t)) : '')).join('')
    if (d.reversed) text = reverse(text)
    runs.push({ index: i, op, font, fontName: d.font, size: d.size, reversed: !!d.reversed, text, segs, mappable: !!font && !text.includes('�') })
  }
  return runs
}

function makeTok(bytes, likeHex) {
  return likeHex ? { t: 'hex', v: toHex(bytes) } : { t: 'str', v: escapeLiteral(bytes) }
}

/**
 * Encode new text for a run. Returns { op, missing: [], note }.
 * TJ: if the glyph count is unchanged, the new codes are distributed over the original segments so kerning is kept;
 * otherwise the array is replaced by a single string.
 */
export function encodeRun(run, newText) {
  if (!run.font) return { op: null, missing: [], note: 'Font not found' }
  const logical = run.reversed ? reverse(newText) : newText
  const enc = run.font.encode(logical)
  if (enc.missing.length) return { op: null, missing: [...new Set(enc.missing)], note: '' }
  const codes = splitCodes(run.font, enc.bytes)
  const hex = run.font.composite || run.segs.some((s) => s.tok.t === 'hex')
  const op = { op: run.op.op, args: JSON.parse(JSON.stringify(run.op.args)) }
  let note = ''
  if (op.op === 'TJ') {
    const total = run.segs.reduce((n, s) => n + s.glyphs, 0)
    if (total === codes.length && run.segs.length > 1) {
      let p = 0
      for (const s of run.segs) {
        const part = codes.slice(p, p + s.glyphs)
        p += s.glyphs
        const bytes = part.length ? enc.bytes.subarray(part[0].start, part[part.length - 1].end) : new Uint8Array()
        op.args[0].v[s.k] = makeTok(bytes, hex)
      }
      note = 'Kerning kept (same number of characters)'
    } else {
      op.args[0] = { t: 'arr', v: [makeTok(enc.bytes, hex)] }
      if (run.segs.length > 1) note = 'Length changed: kerning adjustments of this line were removed'
    }
  } else {
    op.args[op.args.length - 1] = makeTok(enc.bytes, hex)
  }
  return { op, missing: [], note }
}

/** Convert a page-space displacement into the local coordinate system described by ctm. */
export function localDelta(ctm, dx, dy) {
  const [a, b, c, d] = ctm || [1, 0, 0, 1]
  const det = a * d - b * c
  if (!det) return [dx, dy]
  // row vector: [dx dy] = [lx ly] · [[a b] [c d]]
  return [(dx * d - dy * c) / det, (dy * a - dx * b) / det]
}
