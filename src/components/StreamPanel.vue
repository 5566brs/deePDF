<script setup>
// Stream data viewer/editor: decodes the stream, lets you edit it as operators, text or replace it, re-encodes on save.
import { computed, ref, watch, onBeforeUnmount, provide } from 'vue'
import { store, ctx, mutate, locate, locationIndex, download, notify, baseName, offloadLargeStreams, memorySettings } from '../core/store.js'
import {
  decodeStream, filtersOf, setStreamData, setStreamRaw, isTextLike, latin1, fromLatin1, toHex, fmtBytes,
  PDFStream, N, deref, nameStr, rawLength, isOnDisk, rawBytesAsync, PDFRawStream,
} from '../core/pdfobj.js'
import { parseContent, serializeOps, computeBoxes } from '../core/contentStream.js'
import { makeEnv, listPages, fontDictByName } from '../core/pages.js'
import { fontInfo } from '../core/fonts.js'
import { opDoc } from '../core/docs.js'
import { imageBlob, isImageXObject } from '../core/images.js'
import OpLine from './OpLine.vue'

const props = defineProps({ streamRef: Object })

const stream = computed(() => { store.rev; const s = ctx().lookup(props.streamRef); return s instanceof PDFStream ? s : null })
const loadTick = ref(0)
const info = computed(() => {
  store.rev
  loadTick.value
  const s = stream.value
  if (!s) return null
  const c = ctx()
  const d = decodeStream(c, s)
  const type = nameStr(deref(c, s.dict.get(N('Type'))))
  const subtype = nameStr(deref(c, s.dict.get(N('Subtype'))))
  const loc = locationIndex().get(props.streamRef)
  const isContent = !!(loc && loc.content) || subtype === 'Form' || (deref(c, s.dict.get(N('PatternType')))?.asNumber?.() === 1) || (!type && !subtype && isTextLike(d.bytes) && looksLikeOps(d.bytes))
  return {
    filters: filtersOf(c, s), raw: rawLength(s), decoded: d.bytes, remaining: d.remaining, error: d.error, notLoaded: !!d.notLoaded, onDisk: isOnDisk(s),
    type, subtype, isContent, isImage: isImageXObject(c, s), text: isTextLike(d.bytes), loc,
  }
})

function looksLikeOps(bytes) {
  const s = latin1(bytes.subarray(0, 2000))
  return /(^|\s)(BT|q|cm|re|Tf|Do)(\s|$)/.test(s)
}

const mode = ref('')
watch(info, (i) => {
  if (!i) return
  if (!mode.value || (mode.value === 'ops' && !i.isContent)) mode.value = i.isImage ? 'image' : i.isContent ? 'ops' : i.text && !i.remaining.length ? 'text' : 'hex'
}, { immediate: true })

/* ---------- operators ---------- */
const ops = computed(() => {
  if (mode.value !== 'ops' || !info.value) return []
  try { return parseContent(info.value.decoded) } catch { return [] }
})
const boxes = computed(() => {
  if (mode.value !== 'ops' || !info.value) return []
  const c = ctx()
  const s = stream.value
  let res = deref(c, s.dict.get(N('Resources')))
  const loc = info.value.loc
  if (loc && loc.content) {
    const page = listPages(c)[loc.page]
    if (page) {
      let node = page.dict
      for (let d = 0; node && d < 32 && !res; d++) { res = deref(c, node.get(N('Resources'))); node = deref(c, node.get(N('Parent'))) }
    }
  }
  try { return computeBoxes(ops.value, makeEnv(c, res)) } catch { return [] }
})
const streamRes = computed(() => {
  store.rev
  const c = ctx()
  const s = stream.value
  let res = s ? deref(c, s.dict.get(N('Resources'))) : null
  const loc = info.value?.loc
  if (!res && loc && loc.content) {
    let node = listPages(c)[loc.page]?.dict
    for (let d = 0; node && d < 32 && !res; d++) { res = deref(c, node.get(N('Resources'))); node = deref(c, node.get(N('Parent'))) }
  }
  return res
})
provide('opEnv', {
  boxes: () => boxes.value,
  locate: (box) => { const loc = info.value?.loc; if (loc) locate(loc.page, (loc.content && box) || loc.rect) },
  font: (name) => { const f = fontDictByName(ctx(), streamRes.value, name); return f ? fontInfo(ctx(), f) : null },
  fontLabel: (name) => { const f = fontDictByName(ctx(), streamRes.value, name); if (!f) return 'Font resource not found'; const i = fontInfo(ctx(), f); return `→ ${i.baseFont} · ${i.type}${i.embedded ? ' · embedded' : ''}` },
  xobject: (name) => `XObject /${name}`,
})
void opDoc
const opLimit = ref(400)
const selectedOps = ref(new Set())

