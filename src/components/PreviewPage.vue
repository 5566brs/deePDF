<script setup>
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue'

import { store } from '../core/store.js'

const props = defineProps({ doc: Object, rev: Number, index: Number, scale: Number, estimate: Object })
const emit = defineEmits(['pick'])

const root = ref(null)
const holder = ref(null)
const viewport = shallowRef(null)
const visible = ref(false)
const failed = ref('')
let renderedKey = ''
let task = null
let observer = null

const size = computed(() => {
  if (viewport.value) return { w: viewport.value.width, h: viewport.value.height }
  return { w: (props.estimate?.w || 595) * props.scale, h: (props.estimate?.h || 842) * props.scale }
})

async function ensureViewport() {
  const doc = props.doc
  if (!doc || props.index >= doc.numPages) return null
  const page = await doc.getPage(props.index + 1)
  if (doc !== props.doc) return null
  viewport.value = page.getViewport({ scale: props.scale })
  return page
}

async function render() {
  const key = `${props.rev}:${props.scale}`
  if (!visible.value || renderedKey === key || !props.doc) return
  renderedKey = key
  try {
    const page = await ensureViewport()
    if (!page) return
    if (task) { try { task.cancel() } catch { /* ignore */ } }
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const vp = page.getViewport({ scale: props.scale * dpr })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(vp.width)
    canvas.height = Math.ceil(vp.height)
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp })
    await task.promise
    task = null
    if (holder.value && renderedKey === key) {
      holder.value.replaceChildren(canvas)
      failed.value = ''
    }
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return
    renderedKey = ''
    failed.value = String(e.message || e)
  }
}

watch(() => [props.rev, props.scale], () => { ensureViewport(); render() })
watch(visible, (v) => { if (v) render() })

onMounted(() => {
  ensureViewport()
  observer = new IntersectionObserver((entries) => { visible.value = entries.some((e) => e.isIntersecting) }, { rootMargin: '600px 0px' })
  observer.observe(root.value)
})
onBeforeUnmount(() => { observer?.disconnect(); if (task) try { task.cancel() } catch { /* ignore */ } })

const hl = computed(() => {
  const h = store.highlight
  if (!h || h.page !== props.index || !viewport.value) return null
  const vp = viewport.value
  let r
  if (h.rect) {
    const [a, b] = vp.convertToViewportPoint(h.rect[0], h.rect[1])
    const [c, d] = vp.convertToViewportPoint(h.rect[2], h.rect[3])
    r = { x: Math.min(a, c), y: Math.min(b, d), w: Math.abs(c - a), h: Math.abs(d - b) }
  } else r = { x: 0, y: 0, w: vp.width, h: vp.height }
  const point = r.w < 6 && r.h < 6
  const min = 10
  if (r.w < min) { r.x -= (min - r.w) / 2; r.w = min }
  if (r.h < min) { r.y -= (min - r.h) / 2; r.h = min }
  return { ...r, point, n: h.n }
})

watch(hl, (v) => {
  if (!v || !root.value) return
  const scroller = root.value.closest('[data-scroller]')
  if (!scroller) return
  const pr = root.value.getBoundingClientRect()
  const sr = scroller.getBoundingClientRect()
  const cy = pr.top - sr.top + scroller.scrollTop + v.y + v.h / 2
  const cx = pr.left - sr.left + scroller.scrollLeft + v.x + v.w / 2
  const inView = pr.top + v.y >= sr.top && pr.top + v.y + v.h <= sr.bottom && pr.left + v.x >= sr.left && pr.left + v.x + v.w <= sr.right
  if (!inView) scroller.scrollTo({ top: cy - scroller.clientHeight / 2, left: cx - scroller.clientWidth / 2, behavior: 'smooth' })
})

function pdfPoint(e) {
  const rect = root.value.getBoundingClientRect()
  return viewport.value.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top)
}
function onClick(e, edit = false) {
  if (!viewport.value) return
  const [x, y] = pdfPoint(e)
  emit('pick', { page: props.index, x, y, edit })
}

/* ---------- drag to move the selection ---------- */
const drag = ref(null) // { sx, sy, ox, oy }
const moveBox = computed(() => {
  const t = store.moveTarget
  if (!t || t.page !== props.index || !viewport.value || !t.rect) return null
  const [a, b] = viewport.value.convertToViewportPoint(t.rect[0], t.rect[1])
  const [c, d] = viewport.value.convertToViewportPoint(t.rect[2], t.rect[3])
  return { x: Math.min(a, c), y: Math.min(b, d), w: Math.max(6, Math.abs(c - a)), h: Math.max(6, Math.abs(d - b)) }
})
function dragStart(e) {
  if (e.button !== 0) return
  e.currentTarget.setPointerCapture(e.pointerId)
  drag.value = { sx: e.clientX, sy: e.clientY, ox: 0, oy: 0, moved: false }
}
function dragMove(e) {
  if (!drag.value) return
  drag.value.ox = e.clientX - drag.value.sx
  drag.value.oy = e.clientY - drag.value.sy
  if (Math.abs(drag.value.ox) + Math.abs(drag.value.oy) > 3) drag.value.moved = true
}
function dragEnd(e) {
  const d = drag.value
  drag.value = null
  if (!d) return
  if (!d.moved) { onClick(e); return }
  const rect = root.value.getBoundingClientRect()
  const [x0, y0] = viewport.value.convertToPdfPoint(d.sx - rect.left, d.sy - rect.top)
  const [x1, y1] = viewport.value.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top)
  const round = (v) => Math.round(v * 100) / 100
  store.moveRequest = { page: props.index, dx: round(x1 - x0), dy: round(y1 - y0), kind: store.moveTarget?.kind, n: Math.random() }
}
</script>

<template>
  <div ref="root" class="relative mx-auto bg-white shadow-lg shadow-black/50" :style="{ width: size.w + 'px', height: size.h + 'px' }" :data-page="index" @click="onClick($event)" @dblclick="onClick($event, true)">
    <div ref="holder" class="absolute inset-0" />
    <div v-if="failed" class="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-red-600">Render error: {{ failed }}</div>
    <div v-if="hl" :key="hl.n" class="locate-ring" :class="{ 'is-point': hl.point }" :style="{ left: hl.x - 2 + 'px', top: hl.y - 2 + 'px', width: hl.w + 4 + 'px', height: hl.h + 4 + 'px' }" />
    <div
      v-if="moveBox"
      class="absolute cursor-move rounded-sm border-2 border-dashed border-amber-400/90 bg-amber-300/5 hover:bg-amber-300/15"
      :style="{ left: moveBox.x - 3 + 'px', top: moveBox.y - 3 + 'px', width: moveBox.w + 6 + 'px', height: moveBox.h + 6 + 'px', transform: drag ? `translate(${drag.ox}px, ${drag.oy}px)` : '' }"
      title="Drag to move the selection · double-click to edit its text"
      @click.stop
      @dblclick.stop="onClick($event, true)"
      @pointerdown.stop="dragStart"
      @pointermove="dragMove"
      @pointerup="dragEnd"
    />
    <div class="absolute -left-1 top-0 -translate-x-full pr-1 font-mono text-[10px] text-zinc-500 select-none">{{ index + 1 }}</div>
  </div>
</template>
