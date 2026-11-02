// Content stream tokenizer / parser / serializer / interpreter.
// Operands are kept in their original textual form so round-tripping is lossless.
import { latin1, fromLatin1 } from './pdfobj.js'

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])

export class ContentParseError extends Error {}

/**
 * Parse content-stream bytes into an operations list.
 * op: { op: 'Tj', args: [tok], inline?: { dict: [[k,tok]], data: Uint8Array } }
 * tok: {t:'num',v} {t:'name',v} {t:'str',v} {t:'hex',v} {t:'arr',v:[tok]} {t:'dict',v:[[k,tok]]} {t:'bool',v} {t:'null'}
 */
export function parseContent(bytes) {
  if (typeof bytes === 'string') bytes = fromLatin1(bytes)
  let i = 0
  const n = bytes.length
  const ops = []
  let stack = []

  const skipWs = () => {
    while (i < n) {
      const b = bytes[i]
      if (WS.has(b)) i++
      else if (b === 0x25) { while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++ }
      else break
    }
  }

  const readToken = () => {
    skipWs()
    if (i >= n) return null
    const b = bytes[i]
    if (b === 0x2f) { // name
      let s = i + 1
      i++
      while (i < n && !WS.has(bytes[i]) && !DELIM.has(bytes[i])) i++
      return { t: 'name', v: latin1(bytes.subarray(s, i)) }
    }
    if (b === 0x28) { // literal string
      let depth = 1
      const s = i + 1
      i++
      while (i < n && depth > 0) {
        const c = bytes[i]
        if (c === 0x5c) { i += 2; continue }
        if (c === 0x28) depth++
        else if (c === 0x29) depth--
        i++
      }
      return { t: 'str', v: latin1(bytes.subarray(s, i - 1)) }
    }
    if (b === 0x3c) {
      if (bytes[i + 1] === 0x3c) { // dict
        i += 2
        const entries = []
        for (;;) {
          skipWs()
          if (i >= n) break
          if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) { i += 2; break }
          const k = readToken()
          if (!k) break
          const v = readToken()
          entries.push([k.t === 'name' ? k.v : String(k.v), v || { t: 'null' }])
        }
        return { t: 'dict', v: entries }
      }
      const s = i + 1
      i++
      while (i < n && bytes[i] !== 0x3e) i++
      i++
      return { t: 'hex', v: latin1(bytes.subarray(s, i - 1)).replace(/\s+/g, '') }
    }
    if (b === 0x5b) {
      i++
      const items = []
      for (;;) {
        skipWs()
        if (i >= n) break
        if (bytes[i] === 0x5d) { i++; break }
        const t = readToken()
        if (!t) break
        if (t.t === 'op') { items.push({ t: 'name', v: t.v, bare: true }); continue }
        items.push(t)
      }
      return { t: 'arr', v: items }
    }
    if (b === 0x5d || b === 0x3e || b === 0x29 || b === 0x7b || b === 0x7d) { i++; return readToken() }
    // number or keyword
    const s = i
    while (i < n && !WS.has(bytes[i]) && !DELIM.has(bytes[i])) i++
    if (i === s) { i++; return readToken() }
    const word = latin1(bytes.subarray(s, i))
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: word }
    if (word === 'true' || word === 'false') return { t: 'bool', v: word === 'true' }
    if (word === 'null') return { t: 'null' }
    return { t: 'op', v: word }
  }

  for (;;) {
    const tok = readToken()
    if (!tok) break
    if (tok.t !== 'op') { stack.push(tok); continue }
    if (tok.v === 'BI') {
      // inline image: BI <dict entries> ID <data> EI
      const entries = []
      for (;;) {
        const k = readToken()
        if (!k) break
        if (k.t === 'op' && k.v === 'ID') break
        const v = readToken()
        entries.push([k.t === 'name' ? k.v : String(k.v), v || { t: 'null' }])
      }
      // single white-space after ID
      if (WS.has(bytes[i])) i++
      const start = i
      let dataEnd = -1
      let eiPos = -1
      const lenEntry = entries.find(([k]) => k === 'L' || k === 'Length')
      if (lenEntry && lenEntry[1].t === 'num') {
        const L = parseInt(lenEntry[1].v, 10)
        let k = start + L
        while (k < n && WS.has(bytes[k])) k++
        if (bytes[k] === 0x45 && bytes[k + 1] === 0x49) { dataEnd = start + L; eiPos = k }
      }
      if (eiPos < 0) {
        for (let j = start + 1; j < n - 1; j++) {
          if (bytes[j] === 0x45 && bytes[j + 1] === 0x49 && WS.has(bytes[j - 1]) && (j + 2 >= n || WS.has(bytes[j + 2]) || DELIM.has(bytes[j + 2]))) {
            eiPos = j
            dataEnd = j - 1
            break
          }
        }
      }
      if (eiPos < 0) { dataEnd = n; eiPos = n }
      const data = bytes.slice(start, dataEnd)
      i = Math.min(n, eiPos + 2)
      ops.push({ op: 'BI', args: [], inline: { dict: entries, data } })
      stack = []
      continue
    }
    ops.push({ op: tok.v, args: stack })
    stack = []
  }
  if (stack.length) ops.push({ op: '', args: stack, dangling: true })
  return ops
}

