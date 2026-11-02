// Low-level helpers around pdf-lib's object model.
import {
  PDFDict, PDFArray, PDFName, PDFNumber, PDFString, PDFHexString, PDFBool,
  PDFNull, PDFRef, PDFRawStream, PDFStream, PDFInvalidObject, decodePDFRawStream,
} from 'pdf-lib'
import pako from 'pako'

export { PDFDict, PDFArray, PDFName, PDFNumber, PDFString, PDFHexString, PDFBool, PDFNull, PDFRef, PDFRawStream, PDFStream }

export const N = (s) => PDFName.of(s)

export function kindOf(o) {
  if (o === undefined) return 'missing'
  if (o instanceof PDFRef) return 'ref'
  if (o instanceof PDFDict) return 'dict'
  if (o instanceof PDFArray) return 'array'
  if (o instanceof PDFStream) return 'stream'
  if (o instanceof PDFName) return 'name'
  if (o instanceof PDFNumber) return 'number'
  if (o instanceof PDFHexString) return 'hex'
  if (o instanceof PDFString) return 'string'
  if (o instanceof PDFBool) return 'bool'
  if (o === PDFNull) return 'null'
  if (o instanceof PDFInvalidObject) return 'invalid'
  return 'unknown'
}

export const isDictLike = (o) => o instanceof PDFDict || o instanceof PDFStream
export const dictOf = (o) => (o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null)

export function deref(ctx, o) {
  let guard = 0
  while (o instanceof PDFRef && guard++ < 32) o = ctx.lookup(o)
  return o
}

export function nameStr(o) {
  return o instanceof PDFName ? o.decodeText() : undefined
}

export function getKey(ctx, dictLike, key) {
  const d = dictOf(dictLike)
  if (!d) return undefined
  return deref(ctx, d.get(N(key)))
}

export function numVal(o) {
  return o instanceof PDFNumber ? o.asNumber() : undefined
}

export function numArray(ctx, o) {
  o = deref(ctx, o)
  if (!(o instanceof PDFArray)) return null
  const out = []
  for (const it of o.asArray()) {
    const v = deref(ctx, it)
    if (!(v instanceof PDFNumber)) return null
    out.push(v.asNumber())
  }
  return out
}

export function refKey(ref) {
  return `${ref.objectNumber} ${ref.generationNumber}`
}
export function parseRefKey(s) {
  const m = String(s).trim().match(/^(\d+)(?:\s+(\d+))?(?:\s+R)?$/)
  if (!m) return null
  return PDFRef.of(+m[1], m[2] ? +m[2] : 0)
}

/* ---------- strings ---------- */

export function latin1(bytes) {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
  return s
}
export function fromLatin1(str) {
  const b = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xff
  return b
}
export function toHex(bytes, sep = '') {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += (i && sep ? sep : '') + bytes[i].toString(16).padStart(2, '0').toUpperCase()
  return s
}
export function fromHex(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const padded = clean.length % 2 ? clean + '0' : clean
  const out = new Uint8Array(padded.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.substr(i * 2, 2), 16)
  return out
}

export function escapeLiteral(bytes) {
  let s = ''
  for (const b of bytes) {
    if (b === 0x28) s += '\\('
    else if (b === 0x29) s += '\\)'
    else if (b === 0x5c) s += '\\\\'
    else if (b === 0x0a) s += '\\n'
    else if (b === 0x0d) s += '\\r'
    else if (b === 0x09) s += '\\t'
    else if (b === 0x08) s += '\\b'
    else if (b === 0x0c) s += '\\f'
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0')
    else s += String.fromCharCode(b)
  }
  return s
}

export function stringBytes(o) {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.asBytes()
  return new Uint8Array()
}

export function stringText(o) {
  try {
    return o.decodeText()
  } catch {
    return latin1(stringBytes(o))
  }
}

/** Encode user text as bytes: ASCII stays single byte, otherwise UTF-16BE with BOM. */
export function textToBytes(text) {
  let ascii = true
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7e) { ascii = false; break }
  if (ascii) return fromLatin1(text)
  const out = new Uint8Array(2 + text.length * 2)
  out[0] = 0xfe; out[1] = 0xff
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    out[2 + i * 2] = c >> 8
    out[3 + i * 2] = c & 0xff
  }
  return out
}

