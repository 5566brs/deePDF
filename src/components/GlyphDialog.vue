<script setup>
// Glyphs of a font: outline previews, export as SVG (single / sheet / JSON), copy codes for pasting into strings.
import { ref, onMounted, computed } from 'vue'
import { findPdfjsFont, listGlyphs, glyphSVG, glyphSheetSVG } from '../core/glyphs.js'
import { download, baseName, notify } from '../core/store.js'

const props = defineProps({ pageIndex: Number, font: Object }) // font: { name, base, info }
const emit = defineEmits(['close'])

const state = ref({ loading: true })
const filter = ref('')
const selected = ref(null)

onMounted(async () => {
  try {
    const f = await findPdfjsFont(props.pageIndex, props.font.base)
    if (!f) { state.value = { error: 'This font is not used on the rendered page (pdf.js did not load it).' }; return }
    const r = listGlyphs(f)
    state.value = r.error ? { error: r.error } : { ...r, loading: false }
  } catch (e) {
    state.value = { error: String(e.message || e) }
  }
})

const glyphs = computed(() => {
  const list = state.value.glyphs || []
  const info = props.font.info
  return list.map((g) => {
    const uni = info ? info.toUnicode(g.code) : null
    return { ...g, uni, svg: glyphSVG(g, { size: 44, fill: 'currentColor' }), codeLen: info && info.composite ? 2 : 1 }
  }).filter((g) => {
    const f = filter.value.trim().toLowerCase()
    if (!f) return true
    return (g.uni && g.uni.includes(filter.value.trim())) || (g.name || '').toLowerCase().includes(f) || g.code.toString(16).includes(f.replace(/^0x/, ''))
  })
})

const fname = (g, ext) => `${baseName()}-${(props.font.base || props.font.name).replace(/[^\w.+-]/g, '_')}-${g.code.toString(16).padStart(4, '0')}${g.name ? '-' + g.name.replace(/[^\w.-]/g, '_') : ''}.${ext}`
function exportOne(g) { download(new Blob([glyphSVG(g)], { type: 'image/svg+xml' }), fname(g, 'svg')) }
function pdfCode(g) { return '<' + g.code.toString(16).toUpperCase().padStart(g.codeLen * 2, '0') + '>' }
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); notify(`${what} copied`) } catch { notify('Clipboard not available', 'warn') }
}
function exportSheet() {
  download(new Blob([glyphSheetSVG(state.value.glyphs)], { type: 'image/svg+xml' }), `${baseName()}-${(props.font.base || props.font.name).replace(/[^\w.+-]/g, '_')}-glyphs.svg`)
}
function exportJSON() {
  const data = {
    font: props.font.base, resource: props.font.name, unitsPerEm: state.value.unitsPerEm, substitute: state.value.substitute,
    glyphs: state.value.glyphs.map((g) => ({
      code: g.code, codeHex: pdfCode({ ...g, codeLen: props.font.info?.composite ? 2 : 1 }), name: g.name,
      unicode: props.font.info ? props.font.info.toUnicode(g.code) : null, advanceWidth: g.width,
      path: g.glyph.getPath(0, 0, g.unitsPerEm).toPathData(2),
    })),
  }
  download(JSON.stringify(data, null, 1), `${baseName()}-${(props.font.base || props.font.name).replace(/[^\w.+-]/g, '_')}-glyphs.json`, 'application/json')
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/60 p-3 sm:items-center" @click.self="emit('close')">
    <div class="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
      <div class="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        <h2 class="text-sm font-semibold text-zinc-100">Glyphs · <span class="font-mono">/{{ font.name }}</span> <span class="font-normal text-zinc-400">{{ font.base }}</span></h2>
        <span v-if="state.substitute" class="tag bg-amber-900 text-amber-200" v-tip="'The font is not embedded; outlines come from the standard substitute font pdf.js uses'">substitute</span>
        <div class="flex-1" />
        <input v-model="filter" class="inp w-36" placeholder="Filter (char, name, hex)" />
        <button class="btn btn-icon" @click="emit('close')">✕</button>
      </div>
      <div class="min-h-0 flex-1 overflow-auto p-3 scroll-thin">
        <div v-if="state.loading && !state.error" class="text-sm text-zinc-400">Loading font outlines…</div>
        <div v-else-if="state.error" class="text-sm text-amber-300">{{ state.error }}</div>
        <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-1.5">
          <button
            v-for="g in glyphs" :key="g.code"
            class="flex flex-col items-center rounded border bg-zinc-100 p-1 text-zinc-900 transition-colors hover:border-cyan-400"
            :class="selected === g ? 'border-cyan-400 ring-2 ring-cyan-500' : 'border-zinc-700'"
            v-tip="`Code 0x${g.code.toString(16).toUpperCase()}${g.name ? ' · ' + g.name : ''}${g.uni ? ' · “' + g.uni + '”' : ''} · width ${g.width}/${g.unitsPerEm}`"
            @click="selected = g"
          >
            <span class="flex h-12 items-center" v-html="g.svg" />
            <span class="font-mono text-[9px] text-zinc-600">{{ g.code.toString(16).toUpperCase().padStart(g.codeLen * 2, '0') }}</span>
            <span class="h-3 text-[10px] leading-3 text-zinc-800">{{ g.uni }}</span>
          </button>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-4 py-2.5 text-xs">
        <template v-if="selected">
          <span class="text-zinc-300">0x{{ selected.code.toString(16).toUpperCase() }} {{ selected.name }}</span>
          <button class="btn" @click="exportOne(selected)">⇩ SVG</button>
          <button class="btn" v-tip="'Copy the SVG markup'" @click="copy(glyphSVG(selected), 'SVG')">Copy SVG</button>
          <button class="btn" v-tip="'Copy the character code as a PDF hex string, ready to paste into a Tj / TJ operand'" @click="copy(pdfCode(selected), 'PDF code')">Copy code {{ pdfCode(selected) }}</button>
          <button v-if="selected.uni" class="btn" @click="copy(selected.uni, 'Character')">Copy “{{ selected.uni }}”</button>
        </template>
        <span v-else class="text-zinc-500">{{ glyphs.length }} glyphs · select one for actions</span>
        <div class="flex-1" />
        <button class="btn" :disabled="!state.glyphs" v-tip="'All glyphs in one SVG sheet'" @click="exportSheet">⇩ Sheet SVG</button>
        <button class="btn" :disabled="!state.glyphs" v-tip="'All glyph outlines (SVG path data), codes and Unicode values'" @click="exportJSON">⇩ JSON</button>
      </div>
    </div>
  </div>
</template>
