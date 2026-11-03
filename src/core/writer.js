// PDF writer producing a Blob. Large stream data stays disk-backed (Blob parts), so writing a big
// document does not require holding it in memory. Supports a classic xref table or
// compressed object streams + cross-reference stream.
import pako from 'pako'
import { PDFDict, PDFArray, PDFNumber, PDFName, PDFRef, PDFRawStream, PDFStream, PDFInvalidObject } from 'pdf-lib'
import { isLazy } from './lazy.js'

const enc = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b }
function objBytes(o) {
  const n = o.sizeInBytes()
  const b = new Uint8Array(n)
  o.copyBytesInto(b, 0)
  return b
}

class Parts {
  constructor() { this.parts = []; this.size = 0 }
  push(p) {
    if (typeof p === 'string') p = enc(p)
    this.parts.push(p)
    this.size += p instanceof Blob ? p.size : p.length
  }
}

function streamParts(stream) {
  const c = stream instanceof PDFRawStream ? stream.contents : stream.getContents()
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(c.length))
  return { dict: objBytes(stream.dict), data: isLazy(c) ? c.blob : c }
}

function trailerDict(ctx, size, extra = {}) {
  const d = PDFDict.withContext(ctx)
  for (const [k, v] of Object.entries(extra)) d.set(PDFName.of(k), v)
  d.set(PDFName.of('Size'), PDFNumber.of(size))
  for (const k of ['Root', 'Encrypt', 'Info', 'ID']) if (ctx.trailerInfo[k] !== undefined) d.set(PDFName.of(k), ctx.trailerInfo[k])
  return d
}

/**
 * Write the context.
 * returns { blob, offsets: Map(objNum → {offset, gen} | {stm, index}), xrefOffset, classic }
 */
