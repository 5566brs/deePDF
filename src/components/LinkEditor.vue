<script setup>
// Edit where a link annotation points: URL, page of this document, or named destination.
import { ref, watch, computed } from 'vue'
import { store, ctx, mutate, locate } from '../core/store.js'
import { readLink, writeLink, namedDestinations, FIT_MODES } from '../core/links.js'
import { PDFDict } from '../core/pdfobj.js'

const props = defineProps({ annotRef: Object, autofocus: Boolean })

const cur = computed(() => {
  store.rev
  const a = ctx().lookup(props.annotRef)
  return a instanceof PDFDict ? readLink(ctx(), a) : { kind: 'none' }
})
const form = ref({})
watch(cur, (c) => {
  form.value = {
    kind: c.kind === 'other' || c.kind === 'none' ? 'url' : c.kind,
    url: c.url || '',
    page: (c.page ?? 0) + 1,
    mode: c.mode || 'Fit',
    params: (c.params || []).map((v) => (v === null ? '' : v)),
    name: c.name || '',
  }
}, { immediate: true })
const names = computed(() => { store.rev; return form.value.kind === 'named' ? namedDestinations(ctx()) : [] })
const paramLabels = computed(() => ({ XYZ: ['left', 'top', 'zoom'], FitH: ['top'], FitV: ['left'] }[form.value.mode] || []))
const urlInput = ref(null)
watch(() => props.autofocus, (v) => { if (v) setTimeout(() => urlInput.value?.focus(), 50) }, { immediate: true })

const valid = computed(() => {
  const f = form.value
  if (f.kind === 'url') return /^[a-z][a-z0-9+.-]*:/i.test(f.url.trim()) ? '' : 'Enter a full URL (https://…, mailto:…)'
  if (f.kind === 'page') return f.page >= 1 && f.page <= store.pageCount ? '' : `Page must be 1–${store.pageCount}`
  if (f.kind === 'named') return f.name.trim() ? '' : 'Enter a destination name'
  return ''
})
function apply() {
  if (valid.value) return
  const f = form.value
  mutate('Edit link target', (c) => writeLink(c, c.lookup(props.annotRef), {
    kind: f.kind, url: f.url.trim(), page: f.page - 1, mode: f.mode, params: f.params, name: f.name.trim(),
  }))
}
function showTarget() {
  if (form.value.kind === 'page') { store.currentPage = form.value.page - 1; locate(form.value.page - 1, null) }
  else if (form.value.kind === 'url') window.open(form.value.url, '_blank', 'noopener')
}
const describe = computed(() => {
  const c = cur.value
  if (c.kind === 'url') return `URL: ${c.url}`
  if (c.kind === 'page') return `Page ${c.page + 1} (${c.mode})`
  if (c.kind === 'named') return `Named destination “${c.name}”`
  if (c.kind === 'other') return `Other action: ${c.action}${c.file ? ' → ' + c.file : ''} (will be replaced if you apply)`
  return 'No target'
})
</script>

<template>
  <div class="ml-6 mr-1 mb-1 rounded border border-sky-900/70 bg-sky-950/20 p-1.5 text-xs" @keydown.enter.prevent="apply">
    <div class="mb-1 flex flex-wrap items-center gap-1">
      <span class="font-semibold text-sky-200">Link target</span>
      <span class="truncate text-[10px] text-zinc-400" dir="auto">now: {{ describe }}</span>
    </div>
    <div class="flex flex-wrap items-center gap-1">
      <select v-model="form.kind" class="inp" v-tip="'URL = /A << /S /URI >> · Page = /Dest [page /Fit…] · Named = /Dest (name) resolved through the catalog'">
        <option value="url">URL</option>
        <option value="page">Page in this document</option>
        <option value="named">Named destination</option>
      </select>
      <template v-if="form.kind === 'url'">
        <input ref="urlInput" v-model="form.url" class="inp min-w-0 flex-1" dir="ltr" placeholder="https://…" />
      </template>
      <template v-else-if="form.kind === 'page'">
        <label class="flex items-center gap-0.5 text-[10px] text-zinc-500">page<input v-model.number="form.page" type="number" min="1" :max="store.pageCount" class="inp w-14" /></label>
        <select v-model="form.mode" class="inp" v-tip="FIT_MODES[form.mode]">
          <option v-for="(d, m) in FIT_MODES" :key="m" :value="m">{{ m }}</option>
        </select>
        <label v-for="(l, i) in paramLabels" :key="l" class="flex items-center gap-0.5 text-[10px] text-zinc-500" v-tip="'Empty = keep the current value when jumping'">{{ l }}<input v-model="form.params[i]" type="number" step="any" class="inp w-14" /></label>
      </template>
      <template v-else>
        <input v-model="form.name" class="inp min-w-0 flex-1" list="dl-named-dests" placeholder="destination name" />
        <datalist id="dl-named-dests"><option v-for="n in names" :key="n" :value="n" /></datalist>
      </template>
      <button class="btn btn-primary" :disabled="!!valid" @click="apply">Apply</button>
      <button class="btn" v-tip="form.kind === 'url' ? 'Open the URL in a new tab' : 'Show the target page'" :disabled="form.kind === 'named'" @click="showTarget">↗</button>
    </div>
    <div v-if="valid" class="mt-0.5 text-[10px] text-amber-300">{{ valid }}</div>
  </div>
</template>