function writeOps(newOps, label) {
  mutate(label, (c) => {
    const s = c.lookup(props.streamRef)
    setStreamData(c, s, serializeOps(newOps), filtersOf(c, s).length ? 'flate' : 'none')
  })
}
function replaceOp(i, repl) {
  const arr = ops.value.slice()
  arr.splice(i, 1, ...repl)
  writeOps(arr, `Edit operation #${i}`)
}
function focusOp(i) {
  const loc = info.value.loc
  if (!loc) return
  // operator boxes are only in page space for page content streams; forms/patterns fall back to their placement
  locate(loc.page, (loc.content && boxes.value[i]) || loc.rect)
}
function toggleOp(i, e) {
  const s = new Set(selectedOps.value)
  if (e.shiftKey && s.size) {
    const last = Math.max(...s)
    for (let k = Math.min(last, i); k <= Math.max(last, i); k++) s.add(k)
  } else if (s.has(i)) s.delete(i)
  else s.add(i)
  selectedOps.value = s
}
function opsAction(kind) {
  const sel = [...selectedOps.value].sort((a, b) => a - b)
  if (!sel.length) return
  let arr = ops.value.slice()
  if (kind === 'delete') arr = arr.filter((_, i) => !selectedOps.value.has(i))
  else if (kind === 'dup') { const copies = sel.map((i) => arr[i]); arr.splice(sel[sel.length - 1] + 1, 0, ...copies) }
  else if (kind === 'up' && sel[0] > 0) { for (const i of sel) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; selectedOps.value = new Set(sel.map((i) => i - 1)) }
  else if (kind === 'down' && sel[sel.length - 1] < arr.length - 1) { for (const i of [...sel].reverse()) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; selectedOps.value = new Set(sel.map((i) => i + 1)) }
  else return
  if (kind === 'delete' || kind === 'dup') selectedOps.value = new Set()
  writeOps(arr, { delete: 'Delete operations', dup: 'Duplicate operations', up: 'Move operations up', down: 'Move operations down' }[kind])
}

/* ---------- text ---------- */
const textValue = ref('')
const textDirty = ref(false)
watch(() => [info.value, mode.value], () => { if (mode.value === 'text' || mode.value === 'raw') { textValue.value = info.value ? latin1(info.value.decoded) : ''; textDirty.value = false } }, { immediate: true })
const utf8 = ref(false)
const shownText = computed({
  get() {
    if (!utf8.value) return textValue.value
    try { return new TextDecoder('utf-8', { fatal: true }).decode(fromLatin1(textValue.value)) } catch { return textValue.value }
  },
  set(v) {
    textDirty.value = true
    textValue.value = utf8.value ? latin1(new TextEncoder().encode(v)) : v
  },
})
const encodeMode = ref('keep')
function saveText() {
  mutate('Edit stream data', (c) => setStreamData(c, c.lookup(props.streamRef), fromLatin1(textValue.value), encodeMode.value))
  textDirty.value = false
}

/* ---------- hex ---------- */
const hexDump = computed(() => {
  if (mode.value !== 'hex' || !info.value) return ''
  const b = info.value.decoded.subarray(0, 16 * 512)
  const lines = []
  for (let o = 0; o < b.length; o += 16) {
    const row = b.subarray(o, o + 16)
    lines.push(o.toString(16).padStart(8, '0') + '  ' + toHex(row, ' ').padEnd(47) + '  ' + [...row].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join(''))
  }
  if (info.value.decoded.length > b.length) lines.push(`… ${info.value.decoded.length - b.length} more bytes`)
  return lines.join('\n')
})

