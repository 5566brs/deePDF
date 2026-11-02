// pdf.js document shared by preview pane and thumbnails.
import { shallowRef, watch, markRaw } from 'vue'
import * as pdfjs from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { store } from './store.js'

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

export const pdfDoc = shallowRef(null)
export const pdfDocRev = shallowRef(0)

let seq = 0

watch(() => store.previewRev, async () => {
  const bytes = store.previewBytes
  if (!bytes) return
  const my = ++seq
  const old = pdfDoc.value
  try {
    const loadingTask = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false, stopAtErrors: false })
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

export { pdfjs }
