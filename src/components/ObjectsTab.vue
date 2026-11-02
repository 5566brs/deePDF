<script setup>
// Objects view: tree from the trailer, or a flat filterable list of all indirect objects.
import { computed, ref, watch, nextTick } from 'vue'
import { store, ctx, mutate, notify } from '../core/store.js'
import { kindOf, typeLabel, shortValue, cloneObj, PDFRef, PDFDict, collectRefs, rawBytes, PDFStream, fmtBytes } from '../core/pdfobj.js'
import { validate } from '../core/exporter.js'
import ObjectNode from './ObjectNode.vue'

const view = ref('tree')
const filter = ref('')
const typeFilter = ref('')
const open = ref(new Set())
const selected = ref(new Set())
const limit = ref(300)
const listEl = ref(null)

const objects = computed(() => {
  store.rev
  const c = ctx()
  if (!c) return []
  return c.enumerateIndirectObjects()
    .sort((a, b) => a[0].objectNumber - b[0].objectNumber)
    .map(([ref, obj]) => ({ ref, key: `${ref.objectNumber} ${ref.generationNumber}`, kind: kindOf(obj), type: typeLabel(c, obj), obj }))
})
const types = computed(() => [...new Set(objects.value.map((o) => o.type || `(${o.kind})`))].sort())
const filtered = computed(() => {
  const f = filter.value.trim().toLowerCase()
  const c = ctx()
  return objects.value.filter((o) => {
    if (typeFilter.value && (o.type || `(${o.kind})`) !== typeFilter.value) return false
    if (!f) return true
    if (/^\d+$/.test(f)) return String(o.ref.objectNumber).startsWith(f)
    return o.key.includes(f) || o.type.toLowerCase().includes(f) || shortValue(c, o.obj).toLowerCase().includes(f)
  })
})
const stats = computed(() => {
  let streams = 0, bytes = 0
  for (const o of objects.value) if (o.obj instanceof PDFStream) { streams++; bytes += rawBytes(o.obj).length }
  return { streams, bytes }
})

function toggleOpen(key) {
  const s = new Set(open.value)
  s.has(key) ? s.delete(key) : s.add(key)
  open.value = s
}
function toggleSel(key) {
  const s = new Set(selected.value)
  s.has(key) ? s.delete(key) : s.add(key)
  selected.value = s
}
const refsOf = (keys) => objects.value.filter((o) => keys.has(o.key)).map((o) => o.ref)

function duplicateSelected() {
  const refs = refsOf(selected.value)
  const created = mutate(`Duplicate ${refs.length} object(s)`, (c) => {
    // references between the duplicated objects are remapped to the copies
    const map = new Map()
    for (const r of refs) map.set(r, c.nextRef())
    for (const r of refs) {
      const copy = cloneObj(c.lookup(r), c)
      const remap = (o) => {
        if (o instanceof PDFDict || o instanceof PDFStream) {
          const d = o instanceof PDFStream ? o.dict : o
          for (const [k, v] of d.entries()) if (v instanceof PDFRef && map.has(v)) d.set(k, map.get(v)); else remap(v)
        } else if (o && o.asArray) o.asArray().forEach((v, i) => { if (v instanceof PDFRef && map.has(v)) o.set(i, map.get(v)); else remap(v) })
      }
      remap(copy)
      c.assign(map.get(r), copy)
    }
    return [...map.values()]
  })
  if (created) {
    notify(`Created ${created.map((r) => r.objectNumber + ' 0 R').join(', ')} (not yet referenced from anywhere)`, 'info', 5000)
    selected.value = new Set(created.map((r) => `${r.objectNumber} ${r.generationNumber}`))
  }
}
function deleteSelected() {
  const refs = refsOf(selected.value)
  const c = ctx()
  const del = new Set(refs)
  let inbound = 0
  for (const [r, o] of c.enumerateIndirectObjects()) if (!del.has(r)) for (const x of collectRefs(o)) if (del.has(x)) inbound++
  if (inbound && !confirm(`${inbound} reference(s) from other objects point to the selected object(s). Delete anyway? (references become dangling; export can replace them with null)`)) return
  mutate(`Delete ${refs.length} object(s)`, (cc) => { for (const r of refs) cc.delete(r) })
  selected.value = new Set()
}
function newObject() {
  const r = mutate('New object', (c) => c.register(PDFDict.withContext(c)))
  if (r) { view.value = 'list'; reveal(`${r.objectNumber} ${r.generationNumber}`) }
}
function findRefsTo(key) {
  const c = ctx()
  const target = objects.value.find((o) => o.key === key)?.ref
  const hits = []
  for (const [r, o] of c.enumerateIndirectObjects()) if (collectRefs(o).includes(target)) hits.push(`${r.objectNumber} ${r.generationNumber}`)
  for (const k of ['Root', 'Info', 'Encrypt']) if (c.trailerInfo[k] === target) hits.push('trailer')
  notify(hits.length ? `Referenced from: ${hits.slice(0, 20).join(', ')}${hits.length > 20 ? '…' : ''}` : 'Not referenced by any object', 'info', 6000)
}

