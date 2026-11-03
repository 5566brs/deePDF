<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { store } from '../core/store.js'
import { pdfDoc, pdfDocRev } from '../core/preview.js'
import PreviewPage from './PreviewPage.vue'

const scroller = ref(null)
const zoom = ref(1)
const fit = ref('width') // 'width' | 'page' | null
const estimate = ref({ w: 595, h: 842 })
const containerW = ref(800)
const containerH = ref(600)
let ro = null

const numPages = computed(() => (pdfDoc.value ? pdfDoc.value.numPages : 0))

async function measure() {
  const doc = pdfDoc.value
  if (!doc) return
  const p = await doc.getPage(Math.min(doc.numPages, store.currentPage + 1) || 1)
  const vp = p.getViewport({ scale: 1 })
  estimate.value = { w: vp.width, h: vp.height }
}
watch(pdfDocRev, measure)

const scale = computed(() => {
  if (fit.value === 'width') return Math.max(0.1, (containerW.value - 48) / estimate.value.w)
  if (fit.value === 'page') return Math.max(0.1, Math.min((containerW.value - 48) / estimate.value.w, (containerH.value - 32) / estimate.value.h))
  return zoom.value
})

function setZoom(z) {
  zoom.value = Math.min(6, Math.max(0.1, z))
  fit.value = null
}

function onPick(p) {
  if (p.edit) { store.tab = 'elements'; store.mobileView = 'editor' }
  store.currentPage = p.page
  store.pick = { ...p, n: Math.random() }
}

// track current page while scrolling
function onScroll() {
  const el = scroller.value
  if (!el) return
  const mid = el.scrollTop + el.clientHeight / 3
  const pages = el.querySelectorAll('[data-page]')
  for (const p of pages) {
    if (p.offsetTop + p.offsetHeight > mid) {
      const i = +p.dataset.page
      if (i !== store.currentPage && !scrollLock) store.currentPage = i
      break
    }
  }
}

let scrollLock = false
watch(() => store.currentPage, async (i) => {
  await nextTick()
  const el = scroller.value
  const p = el?.querySelector(`[data-page="${i}"]`)
  if (!p) return
  const top = p.offsetTop - 12
  if (Math.abs(el.scrollTop - top) > el.clientHeight * 0.5 && (p.offsetTop > el.scrollTop + el.clientHeight || p.offsetTop + p.offsetHeight < el.scrollTop)) {
    scrollLock = true
    el.scrollTo({ top, behavior: 'smooth' })
    setTimeout(() => { scrollLock = false }, 600)
  }
})

function onWheel(e) {
  if (!e.ctrlKey) return
  e.preventDefault()
  setZoom(scale.value * (e.deltaY < 0 ? 1.1 : 1 / 1.1))
}

onMounted(() => {
  ro = new ResizeObserver(() => {
    if (!scroller.value) return
    containerW.value = scroller.value.clientWidth
    containerH.value = scroller.value.clientHeight
  })
  ro.observe(scroller.value)
  measure()
})
onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <div class="flex h-full flex-col bg-zinc-950">
    <div class="flex shrink-0 items-center gap-1.5 border-b border-zinc-800 bg-zinc-900 px-2 py-1 text-xs">
      <span class="text-zinc-400">Preview</span>
      <div class="flex-1" />
      <button class="btn btn-icon" :disabled="store.currentPage <= 0" v-tip="'Previous page'" @click="store.currentPage--">‹</button>
      <span class="font-mono text-zinc-300">{{ numPages ? store.currentPage + 1 : 0 }} / {{ numPages }}</span>
      <button class="btn btn-icon" :disabled="store.currentPage >= numPages - 1" v-tip="'Next page'" @click="store.currentPage++">›</button>
      <div class="mx-1 h-4 w-px bg-zinc-700" />
      <button class="btn btn-icon" v-tip="'Zoom out (Ctrl+wheel)'" @click="setZoom(scale / 1.2)">−</button>
      <span class="w-12 text-center font-mono text-zinc-300">{{ Math.round(scale * 100) }}%</span>
      <button class="btn btn-icon" v-tip="'Zoom in (Ctrl+wheel)'" @click="setZoom(scale * 1.2)">+</button>
      <button class="btn" :class="{ 'border-cyan-600 text-cyan-300': fit === 'width' }" v-tip="'Fit page width'" @click="fit = 'width'">Width</button>
      <button class="btn" :class="{ 'border-cyan-600 text-cyan-300': fit === 'page' }" v-tip="'Fit whole page'" @click="fit = 'page'">Page</button>
    </div>
    <div ref="scroller" data-scroller class="scroll-thin relative min-h-0 flex-1 overflow-auto" @scroll.passive="onScroll" @wheel="onWheel">
      <div v-if="pdfDoc" class="flex min-w-fit flex-col items-center gap-5 px-6 py-4">
        <PreviewPage
          v-for="i in numPages" :key="i"
          :doc="pdfDoc" :rev="pdfDocRev" :index="i - 1" :scale="scale" :estimate="estimate"
          @pick="onPick"
        />
      </div>
      <div v-else class="flex h-full items-center justify-center text-sm text-zinc-500">Rendering…</div>
    </div>
  </div>
</template>
