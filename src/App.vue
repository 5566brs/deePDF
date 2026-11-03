<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { store, ctxRef, loadPdfBytes, loadJSON, undo, redo, saveDraft, loadDraft, draftInfo, notify, memoryStats } from './core/store.js'
import { fmtBytes } from './core/pdfobj.js'
import PreviewPane from './components/PreviewPane.vue'
import PagesTab from './components/PagesTab.vue'
import ElementsTab from './components/ElementsTab.vue'
import ObjectsTab from './components/ObjectsTab.vue'
import MetadataTab from './components/MetadataTab.vue'
import ExportDialog from './components/ExportDialog.vue'

const tabs = [
  { id: 'pages', label: 'Pages', tip: 'Reorder, delete and inspect pages and their boxes.' },
  { id: 'elements', label: 'Elements', tip: 'Content of the current page: text, images, paths, groups and annotations. Duplicate, reorder, edit.' },
  { id: 'objects', label: 'Objects', tip: 'Every indirect object in the file, as a tree from the trailer or as a flat list. Streams can be opened and edited.' },
  { id: 'metadata', label: 'Metadata', tip: 'Document information dictionary, XMP metadata, viewer preferences and other catalog-level settings.' },
]
const tabComp = { pages: PagesTab, elements: ElementsTab, objects: ObjectsTab, metadata: MetadataTab }

const showExport = ref(false)
const fileInput = ref(null)
const jsonInput = ref(null)
const dragging = ref(false)
const leftWidth = ref(Math.round(Math.min(720, Math.max(420, window.innerWidth * 0.46))))
const draft = ref(null)

const loaded = computed(() => !!ctxRef.value)

async function openFile(file) {
  if (!file) return
  const buf = new Uint8Array(await file.arrayBuffer())
  if (/\.json$/i.test(file.name) || file.type === 'application/json') {
    try {
      loadJSON(JSON.parse(new TextDecoder().decode(buf)), file.name)
      notify('Loaded JSON description')
    } catch (e) {
      notify('Invalid JSON description: ' + (e.message || e), 'error', 6000)
    }
    return
  }
  await loadPdfBytes(buf, file.name, file)
}
function onPick(e) { openFile(e.target.files[0]); e.target.value = '' }

function onDrop(e) {
  e.preventDefault()
  dragging.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f) openFile(f)
}
function onDragOver(e) {
  if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); dragging.value = true }
}

function onKey(e) {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  const t = e.target
  const editing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
  if (e.key.toLowerCase() === 'z' && !editing) { e.preventDefault(); e.shiftKey ? redo() : undo() }
  else if (e.key.toLowerCase() === 'y' && !editing) { e.preventDefault(); redo() }
  else if (e.key.toLowerCase() === 's') { e.preventDefault(); if (loaded.value) showExport.value = true }
  else if (e.key.toLowerCase() === 'o') { e.preventDefault(); fileInput.value?.click() }
}

let resizing = false
function startResize(e) {
  resizing = true
  const startX = e.clientX, startW = leftWidth.value
  const move = (ev) => { if (resizing) leftWidth.value = Math.min(window.innerWidth - 280, Math.max(320, startW + ev.clientX - startX)) }
  const up = () => { resizing = false; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function beforeUnload(e) { if (store.dirty) { e.preventDefault(); e.returnValue = '' } }

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('beforeunload', beforeUnload)
  draft.value = await draftInfo()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('beforeunload', beforeUnload)
})

const sig = computed(() => store.signature)
const mem = computed(() => { store.rev; return memoryStats() })
</script>

