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

function onClick(e) {
  if (!viewport.value) return
  const rect = root.value.getBoundingClientRect()
  const [x, y] = viewport.value.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top)
  emit('pick', { page: props.index, x, y })
}
</script>

<template>
  <div ref="root" class="relative mx-auto bg-white shadow-lg shadow-black/50" :style="{ width: size.w + 'px', height: size.h + 'px' }" :data-page="index" @click="onClick">
    <div ref="holder" class="absolute inset-0" />
    <div v-if="failed" class="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-red-600">Render error: {{ failed }}</div>
    <div v-if="hl" :key="hl.n" class="locate-ring" :class="{ 'is-point': hl.point }" :style="{ left: hl.x - 2 + 'px', top: hl.y - 2 + 'px', width: hl.w + 4 + 'px', height: hl.h + 4 + 'px' }" />
    <div class="absolute -left-1 top-0 -translate-x-full pr-1 font-mono text-[10px] text-zinc-500 select-none">{{ index + 1 }}</div>
  </div>
</template>