export function tokToString(t) {
  switch (t.t) {
    case 'num': return t.v
    case 'name': return t.bare ? t.v : '/' + t.v
    case 'str': return '(' + t.v + ')'
    case 'hex': return '<' + t.v + '>'
    case 'bool': return t.v ? 'true' : 'false'
    case 'null': return 'null'
    case 'arr': return '[' + t.v.map(tokToString).join(' ') + ']'
    case 'dict': return '<<' + t.v.map(([k, v]) => '/' + k + ' ' + tokToString(v)).join(' ') + '>>'
    default: return ''
  }
}

/** Text (latin1 string) of one operation; inline images get their binary data as latin1. */
export function opToString(o) {
  if (o.inline) {
    const d = o.inline.dict.map(([k, v]) => '/' + k + ' ' + tokToString(v)).join(' ')
    return 'BI ' + d + ' ID ' + latin1(o.inline.data) + '\nEI'
  }
  const a = o.args.map(tokToString).join(' ')
  return o.op ? (a ? a + ' ' + o.op : o.op) : a
}

/** Display text of one operation (inline image data abbreviated). */
export function opToDisplay(o) {
  if (o.inline) {
    const d = o.inline.dict.map(([k, v]) => '/' + k + ' ' + tokToString(v)).join(' ')
    return `BI ${d} ID …${o.inline.data.length} bytes… EI`
  }
  return opToString(o)
}

export function serializeOps(ops) {
  const parts = []
  for (const o of ops) parts.push(opToString(o))
  return fromLatin1(parts.join('\n') + '\n')
}

/* ---------- decoding text strings for display ---------- */

export function decodeLiteral(raw) {
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c !== '\\') { out.push(c.charCodeAt(0) & 0xff); continue }
    const d = raw[++i]
    if (d === undefined) break
    if (d === 'n') out.push(10)
    else if (d === 'r') out.push(13)
    else if (d === 't') out.push(9)
    else if (d === 'b') out.push(8)
    else if (d === 'f') out.push(12)
    else if (d === '\r') { if (raw[i + 1] === '\n') i++ }
    else if (d === '\n') { /* line continuation */ }
    else if (d >= '0' && d <= '7') {
      let oct = d
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i]
      out.push(parseInt(oct, 8) & 0xff)
    } else out.push(d.charCodeAt(0) & 0xff)
  }
  return new Uint8Array(out)
}

export function tokBytes(t) {
  if (t.t === 'str') return decodeLiteral(t.v)
  if (t.t === 'hex') {
    const h = t.v.length % 2 ? t.v + '0' : t.v
    const out = new Uint8Array(h.length / 2)
    for (let k = 0; k < out.length; k++) out[k] = parseInt(h.substr(k * 2, 2), 16) || 0
    return out
  }
  return new Uint8Array()
}

export function guessText(bytes, twoByte) {
  if (twoByte) {
    let s = ''
    for (let k = 0; k + 1 < bytes.length; k += 2) {
      const c = (bytes[k] << 8) | bytes[k + 1]
      s += c >= 32 && c < 0xfffe ? String.fromCharCode(c) : '·'
    }
    return s
  }
  let s = ''
  for (const b of bytes) s += b >= 32 && b < 127 ? String.fromCharCode(b) : b >= 160 ? String.fromCharCode(b) : '·'
  return s
}

/* ---------- element tree ---------- */

export const PATH_CONSTRUCT = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're'])
export const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'])
const CLIP = new Set(['W', 'W*'])
export const TEXT_SHOW = new Set(['Tj', 'TJ', "'", '"'])

let nodeSeq = 0
/**
 * Group operations into a tree of elements.
 * node: { id, type, from, to, children? }  (from/to are inclusive op indices)
 * types: group(q..Q) text(BT..ET) marked(BMC/BDC..EMC) compat(BX..EX) path xobject shading inline op
 */
