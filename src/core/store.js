// Central application state.
import { reactive, markRaw, shallowRef } from 'vue'
import { PDFParser, PDFContext } from 'pdf-lib'
import { cloneObj, PDFRef, deref, N, PDFDict, numArray } from './pdfobj.js'
import { listPages, buildLocationIndex, locateXObject, pageBox, normRect } from './pages.js'
import { detectSignatures } from './signature.js'
import { serializeForPreview } from './exporter.js'
import { parsePdf } from './loader.js'
import { isLazy, LazyContents, loadLazy, idbPutBlob, idbGetBlob, idbClear } from './lazy.js'

export const memorySettings = { threshold: 256 * 1024, inlinePreviewLimit: 48 * 1024 * 1024 }
import { contextToJSON, contextFromJSON } from './jsonDesc.js'

const UNDO_LIMIT = 40

export const ctxRef = shallowRef(null) // PDFContext (non reactive internals)

export const store = reactive({
  fileName: '',
  originalSize: 0,
  rev: 0,
  loading: false,
  error: '',
  toast: null,
  signature: null,
  encrypted: false,
  tab: 'pages',
  currentPage: 0,
  pageCount: 0,
  highlight: null, // { page, rect:[x1,y1,x2,y2] user space, n }
  undo: [],
  redo: [],
  previewBytes: null,
  previewSource: null,
  offloaded: null, // { count, bytes } streams kept on disk at load // { transport, length } when the document is served from a Blob
  previewRev: 0,
  previewBusy: false,
  pick: null, // { page, x, y, n } click in preview
  dirty: false,
  mobileView: 'editor',
  objectFocus: null, // ref tag to reveal in objects tab
})

let locIndex = null
let locIndexRev = -1

export function ctx() {
  return ctxRef.value
}

export function notify(msg, kind = 'info', ms = 3500) {
  const id = Math.random()
  store.toast = { msg, kind, id }
  setTimeout(() => { if (store.toast && store.toast.id === id) store.toast = null }, ms)
}

function afterLoad(context, name, size) {
  ctxRef.value = markRaw(context)
  store.fileName = name
  store.originalSize = size
  store.undo = []
  store.redo = []
  store.currentPage = 0
  store.highlight = null
  store.encrypted = !!context.trailerInfo.Encrypt
  store.signature = detectSignatures(context)
  store.dirty = false
  bump()
}

export async function loadPdfBytes(bytes, name = 'document.pdf', file = null) {
  store.loading = true
  store.error = ''
  try {
    const { ctx: context, offloaded } = await parsePdf(bytes, { file, threshold: memorySettings.threshold })
    store.offloaded = offloaded
    afterLoad(context, name, bytes.length)
    if (store.encrypted) {
      // pdf-lib cannot decrypt; the preview uses the original bytes until the first edit.
      store.previewBytes = markRaw(bytes.slice())
      store.previewRev++
    }
  } catch (e) {
    console.error(e)
    store.error = 'Could not parse PDF: ' + (e.message || e)
  } finally {
    store.loading = false
  }
}

export function loadJSON(json, name) {
  const context = contextFromJSON(json)
  afterLoad(context, name.replace(/\.json$/i, '') || 'document.pdf', 0)
}

/** Full JSON description (disk-backed streams are read in for this). */
export async function exportJSON(opts) {
  const c = ctx()
  const bytes = new Map()
  for (const [, o] of c.enumerateIndirectObjects()) if (o && o.contents && isLazy(o.contents)) bytes.set(o, await loadLazy(o.contents))
  return contextToJSON(c, { ...opts, bytes })
}

function collectLazyKeys(json) {
  const out = []
  for (const v of Object.values(json.objects || {})) if (v && typeof v === 'object' && v.$stream && v.lazyKey) out.push(v.lazyKey)
  return out
}

/** Memory usage: resident vs disk-backed stream data. */
export function memoryStats() {
  const c = ctx()
  let resident = 0, onDisk = 0, lazyCount = 0
  if (c) for (const [, o] of c.enumerateIndirectObjects()) {
    if (!o || !o.contents) continue
    if (isLazy(o.contents)) { onDisk += o.contents.length; lazyCount++ } else resident += o.contents.length
  }
  return { resident, onDisk, lazyCount }
}