/* ---------- image ---------- */
const imgUrl = ref('')
const imgNote = ref('')
watch(() => [mode.value, store.rev], async () => {
  if (mode.value !== 'image' || !stream.value) return
  try {
    const { blob, ext, ex } = await imageBlob(ctx(), stream.value, true)
    if (imgUrl.value) URL.revokeObjectURL(imgUrl.value)
    imgUrl.value = ['jpg', 'png'].includes(ext) ? URL.createObjectURL(blob) : ''
    imgNote.value = ex.kind === 'native' ? `Encoded as ${ex.note} (.${ex.ext})` : ex.kind === 'pixels' ? 'Raw pixel data (exported as PNG)' : `Cannot decode: ${ex.note}`
  } catch (e) { imgNote.value = String(e.message || e) }
}, { immediate: true })
onBeforeUnmount(() => { if (imgUrl.value) URL.revokeObjectURL(imgUrl.value) })

async function exportImage() {
  const { blob, ext } = await imageBlob(ctx(), stream.value, false)
  download(blob, `${baseName()}-obj${props.streamRef.objectNumber}.${ext}`)
}

/* ---------- file I/O ---------- */
function downloadDecoded() { download(info.value.decoded, `${baseName()}-obj${props.streamRef.objectNumber}-decoded.bin`) }
async function downloadRaw() {
  const s = stream.value
  const c = s.contents
  download(c && c.blob ? c.blob : await rawBytesAsync(s), `${baseName()}-obj${props.streamRef.objectNumber}-raw.bin`)
}
async function loadFromDisk() {
  await rawBytesAsync(stream.value)
  loadTick.value++
}
const fileIn = ref(null)
const replaceKind = ref('decoded')
function pickReplace(kind) { replaceKind.value = kind; fileIn.value.click() }
async function onReplace(e) {
  const f = e.target.files[0]
  e.target.value = ''
  if (!f) return
  const bytes = new Uint8Array(await f.arrayBuffer())
  if (replaceKind.value === 'raw') mutate('Replace raw stream data', (c) => setStreamRaw(c.lookup(props.streamRef), bytes))
  else mutate('Replace stream data', (c) => setStreamData(c, c.lookup(props.streamRef), bytes, encodeMode.value))
  notify(`Stream replaced (${fmtBytes(bytes.length)})`)
  if (bytes.length >= memorySettings.threshold) offloadLargeStreams().catch(() => {})
}
async function recompress(m) {
  const bytes = await rawBytesAsync(stream.value)
  mutate(m === 'flate' ? 'Compress stream' : 'Decompress stream', (c) => {
    const s = c.lookup(props.streamRef)
    const d = decodeStream(c, PDFRawStream.of(s.dict, bytes))
    if (d.error || d.remaining.length) throw new Error('Stream cannot be fully decoded')
    setStreamData(c, s, d.bytes, m)
  })
}
const MODES = computed(() => {
  const i = info.value
  const m = []
  if (i?.isContent) m.push(['ops', 'Operators'])
  if (i?.isImage) m.push(['image', 'Image'])
  m.push(['text', 'Text'], ['hex', 'Hex'])
  return m
})
</script>