export function makeString(text, asHex = false) {
  const bytes = textToBytes(text)
  return asHex ? PDFHexString.of(toHex(bytes)) : PDFString.of(escapeLiteral(bytes))
}
export function makeStringFromBytes(bytes, asHex = false) {
  return asHex ? PDFHexString.of(toHex(bytes)) : PDFString.of(escapeLiteral(bytes))
}

/* ---------- cloning ---------- */

/** Deep clone of direct structure. Stream byte buffers are shared (treated as immutable). */
export function cloneObj(o, ctx) {
  if (o instanceof PDFDict) {
    const m = new Map()
    for (const [k, v] of o.entries()) m.set(k, cloneObj(v, ctx))
    return PDFDict.fromMapWithContext(m, ctx)
  }
  if (o instanceof PDFArray) {
    const a = PDFArray.withContext(ctx)
    for (const v of o.asArray()) a.push(cloneObj(v, ctx))
    return a
  }
  if (o instanceof PDFRawStream) return PDFRawStream.of(cloneObj(o.dict, ctx), o.contents)
  if (o instanceof PDFStream) return PDFRawStream.of(cloneObj(o.dict, ctx), o.getContents())
  return o
}

/* ---------- streams ---------- */

export function filtersOf(ctx, stream) {
  const f = deref(ctx, stream.dict.get(N('Filter')))
  if (f instanceof PDFName) return [f.decodeText()]
  if (f instanceof PDFArray) return f.asArray().map((x) => nameStr(deref(ctx, x)) || '?')
  return []
}
function parmsOf(ctx, stream, i) {
  let p = deref(ctx, stream.dict.get(N('DecodeParms')) || stream.dict.get(N('DP')))
  if (p instanceof PDFArray) p = deref(ctx, p.get(i))
  return p instanceof PDFDict ? p : null
}

const FILTER_ALIASES = { Fl: 'FlateDecode', LZW: 'LZWDecode', AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', RL: 'RunLengthDecode', DCT: 'DCTDecode', CCF: 'CCITTFaxDecode' }
export const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode'])
export const DECODABLE = new Set(['FlateDecode', 'LZWDecode', 'ASCIIHexDecode', 'ASCII85Decode', 'RunLengthDecode', 'Crypt'])

function inflateLenient(bytes) {
  try {
    return pako.inflate(bytes)
  } catch (e) {
    // try to salvage truncated / slightly corrupt data
    const inf = new pako.Inflate()
    inf.push(bytes, false)
    if (inf.result && inf.result.length) return inf.result
    const chunks = []
    try {
      const raw = new pako.Inflate({ raw: true })
      raw.onData = (c) => chunks.push(c)
      raw.push(bytes.subarray(2), false)
    } catch { /* ignore */ }
    if (chunks.length) return concatBytes(chunks)
    throw e
  }
}

export function concatBytes(chunks) {
  let len = 0
  for (const c of chunks) len += c.length
  const out = new Uint8Array(len)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

function applyPredictor(ctx, data, parms) {
  if (!parms) return data
  const predictor = numVal(deref(ctx, parms.get(N('Predictor')))) || 1
  if (predictor <= 1) return data
  const colors = numVal(deref(ctx, parms.get(N('Colors')))) || 1
  const bpc = numVal(deref(ctx, parms.get(N('BitsPerComponent')))) || 8
  const columns = numVal(deref(ctx, parms.get(N('Columns')))) || 1
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowLen = Math.ceil((colors * bpc * columns) / 8)
  if (predictor === 2) {
    if (bpc !== 8) return data
    const out = new Uint8Array(data)
    for (let r = 0; r + rowLen <= out.length; r += rowLen)
      for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff
    return out
  }
  // PNG predictors
  const rows = Math.floor(data.length / (rowLen + 1))
  const out = new Uint8Array(rows * rowLen)
  let prev = new Uint8Array(rowLen)
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)]
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1))
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen)
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = src[i]
      switch (type) {
        case 1: v += a; break
        case 2: v += b; break
        case 3: v += (a + b) >> 1; break
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          break
        }
        default: break
      }
      cur[i] = v & 0xff
    }
    prev = cur
  }
  return out
}

