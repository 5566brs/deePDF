// pdf.js documents: the live preview document, and an on-demand "rich" document
// (font programs + glyph maps kept, main-thread rendering) used for glyph and HTML export.
import { shallowRef, watch, markRaw } from 'vue'
import * as pdfjs from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { store } from './store.js'

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

export const pdfDoc = shallowRef(null)
export const pdfDocRev = shallowRef(0)

export function assetOptions() {
  const base = typeof document !== 'undefined' ? document.baseURI : '/'
  return {
    standardFontDataUrl: new URL('pdfjs/standard_fonts/', base).href,
    cMapUrl: new URL('pdfjs/cmaps/', base).href,
    cMapPacked: true,
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: false,
  }
}

/** pdf.js source for the current preview bytes (plain data or a range transport for blobs). */
export function previewSource() {
  const src = store.previewSource
  if (src && src.transport) return { range: src.transport, length: src.length, disableAutoFetch: true, disableStream: true }
  return { data: store.previewBytes.slice() }
}

let seq = 0
watch(() => store.previewRev, async () => {
  if (!store.previewBytes && !store.previewSource) return
  const my = ++seq
  const old = pdfDoc.value
  try {
    const loadingTask = pdfjs.getDocument({ ...previewSource(), ...assetOptions() })
    const doc = await loadingTask.promise
    if (my !== seq) { loadingTask.destroy(); return }
    pdfDoc.value = markRaw(doc)
    pdfDocRev.value++
    if (old) setTimeout(() => { try { old.loadingTask.destroy() } catch { /* ignore */ } }, 3000)
  } catch (e) {
    if (my !== seq) return
    console.error(e)
    store.error = 'Preview could not render this state: ' + (e.message || e)
    setTimeout(() => { if (store.error.startsWith('Preview')) store.error = '' }, 5000)
  }
})

let rich = null
/** Document with fontExtraProperties and main-thread rendering, cached per preview revision. */
export async function richDoc() {
  if (rich && rich.rev === store.previewRev) return rich.doc
  if (rich) { try { rich.doc.loadingTask.destroy() } catch { /* ignore */ } }
  const task = pdfjs.getDocument({ ...previewSource(), ...assetOptions(), fontExtraProperties: true, disableWorkerRendering: true, useSystemFonts: false })
  const doc = await task.promise
  rich = { rev: store.previewRev, doc }
  return doc
}

/** Fonts used on a page (pdf.js FontFaceObjects). */
export async function pageFonts(doc, pageIndex) {
  const page = await doc.getPage(pageIndex + 1)
  const ol = await page.getOperatorList({ intent: 'print' })
  const names = new Set()
  ol.fnArray.forEach((fn, i) => { if (fn === pdfjs.OPS.setFont) names.add(ol.argsArray[i][0]) })
  const out = []
  for (const n of names) {
    try {
      const f = page.commonObjs.get(n)
      if (f) out.push(f)
    } catch { /* not resolved */ }
  }
  return out
}

export { pdfjs }
