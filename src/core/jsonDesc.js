// Full JSON description of a PDF (all indirect objects + trailer) and its inverse.
import {
  PDFContext, PDFHeader,
} from 'pdf-lib'
import {
  PDFDict, PDFArray, PDFName, PDFNumber, PDFString, PDFHexString, PDFBool, PDFNull, PDFRef, PDFRawStream, PDFStream,
  kindOf, N, latin1, fromLatin1, escapeLiteral, toHex, stringBytes, decodeStream, rawBytes, isTextLike, filtersOf,
  setStreamData, textToBytes,
} from './pdfobj.js'

const FORMAT = 'deePDF-description'

function b64(bytes) {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
  return btoa(s)
}
function unb64(s) {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function isPrintableAscii(bytes) {
  for (const b of bytes) if (!(b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127))) return false
  return true
}

export function valueToJSON(ctx, o, opts = {}) {
  switch (kindOf(o)) {
    case 'null': return null
    case 'bool': return o.asBoolean()
    case 'number': return o.asNumber()
    case 'name': return '/' + o.decodeText()
    case 'ref': return { $ref: `${o.objectNumber} ${o.generationNumber}` }
    case 'string': {
      const b = stringBytes(o)
      if (isPrintableAscii(b)) return { $str: latin1(b) }
      if (b[0] === 0xfe && b[1] === 0xff && b.length % 2 === 0) return { $str: o.decodeText(), utf16: true }
      return { $str_hex: toHex(b) }
    }
    case 'hex': {
      const b = stringBytes(o)
      if (b[0] === 0xfe && b[1] === 0xff && b.length % 2 === 0) return { $str: o.decodeText(), utf16: true, hex: true }
      return { $hex: toHex(b) }
    }
    case 'array': return o.asArray().map((x) => valueToJSON(ctx, x, opts))
    case 'dict': {
      const r = {}
      for (const [k, v] of o.entries()) r[k.decodeText()] = valueToJSON(ctx, v, opts)
      return r
    }
    case 'stream': {
      const dict = valueToJSON(ctx, o.dict, opts)
      delete dict.Length
      if (opts.lazyKeys && opts.lazyKeys.has(o)) return { $stream: dict, lazyKey: opts.lazyKeys.get(o) }
      const resident = opts.bytes && opts.bytes.has(o) ? PDFRawStream.of(o.dict, opts.bytes.get(o)) : o
      if (opts.decodeText !== false) {
        const d = decodeStream(ctx, resident)
        if (!d.error && !d.remaining.length && isTextLike(d.bytes, 1 << 20) && d.bytes.length < (opts.maxText || 4 << 20)) {
          return { $stream: dict, decoded: true, text: latin1(d.bytes) }
        }
      }
      return { $stream: dict, base64: b64(rawBytes(resident) || new Uint8Array()) }
    }
    case 'invalid': return { $invalid: true }
    default: return null
  }
}

export function contextToJSON(ctx, opts = {}) {
  const objects = {}
  const entries = ctx.enumerateIndirectObjects().sort((a, b) => a[0].objectNumber - b[0].objectNumber)
  for (const [ref, obj] of entries) objects[`${ref.objectNumber} ${ref.generationNumber}`] = valueToJSON(ctx, obj, opts)
  const trailer = {}
  for (const k of ['Root', 'Info', 'ID', 'Encrypt']) if (ctx.trailerInfo[k] !== undefined) trailer[k] = valueToJSON(ctx, ctx.trailerInfo[k], opts)
  const h = ctx.header
  return {
    format: FORMAT,
    formatVersion: 1,
    generator: 'deePDF',
    pdfVersion: `${h.major}.${h.minor}`,
    trailer,
    objects,
  }
}

export function valueFromJSON(ctx, v, opts = {}) {
  if (v === null || v === undefined) return PDFNull
  if (typeof v === 'boolean') return v ? PDFBool.True : PDFBool.False
  if (typeof v === 'number') return PDFNumber.of(v)
  if (typeof v === 'string') return PDFName.of(v.startsWith('/') ? v.slice(1) : v)
  if (Array.isArray(v)) {
    const a = PDFArray.withContext(ctx)
    for (const x of v) a.push(valueFromJSON(ctx, x, opts))
    return a
  }
  if (typeof v === 'object') {
    if ('$ref' in v) {
      const [n, g] = String(v.$ref).trim().split(/\s+/).map(Number)
      return PDFRef.of(n, g || 0)
    }
    if ('$str' in v) {
      const bytes = v.utf16 ? utf16(v.$str) : fromLatin1(v.$str)
      return v.hex ? PDFHexString.of(toHex(bytes)) : PDFString.of(escapeLiteral(bytes))
    }
    if ('$str_hex' in v) return PDFString.of(escapeLiteral(fromHexLoose(v.$str_hex)))
    if ('$hex' in v) return PDFHexString.of(String(v.$hex).replace(/\s+/g, ''))
    if ('$invalid' in v) return PDFNull
    if ('$stream' in v) {
      const dict = valueFromJSON(ctx, v.$stream, opts)
      const s = PDFRawStream.of(dict instanceof PDFDict ? dict : PDFDict.withContext(ctx), new Uint8Array())
      if (v.lazyKey && opts.lazy && opts.lazy.has(v.lazyKey)) {
        s.contents = opts.lazy.get(v.lazyKey)
        s.dict.set(N('Length'), PDFNumber.of(s.contents.length))
      } else if (v.decoded) {
        const keepFlate = filtersOf(ctx, s).includes('FlateDecode')
        setStreamData(ctx, s, fromLatin1(v.text || ''), keepFlate ? 'flate' : 'none')
      } else {
        s.contents = v.base64 ? unb64(v.base64) : new Uint8Array()
        s.dict.set(N('Length'), PDFNumber.of(s.contents.length))
      }
      return s
    }
    const d = PDFDict.withContext(ctx)
    for (const [k, x] of Object.entries(v)) d.set(PDFName.of(k.startsWith('/') ? k.slice(1) : k), valueFromJSON(ctx, x, opts))
    return d
  }
  return PDFNull
}

function utf16(text) {
  const out = new Uint8Array(2 + text.length * 2)
  out[0] = 0xfe; out[1] = 0xff
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[2 + i * 2] = c >> 8; out[3 + i * 2] = c & 0xff }
  return out
}

function fromHexLoose(h) {
  const clean = String(h).replace(/[^0-9a-fA-F]/g, '')
  const out = new Uint8Array(Math.ceil(clean.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2).padEnd(2, '0'), 16)
  return out
}

export function contextFromJSON(json, opts = {}) {
  if (!json || json.format !== FORMAT || !json.objects) throw new Error('Not a deePDF JSON description')
  const ctx = PDFContext.create()
  const [maj, min] = String(json.pdfVersion || '1.7').split('.').map(Number)
  ctx.header = PDFHeader.forVersion(maj || 1, isNaN(min) ? 7 : min)
  for (const [key, v] of Object.entries(json.objects)) {
    const [n, g] = key.trim().split(/\s+/).map(Number)
    if (!Number.isFinite(n)) continue
    ctx.assign(PDFRef.of(n, g || 0), valueFromJSON(ctx, v, opts))
  }
  for (const k of ['Root', 'Info', 'ID', 'Encrypt']) if (json.trailer && json.trailer[k] !== undefined) ctx.trailerInfo[k] = valueFromJSON(ctx, json.trailer[k], opts)
  return ctx
}

export { PDFStream }
