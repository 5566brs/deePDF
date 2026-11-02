// Page tree helpers, page content access and element location.
import {
  PDFDict, PDFArray, PDFRef, PDFNumber, PDFRawStream, PDFStream, PDFName,
  N, deref, nameStr, numArray, numVal, cloneObj, decodeStream, setStreamData, concatBytes, filtersOf,
} from './pdfobj.js'
import { parseContent, serializeOps, computeBoxes, IDENTITY } from './contentStream.js'

export const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate']
export const BOX_KEYS = ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox']

export function catalog(ctx) {
  const c = deref(ctx, ctx.trailerInfo.Root)
  return c instanceof PDFDict ? c : null
}

/** Returns ordered [{ref, dict}] of leaf pages. */
export function listPages(ctx) {
  const cat = catalog(ctx)
  const out = []
  if (!cat) return out
  const seen = new Set()
  const walk = (ref, depth) => {
    if (depth > 64) return
    const node = ref instanceof PDFRef ? ctx.lookup(ref) : ref
    if (!(node instanceof PDFDict)) return
    if (ref instanceof PDFRef) { if (seen.has(ref)) return; seen.add(ref) }
    const type = nameStr(deref(ctx, node.get(N('Type'))))
    const kids = deref(ctx, node.get(N('Kids')))
    if (type === 'Pages' || (!type && kids instanceof PDFArray)) {
      if (kids instanceof PDFArray) for (const k of kids.asArray()) walk(k, depth + 1)
    } else out.push({ ref: ref instanceof PDFRef ? ref : null, dict: node })
  }
  walk(cat.get(N('Pages')), 0)
  return out
}

export function inherited(ctx, pageDict, key) {
  let node = pageDict
  for (let d = 0; node && d < 64; d++) {
    const v = node.get(N(key))
    if (v !== undefined) return deref(ctx, v)
    node = deref(ctx, node.get(N('Parent')))
    if (!(node instanceof PDFDict)) break
  }
  return undefined
}

export function pageBox(ctx, pageDict, key = 'MediaBox') {
  let b = numArray(ctx, inherited(ctx, pageDict, key))
  if (!b && key !== 'MediaBox') b = pageBox(ctx, pageDict, 'MediaBox')
  if (!b) b = [0, 0, 612, 792]
  return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])]
}

/** Rebuild the page tree as a single flat /Pages node with the given leaf order. */
export function setPageOrder(ctx, pageRefs) {
  const cat = catalog(ctx)
  let rootRef = cat.get(N('Pages'))
  let root = deref(ctx, rootRef)
  if (!(rootRef instanceof PDFRef) || !(root instanceof PDFDict)) {
    root = ctx.obj({ Type: 'Pages' })
    rootRef = ctx.register(root)
    cat.set(N('Pages'), rootRef)
  }
  // push inheritable attributes down before flattening
  for (const ref of pageRefs) {
    const page = ctx.lookup(ref)
    if (!(page instanceof PDFDict)) continue
    for (const key of INHERITABLE) {
      if (page.get(N(key)) !== undefined) continue
      let node = deref(ctx, page.get(N('Parent')))
      let found
      for (let d = 0; node instanceof PDFDict && d < 64; d++) {
        const v = node.get(N(key))
        if (v !== undefined) { found = v; break }
        node = deref(ctx, node.get(N('Parent')))
      }
      if (found !== undefined) page.set(N(key), cloneObj(found, ctx))
    }
  }
  // delete intermediate /Pages nodes that are not the root
  const old = new Set()
  const collect = (r, depth) => {
    if (depth > 64) return
    const nd = deref(ctx, r)
    if (!(nd instanceof PDFDict)) return
    const kids = deref(ctx, nd.get(N('Kids')))
    if (kids instanceof PDFArray) {
      if (r instanceof PDFRef && r !== rootRef) old.add(r)
      for (const k of kids.asArray()) collect(k, depth + 1)
    }
  }
  collect(rootRef, 0)
  for (const r of old) ctx.delete(r)
  for (const key of INHERITABLE) root.delete(N(key))
  const kids = PDFArray.withContext(ctx)
  for (const ref of pageRefs) {
    kids.push(ref)
    const page = ctx.lookup(ref)
    if (page instanceof PDFDict) page.set(N('Parent'), rootRef)
  }
  root.set(N('Kids'), kids)
  root.set(N('Count'), PDFNumber.of(pageRefs.length))
  root.delete(N('Parent'))
}

