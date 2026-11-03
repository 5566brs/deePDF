<script setup>
// Export: PDF (compression / object streams / cleanup / validation) and JSON description.
import { ref, computed, onMounted } from 'vue'
import { store, ctx, download, baseName, exportJSON, notify } from '../core/store.js'
import { exportPdf, validate } from '../core/exporter.js'
import { fmtBytes } from '../core/pdfobj.js'

const emit = defineEmits(['close'])

const opts = ref({
  compression: 'keep',
  objectStreams: false,
  removeUnused: true,
  renumber: false,
  fixDangling: true,
  stripSignature: true,
  updateModDate: false,
})
const signed = computed(() => !!store.signature?.signed)
const encrypted = computed(() => store.encrypted)
const report = ref(null)
const result = ref(null)
const busy = ref(false)
const jsonDecode = ref(true)

/* ---------- HTML ---------- */
const html = ref(null)
const htmlBusy = ref('')
const htmlScale = ref(2)
async function buildHtmlExport() {
  html.value = null
  htmlBusy.value = 'Loading…'
  try {
    const { buildHtml } = await import('../core/htmlExport.js')
    const info = ctx().trailerInfo.Info
    void info
    html.value = await buildHtml({
      scale: +htmlScale.value,
      title: baseName(),
      onProgress: (i, n, phase) => { htmlBusy.value = `${phase === 'drawing' ? 'Converting' : 'Verifying'} page ${i + 1} / ${n}…` },
    })
  } catch (e) {
    console.error(e)
    notify('HTML export failed: ' + (e.message || e), 'error', 8000)
  } finally {
    htmlBusy.value = ''
  }
}
function downloadHtml() {
  download(new Blob([html.value.html], { type: 'text/html' }), `${baseName()}.html`)
}
const pct = (v) => (v === undefined ? '–' : (Math.floor(v * 1000) / 10).toFixed(1) + '%')

onMounted(() => { report.value = validate(ctx()) })

const tips = {
  keep: 'Streams keep their current encoding.',
  compress: 'Every uncompressed stream (except XMP metadata) is compressed with FlateDecode.',
  decompress: 'Every stream that can be decoded is stored uncompressed (image codecs like JPEG are kept). Useful for inspecting the file in a text editor.',
}