export function writePdf(ctx, { objectStreams = false, objectsPerStream = 100 } = {}) {
  const out = new Parts()
  const h = ctx.header
  out.push(`%PDF-${h.major}.${h.minor}\n%`)
  out.push(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))
  const objs = ctx.enumerateIndirectObjects().sort((a, b) => a[0].objectNumber - b[0].objectNumber)
  const offsets = new Map()
  let maxNum = objs.length ? objs[objs.length - 1][0].objectNumber : 0
  const encryptRef = ctx.trailerInfo.Encrypt instanceof PDFRef ? ctx.trailerInfo.Encrypt : null
  const canPack = objectStreams && !ctx.trailerInfo.Encrypt

  const writeIndirect = (ref, o) => {
    offsets.set(ref.objectNumber, { offset: out.size, gen: ref.generationNumber })
    out.push(`${ref.objectNumber} ${ref.generationNumber} obj\n`)
    if (o instanceof PDFStream) {
      const sp = streamParts(o)
      out.push(sp.dict)
      out.push('\nstream\n')
      out.push(sp.data)
      out.push('\nendstream\nendobj\n')
    } else if (o === undefined) {
      out.push('null\nendobj\n')
    } else {
      out.push(objBytes(o))
      out.push('\nendobj\n')
    }
  }

  if (!canPack) {
    for (const [ref, o] of objs) writeIndirect(ref, o)
    const xrefOffset = out.size
    // subsections of consecutive object numbers
    const nums = [...offsets.keys()].sort((a, b) => a - b)
    let x = 'xref\n'
    const sections = []
    let cur = { start: 0, entries: ['0000000000 65535 f \n'] }
    let expect = 1
    for (const n of nums) {
      if (n !== expect) { sections.push(cur); cur = { start: n, entries: [] } }
      const e = offsets.get(n)
      cur.entries.push(`${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n \n`)
      expect = n + 1
    }
    sections.push(cur)
    for (const s of sections) x += `${s.start} ${s.entries.length}\n${s.entries.join('')}`
    out.push(x)
    out.push('trailer\n')
    out.push(objBytes(trailerDict(ctx, maxNum + 1)))
    out.push(`\nstartxref\n${xrefOffset}\n%%EOF\n`)
    return { blob: new Blob(out.parts, { type: 'application/pdf' }), offsets, xrefOffset, classic: true }
  }

  // object streams: pack non-stream objects with generation 0
  const packable = []
  for (const [ref, o] of objs) {
    if (o instanceof PDFStream || ref.generationNumber !== 0 || ref === encryptRef || o instanceof PDFInvalidObject) writeIndirect(ref, o)
    else packable.push([ref, o])
  }
  let nextNum = maxNum + 1
  for (let i = 0; i < packable.length; i += objectsPerStream) {
    const chunk = packable.slice(i, i + objectsPerStream)
    const stmNum = nextNum++
    const bodies = chunk.map(([, o]) => objBytes(o))
    let header = ''
    let off = 0
    chunk.forEach(([ref], k) => { header += `${ref.objectNumber} ${off} `; off += bodies[k].length + 1 })
    const headerBytes = enc(header)
    const data = new Uint8Array(headerBytes.length + off)
    data.set(headerBytes, 0)
    let p = headerBytes.length
    bodies.forEach((b) => { data.set(b, p); p += b.length; data[p++] = 0x0a })
    const compressed = pako.deflate(data)
    const d = PDFDict.withContext(ctx)
    d.set(PDFName.of('Type'), PDFName.of('ObjStm'))
    d.set(PDFName.of('N'), PDFNumber.of(chunk.length))
    d.set(PDFName.of('First'), PDFNumber.of(headerBytes.length))
    d.set(PDFName.of('Filter'), PDFName.of('FlateDecode'))
    const stm = PDFRawStream.of(d, compressed)
    writeIndirect(PDFRef.of(stmNum), stm)
    chunk.forEach(([ref], k) => offsets.set(ref.objectNumber, { stm: stmNum, index: k }))
  }
  const xrefNum = nextNum++
  const size = xrefNum + 1
  const xrefOffset = out.size
  offsets.set(xrefNum, { offset: xrefOffset, gen: 0 })
  const W = [1, 4, 2]
  const rows = new Uint8Array(size * 7)
  for (let n = 0; n < size; n++) {
    const e = offsets.get(n)
    const r = n * 7
    if (!e) { rows[r] = 0; if (n === 0) { rows[r + 5] = 0xff; rows[r + 6] = 0xff } continue }
    if (e.stm !== undefined) {
      rows[r] = 2
      rows[r + 1] = (e.stm >>> 24) & 0xff; rows[r + 2] = (e.stm >>> 16) & 0xff; rows[r + 3] = (e.stm >>> 8) & 0xff; rows[r + 4] = e.stm & 0xff
      rows[r + 5] = (e.index >>> 8) & 0xff; rows[r + 6] = e.index & 0xff
    } else {
      rows[r] = 1
      rows[r + 1] = (e.offset >>> 24) & 0xff; rows[r + 2] = (e.offset >>> 16) & 0xff; rows[r + 3] = (e.offset >>> 8) & 0xff; rows[r + 4] = e.offset & 0xff
      rows[r + 5] = (e.gen >>> 8) & 0xff; rows[r + 6] = e.gen & 0xff
    }
  }
  const xdata = pako.deflate(rows)
  const td = trailerDict(ctx, size, {
    Type: PDFName.of('XRef'),
    W: (() => { const a = PDFArray.withContext(ctx); W.forEach((w) => a.push(PDFNumber.of(w))); return a })(),
    Filter: PDFName.of('FlateDecode'),
    Length: PDFNumber.of(xdata.length),
  })
  out.push(`${xrefNum} 0 obj\n`)
  out.push(objBytes(td))
  out.push('\nstream\n')
  out.push(xdata)
  out.push(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)
  return { blob: new Blob(out.parts, { type: 'application/pdf' }), offsets, xrefOffset, classic: false }
}

/** Check that every directly-stored object's offset points at "n g obj". Reads only small slices. */
export async function verifyOffsets(blob, offsets, { sampleLimit = 4000 } = {}) {
  const entries = [...offsets.entries()].filter(([, e]) => e.offset !== undefined)
  let list = entries
  let sampled = false
  if (entries.length > sampleLimit) {
    sampled = true
    const step = entries.length / sampleLimit
    list = Array.from({ length: sampleLimit }, (_, i) => entries[Math.floor(i * step)])
    list.push(entries[entries.length - 1])
  }
  const problems = []
  // read in batched windows to keep it fast
  const small = blob.size <= 64 * 1024 * 1024
  const whole = small ? new Uint8Array(await blob.arrayBuffer()) : null
  const read = async (off) => (whole ? whole.subarray(off, off + 32) : new Uint8Array(await blob.slice(off, off + 32).arrayBuffer()))
  for (let i = 0; i < list.length; i += 64) {
    const batch = list.slice(i, i + 64)
    const heads = await Promise.all(batch.map(([, e]) => read(e.offset)))
    batch.forEach(([n, e], k) => {
      let s = ''
      for (const b of heads[k]) s += String.fromCharCode(b)
      if (!new RegExp(`^${n}\\s+${e.gen}\\s+obj`).test(s)) problems.push(`object ${n}: offset ${e.offset} does not point to its header`)
    })
  }
  return { checked: list.length, sampled, problems, whole }
}
