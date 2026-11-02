// Export pipeline: clone → strip signatures → validate/fix → gc → renumber → compression → write → verify xref.
import { PDFContext, PDFWriter, PDFStreamWriter, PDFParser } from 'pdf-lib'
import {
  PDFDict, PDFArray, PDFRef, PDFRawStream, PDFStream, PDFNull, PDFNumber,
  N, deref, nameStr, cloneObj, collectRefs, mapRefs, decodeStream, setStreamData, filtersOf, rawBytes, makeString,
  latin1,
} from './pdfobj.js'
import { catalog, listPages } from './pages.js'
import { stripSignatures } from './signature.js'
import { formatPdfDate, nowParts } from './pdfDate.js'

export function cloneContext(ctx) {
  const c = PDFContext.create()
  c.header = ctx.header
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) c.assign(ref, cloneObj(obj, c))
  for (const k of ['Root', 'Info', 'ID', 'Encrypt']) if (ctx.trailerInfo[k] !== undefined) c.trailerInfo[k] = cloneObj(ctx.trailerInfo[k], c)
  c.largestObjectNumber = Math.max(c.largestObjectNumber, ctx.largestObjectNumber)
  return c
}

function trailerRoots(ctx) {
  const out = []
  for (const k of ['Root', 'Info', 'ID', 'Encrypt']) { const v = ctx.trailerInfo[k]; if (v !== undefined) collectRefs(v, out); if (v instanceof PDFRef) out.push(v) }
  return out
}

export function reachable(ctx) {
  const seen = new Set()
  const stack = trailerRoots(ctx)
  while (stack.length) {
    const r = stack.pop()
    if (seen.has(r)) continue
    seen.add(r)
    const o = ctx.lookup(r)
    if (o !== undefined) collectRefs(o, stack)
  }
  return seen
}

/** Validation report on a context (does not modify it). */
export function validate(ctx) {
  const issues = []
  const objs = ctx.enumerateIndirectObjects()
  const existing = new Set(objs.map(([r]) => r))
  const dangling = []
  for (const [ref, obj] of objs) {
    for (const r of collectRefs(obj)) if (!existing.has(r)) dangling.push({ from: ref, to: r })
  }
  for (const r of trailerRoots(ctx)) if (!existing.has(r)) dangling.push({ from: null, to: r })
  if (dangling.length) issues.push({ level: 'warn', code: 'dangling', msg: `${dangling.length} reference(s) point to missing objects (will be written as null)`, items: dangling.slice(0, 50).map((d) => `${d.from ? d.from.objectNumber + ' ' + d.from.generationNumber + ' R' : 'trailer'} → ${d.to.objectNumber} ${d.to.generationNumber} R`) })

  const cat = catalog(ctx)
  if (!cat) issues.push({ level: 'error', code: 'nocatalog', msg: 'Trailer /Root does not point to a catalog dictionary' })
  else {
    const pages = listPages(ctx)
    const root = deref(ctx, cat.get(N('Pages')))
    if (root instanceof PDFDict) {
      const count = deref(ctx, root.get(N('Count')))
      const leafCount = countLeaves(ctx, cat.get(N('Pages')))
      if (!(count instanceof PDFNumber) || count.asNumber() !== leafCount) issues.push({ level: 'fix', code: 'count', msg: `Page tree /Count is ${count ? count.asNumber?.() : 'missing'}, actual ${leafCount} (will be fixed)` })
    }
    let badParent = 0
    checkParents(ctx, cat.get(N('Pages')), null, () => badParent++)
    if (badParent) issues.push({ level: 'fix', code: 'parent', msg: `${badParent} page tree node(s) with wrong /Parent (will be fixed)` })
    if (!pages.length) issues.push({ level: 'warn', code: 'nopages', msg: 'Document has no pages' })
  }
  const unreachable = objs.length - [...reachable(ctx)].filter((r) => existing.has(r)).length
  if (unreachable > 0) issues.push({ level: 'info', code: 'unused', msg: `${unreachable} object(s) are not referenced from the trailer` })
  let streamsNoLen = 0
  for (const [, o] of objs) if (o instanceof PDFStream) { const L = deref(ctx, o.dict.get(N('Length'))); if (!(L instanceof PDFNumber) || L.asNumber() !== rawBytes(o).length) streamsNoLen++ }
  if (streamsNoLen) issues.push({ level: 'fix', code: 'length', msg: `${streamsNoLen} stream(s) have an incorrect /Length (rewritten on export)` })
  if (ctx.trailerInfo.Encrypt) issues.push({ level: 'warn', code: 'encrypt', msg: 'Document is encrypted; renumbering objects would break decryption and is disabled' })
  return { issues, objectCount: objs.length, dangling }
}

