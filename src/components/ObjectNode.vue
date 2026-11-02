<script setup>
// Recursive tree node for any PDF value, addressed by (owner, path) so it survives undo/redo.
import { computed, ref } from 'vue'
import { store, ctx, mutate, locateRef, notify } from '../core/store.js'
import { resolvePath, setAtPath, deleteAtPath } from '../core/paths.js'
import {
  kindOf, typeLabel, shortValue, PDFRef, PDFDict, PDFArray, PDFStream, PDFName, PDFNull,
  convertValue, defaultValueFor, cloneObj, deref,
} from '../core/pdfobj.js'
import { keyDoc } from '../core/docs.js'
import ValueInput from './ValueInput.vue'
import StreamPanel from './StreamPanel.vue'

defineOptions({ name: 'ObjectNode' })

const props = defineProps({
  owner: [Object, String], // PDFRef or 'trailer'
  path: { type: Array, default: () => [] },
  label: [String, Number],
  parentType: String,
  depth: { type: Number, default: 0 },
  startOpen: Boolean,
  removable: { type: Boolean, default: true },
  arrayLen: Number,
})
const emit = defineEmits(['goto'])

const open = ref(props.startOpen)
const showAll = ref(false)
const menu = ref(false)
const newKey = ref('')
const newKind = ref('name')