export function deletePages(ctx, refsToDelete) {
  const del = new Set(refsToDelete)
  const remaining = listPages(ctx).map((p) => p.ref).filter((r) => r && !del.has(r))
  setPageOrder(ctx, remaining)
  for (const r of del) {
    const page = ctx.lookup(r)
    // annotations that belong only to this page
    const annots = page instanceof PDFDict ? deref(ctx, page.get(N('Annots'))) : null
    if (annots instanceof PDFArray) {
      for (const a of annots.asArray()) {
        if (!(a instanceof PDFRef)) continue
        const ad = ctx.lookup(a)
        if (ad instanceof PDFDict && nameStr(deref(ctx, ad.get(N('Subtype')))) !== 'Widget') ctx.delete(a)
      }
    }
    ctx.delete(r)
  }
}

/* ---------- content streams ---------- */

export function contentRefs(ctx, pageDict) {
  const c = pageDict.get(N('Contents'))
  if (c instanceof PDFRef) {
    const t = ctx.lookup(c)
    if (t instanceof PDFArray) return t.asArray().filter((x) => x instanceof PDFRef)
    return [c]
  }
  if (c instanceof PDFArray) return c.asArray().filter((x) => x instanceof PDFRef)
  return []
}

export function readPageContent(ctx, pageDict) {
  const refs = contentRefs(ctx, pageDict)
  const chunks = []
  const errors = []
  for (const r of refs) {
    const s = ctx.lookup(r)
    if (!(s instanceof PDFStream)) continue
    const d = decodeStream(ctx, s)
    if (d.error) errors.push(`${r.objectNumber} 0 R: ${d.error}`)
    chunks.push(d.bytes, new Uint8Array([0x0a]))
  }
  return { bytes: concatBytes(chunks), refs, errors }
}

/** Write new content for a page. Single stream → updated in place; several → merged into the first. */
export function writePageContent(ctx, pageDict, bytes) {
  const refs = contentRefs(ctx, pageDict)
  const first = refs.length ? ctx.lookup(refs[0]) : null
  if (first instanceof PDFRawStream && refs.length === 1) {
    const mode = filtersOf(ctx, first).length ? 'flate' : 'none'
    setStreamData(ctx, first, bytes, mode)
    return
  }
  const dict = PDFDict.withContext(ctx)
  const s = PDFRawStream.of(dict, new Uint8Array())
  setStreamData(ctx, s, bytes, 'flate')
  const ref = ctx.register(s)
  pageDict.set(N('Contents'), ref)
}

/* ---------- resources ---------- */

export function resourcesOf(ctx, dictLike) {
  return deref(ctx, dictLike.get(N('Resources')))
}

function fontWidths(ctx, fontDict) {
  const subtype = nameStr(deref(ctx, fontDict.get(N('Subtype'))))
  if (subtype === 'Type0') {
    const desc = deref(ctx, fontDict.get(N('DescendantFonts')))
    const cid = desc instanceof PDFArray ? deref(ctx, desc.get(0)) : null
    const dw = cid instanceof PDFDict ? numVal(deref(ctx, cid.get(N('DW')))) ?? 1000 : 1000
    const map = new Map()
    const W = cid instanceof PDFDict ? deref(ctx, cid.get(N('W'))) : null
    if (W instanceof PDFArray) {
      const a = W.asArray().map((x) => deref(ctx, x))
      for (let k = 0; k < a.length;) {
        const first = numVal(a[k])
        if (a[k + 1] instanceof PDFArray) {
          a[k + 1].asArray().forEach((w, j) => map.set(first + j, numVal(deref(ctx, w)) ?? dw))
          k += 2
        } else {
          const last = numVal(a[k + 1]), w = numVal(a[k + 2])
          if (last - first < 70000) for (let c = first; c <= last; c++) map.set(c, w)
          k += 3
        }
      }
    }
    return { twoByte: true, widthOf: (c) => map.get(c) ?? dw }
  }
  if (subtype === 'Type3') return { twoByte: false, widthOf: () => 500 }
  const fc = numVal(deref(ctx, fontDict.get(N('FirstChar')))) ?? 0
  const widths = numArray(ctx, fontDict.get(N('Widths')))
  const desc = deref(ctx, fontDict.get(N('FontDescriptor')))
  const missing = desc instanceof PDFDict ? numVal(deref(ctx, desc.get(N('MissingWidth')))) : undefined
  const base = nameStr(deref(ctx, fontDict.get(N('BaseFont')))) || ''
  const mono = /Courier/i.test(base)
  return {
    twoByte: false,
    widthOf: (c) => (widths && widths[c - fc] !== undefined ? widths[c - fc] : missing ?? (mono ? 600 : 520)),
  }
}

