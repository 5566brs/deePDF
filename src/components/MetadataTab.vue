<script setup>
// Document-level metadata: /Info, XMP, catalog settings, viewer preferences, header version, file ID.
import { computed, ref } from 'vue'
import { PDFHeader } from 'pdf-lib'
import { store, ctx, mutate, notify } from '../core/store.js'
import { catalog } from '../core/pages.js'
import {
  N, deref, nameStr, stringText, makeString, PDFDict, PDFArray, PDFName, PDFNumber, PDFBool, PDFRef, PDFStream,
  PDFString, PDFHexString, numVal, kindOf, toHex, stringBytes, textToBytes, setStreamData,
} from '../core/pdfobj.js'
import { KEY_DOCS, keyDoc, NAME_SUGGESTIONS } from '../core/docs.js'
import { parsePdfDate, formatIsoDate } from '../core/pdfDate.js'
import DateInput from './DateInput.vue'
import ObjectNode from './ObjectNode.vue'
import XmpEditor from './XmpEditor.vue'

const INFO_STD = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped']
const DATE_KEYS = new Set(['CreationDate', 'ModDate'])

const infoRef = computed(() => { store.rev; const i = ctx().trailerInfo.Info; return i instanceof PDFRef ? i : null })
const info = computed(() => { store.rev; const i = deref(ctx(), ctx().trailerInfo.Info); return i instanceof PDFDict ? i : null })
const infoValues = computed(() => {
  store.rev
  const out = {}
  if (!info.value) return out
  for (const [k, v] of info.value.entries()) {
    const val = deref(ctx(), v)
    const key = k.decodeText()
    const kd = kindOf(val)
    out[key] = kd === 'string' || kd === 'hex' ? stringText(val) : kd === 'name' ? val.decodeText() : kd === 'bool' ? String(val.asBoolean()) : kd === 'number' ? String(val.asNumber()) : `(${kd})`
  }
  return out
})
const customKeys = computed(() => Object.keys(infoValues.value).filter((k) => !INFO_STD.includes(k)))
const infoForXmp = computed(() => {
  const v = { ...infoValues.value }
  for (const k of ['CreationDate', 'ModDate']) { const p = parsePdfDate(v[k]); if (p) v[k + 'Iso'] = formatIsoDate(p) }
  return v
})

function withInfo(label, fn) {
  mutate(label, (c) => {
    let d = deref(c, c.trailerInfo.Info)
    if (!(d instanceof PDFDict)) { d = PDFDict.withContext(c); c.trailerInfo.Info = c.register(d) }
    fn(c, d)
  })
}
function setInfo(key, text) {
  withInfo(`Set /${key}`, (c, d) => {
    if (text === '' || text === undefined) d.delete(N(key))
    else if (key === 'Trapped') d.set(N(key), PDFName.of(text))
    else {
      const old = deref(c, d.get(N(key)))
      d.set(N(key), makeString(text, old instanceof PDFHexString))
    }
  })
}
const newInfoKey = ref('')
function addInfoKey() {
  const k = newInfoKey.value.trim().replace(/^\//, '')
  if (!k) return
  withInfo(`Add /${k}`, (c, d) => d.set(N(k), makeString('')))
  newInfoKey.value = ''
}

/* ---------- XMP ---------- */
const metaRef = computed(() => { store.rev; const cat = catalog(ctx()); const m = cat?.get(N('Metadata')); return m instanceof PDFRef && ctx().lookup(m) instanceof PDFStream ? m : null })
function createXmp() {
  const i = infoForXmp.value
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const xml = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(i.Title)}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>${esc(i.Author)}</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(i.Subject)}</rdf:li></rdf:Alt></dc:description>
   <pdf:Keywords>${esc(i.Keywords)}</pdf:Keywords>
   <pdf:Producer>${esc(i.Producer)}</pdf:Producer>
   <xmp:CreatorTool>${esc(i.Creator)}</xmp:CreatorTool>${i.CreationDateIso ? `\n   <xmp:CreateDate>${i.CreationDateIso}</xmp:CreateDate>` : ''}${i.ModDateIso ? `\n   <xmp:ModifyDate>${i.ModDateIso}</xmp:ModifyDate>` : ''}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
  mutate('Create XMP metadata', (c) => {
    const s = c.stream(new Uint8Array(), { Type: 'Metadata', Subtype: 'XML' })
    setStreamData(c, s, new TextEncoder().encode(xml), 'none')
    catalog(c).set(N('Metadata'), c.register(s))
  })
}
function removeXmp() {
  if (!confirm('Remove the XMP metadata stream from the catalog?')) return
  mutate('Remove XMP metadata', (c) => {
    const cat = catalog(c)
    const r = cat.get(N('Metadata'))
    cat.delete(N('Metadata'))
    if (r instanceof PDFRef) c.delete(r)
  })
}

