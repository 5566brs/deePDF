// Export pipeline: clone → strip signatures → validate/fix → gc → renumber → compression → write → verify xref.
import { PDFContext, PDFParser } from 'pdf-lib'
import { writePdf, verifyOffsets } from './writer.js'
import {
  PDFDict, PDFArray, PDFRef, PDFRawStream, PDFStream, PDFNull, PDFNumber,
  N, deref, nameStr, cloneObj, collectRefs, mapRefs, decodeStream, setStreamData, filtersOf, rawLength, makeString,
  latin1, isOnDisk, rawBytesAsync,
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
  for (const [, o] of objs) if (o instanceof PDFStream) { const L = deref(ctx, o.dict.get(N('Length'))); if (!(L instanceof PDFNumber) || L.asNumber() !== rawLength(o)) streamsNoLen++ }
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
      const bytes = await rawBytesAsync(o)
      setStreamData(ctx, o, bytes, 'flate')
      n++
    }
    log.push(`Compressed ${n} uncompressed stream(s) with FlateDecode`)
  } else if (opts.compression === 'decompress' && !encrypted) {
    let n = 0, partial = 0
    for (const [, o] of ctx.enumerateIndirectObjects()) {
      if (!(o instanceof PDFRawStream)) continue
      const filters = filtersOf(ctx, o)
      if (!filters.length) continue
      const work = isOnDisk(o) ? PDFRawStream.of(o.dict, await rawBytesAsync(o)) : o
      const d = decodeStream(ctx, work)
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

  const w = writePdf(ctx, { objectStreams: !!opts.objectStreams })
  log.push(w.classic ? 'Wrote classic cross-reference table' : 'Wrote compressed object streams + cross-reference stream')
  const verify = await verifyOutput(w, ctx)
  return { blob: w.blob, size: w.blob.size, log, verify }
}

/**
 * Verify the written file: every directly stored object's xref offset must point at its "n g obj" header,
 * and (for files up to 64 MB) the output is re-parsed and the object count compared.
 */
export async function verifyOutput(w, ctx) {
  const res = { ok: true, checked: 0, problems: [] }
  const v = await verifyOffsets(w.blob, w.offsets)
  res.checked = v.checked
  res.sampled = v.sampled
  res.problems.push(...v.problems)
  // the xref section itself
  const tailBytes = new Uint8Array(await w.blob.slice(Math.max(0, w.blob.size - 64)).arrayBuffer())
  const m = latin1(tailBytes).match(/startxref\s+(\d+)/)
  if (!m || +m[1] !== w.xrefOffset) res.problems.push('startxref does not point to the cross-reference section')
  if (v.whole) {
    try {
      const parsed = await PDFParser.forBytesWithOptions(v.whole, 1000, false, false).parseDocument()
      const a = parsed.enumerateIndirectObjects().length
      const b = ctx.enumerateIndirectObjects().length
      if (a !== b) res.problems.push(`re-parsed object count ${a} ≠ written ${b}`)
      res.reparsed = a
    } catch (e) {
      res.problems.push('re-parse failed: ' + (e.message || e))
    }
  } else res.note = 'File larger than 64 MB: offsets verified by sampling, full re-parse skipped'
  res.ok = res.problems.length === 0
  return res
}

export function serializeForPreview(ctx) {
  return writePdf(ctx, { objectStreams: false }).blob
}