export function buildTree(ops) {
  const root = { id: 'root', type: 'root', from: 0, to: ops.length - 1, children: [] }
  const stack = [root]
  const closers = { q: 'Q', BT: 'ET', BMC: 'EMC', BDC: 'EMC', BX: 'EX' }
  const types = { q: 'group', BT: 'text', BMC: 'marked', BDC: 'marked', BX: 'compat' }
  let pathStart = -1
  const top = () => stack[stack.length - 1]
  const leaf = (type, from, to) => top().children.push({ id: 'n' + ++nodeSeq, type, from, to })

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i].op
    if (pathStart >= 0) {
      if (PATH_CONSTRUCT.has(op) || CLIP.has(op)) continue
      if (PATH_PAINT.has(op)) { leaf('path', pathStart, i); pathStart = -1; continue }
      // path interrupted: flush as unpainted path
      leaf('path', pathStart, i - 1)
      pathStart = -1
    }
    if (closers[op]) {
      const node = { id: 'n' + ++nodeSeq, type: types[op], from: i, to: i, children: [], open: op }
      top().children.push(node)
      stack.push(node)
      continue
    }
    const t = top()
    if (t.open && closers[t.open] === op) {
      t.to = i
      stack.pop()
      continue
    }
    if (op === 'Q' || op === 'ET' || op === 'EMC' || op === 'EX') {
      // mismatched closer: look further down the stack
      let idx = -1
      for (let s = stack.length - 1; s > 0; s--) if (closers[stack[s].open] === op) { idx = s; break }
      if (idx > 0) {
        while (stack.length > idx + 1) { const x = stack.pop(); x.to = i - 1; x.unclosed = true }
        stack[idx].to = i
        stack.pop()
        continue
      }
      leaf('op', i, i)
      continue
    }
    if (PATH_CONSTRUCT.has(op)) { pathStart = i; continue }
    if (op === 'Do') { leaf('xobject', i, i); continue }
    if (op === 'sh') { leaf('shading', i, i); continue }
    if (op === 'BI') { leaf('inline', i, i); continue }
    leaf('op', i, i)
  }
  if (pathStart >= 0) leaf('path', pathStart, ops.length - 1)
  while (stack.length > 1) { const x = stack.pop(); x.to = ops.length - 1; x.unclosed = true }
  return root
}

export function walkTree(node, fn, parent = null) {
  fn(node, parent)
  if (node.children) for (const c of node.children) walkTree(c, fn, node)
}

/* ---------- interpreter (bounding boxes) ---------- */

export const IDENTITY = [1, 0, 0, 1, 0, 0]
export function mul(m, n) {
  // m then n  (p' = p * m * n)
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ]
}
export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}
function bboxOfPoints(pts) {
  if (!pts.length) return null
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const [x, y] of pts) {
    if (!isFinite(x) || !isFinite(y)) continue
    if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y
  }
  return x1 === Infinity ? null : [x1, y1, x2, y2]
}
function rectPts(m, x1, y1, x2, y2) {
  return [apply(m, x1, y1), apply(m, x2, y1), apply(m, x1, y2), apply(m, x2, y2)]
}
export function unionBox(a, b) {
  if (!a) return b
  if (!b) return a
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}
const num = (t) => (t && t.t === 'num' ? parseFloat(t.v) : 0)

/**
 * Compute an approximate user-space bounding box for every op.
 * env: { resolveFont(name) => {widthOf(code), twoByte} | null, resolveXObject(name) => {subtype, bbox, matrix} | null }
 */