/* ---------- catalog ---------- */
const cat = computed(() => { store.rev; return catalog(ctx()) })
const catRef = computed(() => { store.rev; const r = ctx().trailerInfo.Root; return r instanceof PDFRef ? r : null })
function catName(key) { store.rev; return nameStr(deref(ctx(), cat.value?.get(N(key)))) || '' }
function setCatName(key, v) {
  mutate(`Set /${key}`, (c) => { const d = catalog(c); v ? d.set(N(key), PDFName.of(v)) : d.delete(N(key)) })
}
const lang = computed(() => { store.rev; const l = deref(ctx(), cat.value?.get(N('Lang'))); return l ? stringText(l) : '' })
function setLang(v) { mutate('Set /Lang', (c) => { const d = catalog(c); v ? d.set(N('Lang'), makeString(v)) : d.delete(N('Lang')) }) }
const marked = computed(() => {
  store.rev
  const mi = deref(ctx(), cat.value?.get(N('MarkInfo')))
  const m = mi instanceof PDFDict ? deref(ctx(), mi.get(N('Marked'))) : undefined
  return m instanceof PDFBool ? String(m.asBoolean()) : ''
})
function setMarked(v) {
  mutate('Set MarkInfo /Marked', (c) => {
    const d = catalog(c)
    let mi = deref(c, d.get(N('MarkInfo')))
    if (!v) { if (mi instanceof PDFDict) mi.delete(N('Marked')); return }
    if (!(mi instanceof PDFDict)) { mi = PDFDict.withContext(c); d.set(N('MarkInfo'), mi) }
    mi.set(N('Marked'), v === 'true' ? PDFBool.True : PDFBool.False)
  })
}

/* ---------- viewer preferences ---------- */
const VP_BOOL = ['HideToolbar', 'HideMenubar', 'HideWindowUI', 'FitWindow', 'CenterWindow', 'DisplayDocTitle', 'PickTrayByPDFSize']
const VP_NAME = ['NonFullScreenPageMode', 'Direction', 'ViewArea', 'ViewClip', 'PrintArea', 'PrintClip', 'PrintScaling', 'Duplex']
const vp = computed(() => { store.rev; const v = deref(ctx(), cat.value?.get(N('ViewerPreferences'))); return v instanceof PDFDict ? v : null })
function vpVal(key) {
  const v = vp.value ? deref(ctx(), vp.value.get(N(key))) : undefined
  if (v === undefined) return ''
  switch (kindOf(v)) {
    case 'bool': return String(v.asBoolean())
    case 'name': return v.decodeText()
    case 'number': return String(v.asNumber())
    case 'array': return v.asArray().map((x) => numVal(deref(ctx(), x))).join(' ')
    default: return ''
  }
}
function setVP(key, val, type) {
  mutate(`Set ViewerPreferences /${key}`, (c) => {
    const d = catalog(c)
    let v = deref(c, d.get(N('ViewerPreferences')))
    if (!(v instanceof PDFDict)) { v = PDFDict.withContext(c); d.set(N('ViewerPreferences'), v) }
    if (val === '' || val === undefined) { v.delete(N(key)); return }
    if (type === 'bool') v.set(N(key), val === 'true' ? PDFBool.True : PDFBool.False)
    else if (type === 'name') v.set(N(key), PDFName.of(val))
    else if (type === 'number') v.set(N(key), PDFNumber.of(+val))
    else if (type === 'range') {
      const nums = val.split(/[\s,;-]+/).map(Number).filter((n) => Number.isInteger(n))
      v.set(N(key), c.obj(nums.map((n) => PDFNumber.of(n))))
    }
  })
}

/* ---------- header / ID ---------- */
const VERSIONS = ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '2.0']
const headerVersion = computed(() => { store.rev; const h = ctx().header; return `${h.major}.${h.minor}` })
function setHeader(v) {
  const [a, b] = v.split('.').map(Number)
  mutate('Set PDF header version', (c) => { c.header = PDFHeader.forVersion(a, b) })
}
const ids = computed(() => {
  store.rev
  const id = deref(ctx(), ctx().trailerInfo.ID)
  if (!(id instanceof PDFArray)) return null
  return id.asArray().map((x) => toHex(stringBytes(deref(ctx(), x))))
})
function setId(i, hex) {
  mutate('Set file ID', (c) => {
    let id = deref(c, c.trailerInfo.ID)
    if (!(id instanceof PDFArray)) { id = c.obj([PDFHexString.of(''), PDFHexString.of('')]); c.trailerInfo.ID = id }
    id.set(i, PDFHexString.of(hex.replace(/[^0-9a-fA-F]/g, '')))
  })
}
function regenId(which) {
  const rnd = () => toHex(crypto.getRandomValues(new Uint8Array(16)))
  mutate('Regenerate file ID', (c) => {
    let id = deref(c, c.trailerInfo.ID)
    const cur = id instanceof PDFArray ? id.asArray().map((x) => toHex(stringBytes(deref(c, x)))) : [rnd(), rnd()]
    const next = which === 'both' ? [rnd(), rnd()] : [cur[0], rnd()]
    c.trailerInfo.ID = c.obj(next.map((h) => PDFHexString.of(h)))
  })
}
function removeId() { mutate('Remove file ID', (c) => { delete c.trailerInfo.ID }) }