async function runExport() {
  busy.value = true
  result.value = null
  try {
    const o = { ...opts.value, stripSignature: signed.value ? true : opts.value.stripSignature }
    const r = await exportPdf(ctx(), o)
    result.value = r
    if (r.verify.ok) {
      download(r.blob, `${baseName()}${store.dirty ? '-edited' : ''}.pdf`)
      store.dirty = false
    }
  } catch (e) {
    console.error(e)
    notify('Export failed: ' + (e.message || e), 'error', 8000)
  } finally {
    busy.value = false
  }
}
function forceDownload() {
  download(result.value.blob, `${baseName()}-edited.pdf`)
}
async function exportJson() {
  const json = await exportJSON({ decodeText: jsonDecode.value })
  download(JSON.stringify(json, null, 1), `${baseName()}.deepdf.json`, 'application/json')
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/60 p-3 sm:items-center" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="w-full max-w-xl rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
      <div class="flex items-center border-b border-zinc-800 px-4 py-2.5">
        <h2 class="text-sm font-semibold text-zinc-100">Export</h2>
        <div class="flex-1" />
        <button class="btn btn-icon" @click="emit('close')">✕</button>
      </div>

      <div class="space-y-4 p-4 text-xs">
        <div v-if="signed" class="rounded border border-amber-700 bg-amber-950/60 p-2 text-amber-200">
          This document is signed. The exported PDF is written <b>without signatures</b> (signature values, /Perms and /DSS are removed; empty signature fields remain).
        </div>

        <section>
          <h3 class="mb-1.5 font-semibold text-zinc-300">Compression</h3>
          <div class="flex flex-wrap gap-1">
            <label v-for="m in ['keep', 'compress', 'decompress']" :key="m" class="btn cursor-pointer" :class="{ 'border-cyan-500 text-cyan-200': opts.compression === m }" v-tip="tips[m]">
              <input v-model="opts.compression" type="radio" :value="m" class="hidden" :disabled="encrypted && m !== 'keep'" />
              {{ { keep: 'Keep as is', compress: 'Compress all', decompress: 'No compression' }[m] }}
            </label>
          </div>
          <label class="mt-2 flex items-center gap-2" v-tip="'Pack objects into compressed object streams with a cross-reference stream (PDF 1.5+). Smaller files; not readable in a text editor.'">
            <input v-model="opts.objectStreams" type="checkbox" /> Use object streams &amp; xref stream
          </label>
        </section>

        <section>
          <h3 class="mb-1.5 font-semibold text-zinc-300">Structure &amp; index</h3>
          <div class="space-y-1.5">
            <label class="flex items-center gap-2" v-tip="'Drop objects that cannot be reached from the trailer (orphans left by edits, deleted pages…)'"><input v-model="opts.removeUnused" type="checkbox" /> Remove unreferenced objects</label>
            <label class="flex items-center gap-2" v-tip="'Replace references to objects that do not exist with null'"><input v-model="opts.fixDangling" type="checkbox" /> Replace dangling references with null</label>
            <label class="flex items-center gap-2" :class="{ 'opacity-50': encrypted }" v-tip="'Renumber all objects consecutively from 1 (catalog first), updating every reference'"><input v-model="opts.renumber" type="checkbox" :disabled="encrypted" /> Renumber objects 1…n</label>
            <label class="flex items-center gap-2" v-tip="'Set /Info /ModDate to the current time'"><input v-model="opts.updateModDate" type="checkbox" /> Update modification date</label>
            <label v-if="!signed" class="flex items-center gap-2" v-tip="'Also remove signature-related entries if any exist'"><input v-model="opts.stripSignature" type="checkbox" /> Remove signature data</label>
          </div>
          <p class="mt-2 text-zinc-500">The file is always written with a freshly built cross-reference index; every /Length is recomputed. After writing, each xref entry is checked against its object header and the output is re-parsed.</p>
        </section>

        <section v-if="report">
          <h3 class="mb-1.5 font-semibold text-zinc-300">Pre-export check <span class="font-normal text-zinc-500">({{ report.objectCount }} objects)</span></h3>
          <div v-if="!report.issues.length" class="text-emerald-300">✓ No issues found</div>
          <div v-for="(i, k) in report.issues" :key="k" :class="{ 'text-red-300': i.level === 'error', 'text-amber-300': i.level === 'warn', 'text-sky-300': i.level === 'fix', 'text-zinc-400': i.level === 'info' }">
            • {{ i.msg }}
            <div v-if="i.items" class="ml-3 max-h-20 overflow-auto font-mono text-[10px] text-zinc-500">{{ i.items.join('  ') }}</div>
          </div>
        </section>

        <section class="rounded border border-zinc-700 p-2">
          <h3 class="mb-1.5 flex items-center gap-2 font-semibold text-zinc-300">HTML (print-faithful)
            <span class="font-normal text-zinc-500" v-tip="'Self-contained HTML: each page is an inline SVG. Vector drawings become individual <path> elements, text becomes editable <text> using the embedded fonts, raster images stay images. The result is rendered again and compared pixel by pixel with the PDF rendering.'">ⓘ</span>
          </h3>
          <div class="flex flex-wrap items-center gap-2">
            <label class="flex items-center gap-1 text-zinc-400" v-tip="'Internal resolution (units per point). Higher = more precise coordinates and sharper rasterised fallbacks (patterns/soft masks).'">resolution
              <select v-model="htmlScale" class="inp"><option :value="1">1×</option><option :value="2">2×</option><option :value="3">3×</option></select>
            </label>
            <button class="btn" :disabled="!!htmlBusy" @click="buildHtmlExport">{{ htmlBusy || 'Build & verify HTML' }}</button>
            <button v-if="html" class="btn btn-primary" @click="downloadHtml">⇩ HTML ({{ fmtBytes(html.summary.bytes) }})</button>
          </div>
          <div v-if="html" class="mt-2 space-y-1">
            <div :class="html.summary.minSimilarity >= 0.995 ? 'text-emerald-300' : html.summary.minSimilarity >= 0.97 ? 'text-amber-300' : 'text-red-300'">
              Lowest page match: <b>{{ pct(html.summary.minSimilarity) }}</b> of drawn pixels identical to the PDF rendering
              · {{ html.summary.paths }} vector paths · {{ html.summary.texts }} text runs · {{ html.summary.rasterImages }} raster images<template v-if="html.summary.patterns"> · {{ html.summary.patterns }} rasterised patterns</template>
            </div>
            <div v-if="html.summary.untranslatedRuns" class="text-zinc-400" v-tip="'These text runs use fonts whose codes could not be mapped to Unicode (no ToUnicode); they still render exactly but contain private-use characters.'">{{ html.summary.untranslatedRuns }} text run(s) without Unicode text</div>
            <div v-if="html.summary.missingFonts.length" class="text-amber-300">Fonts without embeddable data (system fallback): {{ html.summary.missingFonts.join(', ') }}</div>
            <div v-if="html.summary.unsupported.length" class="text-amber-300">Approximated: {{ html.summary.unsupported.join(' · ') }}</div>
            <div class="flex flex-wrap gap-2 pt-1">
              <div v-for="p in html.pages" :key="p.index" class="text-center" v-tip="'Red = pixels that differ from the PDF rendering, grey = matching ink'">
                <img v-if="p.diffUrl" :src="p.diffUrl" class="h-24 rounded border border-zinc-700 bg-white" alt="" />
                <div class="text-[10px]" :class="p.similarity >= 0.995 ? 'text-emerald-300' : 'text-amber-300'">p{{ p.index + 1 }} · {{ pct(p.similarity) }}</div>
              </div>
            </div>
          </div>
        </section>

        <section v-if="result" class="rounded border p-2" :class="result.verify.ok ? 'border-emerald-700 bg-emerald-950/40' : 'border-red-700 bg-red-950/40'">
          <div class="font-semibold" :class="result.verify.ok ? 'text-emerald-300' : 'text-red-300'">
            {{ result.verify.ok ? '✓ Exported and verified' : '✗ Verification failed' }} · {{ fmtBytes(result.size) }}
            <span v-if="store.originalSize" class="font-normal text-zinc-400">(original {{ fmtBytes(store.originalSize) }})</span>
          </div>
          <ul class="mt-1 text-zinc-300">
            <li v-for="(l, k) in result.log" :key="k">• {{ l }}</li>
            <li v-if="result.verify.checked">• {{ result.verify.checked }} xref entries point to their objects</li>
            <li v-if="result.verify.reparsed">• Re-parsed {{ result.verify.reparsed }} objects</li>
            <li v-if="result.verify.note" class="text-zinc-400">• {{ result.verify.note }}</li>
            <li v-for="(p, k) in result.verify.problems" :key="'p' + k" class="text-red-300">• {{ p }}</li>
          </ul>
          <button v-if="!result.verify.ok" class="btn mt-2" @click="forceDownload">Download anyway</button>
        </section>
      </div>

      <div class="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-4 py-3">
        <button class="btn" v-tip="'Full description of every object and stream as JSON. It can be edited and loaded back with Open…'" @click="exportJson">⇩ JSON description</button>
        <label class="flex items-center gap-1 text-[11px] text-zinc-400" v-tip="'Store decodable text streams (content, XMP…) as readable text instead of base64'"><input v-model="jsonDecode" type="checkbox" /> readable streams</label>
        <div class="flex-1" />
        <button class="btn" @click="emit('close')">Close</button>
        <button class="btn btn-primary" :disabled="busy" @click="runExport">{{ busy ? 'Exporting…' : '⇩ Export PDF' }}</button>
      </div>
    </div>
  </div>
</template>