function decodeWithPdfLib(ctx, filter, bytes) {
  const d = PDFDict.withContext(ctx)
  d.set(N('Filter'), N(filter))
  const s = PDFRawStream.of(d, bytes)
  return decodePDFRawStream(s).decode()
}

/**
 * Decode a stream through all decodable filters.
 * Returns { bytes, remaining: [filters not applied], error }
 */
export function decodeStream(ctx, stream) {
  const raw = stream instanceof PDFRawStream ? stream.contents : stream.getContents()
  const filters = filtersOf(ctx, stream).map((f) => FILTER_ALIASES[f] || f)
  let data = raw
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i]
    if (!DECODABLE.has(f)) return { bytes: data, remaining: filters.slice(i), error: null }
    try {
      if (f === 'FlateDecode') data = applyPredictor(ctx, inflateLenient(data), parmsOf(ctx, stream, i))
      else if (f === 'LZWDecode') data = applyPredictor(ctx, decodeWithPdfLib(ctx, f, data), parmsOf(ctx, stream, i))
      else if (f === 'Crypt') { /* identity */ }
      else data = decodeWithPdfLib(ctx, f, data)
    } catch (e) {
      return { bytes: data, remaining: filters.slice(i), error: `${f}: ${e.message || e}` }
    }
  }
  return { bytes: data, remaining: [], error: null }
}

export function rawBytes(stream) {
  return stream instanceof PDFRawStream ? stream.contents : stream.getContents()
}

/**
 * Replace a stream's decoded data, re-encoding it.
 * mode: 'flate' | 'none' | 'keep' (keep = flate if the stream was flate-compressed, otherwise none)
 */
export function setStreamData(ctx, stream, bytes, mode = 'keep') {
  const filters = filtersOf(ctx, stream).map((f) => FILTER_ALIASES[f] || f)
  let useFlate = mode === 'flate' || (mode === 'keep' && filters.includes('FlateDecode'))
  const d = stream.dict
  d.delete(N('Filter'))
  d.delete(N('DecodeParms'))
  d.delete(N('DP'))
  d.delete(N('DL'))
  let contents = bytes
  if (useFlate) {
    contents = pako.deflate(bytes)
    d.set(N('Filter'), N('FlateDecode'))
  }
  stream.contents = contents
  d.set(N('Length'), PDFNumber.of(contents.length))
}

/** Replace a stream's raw (already-encoded) contents keeping its dictionary. */
export function setStreamRaw(stream, contents) {
  stream.contents = contents
  stream.dict.set(N('Length'), PDFNumber.of(contents.length))
}

export function isTextLike(bytes, limit = 4096) {
  const n = Math.min(bytes.length, limit)
  if (!n) return true
  let bad = 0
  for (let i = 0; i < n; i++) {
    const b = bytes[i]
    if (b === 9 || b === 10 || b === 13 || b === 12 || (b >= 32 && b < 127)) continue
    bad++
  }
  return bad / n < 0.1
}

/* ---------- summaries ---------- */

export function typeLabel(ctx, o) {
  const d = dictOf(o)
  if (!d) return ''
  const t = nameStr(deref(ctx, d.get(N('Type'))))
  const st = nameStr(deref(ctx, d.get(N('Subtype')))) || nameStr(deref(ctx, d.get(N('S'))))
  if (t && st) return `${t}/${st}`
  if (t) return t
  if (st) return st
  if (d.has(N('FT'))) return `Field/${nameStr(deref(ctx, d.get(N('FT'))))}`
  if (d.has(N('BaseFont'))) return 'Font'
  return ''
}