function countLeaves(ctx, ref, depth = 0, seen = new Set()) {
  if (depth > 64) return 0
  if (ref instanceof PDFRef) { if (seen.has(ref)) return 0; seen.add(ref) }
  const node = deref(ctx, ref)
  if (!(node instanceof PDFDict)) return 0
  const kids = deref(ctx, node.get(N('Kids')))
  if (!(kids instanceof PDFArray)) return 1
  let n = 0
  for (const k of kids.asArray()) n += countLeaves(ctx, k, depth + 1, seen)
  return n
}

function checkParents(ctx, ref, parentRef, onBad, fix = false, depth = 0, seen = new Set()) {
  if (depth > 64 || !(ref instanceof PDFRef) || seen.has(ref)) return 0
  seen.add(ref)
  const node = ctx.lookup(ref)
  if (!(node instanceof PDFDict)) return 0
  const p = node.get(N('Parent'))
  if (parentRef ? p !== parentRef : p !== undefined) { onBad(); if (fix) { if (parentRef) node.set(N('Parent'), parentRef); else node.delete(N('Parent')) } }
  const kids = deref(ctx, node.get(N('Kids')))
  if (!(kids instanceof PDFArray)) return 1
  let n = 0
  for (const k of kids.asArray()) n += checkParents(ctx, k, ref, onBad, fix, depth + 1, seen)
  if (fix) node.set(N('Count'), PDFNumber.of(n))
  return n
}

function renumber(ctx) {
  const objs = ctx.enumerateIndirectObjects().sort((a, b) => a[0].objectNumber - b[0].objectNumber)
  // put catalog first for readability
  const rootRef = ctx.trailerInfo.Root
  objs.sort((a, b) => (a[0] === rootRef ? -1 : b[0] === rootRef ? 1 : 0))
  const map = new Map()
  objs.forEach(([r], i) => map.set(r, PDFRef.of(i + 1, 0)))
  const fn = (r) => map.get(r) || PDFNull
  ctx.indirectObjects = new Map()
  ctx.largestObjectNumber = 0
  for (const [r, o] of objs) {
    let obj = o
    if (obj instanceof PDFRef) obj = fn(obj)
    else mapRefs(obj, fn)
    ctx.assign(map.get(r), obj)
  }
  for (const k of ['Root', 'Info', 'ID', 'Encrypt']) {
    const v = ctx.trailerInfo[k]
    if (v instanceof PDFRef) ctx.trailerInfo[k] = fn(v)
    else if (v) mapRefs(v, fn)
  }
}

/**
 * opts: { compression: 'keep'|'compress'|'decompress', objectStreams, removeUnused, renumber,
 *         fixDangling, stripSignature, updateModDate }
 * returns { bytes, log: [string], verify }
 */
