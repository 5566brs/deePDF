// Link annotation targets: read and write URL / page / named destinations.
import {
  PDFDict, PDFArray, PDFName, PDFNumber, PDFNull, PDFRef, PDFString, N, deref, nameStr, numVal, stringText, escapeLiteral, fromLatin1,
} from './pdfobj.js'
import { catalog, listPages } from './pages.js'

export const FIT_MODES = {
  Fit: 'Fit the whole page',
  FitH: 'Fit page width, scroll to top',
  XYZ: 'Exact position (left, top) and zoom',
  FitB: 'Fit the bounding box of the content',
  FitV: 'Fit page height',
}

function readDest(ctx, d, pages) {
  d = deref(ctx, d)
  if (d instanceof PDFName) return { kind: 'named', name: d.decodeText(), nameIsName: true }
  if (d && (d.decodeText || d.asBytes) && !(d instanceof PDFArray)) return { kind: 'named', name: stringText(d) }
  if (d instanceof PDFArray) {
    const p = d.get(0)
    let page = -1
    if (p instanceof PDFRef) page = pages.findIndex((x) => x.ref === p)
    else if (numVal(deref(ctx, p)) !== undefined) page = numVal(deref(ctx, p)) // remote/numbered
    const mode = nameStr(deref(ctx, d.get(1))) || 'Fit'
    const params = d.asArray().slice(2).map((x) => { const v = deref(ctx, x); return v === PDFNull ? null : numVal(v) ?? null })
    return { kind: 'page', page, mode, params }
  }
  return null
}

/** { kind: 'url'|'page'|'named'|'other'|'none', url, page, mode, params, name, action } */
export function readLink(ctx, annot) {
  const pages = listPages(ctx)
  const a = deref(ctx, annot.get(N('A')))
  if (a instanceof PDFDict) {
    const s = nameStr(deref(ctx, a.get(N('S'))))
    if (s === 'URI') return { kind: 'url', url: stringText(deref(ctx, a.get(N('URI')))) }
    if (s === 'GoTo') return readDest(ctx, a.get(N('D')), pages) || { kind: 'other', action: s }
    if (s === 'GoToR') return { kind: 'other', action: 'GoToR (other file)', file: (() => { const f = deref(ctx, a.get(N('F'))); return f ? (f instanceof PDFDict ? stringText(deref(ctx, f.get(N('F')) || f.get(N('UF')))) : stringText(f)) : '' })() }
    return { kind: 'other', action: s || '?' }
  }
  const d = annot.get(N('Dest'))
  if (d !== undefined) return readDest(ctx, d, pages) || { kind: 'other', action: 'Dest' }
  return { kind: 'none' }
}

function pdfStr(text) {
  let ascii = true
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7e) { ascii = false; break }
  return PDFString.of(escapeLiteral(fromLatin1(ascii ? text : encodeURI(text))))
}

/** Write a link target. t: { kind, url, page, mode, params, name } */
export function writeLink(ctx, annot, t) {
  const pages = listPages(ctx)
  annot.delete(N('Dest'))
  annot.delete(N('A'))
  if (t.kind === 'url') {
    annot.set(N('A'), ctx.obj({ Type: 'Action', S: 'URI', URI: pdfStr(t.url || '') }))
  } else if (t.kind === 'page') {
    const p = pages[t.page]
    if (!p || !p.ref) throw new Error('Page not found')
    const arr = PDFArray.withContext(ctx)
    arr.push(p.ref)
    arr.push(PDFName.of(t.mode || 'Fit'))
    const want = { XYZ: 3, FitH: 1, FitV: 1, FitBH: 1, FitBV: 1, FitR: 4 }[t.mode] || 0
    for (let k = 0; k < want; k++) {
      const v = t.params ? t.params[k] : null
      arr.push(v === null || v === undefined || v === '' || isNaN(+v) ? PDFNull : PDFNumber.of(+v))
    }
    annot.set(N('Dest'), arr)
  } else if (t.kind === 'named') {
    annot.set(N('Dest'), pdfStr(t.name || ''))
  }
}

/** Named destinations from the catalog's /Dests dictionary and /Names /Dests name tree. */
export function namedDestinations(ctx) {
  const out = new Set()
  const cat = catalog(ctx)
  if (!cat) return []
  const dests = deref(ctx, cat.get(N('Dests')))
  if (dests instanceof PDFDict) for (const k of dests.keys()) out.add(k.decodeText())
  const names = deref(ctx, cat.get(N('Names')))
  const tree = names instanceof PDFDict ? deref(ctx, names.get(N('Dests'))) : null
  const walk = (node, depth) => {
    node = deref(ctx, node)
    if (!(node instanceof PDFDict) || depth > 32 || out.size > 5000) return
    const arr = deref(ctx, node.get(N('Names')))
    if (arr instanceof PDFArray) for (let i = 0; i < arr.size(); i += 2) { const k = deref(ctx, arr.get(i)); if (k) out.add(stringText(k)) }
    const kids = deref(ctx, node.get(N('Kids')))
    if (kids instanceof PDFArray) for (const k of kids.asArray()) walk(k, depth + 1)
  }
  if (tree) walk(tree, 0)
  return [...out].sort()
}

/** Shift an annotation's geometry by (dx, dy) in page units. */
export function shiftAnnotation(ctx, annot, dx, dy) {
  const shiftArr = (key, pairs = true) => {
    const a = deref(ctx, annot.get(N(key)))
    if (!(a instanceof PDFArray)) return
    const vals = a.asArray().map((x) => numVal(deref(ctx, x)))
    if (vals.some((v) => v === undefined)) return
    annot.set(N(key), ctx.obj(vals.map((v, i) => PDFNumber.of(v + (pairs ? (i % 2 ? dy : dx) : 0)))))
  }
  for (const k of ['Rect', 'QuadPoints', 'Vertices', 'L', 'CL']) shiftArr(k)
  const ink = deref(ctx, annot.get(N('InkList')))
  if (ink instanceof PDFArray) {
    annot.set(N('InkList'), ctx.obj(ink.asArray().map((path) => {
      const p = deref(ctx, path)
      return p instanceof PDFArray ? p.asArray().map((x, i) => PDFNumber.of((numVal(deref(ctx, x)) || 0) + (i % 2 ? dy : dx))) : path
    })))
  }
  const popup = deref(ctx, annot.get(N('Popup')))
  if (popup instanceof PDFDict) {
    const r = deref(ctx, popup.get(N('Rect')))
    if (r instanceof PDFArray) popup.set(N('Rect'), ctx.obj(r.asArray().map((x, i) => PDFNumber.of((numVal(deref(ctx, x)) || 0) + (i % 2 ? dy : dx)))))
  }
}