export function shortValue(ctx, o, depth = 0) {
  const k = kindOf(o)
  switch (k) {
    case 'ref': {
      const t = ctx ? typeLabel(ctx, ctx.lookup(o)) : ''
      return `${o.objectNumber} ${o.generationNumber} R${t ? ' → ' + t : ''}`
    }
    case 'name': return '/' + o.decodeText()
    case 'number': return String(o.asNumber())
    case 'bool': return String(o.asBoolean())
    case 'null': return 'null'
    case 'string': case 'hex': {
      const t = stringText(o)
      return (k === 'hex' ? '<' : '(') + (t.length > 40 ? t.slice(0, 40) + '…' : t) + (k === 'hex' ? '>' : ')')
    }
    case 'array': {
      if (depth > 0) return `[${o.size()}]`
      const items = o.asArray().slice(0, 6).map((x) => shortValue(ctx, x, depth + 1))
      return `[${items.join(' ')}${o.size() > 6 ? ' …' : ''}]`
    }
    case 'dict': {
      const t = typeLabel(ctx, o)
      return `<<${t ? ' ' + t : ''} ${o.keys().length} keys>>`
    }
    case 'stream': {
      const t = typeLabel(ctx, o)
      const f = filtersOf(ctx, o)
      return `stream${t ? ' ' + t : ''} ${rawBytes(o).length} B${f.length ? ' ' + f.join(',') : ''}`
    }
    case 'invalid': return '(invalid object)'
    default: return '?'
  }
}

/** Collect all refs contained (directly) in an object. */
export function collectRefs(o, out = []) {
  if (o instanceof PDFRef) out.push(o)
  else if (o instanceof PDFDict) for (const v of o.values()) collectRefs(v, out)
  else if (o instanceof PDFArray) for (const v of o.asArray()) collectRefs(v, out)
  else if (o instanceof PDFStream) collectRefs(o.dict, out)
  return out
}

/** Walk and replace refs according to fn(ref) => newObj|undefined. Mutates in place. */
export function mapRefs(o, fn) {
  if (o instanceof PDFDict) {
    for (const [k, v] of o.entries()) {
      if (v instanceof PDFRef) { const r = fn(v); if (r !== undefined) o.set(k, r) }
      else mapRefs(v, fn)
    }
  } else if (o instanceof PDFArray) {
    const arr = o.asArray()
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]
      if (v instanceof PDFRef) { const r = fn(v); if (r !== undefined) o.set(i, r) }
      else mapRefs(v, fn)
    }
  } else if (o instanceof PDFStream) mapRefs(o.dict, fn)
}

export function trailerEntries(ctx) {
  const t = ctx.trailerInfo
  return ['Root', 'Info', 'ID', 'Encrypt'].filter((k) => t[k] !== undefined).map((k) => [k, t[k]])
}

export function defaultValueFor(kind, ctx) {
  switch (kind) {
    case 'null': return PDFNull
    case 'bool': return PDFBool.False
    case 'number': return PDFNumber.of(0)
    case 'name': return N('Name')
    case 'string': return PDFString.of('')
    case 'hex': return PDFHexString.of('')
    case 'array': return PDFArray.withContext(ctx)
    case 'dict': return PDFDict.withContext(ctx)
    case 'ref': return PDFRef.of(1, 0)
    default: return PDFNull
  }
}

/** Best-effort conversion between value kinds. */
export function convertValue(ctx, o, kind) {
  const k = kindOf(o)
  if (k === kind) return o
  const text = k === 'string' || k === 'hex' ? stringText(o) : k === 'name' ? o.decodeText() : k === 'number' ? String(o.asNumber()) : null
  switch (kind) {
    case 'number': { const v = parseFloat(text); return PDFNumber.of(isFinite(v) ? v : 0) }
    case 'name': return N(text ?? 'Name')
    case 'string': return k === 'hex' ? makeStringFromBytes(o.asBytes()) : makeString(text ?? '')
    case 'hex': return k === 'string' ? makeStringFromBytes(o.asBytes(), true) : makeString(text ?? '', true)
    case 'bool': return text === 'true' ? PDFBool.True : PDFBool.False
    case 'array': { const a = PDFArray.withContext(ctx); if (k !== 'null') a.push(o); return a }
    default: return defaultValueFor(kind, ctx)
  }
}

export function fmtNum(n) {
  if (!isFinite(n)) return '0'
  const r = Math.round(n * 10000) / 10000
  return String(r)
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}