export function makeEnv(ctx, resources) {
  const fonts = resources instanceof PDFDict ? deref(ctx, resources.get(N('Font'))) : null
  const xobjs = resources instanceof PDFDict ? deref(ctx, resources.get(N('XObject'))) : null
  return {
    resolveFont(name) {
      const f = fonts instanceof PDFDict ? deref(ctx, fonts.get(N(name))) : null
      return f instanceof PDFDict ? fontWidths(ctx, f) : null
    },
    resolveXObject(name) {
      const x = xobjs instanceof PDFDict ? deref(ctx, xobjs.get(N(name))) : null
      if (!(x instanceof PDFStream)) return null
      const subtype = nameStr(deref(ctx, x.dict.get(N('Subtype'))))
      return {
        subtype,
        bbox: numArray(ctx, x.dict.get(N('BBox'))),
        matrix: numArray(ctx, x.dict.get(N('Matrix'))) || IDENTITY,
      }
    },
  }
}

/** Parse a page's content into ops, tree-ready, with bounding boxes. */
export function analyzePage(ctx, pageDict) {
  const { bytes, refs, errors } = readPageContent(ctx, pageDict)
  let ops = []
  try { ops = parseContent(bytes) } catch (e) { errors.push(String(e.message || e)) }
  const env = makeEnv(ctx, inherited(ctx, pageDict, 'Resources'))
  let boxes = []
  try { boxes = computeBoxes(ops, env) } catch (e) { boxes = new Array(ops.length).fill(null) }
  return { ops, boxes, refs, errors, size: bytes.length }
}

export function writePageOps(ctx, pageDict, ops) {
  writePageContent(ctx, pageDict, serializeOps(ops))
}

/* ---------- location index ---------- */

/**
 * Index used to locate an indirect object on a page: annotations, xobjects, content streams.
 * Map refTag -> {page, rect|null}
 */
export function buildLocationIndex(ctx) {
  const idx = new Map()
  const pages = listPages(ctx)
  pages.forEach((p, pi) => {
    if (p.ref) idx.set(p.ref, { page: pi, rect: null })
    const annots = deref(ctx, p.dict.get(N('Annots')))
    if (annots instanceof PDFArray) {
      for (const a of annots.asArray()) {
        const ad = deref(ctx, a)
        if (!(ad instanceof PDFDict)) continue
        const rect = numArray(ctx, ad.get(N('Rect')))
        const loc = { page: pi, rect: rect ? normRect(rect) : null }
        if (a instanceof PDFRef) idx.set(a, loc)
        const ap = deref(ctx, ad.get(N('AP')))
        if (ap instanceof PDFDict) for (const v of ap.values()) markRefs(ctx, v, idx, loc, 2)
        const popup = ad.get(N('Popup'))
        if (popup instanceof PDFRef && !idx.has(popup)) {
          const pd = ctx.lookup(popup)
          const pr = pd instanceof PDFDict ? numArray(ctx, pd.get(N('Rect'))) : null
          idx.set(popup, { page: pi, rect: pr ? normRect(pr) : null })
        }
      }
    }
    for (const r of contentRefs(ctx, p.dict)) if (!idx.has(r)) idx.set(r, { page: pi, rect: null, content: true })
  })
  return idx
}

function markRefs(ctx, v, idx, loc, depth) {
  if (depth < 0) return
  if (v instanceof PDFRef) { if (!idx.has(v)) idx.set(v, loc); return }
  if (v instanceof PDFDict) for (const x of v.values()) markRefs(ctx, x, idx, loc, depth - 1)
}

/** Find placements of an XObject by scanning page content (lazy, per request). */
export function locateXObject(ctx, xref) {
  const pages = listPages(ctx)
  for (let pi = 0; pi < pages.length; pi++) {
    const res = inherited(ctx, pages[pi].dict, 'Resources')
    const xobjs = res instanceof PDFDict ? deref(ctx, res.get(N('XObject'))) : null
    if (!(xobjs instanceof PDFDict)) continue
    let name = null
    for (const [k, v] of xobjs.entries()) if (v === xref) { name = k.decodeText(); break }
    if (!name) continue
    const a = analyzePage(ctx, pages[pi].dict)
    for (let i = 0; i < a.ops.length; i++) {
      const o = a.ops[i]
      if (o.op === 'Do' && o.args[0] && o.args[0].v === name) return { page: pi, rect: a.boxes[i] }
    }
    return { page: pi, rect: null }
  }
  return null
}

export function normRect(r) {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]
}

export function pageOfAnnot(ctx, annotRef) {
  const pages = listPages(ctx)
  for (let i = 0; i < pages.length; i++) {
    const annots = deref(ctx, pages[i].dict.get(N('Annots')))
    if (annots instanceof PDFArray && annots.asArray().includes(annotRef)) return i
  }
  return -1
}

export { PDFName }
