<script setup>
// Small rendered page thumbnail (lazy).
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { pdfDoc, pdfDocRev } from '../core/preview.js'

const props = defineProps({ index: Number, width: { type: Number, default: 72 } })
const holder = ref(null)
const aspect = ref(1.414)
let visible = false
let key = ''
let obs = null

async function render() {
  const doc = pdfDoc.value
  if (!visible || !doc || props.index >= doc.numPages) return
  const k = `${pdfDocRev.value}:${props.index}`
  if (k === key) return
  key = k
  try {
    const page = await doc.getPage(props.index + 1)
    const vp0 = page.getViewport({ scale: 1 })
    aspect.value = vp0.height / vp0.width
    const scale = (props.width * Math.min(2, window.devicePixelRatio || 1)) / vp0.width
    const vp = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height)
    canvas.className = 'w-full h-full'
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise
    if (key === k && holder.value) holder.value.replaceChildren(canvas)
  } catch { key = '' }
}
watch([pdfDocRev, () => props.index], render)
onMounted(() => {
  obs = new IntersectionObserver((e) => { visible = e.some((x) => x.isIntersecting); render() }, { rootMargin: '200px' })
  obs.observe(holder.value)
})
onBeforeUnmount(() => obs?.disconnect())
</script>

<template>
  <div ref="holder" class="shrink-0 overflow-hidden rounded-sm bg-white shadow" :style="{ width: width + 'px', height: Math.round(width * aspect) + 'px' }" />
</template>