/** Move large in-memory binary streams (e.g. replaced images) to IndexedDB. */
export async function offloadLargeStreams(threshold = memorySettings.threshold) {
  const c = ctx()
  let n = 0, bytes = 0
  for (const [ref, o] of c.enumerateIndirectObjects()) {
    if (!o || !o.contents || isLazy(o.contents) || o.contents.length < threshold) continue
    const st = o.dict.get(N('Subtype'))
    const isImage = st && st.decodeText && st.decodeText() === 'Image'
    const isFont = o.dict.has(N('Length1')) || o.dict.has(N('Length2'))
    const isFile = o.dict.get(N('Type'))?.decodeText?.() === 'EmbeddedFile'
    if (!isImage && !isFont && !isFile) continue
    const key = `live:${ref.objectNumber}:${Date.now()}`
    await idbPutBlob(key, new Blob([o.contents]))
    const blob = await idbGetBlob(key)
    bytes += o.contents.length
    o.contents = new LazyContents(blob, 'idb')
    n++
  }
  bump()
  return { n, bytes }
}

/* ---------- undo / redo snapshots ---------- */

function snapshot(c) {
  const objs = new Map()
  for (const [r, o] of c.enumerateIndirectObjects()) objs.set(r, cloneObj(o, c))
  const t = {}
  for (const k of ['Root', 'Info', 'ID', 'Encrypt']) if (c.trailerInfo[k] !== undefined) t[k] = cloneObj(c.trailerInfo[k], c)
  return { objs, trailer: t, largest: c.largestObjectNumber, header: c.header, page: store.currentPage }
}
function restore(c, s) {
  c.indirectObjects = s.objs
  c.trailerInfo = s.trailer
  c.largestObjectNumber = s.largest
  c.header = s.header
  store.currentPage = s.page
}

/**
 * Run a mutation with undo support. fn(ctx) may return a value.
 */
export function mutate(label, fn) {
  const c = ctx()
  if (!c) return
  const snap = snapshot(c)
  let result
  try {
    result = fn(c)
  } catch (e) {
    restore(c, snap)
    console.error(e)
    notify(`${label} failed: ${e.message || e}`, 'error')
    bump()
    return undefined
  }
  store.undo.push(markRaw({ label, snap }))
  if (store.undo.length > UNDO_LIMIT) store.undo.shift()
  store.redo = []
  store.dirty = true
  bump()
  return result
}

export function undo() {
  const c = ctx()
  const e = store.undo.pop()
  if (!c || !e) return
  store.redo.push(markRaw({ label: e.label, snap: snapshot(c) }))
  restore(c, e.snap)
  bump()
  notify(`Undo: ${e.label}`, 'info', 1500)
}
export function redo() {
  const c = ctx()
  const e = store.redo.pop()
  if (!c || !e) return
  store.undo.push(markRaw({ label: e.label, snap: snapshot(c) }))
  restore(c, e.snap)
  bump()
  notify(`Redo: ${e.label}`, 'info', 1500)
}

/* ---------- change propagation / preview ---------- */

let previewTimer = null
let previewSeq = 0
export function bump() {
  store.rev++
  const c = ctx()
  if (c) c.__rev = store.rev
  store.pageCount = c ? listPages(c).length : 0
  if (store.currentPage >= store.pageCount) store.currentPage = Math.max(0, store.pageCount - 1)
  if (c) store.signature = detectSignatures(c)
  clearTimeout(previewTimer)
  previewTimer = setTimeout(regeneratePreview, store.rev <= 1 ? 0 : 350)
}

async function regeneratePreview() {
  const c = ctx()
  if (!c) return
  if (store.encrypted && !store.dirty && store.previewBytes) return
  const seq = ++previewSeq
  store.previewBusy = true
  try {
    const blob = serializeForPreview(c)
    if (blob.size <= memorySettings.inlinePreviewLimit) {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (seq !== previewSeq) return
      store.previewSource = null
      store.previewBytes = markRaw(bytes)
    } else {
      // large document: pdf.js reads byte ranges from the (mostly disk-backed) Blob
      if (seq !== previewSeq) return
      store.previewBytes = null
      store.previewSource = markRaw({ blob, length: blob.size })
    }
    store.previewRev++
  } catch (e) {
    console.error(e)
    notify('Preview failed: ' + (e.message || e), 'error')
  } finally {
    if (seq === previewSeq) store.previewBusy = false
  }
}