const showCatalog = ref(false)
</script>

<template>
  <div class="space-y-1 p-2 text-xs">
    <!-- Info -->
    <div class="section-title !mt-0">Document information <span class="font-mono font-normal normal-case text-zinc-500">/Info {{ infoRef ? infoRef.objectNumber + ' 0 R' : '(none)' }}</span></div>
    <div class="space-y-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
      <div v-for="k in INFO_STD" :key="k" class="flex items-center gap-2">
        <span class="w-24 shrink-0 font-mono text-zinc-200 underline decoration-zinc-600 decoration-dotted underline-offset-2" v-tip="KEY_DOCS[k]">/{{ k }}</span>
        <DateInput v-if="DATE_KEYS.has(k) && infoValues[k] !== undefined" :model-value="infoValues[k]" @update:model-value="(v) => setInfo(k, v)" />
        <button v-else-if="DATE_KEYS.has(k)" class="btn" @click="setInfo(k, (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` })())">+ set date</button>
        <select v-else-if="k === 'Trapped'" class="inp" :value="infoValues[k] || ''" @change="setInfo(k, $event.target.value)">
          <option value="">(not set)</option>
          <option v-for="o in NAME_SUGGESTIONS.Trapped" :key="o" :value="o">{{ o }}</option>
        </select>
        <input v-else class="inp min-w-0 flex-1" dir="auto" :value="infoValues[k] ?? ''" :placeholder="infoValues[k] === undefined ? '(not set)' : ''" @change="setInfo(k, $event.target.value)" />
        <button v-if="infoValues[k] !== undefined" class="btn btn-icon" v-tip="'Remove this entry'" @click="setInfo(k, '')">✕</button>
      </div>
      <div v-for="k in customKeys" :key="k" class="flex items-center gap-2">
        <span class="w-24 shrink-0 truncate font-mono text-amber-200" v-tip="'Custom (non-standard) information entry'">/{{ k }}</span>
        <input class="inp min-w-0 flex-1" dir="auto" :value="infoValues[k]" @change="setInfo(k, $event.target.value)" />
        <button class="btn btn-icon" @click="setInfo(k, '')">✕</button>
      </div>
      <div class="flex items-center gap-2 pt-1">
        <input v-model="newInfoKey" class="inp w-32" placeholder="/CustomKey" @keydown.enter="addInfoKey" />
        <button class="btn" @click="addInfoKey">+ custom entry</button>
      </div>
    </div>

    <!-- XMP -->
    <div class="section-title">XMP metadata</div>
    <XmpEditor v-if="metaRef" :stream-ref="metaRef" :info="infoForXmp" />
    <div v-else class="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-400">
      No XMP metadata stream in the catalog.
      <button class="btn" @click="createXmp">Create from /Info</button>
    </div>
    <button v-if="metaRef" class="btn btn-danger mt-1" @click="removeXmp">Remove XMP</button>

    <!-- Catalog -->
    <div class="section-title">Document catalog <span class="font-mono font-normal normal-case text-zinc-500">/Root {{ catRef?.objectNumber }} 0 R</span></div>
    <div v-if="cat" class="space-y-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
      <div v-for="k in ['PageLayout', 'PageMode']" :key="k" class="flex items-center gap-2">
        <span class="w-36 shrink-0 font-mono text-zinc-200 underline decoration-zinc-600 decoration-dotted underline-offset-2" v-tip="keyDoc(k)">/{{ k }}</span>
        <select class="inp" :value="catName(k)" @change="setCatName(k, $event.target.value)">
          <option value="">(default)</option>
          <option v-for="o in NAME_SUGGESTIONS[k]" :key="o" :value="o">{{ o }}</option>
        </select>
      </div>
      <div class="flex items-center gap-2">
        <span class="w-36 shrink-0 font-mono text-zinc-200 underline decoration-zinc-600 decoration-dotted underline-offset-2" v-tip="keyDoc('Lang')">/Lang</span>
        <input class="inp w-28" :value="lang" placeholder="e.g. en-US" list="dl-lang" @change="setLang($event.target.value)" />
        <datalist id="dl-lang"><option v-for="l in ['en-US', 'en-GB', 'he-IL', 'fr-FR', 'de-DE', 'es-ES', 'ru-RU', 'ar', 'zh-CN', 'ja-JP']" :key="l" :value="l" /></datalist>
      </div>
      <div class="flex items-center gap-2">
        <span class="w-36 shrink-0 font-mono text-zinc-200 underline decoration-zinc-600 decoration-dotted underline-offset-2" v-tip="keyDoc('Version')">/Version</span>
        <select class="inp" :value="catName('Version')" @change="setCatName('Version', $event.target.value)">
          <option value="">(use header)</option>
          <option v-for="v in VERSIONS" :key="v" :value="v">{{ v }}</option>
        </select>
      </div>
      <div class="flex items-center gap-2">
        <span class="w-36 shrink-0 font-mono text-zinc-200 underline decoration-zinc-600 decoration-dotted underline-offset-2" v-tip="keyDoc('Marked')">/MarkInfo /Marked</span>
        <select class="inp" :value="marked" @change="setMarked($event.target.value)">
          <option value="">(not set)</option><option value="true">true</option><option value="false">false</option>
        </select>
      </div>
      <button class="btn" @click="showCatalog = !showCatalog">{{ showCatalog ? 'Hide' : 'Show' }} full catalog (OpenAction, Names, Outlines, AcroForm…)</button>
      <ObjectNode v-if="showCatalog && catRef" :owner="catRef" :path="[]" start-open :removable="false" />
    </div>

    <!-- viewer prefs -->
    <div class="section-title">Viewer preferences</div>
    <div class="grid grid-cols-1 gap-x-4 gap-y-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-2 sm:grid-cols-2">
      <div v-for="k in VP_BOOL" :key="k" class="flex items-center gap-2">
        <span class="w-40 shrink-0 truncate font-mono text-zinc-200 underline decoration-zinc-600 decoration-dotted underline-offset-2" v-tip="keyDoc(k)">/{{ k }}</span>
        <select class="inp" :value="vpVal(k)" @change="setVP(k, $event.target.value, 'bool')">
          <option value="">(default)</option><option value="true">true</option><option value="false">false</option>
        </select>
      </div>
      <div v-for="k in VP_NAME" :key="k" class="flex items-center gap-2">
        <span class="w-40 shrink-0 truncate font-mono text-zinc-200 underline decoration-zinc-600 decoration-dotted underline-offset-2" v-tip="keyDoc(k)">/{{ k }}</span>
        <select class="inp min-w-0" :value="vpVal(k)" @change="setVP(k, $event.target.value, 'name')">
          <option value="">(default)</option>
          <option v-for="o in NAME_SUGGESTIONS[k]" :key="o" :value="o">{{ o }}</option>
        </select>
      </div>
      <div class="flex items-center gap-2">
        <span class="w-40 shrink-0 font-mono text-zinc-200 underline decoration-zinc-600 decoration-dotted underline-offset-2" v-tip="keyDoc('NumCopies')">/NumCopies</span>
        <input type="number" min="1" class="inp w-16" :value="vpVal('NumCopies')" @change="setVP('NumCopies', $event.target.value, 'number')" />
      </div>
      <div class="flex items-center gap-2">
        <span class="w-40 shrink-0 font-mono text-zinc-200 underline decoration-zinc-600 decoration-dotted underline-offset-2" v-tip="keyDoc('PrintPageRange') + '\nEnter pairs of page numbers (0-based), e.g. 0 2 5 7'">/PrintPageRange</span>
        <input class="inp w-28" :value="vpVal('PrintPageRange')" placeholder="0 2 5 7" @change="setVP('PrintPageRange', $event.target.value, 'range')" />
      </div>
    </div>

    <!-- file -->
    <div class="section-title">File</div>
    <div class="space-y-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
      <div class="flex items-center gap-2">
        <span class="w-36 shrink-0 text-zinc-200" v-tip="'Version written in the %PDF-x.y header line'">Header version</span>
        <select class="inp" :value="headerVersion" @change="setHeader($event.target.value)">
          <option v-for="v in VERSIONS" :key="v" :value="v">%PDF-{{ v }}</option>
        </select>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span class="w-36 shrink-0 font-mono text-zinc-200 underline decoration-zinc-600 decoration-dotted underline-offset-2" v-tip="KEY_DOCS.ID">Trailer /ID</span>
        <template v-if="ids">
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <input v-for="(h, i) in ids" :key="i" class="inp w-full" :value="h" v-tip="i === 0 ? 'Permanent identifier' : 'Changing identifier'" @change="setId(i, $event.target.value)" />
          </div>
          <button class="btn" v-tip="'New random second (changing) identifier'" @click="regenId('second')">New #2</button>
          <button class="btn" v-tip="'New random identifiers'" @click="regenId('both')">New both</button>
          <button class="btn btn-icon" @click="removeId">✕</button>
        </template>
        <button v-else class="btn" @click="regenId('both')">Create ID</button>
      </div>
    </div>
  </div>
</template>