const value = computed(() => { store.rev; const c = ctx(); return c ? resolvePath(c, props.owner, props.path) : undefined })
const kind = computed(() => (value.value && value.value.trailer ? 'trailer' : kindOf(value.value)))
const target = computed(() => { store.rev; return kind.value === 'ref' ? ctx().lookup(value.value) : undefined })
const tlabel = computed(() => {
  store.rev
  if (kind.value === 'dict' || kind.value === 'stream') return typeLabel(ctx(), value.value)
  if (kind.value === 'ref') return typeLabel(ctx(), target.value)
  return ''
})
const expandable = computed(() => ['dict', 'array', 'stream', 'ref', 'trailer'].includes(kind.value))
const isLeafEditor = computed(() => ['number', 'name', 'string', 'hex', 'bool', 'ref', 'null'].includes(kind.value) || isRectArray.value)
const isRectArray = computed(() => kind.value === 'array' && ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Rect', 'BBox', 'FontBBox'].includes(props.label) && value.value.size() === 4)

const LIMIT = 200
const children = computed(() => {
  store.rev
  const v = value.value
  const c = ctx()
  if (kind.value === 'trailer') return ['Root', 'Info', 'ID', 'Encrypt'].filter((k) => c.trailerInfo[k] !== undefined).map((k) => ({ key: k, path: [k] }))
  if (kind.value === 'dict' || kind.value === 'stream') {
    const d = kind.value === 'stream' ? v.dict : v
    return d.keys().map((k) => ({ key: k.decodeText(), path: [...props.path, k.decodeText()] }))
  }
  if (kind.value === 'array') return v.asArray().map((_, i) => ({ key: i, path: [...props.path, i] }))
  return []
})
const shownChildren = computed(() => (showAll.value ? children.value : children.value.slice(0, LIMIT)))

const myType = computed(() => tlabel.value || props.parentType)
const doc = computed(() => (typeof props.label === 'string' ? keyDoc(props.label, props.parentType) : ''))
const tip = computed(() => {
  const parts = []
  if (doc.value) parts.push(doc.value)
  if (kind.value === 'ref') parts.push(`Indirect reference → object ${value.value.objectNumber} ${value.value.generationNumber}${tlabel.value ? ` (${tlabel.value})` : ''}${target.value === undefined ? ' — MISSING' : ''}`)
  return parts.join('\n') || `${kind.value}`
})

const KIND_COLORS = {
  dict: 'bg-emerald-900/60 text-emerald-300', array: 'bg-teal-900/60 text-teal-300', stream: 'bg-orange-900/60 text-orange-300',
  ref: 'bg-violet-900/60 text-violet-300', name: 'bg-sky-900/60 text-sky-300', number: 'bg-zinc-700 text-zinc-200',
  string: 'bg-amber-900/60 text-amber-200', hex: 'bg-amber-900/60 text-amber-200', bool: 'bg-pink-900/60 text-pink-300',
  null: 'bg-zinc-800 text-zinc-400', trailer: 'bg-cyan-900/60 text-cyan-300', invalid: 'bg-red-900 text-red-200', missing: 'bg-red-900 text-red-200',
}
const KINDS = ['dict', 'array', 'name', 'string', 'hex', 'number', 'bool', 'ref', 'null']

const ownerIsRef = computed(() => props.owner instanceof PDFRef)
const inArray = computed(() => typeof props.label === 'number')
const canEditKind = computed(() => props.path.length > 0 && kind.value !== 'stream' && kind.value !== 'trailer')

function commit(newVal, label = 'Edit value') {
  mutate(`${label} ${props.label ?? ''}`.trim(), (c) => setAtPath(c, props.owner, props.path, newVal))
}
function changeKind(k) {
  menu.value = false
  commit(convertValue(ctx(), value.value, k), 'Change type of')
}
function remove() {
  menu.value = false
  mutate(`Delete ${props.label}`, (c) => deleteAtPath(c, props.owner, props.path))
}
function move(delta) {
  menu.value = false
  const idx = props.label
  mutate(`Move item ${idx}`, (c) => {
    const arr = resolvePath(c, props.owner, props.path.slice(0, -1))
    const a = arr instanceof PDFStream ? null : arr
    if (!(a instanceof PDFArray)) return
    const j = idx + delta
    if (j < 0 || j >= a.size()) return
    const x = a.get(idx), y = a.get(j)
    a.set(idx, y); a.set(j, x)
  })
}
function duplicateItem() {
  menu.value = false
  mutate(`Duplicate item ${props.label}`, (c) => {
    const a = resolvePath(c, props.owner, props.path.slice(0, -1))
    if (a instanceof PDFArray) a.insert(props.label + 1, cloneObj(a.get(props.label), c))
  })
}
function makeIndirect() {
  menu.value = false
  mutate(`Make ${props.label} indirect`, (c) => {
    const v = resolvePath(c, props.owner, props.path)
    const r = c.register(v)
    setAtPath(c, props.owner, props.path, r)
  })
}
function inlineRef() {
  menu.value = false
  mutate(`Inline ${props.label}`, (c) => {
    const t = c.lookup(value.value)
    if (t === undefined || t instanceof PDFStream) throw new Error('Streams must stay indirect')
    setAtPath(c, props.owner, props.path, cloneObj(t, c))
  })
}
function addKey() {
  const k = newKey.value.trim().replace(/^\//, '')
  if (!k) return
  if (kind.value !== 'dict' && kind.value !== 'stream') return
  mutate(`Add key /${k}`, (c) => {
    const v = resolvePath(c, props.owner, props.path)
    const d = v instanceof PDFStream ? v.dict : v
    d.set(PDFName.of(k), defaultValueFor(newKind.value, c))
  })
  newKey.value = ''
}
function addItem() {
  mutate(`Add item to ${props.label ?? 'array'}`, (c) => {
    const a = resolvePath(c, props.owner, props.path)
    if (a instanceof PDFArray) a.push(defaultValueFor(newKind.value, c))
  })
}

function onFocus() {
  // locate the element on the page preview
  const c = ctx()
  const loc = ownerIsRef.value ? props.owner : null
  if (kind.value === 'ref' && locateRef(value.value)) return
  if (!loc) return
  locateRef(loc, isRectArray.value ? value.value : undefined)
}
function gotoRef(r) {
  store.objectFocus = `${r.objectNumber} ${r.generationNumber}`
  emit('goto', r)
}
function toggle() {
  if (expandable.value) open.value = !open.value
}
</script>

<template>
  <div class="text-xs">
    <div
      class="group flex min-h-[26px] items-center gap-1 rounded py-0.5 pr-1 hover:bg-zinc-700/30"
      :style="{ paddingLeft: depth * 14 + 4 + 'px' }"
      @focusin="onFocus"
    >
      <button class="w-4 shrink-0 text-zinc-500 hover:text-zinc-200" :class="{ invisible: !expandable }" @click="toggle">{{ open ? '▾' : '▸' }}</button>
      <span
        v-if="label !== undefined"
        v-tip="tip"
        class="shrink-0 cursor-default font-mono"
        :class="inArray ? 'text-zinc-500' : doc ? 'text-zinc-100 underline decoration-zinc-600 decoration-dotted underline-offset-2' : 'text-zinc-300'"
        @click="toggle"
      >{{ inArray ? `[${label}]` : '/' + label }}</span>
      <span class="tag shrink-0" :class="KIND_COLORS[kind] || KIND_COLORS.null">{{ kind }}</span>

      <ValueInput v-if="isLeafEditor" :value="value" :key-name="label" :rev="store.rev" @commit="commit" @goto="gotoRef" />
      <span v-else class="min-w-0 flex-1 truncate font-mono text-zinc-400" @click="toggle">
        <template v-if="kind === 'trailer'">trailer</template>
        <template v-else>{{ shortValue(ctx(), value) }}</template>
      </span>
      <span v-if="kind === 'ref' && tlabel" class="shrink-0 truncate text-[11px] text-violet-300/80">→ {{ tlabel }}</span>
      <span v-if="kind === 'ref' && target === undefined" class="tag bg-red-900 text-red-200" v-tip="'The referenced object does not exist (dangling reference)'">missing</span>

      <div v-if="canEditKind && removable" class="relative shrink-0">
        <button class="btn btn-icon opacity-40 group-hover:opacity-100" v-tip="'Actions'" @click="menu = !menu">⋯</button>
        <div v-if="menu" class="absolute right-0 top-6 z-30 w-48 rounded-md border border-zinc-700 bg-zinc-900 p-1 shadow-xl" @mouseleave="menu = false">
          <div class="px-2 py-1 text-[10px] uppercase text-zinc-500">Change type</div>
          <div class="flex flex-wrap gap-1 px-1 pb-1">
            <button v-for="k in KINDS" :key="k" class="tag cursor-pointer" :class="[KIND_COLORS[k], k === kind ? 'ring-1 ring-white' : '']" @click="changeKind(k)">{{ k }}</button>
          </div>
          <div class="my-1 h-px bg-zinc-700" />
          <template v-if="inArray">
            <button class="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800" @click="move(-1)">Move up</button>
            <button class="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800" @click="move(1)">Move down</button>
            <button class="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800" @click="duplicateItem">Duplicate item</button>
          </template>
          <button v-if="kind === 'dict' || kind === 'array'" class="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800" v-tip="'Move this value into a new indirect object and reference it here'" @click="makeIndirect">Make indirect object</button>
          <button v-if="kind === 'ref'" class="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800" v-tip="'Replace the reference by a copy of the referenced object'" @click="inlineRef">Inline referenced object</button>
          <button class="block w-full rounded px-2 py-1 text-left text-red-300 hover:bg-red-900/50" @click="remove">Delete {{ inArray ? 'item' : 'key' }}</button>
        </div>
      </div>
    </div>

    <template v-if="open && expandable">
      <!-- referenced object -->
      <template v-if="kind === 'ref'">
        <ObjectNode v-if="target !== undefined && depth < 40" :owner="value" :path="[]" :depth="depth + 1" :parent-type="myType" :removable="false" start-open @goto="(r) => emit('goto', r)" />
        <div v-else-if="target === undefined" class="py-1 text-red-300" :style="{ paddingLeft: (depth + 1) * 14 + 24 + 'px' }">Object does not exist</div>
      </template>
      <template v-else>
        <ObjectNode
          v-for="ch in shownChildren" :key="ch.key"
          :owner="owner" :path="ch.path" :label="ch.key" :depth="depth + 1" :parent-type="myType"
          @goto="(r) => emit('goto', r)"
        />
        <button v-if="children.length > LIMIT && !showAll" class="btn my-1" :style="{ marginLeft: (depth + 1) * 14 + 24 + 'px' }" @click="showAll = true">Show all {{ children.length }} items</button>
        <div v-if="kind === 'dict' || kind === 'stream' || kind === 'array'" class="flex items-center gap-1 py-1" :style="{ paddingLeft: (depth + 1) * 14 + 24 + 'px' }">
          <input v-if="kind !== 'array'" v-model="newKey" class="inp w-28" placeholder="/NewKey" @keydown.enter="addKey" />
          <select v-model="newKind" class="inp w-20" v-tip="'Type of the new value'">
            <option v-for="k in KINDS" :key="k" :value="k">{{ k }}</option>
          </select>
          <button class="btn" @click="kind === 'array' ? addItem() : addKey()">+ {{ kind === 'array' ? 'item' : 'key' }}</button>
        </div>
        <StreamPanel v-if="kind === 'stream' && ownerIsRef && path.length === 0" :stream-ref="owner" :style="{ marginLeft: (depth + 1) * 14 + 8 + 'px' }" />
      </template>
    </template>
  </div>
</template>