<template>
  <div v-if="info" class="my-1 rounded-md border border-orange-900/60 bg-zinc-950/60 p-2">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
      <span class="font-semibold text-orange-300">Stream data</span>
      <span v-tip="'Size of the encoded bytes stored in the file'">raw {{ fmtBytes(info.raw) }}</span>
      <span v-tip="'Size after removing the filters'">decoded {{ fmtBytes(info.decoded.length) }}</span>
      <span v-if="info.filters.length" v-tip="'Filters applied to the data'">filters: {{ info.filters.join(' → ') }}</span>
      <span v-else>no filter</span>
      <span v-if="info.remaining.length" class="text-amber-300" v-tip="'These filters are image codecs or unsupported and are kept as-is'">kept: {{ info.remaining.join(',') }}</span>
      <span v-if="info.error" class="text-red-300">{{ info.error }}</span>
      <span v-if="info.onDisk" class="tag bg-sky-900/60 text-sky-200" v-tip="'This stream\'s data is not held in memory: it is read from the opened file / IndexedDB when needed.'">on disk</span>
    </div>
    <div v-if="info.notLoaded" class="mt-1.5 flex items-center gap-2 text-[11px] text-sky-200">
      Data ({{ fmtBytes(info.raw) }}) is stored on disk to save memory.
      <button class="btn" @click="loadFromDisk">Load to view / edit</button>
    </div>
    <div class="mt-1.5 flex flex-wrap items-center gap-1">
      <button v-for="[m, l] in MODES" :key="m" class="btn" :class="{ 'border-orange-500 text-orange-200': mode === m }" @click="mode = m">{{ l }}</button>
      <div class="flex-1" />
      <button class="btn" v-tip="'Decompress the data (removes filters) – stored uncompressed'" :disabled="!info.filters.length || info.remaining.length > 0" @click="recompress('none')">Decompress</button>
      <button class="btn" v-tip="'Compress with FlateDecode'" :disabled="info.remaining.length > 0 || (info.filters.length === 1 && info.filters[0] === 'FlateDecode')" @click="recompress('flate')">Flate</button>
      <button class="btn" v-tip="'Download decoded data'" @click="downloadDecoded">⇩ decoded</button>
      <button class="btn" v-tip="'Download the raw encoded bytes'" @click="downloadRaw">⇩ raw</button>
      <button class="btn" v-tip="'Replace the data with a file (it will be encoded with the selected compression)'" @click="pickReplace('decoded')">Replace…</button>
      <button class="btn" v-tip="'Replace the raw encoded bytes with a file; filters in the dictionary are kept as-is'" @click="pickReplace('raw')">Replace raw…</button>
      <input ref="fileIn" type="file" class="hidden" @change="onReplace" />
    </div>

    <!-- operators -->
    <div v-if="mode === 'ops'" class="mt-2">
      <div class="mb-1 flex flex-wrap items-center gap-1 text-[11px]">
        <span class="text-zinc-400">{{ ops.length }} operations</span>
        <template v-if="selectedOps.size">
          <span class="text-cyan-300">· {{ selectedOps.size }} selected</span>
          <button class="btn" @click="opsAction('up')">▲</button>
          <button class="btn" @click="opsAction('down')">▼</button>
          <button class="btn" @click="opsAction('dup')">Duplicate</button>
          <button class="btn btn-danger" @click="opsAction('delete')">Delete</button>
          <button class="btn" @click="selectedOps = new Set()">Clear</button>
        </template>
        <span v-else class="text-zinc-500">· click an index to select (shift = range)</span>
      </div>
      <div class="max-h-[60vh] overflow-auto scroll-thin rounded border border-zinc-800 bg-zinc-900/60 py-1">
        <OpLine
          v-for="(o, i) in ops.slice(0, opLimit)" :key="i + ':' + store.rev"
          :op="o" :index="i" :selected="selectedOps.has(i)"
          @replace="(r) => replaceOp(i, r)" @focus="focusOp(i)" @select="(e) => toggleOp(i, e)"
        />
        <button v-if="ops.length > opLimit" class="btn m-1" @click="opLimit += 1000">Show more ({{ ops.length - opLimit }} left)</button>
      </div>
    </div>

    <!-- text -->
    <div v-else-if="mode === 'text'" class="mt-2">
      <textarea v-model="shownText" spellcheck="false" class="inp h-72 w-full resize-y whitespace-pre font-mono text-[11px] leading-snug" />
      <div class="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
        <label class="flex items-center gap-1 text-zinc-400" v-tip="'Interpret bytes as UTF-8 (e.g. XMP). Otherwise each byte is shown as one Latin-1 character.'"><input v-model="utf8" type="checkbox" /> UTF-8</label>
        <label class="flex items-center gap-1 text-zinc-400" v-tip="'How to encode the data when saving'">encode
          <select v-model="encodeMode" class="inp">
            <option value="keep">keep (Flate if was Flate)</option>
            <option value="flate">FlateDecode</option>
            <option value="none">uncompressed</option>
          </select>
        </label>
        <div class="flex-1" />
        <button class="btn btn-primary" :disabled="!textDirty" @click="saveText">Save stream</button>
      </div>
    </div>

    <!-- hex -->
    <pre v-else-if="mode === 'hex'" class="mt-2 max-h-80 overflow-auto scroll-thin rounded border border-zinc-800 bg-zinc-900/60 p-2 font-mono text-[10px] leading-tight text-zinc-300">{{ hexDump }}</pre>

    <!-- image -->
    <div v-else-if="mode === 'image'" class="mt-2 flex flex-wrap items-start gap-3">
      <img v-if="imgUrl" :src="imgUrl" class="max-h-64 max-w-full rounded border border-zinc-700 bg-[conic-gradient(#333_25%,#444_0_50%,#333_0_75%,#444_0)] bg-[length:16px_16px] object-contain" alt="" />
      <div class="space-y-1 text-[11px] text-zinc-400">
        <div>{{ imgNote }}</div>
        <button class="btn btn-primary" @click="exportImage">Export image</button>
      </div>
    </div>
  </div>
</template>