<template>
  <div class="flex h-dvh flex-col" @dragover="onDragOver" @dragleave.self="dragging = false" @drop="onDrop">
    <!-- header -->
    <header class="flex shrink-0 items-center gap-1.5 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
      <div class="flex shrink-0 items-center gap-2 sm:pr-2">
        <img src="/favicon.svg" class="h-6 w-6" alt="" />
        <span class="hidden text-sm font-semibold tracking-tight text-zinc-100 sm:inline">dee<span class="text-cyan-400">PDF</span></span>
      </div>
      <button class="btn" v-tip="'Open a PDF or a deePDF JSON description (Ctrl+O). You can also drop a file anywhere.'" @click="fileInput.click()">Open<span class="hidden sm:inline">…</span></button>
      <input ref="fileInput" type="file" accept=".pdf,application/pdf,.json,application/json" class="hidden" @change="onPick" />
      <template v-if="loaded">
        <div class="mx-1 hidden h-5 w-px bg-zinc-700 sm:block" />
        <button class="btn btn-icon" :disabled="!store.undo.length" v-tip="store.undo.length ? `Undo: ${store.undo[store.undo.length - 1].label} (Ctrl+Z)` : 'Nothing to undo'" @click="undo">↶</button>
        <button class="btn btn-icon" :disabled="!store.redo.length" v-tip="store.redo.length ? `Redo: ${store.redo[store.redo.length - 1].label} (Ctrl+Shift+Z)` : 'Nothing to redo'" @click="redo">↷</button>
        <div class="mx-1 hidden h-5 w-px bg-zinc-700 sm:block" />
        <button class="btn hidden sm:inline-flex" v-tip="'Save the current working state in this browser (IndexedDB) so you can continue later.'" @click="saveDraft">Save draft</button>
        <div class="min-w-0 flex-1 truncate px-1 text-xs text-zinc-400 sm:px-2">
          <span class="hidden text-zinc-200 sm:inline">{{ store.fileName }}</span>
          <span class="hidden md:inline"> · {{ store.pageCount }} page{{ store.pageCount === 1 ? '' : 's' }}<template v-if="store.originalSize"> · {{ fmtBytes(store.originalSize) }}</template></span>
          <span v-if="store.dirty" class="ml-1 text-amber-400" v-tip="'There are unsaved changes'">●</span>
          <span class="ml-2 hidden font-mono text-[10px] text-zinc-500 lg:inline" v-tip="`Stream data held in memory: ${fmtBytes(mem.resident)}\nStream data kept on disk (slices of the opened file / IndexedDB, read only when opened or exported): ${fmtBytes(mem.onDisk)} in ${mem.lazyCount} stream(s)`">RAM {{ fmtBytes(mem.resident) }}<template v-if="mem.onDisk"> · disk {{ fmtBytes(mem.onDisk) }}</template></span>
          <span v-if="store.previewBusy" class="ml-2 text-zinc-500">rendering…</span>
        </div>
        <div class="flex rounded border border-zinc-700 lg:hidden">
          <button class="px-2 py-1 text-xs" :class="store.mobileView === 'editor' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" @click="store.mobileView = 'editor'">Editor</button>
          <button class="px-2 py-1 text-xs" :class="store.mobileView === 'preview' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" @click="store.mobileView = 'preview'">Preview</button>
        </div>
        <button class="btn btn-primary" v-tip="'Export PDF (with compression and validation options), JSON description or elements (Ctrl+S)'" @click="showExport = true"><span class="hidden sm:inline">Export…</span><span class="sm:hidden">⇩</span></button>
      </template>
      <div v-else class="flex-1" />
    </header>

    <!-- banners -->
    <div v-if="loaded && sig && sig.signed" class="flex shrink-0 items-start gap-2 border-b border-amber-700/60 bg-amber-950/70 px-3 py-1.5 text-xs text-amber-200">
      <span class="text-base leading-none">⚠</span>
      <div>
        <b>This document is digitally signed.</b>
        <template v-if="sig.fields.length"> Signature field(s): {{ sig.fields.map((f) => f.name + (f.signer ? ` (${f.signer})` : '')).join(', ') }}.</template>
        Any change invalidates the signature — exported files are written <b>without</b> the signature (signature fields are kept empty).
      </div>
    </div>
    <div v-if="loaded && store.encrypted" class="shrink-0 border-b border-red-800/60 bg-red-950/60 px-3 py-1.5 text-xs text-red-200">
      <b>Encrypted document.</b> Strings and streams are shown in their encrypted form; decryption is not supported. Structural edits are possible, but content edits will not render correctly.
    </div>
    <div v-if="store.error" class="shrink-0 border-b border-red-800/60 bg-red-950/60 px-3 py-1.5 text-xs text-red-200">{{ store.error }}</div>

    <!-- main -->
    <main v-if="loaded" class="flex min-h-0 flex-1">
      <section
        class="min-h-0 flex-col border-zinc-800 bg-zinc-900/40 lg:flex lg:border-r"
        :class="store.mobileView === 'editor' ? 'flex w-full' : 'hidden'"
        :style="{ '--lw': leftWidth + 'px' }"
      >
        <nav class="flex shrink-0 gap-0.5 border-b border-zinc-800 px-2 pt-1.5">
          <button
            v-for="t in tabs" :key="t.id"
            v-tip="t.tip"
            class="rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium transition-colors"
            :class="store.tab === t.id ? 'border-zinc-700 bg-zinc-800 text-white' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
            @click="store.tab = t.id"
          >{{ t.label }}</button>
        </nav>
        <div class="scroll-thin min-h-0 flex-1 overflow-auto bg-zinc-800/40">
          <KeepAlive>
            <component :is="tabComp[store.tab]" :key="store.tab" />
          </KeepAlive>
        </div>
      </section>
      <div class="hidden w-1.5 shrink-0 cursor-col-resize bg-zinc-900 transition-colors hover:bg-cyan-700 lg:block" @pointerdown.prevent="startResize" v-tip="'Drag to resize'" />
      <section class="min-h-0 min-w-0 flex-1 lg:block" :class="store.mobileView === 'preview' ? 'block' : 'hidden'">
        <PreviewPane />
      </section>
    </main>

    <!-- welcome -->
    <main v-else class="flex flex-1 items-center justify-center p-6">
      <div class="w-full max-w-xl rounded-xl border border-dashed p-8 text-center transition-colors" :class="dragging ? 'border-cyan-400 bg-cyan-950/30' : 'border-zinc-700 bg-zinc-900/50'">
        <img src="/favicon.svg" class="mx-auto mb-4 h-14 w-14" alt="" />
        <h1 class="text-2xl font-semibold text-zinc-100">dee<span class="text-cyan-400">PDF</span></h1>
        <p class="mx-auto mt-2 max-w-md text-sm text-zinc-400">
          Edit the values a PDF is made of — objects, streams, content operators and metadata.
          Everything runs locally in your browser; nothing is uploaded.
        </p>
        <div class="mt-6 flex flex-wrap justify-center gap-2">
          <button class="btn btn-primary px-4 py-2 text-sm" @click="fileInput.click()">Open PDF…</button>
          <button class="btn px-4 py-2 text-sm" v-tip="'Load a JSON description previously exported from deePDF'" @click="jsonInput.click()">Import JSON…</button>
          <button v-if="draft" class="btn px-4 py-2 text-sm" v-tip="`Saved ${new Date(draft.savedAt).toLocaleString()}`" @click="loadDraft">Restore draft: {{ draft.name }}</button>
        </div>
        <input ref="jsonInput" type="file" accept=".json,application/json" class="hidden" @change="onPick" />
        <p class="mt-4 text-xs text-zinc-500">or drop a .pdf / .json file here</p>
        <p v-if="store.loading" class="mt-4 text-sm text-cyan-300">Parsing…</p>
      </div>
    </main>

    <ExportDialog v-if="showExport" @close="showExport = false" />

    <div v-if="dragging && loaded" class="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-cyan-950/50 text-lg text-cyan-100">Drop to open</div>

    <Transition enter-from-class="opacity-0 translate-y-2" leave-to-class="opacity-0" enter-active-class="transition" leave-active-class="transition">
      <div v-if="store.toast" :key="store.toast.id"
        class="fixed bottom-4 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-lg px-4 py-2 text-sm shadow-xl"
        :class="{ 'bg-zinc-100 text-zinc-900': store.toast.kind === 'info', 'bg-red-600 text-white': store.toast.kind === 'error', 'bg-amber-500 text-zinc-950': store.toast.kind === 'warn' }">
        {{ store.toast.msg }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
@media (min-width: 1024px) {
  section[style*='--lw'] { width: var(--lw); flex: none; }
}
</style>