/* ---------- highlight ---------- */

let hlSeq = 0
export function locate(page, rect) {
  if (page === undefined || page === null || page < 0) return
  const c = ctx()
  if (!rect && c) {
    const p = listPages(c)[page]
    if (p) rect = pageBox(c, p.dict, 'CropBox')
  }
  store.highlight = { page, rect: rect ? normRect(rect) : null, n: ++hlSeq }
}
export function clearHighlight() {
  store.highlight = null
}

export function locationIndex() {
  const c = ctx()
  if (!c) return new Map()
  if (locIndexRev !== store.rev) {
    locIndex = buildLocationIndex(c)
    locIndexRev = store.rev
  }
  return locIndex
}

/** Locate an indirect object (and optionally a rectangle-valued key inside it). */
export function locateRef(ref, rectValue) {
  const c = ctx()
  if (!c || !(ref instanceof PDFRef)) return false
  const idx = locationIndex()
  let loc = idx.get(ref)
  if (!loc) {
    const obj = c.lookup(ref)
    const st = obj && obj.dict ? deref(c, obj.dict.get(N('Subtype'))) : null
    if (st && st.decodeText && (st.decodeText() === 'Image' || st.decodeText() === 'Form')) {
      loc = locateXObject(c, ref)
      if (loc) idx.set(ref, loc)
    }
  }
  if (!loc) return false
  let rect = loc.rect
  if (rectValue) {
    const r = numArray(c, rectValue)
    if (r && r.length === 4) rect = r
  }
  locate(loc.page, rect)
  return true
}

/* ---------- drafts (IndexedDB) ---------- */

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('deepdf', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('drafts')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
export async function saveDraft() {
  const db = await idb()
  // disk-backed streams go to the IndexedDB blob store; the JSON only references them
  await idbClear('draft:')
  const lazyKeys = new Map()
  let k = 0
  for (const [, o] of ctx().enumerateIndirectObjects()) {
    if (o && o.contents && isLazy(o.contents)) {
      const key = `draft:${++k}`
      await idbPutBlob(key, o.contents.blob)
      lazyKeys.set(o, key)
    }
  }
  const data = { name: store.fileName, savedAt: new Date().toISOString(), json: contextToJSON(ctx(), { decodeText: false, lazyKeys }) }
  await new Promise((res, rej) => {
    const tx = db.transaction('drafts', 'readwrite')
    tx.objectStore('drafts').put(data, 'current')
    tx.oncomplete = res
    tx.onerror = () => rej(tx.error)
  })
  notify('Draft saved in this browser')
}
export async function loadDraft() {
  const db = await idb()
  const data = await new Promise((res, rej) => {
    const tx = db.transaction('drafts', 'readonly')
    const r = tx.objectStore('drafts').get('current')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  if (!data) { notify('No saved draft found', 'warn'); return }
  const blobs = new Map()
  for (const key of collectLazyKeys(data.json)) {
    const b = await idbGetBlob(key)
    if (b) blobs.set(key, new LazyContents(b, 'idb'))
  }
  afterLoad(contextFromJSON(data.json, { lazy: blobs }), data.name, 0)
  store.dirty = true
  notify(`Draft restored (${new Date(data.savedAt).toLocaleString()})`)
}
export async function draftInfo() {
  try {
    const db = await idb()
    return await new Promise((res) => {
      const tx = db.transaction('drafts', 'readonly')
      const r = tx.objectStore('drafts').get('current')
      r.onsuccess = () => res(r.result ? { name: r.result.name, savedAt: r.result.savedAt } : null)
      r.onerror = () => res(null)
    })
  } catch { return null }
}

export function download(bytesOrBlob, name, type = 'application/octet-stream') {
  const blob = bytesOrBlob instanceof Blob ? bytesOrBlob : new Blob([bytesOrBlob], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export function baseName() {
  return (store.fileName || 'document').replace(/\.pdf$/i, '')
}

export { PDFContext, PDFDict }