export function computeBoxes(ops, env = {}, baseCtm = IDENTITY) {
  const boxes = new Array(ops.length).fill(null)
  const gsStack = []
  let ctm = baseCtm.slice()
  let ts = { font: null, size: 12, Tc: 0, Tw: 0, Th: 1, TL: 0, rise: 0 }
  let Tm = IDENTITY.slice(), Tlm = IDENTITY.slice()
  let path = [], pathOps = []
  let fontCache = new Map()
  const font = () => {
    if (!ts.font) return null
    if (!fontCache.has(ts.font)) fontCache.set(ts.font, env.resolveFont ? env.resolveFont(ts.font) : null)
    return fontCache.get(ts.font)
  }

  const showString = (i, bytes) => {
    const f = font()
    const twoByte = f ? f.twoByte : false
    const fs = ts.size
    let w = 0
    const step = twoByte ? 2 : 1
    for (let k = 0; k + step - 1 < bytes.length; k += step) {
      const code = twoByte ? (bytes[k] << 8) | bytes[k + 1] : bytes[k]
      const gw = f ? f.widthOf(code) : 500
      w += (gw / 1000) * fs + ts.Tc + (!twoByte && code === 32 ? ts.Tw : 0)
    }
    w *= ts.Th
    const trm = mul(Tm, ctm)
    const lo = -0.22 * Math.abs(fs) + ts.rise, hi = 0.88 * Math.abs(fs) + ts.rise
    const box = bboxOfPoints(rectPts(trm, 0, lo, w, hi))
    boxes[i] = unionBox(boxes[i], box)
    Tm = mul([1, 0, 0, 1, w, 0], Tm)
  }

  for (let i = 0; i < ops.length; i++) {
    const { op, args } = ops[i]
    switch (op) {
      case 'q': gsStack.push({ ctm, ts: { ...ts } }); break
      case 'Q': { const s = gsStack.pop(); if (s) { ctm = s.ctm; ts = s.ts } break }
      case 'cm': if (args.length >= 6) ctm = mul(args.slice(0, 6).map(num), ctm); break
      case 'BT': Tm = IDENTITY.slice(); Tlm = IDENTITY.slice(); break
      case 'Tf': ts.font = args[0] && args[0].t === 'name' ? args[0].v : null; ts.size = num(args[1]); break
      case 'Tc': ts.Tc = num(args[0]); break
      case 'Tw': ts.Tw = num(args[0]); break
      case 'Tz': ts.Th = num(args[0]) / 100; break
      case 'TL': ts.TL = num(args[0]); break
      case 'Ts': ts.rise = num(args[0]); break
      case 'Td': Tlm = mul([1, 0, 0, 1, num(args[0]), num(args[1])], Tlm); Tm = Tlm.slice(); break
      case 'TD': ts.TL = -num(args[1]); Tlm = mul([1, 0, 0, 1, num(args[0]), num(args[1])], Tlm); Tm = Tlm.slice(); break
      case 'Tm': Tlm = args.slice(0, 6).map(num); Tm = Tlm.slice(); break
      case 'T*': Tlm = mul([1, 0, 0, 1, 0, -ts.TL], Tlm); Tm = Tlm.slice(); break
      case 'Tj': if (args[0]) showString(i, tokBytes(args[0])); break
      case "'": Tlm = mul([1, 0, 0, 1, 0, -ts.TL], Tlm); Tm = Tlm.slice(); if (args[0]) showString(i, tokBytes(args[0])); break
      case '"': ts.Tw = num(args[0]); ts.Tc = num(args[1]); Tlm = mul([1, 0, 0, 1, 0, -ts.TL], Tlm); Tm = Tlm.slice(); if (args[2]) showString(i, tokBytes(args[2])); break
      case 'TJ': {
        const arr = args[0] && args[0].t === 'arr' ? args[0].v : []
        for (const el of arr) {
          if (el.t === 'num') Tm = mul([1, 0, 0, 1, (-parseFloat(el.v) / 1000) * ts.size * ts.Th, 0], Tm)
          else if (el.t === 'str' || el.t === 'hex') showString(i, tokBytes(el))
        }
        break
      }
      case 'm': case 'l': path.push(apply(ctm, num(args[0]), num(args[1]))); pathOps.push(i); break
      case 'c': for (let k = 0; k < 6; k += 2) path.push(apply(ctm, num(args[k]), num(args[k + 1]))); pathOps.push(i); break
      case 'v': case 'y': for (let k = 0; k < 4; k += 2) path.push(apply(ctm, num(args[k]), num(args[k + 1]))); pathOps.push(i); break
      case 're': {
        const x = num(args[0]), y = num(args[1]), w = num(args[2]), h = num(args[3])
        path.push(...rectPts(ctm, x, y, x + w, y + h)); pathOps.push(i); break
      }
      case 'h': case 'W': case 'W*': pathOps.push(i); break
      case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'n': {
        const box = bboxOfPoints(path)
        for (const k of pathOps) boxes[k] = box
        boxes[i] = box
        path = []; pathOps = []
        break
      }
      case 'Do': {
        const name = args[0] && args[0].t === 'name' ? args[0].v : null
        const xo = name && env.resolveXObject ? env.resolveXObject(name) : null
        if (xo && xo.subtype === 'Form') {
          const m = mul(xo.matrix || IDENTITY, ctm)
          const b = xo.bbox || [0, 0, 1, 1]
          boxes[i] = bboxOfPoints(rectPts(m, b[0], b[1], b[2], b[3]))
        } else boxes[i] = bboxOfPoints(rectPts(ctm, 0, 0, 1, 1))
        break
      }
      case 'BI': boxes[i] = bboxOfPoints(rectPts(ctm, 0, 0, 1, 1)); break
      default: break
    }
  }
  return boxes
}

export function nodeBox(node, boxes) {
  let b = null
  for (let k = node.from; k <= node.to; k++) b = unionBox(b, boxes[k])
  return b
}