async function reveal(key) {
  view.value = 'list'
  filter.value = ''
  typeFilter.value = ''
  const idx = filtered.value.findIndex((o) => o.key === key)
  if (idx >= limit.value) limit.value = idx + 50
  const s = new Set(open.value); s.add(key); open.value = s
  await nextTick()
  listEl.value?.querySelector(`[data-key="${key}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
watch(() => store.objectFocus, (k) => { if (k) { reveal(k); store.objectFocus = null } })

const report = ref(null)
function runValidate() { report.value = validate(ctx()) }
</script>

<template>
  <div class="p-2">
    <div class="sticky top-0 z-10 -mx-2 -mt-2 mb-2 flex flex-wrap items-center gap-1 border-b border-zinc-800 bg-zinc-900/95 px-2 py-1.5 backdrop-blur">
      <div class="flex rounded border border-zinc-700">
        <button class="px-2 py-0.5 text-xs" :class="view === 'tree' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" v-tip="'Hierarchy starting at the trailer (Root → Pages → …)'" @click="view = 'tree'">Tree</button>
        <button class="px-2 py-0.5 text-xs" :class="view === 'list' ? 'bg-zinc-700 text-white' : 'text-zinc-400'" v-tip="'All indirect objects by number'" @click="view = 'list'">List</button>
      </div>
      <template v-if="view === 'list'">
        <input v-model="filter" class="inp w-36" placeholder="Filter (number, type, text)" />
        <select v-model="typeFilter" class="inp w-32">
          <option value="">All types</option>
          <option v-for="t in types" :key="t" :value="t">{{ t }}</option>
        </select>
      </template>
      <div class="flex-1" />
      <button class="btn" v-tip="'Check references, page tree and stream lengths'" @click="runValidate">Validate</button>
      <button class="btn" v-tip="'Create a new empty dictionary object'" @click="newObject">+ Object</button>
    </div>

    <div v-if="report" class="mb-2 rounded border border-zinc-700 bg-zinc-900 p-2 text-xs">
      <div class="mb-1 flex items-center"><b class="text-zinc-200">Validation</b><span class="ml-2 text-zinc-500">{{ report.objectCount }} objects</span><div class="flex-1" /><button class="btn btn-icon" @click="report = null">✕</button></div>
      <div v-if="!report.issues.length" class="text-emerald-300">No issues found.</div>
      <div v-for="(i, k) in report.issues" :key="k" class="py-0.5" :class="{ 'text-red-300': i.level === 'error', 'text-amber-300': i.level === 'warn', 'text-sky-300': i.level === 'fix', 'text-zinc-400': i.level === 'info' }">
        • {{ i.msg }}
        <div v-if="i.items" class="ml-3 font-mono text-[10px] text-zinc-500">{{ i.items.join('  ') }}</div>
      </div>
    </div>

    <!-- tree -->
    <div v-if="view === 'tree'">
      <ObjectNode owner="trailer" :path="[]" start-open :removable="false" @goto="(r) => reveal(`${r.objectNumber} ${r.generationNumber}`)" />
    </div>

    <!-- list -->
    <div v-else ref="listEl">
      <div class="mb-1 flex flex-wrap items-center gap-1 text-[11px] text-zinc-500">
        {{ filtered.length }} of {{ objects.length }} objects · {{ stats.streams }} streams ({{ fmtBytes(stats.bytes) }})
        <template v-if="selected.size">
          <span class="ml-2 text-cyan-300">{{ selected.size }} selected</span>
          <button class="btn" v-tip="'Copy the selected objects as new objects (internal references are remapped to the copies)'" @click="duplicateSelected">Duplicate</button>
          <button class="btn btn-danger" @click="deleteSelected">Delete</button>
          <button class="btn" @click="selected = new Set()">Clear</button>
        </template>
      </div>
      <div v-for="o in filtered.slice(0, limit)" :key="o.key" :data-key="o.key" class="border-b border-zinc-800/70">
        <div class="group flex items-center gap-1.5 py-1 text-xs hover:bg-zinc-700/30" :class="{ 'row-sel': selected.has(o.key) }">
          <input type="checkbox" class="ml-1" :checked="selected.has(o.key)" @change="toggleSel(o.key)" />
          <button class="w-4 text-zinc-500" @click="toggleOpen(o.key)">{{ open.has(o.key) ? '▾' : '▸' }}</button>
          <span class="w-16 shrink-0 cursor-pointer font-mono text-violet-300" @click="toggleOpen(o.key)">{{ o.key }} obj</span>
          <span class="tag bg-zinc-800 text-zinc-400">{{ o.kind }}</span>
          <span class="shrink-0 font-medium text-emerald-300">{{ o.type }}</span>
          <span class="min-w-0 flex-1 cursor-pointer truncate font-mono text-zinc-500" @click="toggleOpen(o.key)">{{ shortValue(ctx(), o.obj) }}</span>
          <button class="btn btn-icon opacity-0 group-hover:opacity-100" v-tip="'Which objects reference this one?'" @click="findRefsTo(o.key)">⇠</button>
        </div>
        <div v-if="open.has(o.key)" class="pb-1">
          <ObjectNode :owner="o.ref" :path="[]" start-open :removable="false" :depth="1" @goto="(r) => reveal(`${r.objectNumber} ${r.generationNumber}`)" />
        </div>
      </div>
      <button v-if="filtered.length > limit" class="btn m-2" @click="limit += 500">Show more ({{ filtered.length - limit }})</button>
    </div>
  </div>
</template>