export async function exportPdf(srcCtx, opts) {
  const log = []
  const ctx = cloneContext(srcCtx)
  const encrypted = !!ctx.trailerInfo.Encrypt

  if (opts.stripSignature) {
    const n = stripSignatures(ctx)
    if (n) log.push(`Removed ${n} signature-related entr${n === 1 ? 'y' : 'ies'}`)
  }

  // page tree consistency
  const cat = catalog(ctx)
  if (cat) {
    let bad = 0
    checkParents(ctx, cat.get(N('Pages')), null, () => bad++, true)
    if (bad) log.push(`Fixed ${bad} /Parent link(s) in page tree`)
  }

  if (opts.updateModDate) {
    let info = deref(ctx, ctx.trailerInfo.Info)
    if (!(info instanceof PDFDict)) { info = PDFDict.withContext(ctx); ctx.trailerInfo.Info = ctx.register(info) }
    info.set(N('ModDate'), makeString(formatPdfDate(nowParts())))
    log.push('Updated /ModDate')
  }

  if (opts.removeUnused) {
    const keep = reachable(ctx)
    let removed = 0
    for (const [r] of ctx.enumerateIndirectObjects()) if (!keep.has(r)) { ctx.delete(r); removed++ }
    if (removed) log.push(`Removed ${removed} unreferenced object(s)`)
  }

  if (opts.fixDangling) {
    const existing = new Set(ctx.enumerateIndirectObjects().map(([r]) => r))
    let fixed = 0
    const fn = (r) => (existing.has(r) ? undefined : (fixed++, PDFNull))
    for (const [, o] of ctx.enumerateIndirectObjects()) mapRefs(o, fn)
    if (fixed) log.push(`Replaced ${fixed} dangling reference(s) with null`)
  }

  if (opts.renumber && !encrypted) {
    renumber(ctx)
    log.push(`Renumbered objects 1…${ctx.largestObjectNumber}`)
  }

  if (opts.compression === 'compress' && !encrypted) {
    let n = 0
    for (const [, o] of ctx.enumerateIndirectObjects()) {
      if (!(o instanceof PDFRawStream)) continue
      if (filtersOf(ctx, o).length) continue
      const type = nameStr(deref(ctx, o.dict.get(N('Type'))))
      if (type === 'Metadata') continue // XMP should stay readable
      setStreamData(ctx, o, o.contents, 'flate')
      n++
    }
    log.push(`Compressed ${n} uncompressed stream(s) with FlateDecode`)
  } else if (opts.compression === 'decompress' && !encrypted) {
    let n = 0, partial = 0
    for (const [, o] of ctx.enumerateIndirectObjects()) {
      if (!(o instanceof PDFRawStream)) continue
      const filters = filtersOf(ctx, o)
      if (!filters.length) continue
      const d = decodeStream(ctx, o)
      if (d.error) continue
      if (!d.remaining.length) { setStreamData(ctx, o, d.bytes, 'none'); n++ }
      else if (d.remaining.length < filters.length) {
        // keep image codec (e.g. DCTDecode), drop the outer transport filters
        o.contents = d.bytes
        o.dict.set(N('Filter'), d.remaining.length === 1 ? N(d.remaining[0]) : ctx.obj(d.remaining.map((x) => N(x))))
        const parms = deref(ctx, o.dict.get(N('DecodeParms')))
        if (parms instanceof PDFArray) o.dict.set(N('DecodeParms'), ctx.obj(parms.asArray().slice(filters.length - d.remaining.length)))
        partial++
      }
    }
    log.push(`Decompressed ${n} stream(s)${partial ? `, ${partial} partially (image codecs kept)` : ''}`)
  }

  let bytes
  if (opts.objectStreams) {
    bytes = await PDFStreamWriter.forContext(ctx, 500, true, 50).serializeToBuffer()
    log.push('Wrote compressed object streams + cross-reference stream')
  } else {
    bytes = await PDFWriter.forContext(ctx, 500).serializeToBuffer()
    log.push('Wrote classic cross-reference table')
  }
  const verify = await verifyOutput(bytes, ctx, !opts.objectStreams)
  return { bytes, log, verify }
}

/** Verify that every xref entry points at the right "n g obj" header and object count matches. */
export async function verifyOutput(bytes, ctx, classic) {
  const res = { ok: true, checked: 0, problems: [] }
  if (classic) {
    const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 1024)))
    const m = tail.match(/startxref\s+(\d+)/)
    if (!m) { res.ok = false; res.problems.push('startxref not found'); return res }
    const xrefOff = +m[1]
    const head = latin1(bytes.subarray(xrefOff, xrefOff + 4))
    if (head !== 'xref') { res.ok = false; res.problems.push('startxref does not point to xref'); return res }
    const text = latin1(bytes.subarray(xrefOff, bytes.length))
    const lines = text.split(/\r?\n|\r/)
    let li = 1
    while (li < lines.length && /^\d+\s+\d+\s*$/.test(lines[li].trim())) {
      const [start, count] = lines[li].trim().split(/\s+/).map(Number)
      li++
      for (let k = 0; k < count; k++, li++) {
        const e = lines[li] || ''
        const mm = e.match(/^(\d{10}) (\d{5}) ([nf])/)
        if (!mm) { res.ok = false; res.problems.push(`malformed xref entry for object ${start + k}`); continue }
        if (mm[3] !== 'n') continue
        const off = +mm[1], gen = +mm[2]
        const hdr = latin1(bytes.subarray(off, off + 32))
        const want = new RegExp(`^${start + k}\\s+${gen}\\s+obj`)
        res.checked++
        if (!want.test(hdr)) { res.ok = false; res.problems.push(`object ${start + k} ${gen}: xref offset ${off} does not point to its header`) }
      }
    }
  }
  try {
    const parsed = await PDFParser.forBytesWithOptions(bytes, 1000, false, false).parseDocument()
    const a = parsed.enumerateIndirectObjects().length
    const b = ctx.enumerateIndirectObjects().length
    if (a !== b) { res.ok = false; res.problems.push(`re-parsed object count ${a} ≠ written ${b}`) }
    res.reparsed = a
  } catch (e) {
    res.ok = false
    res.problems.push('re-parse failed: ' + (e.message || e))
  }
  return res
}

export async function serializeForPreview(ctx) {
  return PDFWriter.forContext(ctx, 2000).serializeToBuffer()
}
