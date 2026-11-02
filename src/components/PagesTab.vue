<script setup>
// Page list: reorder (drag or buttons), delete, page boxes and attributes.
import { computed, ref } from 'vue'
import { store, ctx, mutate, locate, notify } from '../core/store.js'
import { listPages, setPageOrder, deletePages, inherited, pageBox, BOX_KEYS, contentRefs } from '../core/pages.js'
import { N, deref, numArray, numVal, PDFArray, PDFNumber, PDFName, PDFRef, nameStr, fmtNum } from '../core/pdfobj.js'
import { keyDoc } from '../core/docs.js'
import PageThumb from './PageThumb.vue'
import RectInput from './RectInput.vue'
import ObjectNode from './ObjectNode.vue'

const selected = ref(new Set())
const dragFrom = ref(-1)
const dragOver = ref(-1)
const showAll = ref(false)

const pages = computed(() => {
  store.rev
  const c = ctx()
  return listPages(c).map((p, i) => {
    const mb = pageBox(c, p.dict, 'MediaBox')
    const annots = deref(c, p.dict.get(N('Annots')))
    return {
      i, ref: p.ref,
      size: `${fmtNum(mb[2] - mb[0])}×${fmtNum(mb[3] - mb[1])}`,
      rotate: numVal(inherited(c, p.dict, 'Rotate')) || 0,
      annots: annots instanceof PDFArray ? annots.size() : 0,
      streams: contentRefs(c, p.dict).length,
    }
  })
})
const current = computed(() => pages.value[store.currentPage])

function select(i, e) {
  store.currentPage = i
  const s = new Set(e && (e.ctrlKey || e.metaKey) ? selected.value : [])
  if (e && e.shiftKey && selected.value.size) {
    const last = [...selected.value].pop()
    for (let k = Math.min(last, i); k <= Math.max(last, i); k++) s.add(k)
  } else if (s.has(i) && e && (e.ctrlKey || e.metaKey)) s.delete(i)
  else s.add(i)
  selected.value = s
  locate(i, null)
}
const selList = () => (selected.value.size ? [...selected.value].sort((a, b) => a - b) : [store.currentPage])

function reorder(newOrderIdx, label) {
  const refs = pages.value.map((p) => p.ref)
  if (refs.some((r) => !r)) { notify('Some pages are direct objects; cannot reorder', 'error'); return }
  mutate(label, (c) => setPageOrder(c, newOrderIdx.map((i) => refs[i])))
}
function move(delta) {
  const sel = selList()
  const order = pages.value.map((p) => p.i)
  if (delta < 0 && sel[0] === 0) return
  if (delta > 0 && sel[sel.length - 1] === order.length - 1) return
  const it = delta < 0 ? sel : [...sel].reverse()
  for (const i of it) { const j = i + delta;[order[i], order[j]] = [order[j], order[i]] }
  reorder(order, `Move page${sel.length > 1 ? 's' : ''} ${delta < 0 ? 'up' : 'down'}`)
  selected.value = new Set(sel.map((i) => i + delta))
  store.currentPage += delta
}
function moveTo(from, to) {
  const sel = selected.value.has(from) ? selList() : [from]
  const order = pages.value.map((p) => p.i)
  const moving = sel.map((i) => order[i])
  const rest = order.filter((x) => !sel.includes(x))
  let insertAt = rest.findIndex((x) => x === order[to])
  if (insertAt < 0) insertAt = rest.length
  if (to > from) insertAt++
  rest.splice(insertAt, 0, ...moving)
  reorder(rest, 'Reorder pages')
  selected.value = new Set(moving.map((x) => rest.indexOf(x)))
  store.currentPage = rest.indexOf(moving[0])
}
function remove() {
  const sel = selList()
  if (sel.length >= pages.value.length) { notify('A document must keep at least one page', 'warn'); return }
  if (!confirm(`Delete ${sel.length} page(s)?`)) return
  mutate(`Delete ${sel.length} page(s)`, (c) => deletePages(c, sel.map((i) => pages.value[i].ref)))
  selected.value = new Set()
}
function reverse() {
  reorder(pages.value.map((p) => p.i).reverse(), 'Reverse page order')
}
function rotate(delta) {
  const sel = selList()
  mutate('Rotate page(s)', (c) => {
    const all = listPages(c)
    for (const i of sel) {
      const d = all[i].dict
      const r = ((numVal(inherited(c, d, 'Rotate')) || 0) + delta + 360) % 360
      d.set(N('Rotate'), PDFNumber.of(r))
    }
  })
}

function onDragStart(i, e) { dragFrom.value = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)) }
function onDrop(i) { if (dragFrom.value >= 0 && dragFrom.value !== i) moveTo(dragFrom.value, i); dragFrom.value = -1; dragOver.value = -1 }

/* ---------- page attributes ---------- */
const boxes = computed(() => {
  store.rev
  const c = ctx()
  const p = listPages(c)[store.currentPage]
  if (!p) return []
  return BOX_KEYS.map((k) => {
    const own = p.dict.get(N(k))
    const v = numArray(c, inherited(c, p.dict, k))
    return { key: k, own: own !== undefined, inheritedOnly: own === undefined && !!v, value: v || pageBox(c, p.dict, k), effective: !v }
  })
})
function setBox(key, arr) {
  mutate(`Set ${key}`, (c) => {
    const p = listPages(c)[store.currentPage]
    p.dict.set(N(key), c.obj(arr.map((n) => PDFNumber.of(n))))
  })
}
function removeBox(key) {
  mutate(`Remove ${key}`, (c) => listPages(c)[store.currentPage].dict.delete(N(key)))
}
function applyBoxToSelection(key) {
  const v = boxes.value.find((b) => b.key === key).value
  const sel = selList()
  mutate(`Apply ${key} to ${sel.length} page(s)`, (c) => {
    const all = listPages(c)
    for (const i of sel) all[i].dict.set(N(key), c.obj(v.map((n) => PDFNumber.of(n))))
  })
}
const rotateVal = computed(() => { store.rev; const p = listPages(ctx())[store.currentPage]; return p ? numVal(inherited(ctx(), p.dict, 'Rotate')) || 0 : 0 })
function setRotate(v) { mutate('Set Rotate', (c) => listPages(c)[store.currentPage].dict.set(N('Rotate'), PDFNumber.of(+v))) }
const userUnit = computed(() => { store.rev; const p = listPages(ctx())[store.currentPage]; return p ? numVal(deref(ctx(), p.dict.get(N('UserUnit')))) ?? '' : '' })
function setUserUnit(v) {
  mutate('Set UserUnit', (c) => {
    const d = listPages(c)[store.currentPage].dict
    if (v === '' || +v === 1) d.delete(N('UserUnit')); else d.set(N('UserUnit'), PDFNumber.of(+v))
  })
}
const tabsVal = computed(() => { store.rev; const p = listPages(ctx())[store.currentPage]; return p ? nameStr(deref(ctx(), p.dict.get(N('Tabs')))) || '' : '' })
function setTabs(v) {
  mutate('Set Tabs', (c) => { const d = listPages(c)[store.currentPage].dict; v ? d.set(N('Tabs'), PDFName.of(v)) : d.delete(N('Tabs')) })
}
</script>

<template>
  <div class="p-2">
    <div class="sticky top-0 z-10 -mx-2 -mt-2 mb-2 flex flex-wrap items-center gap-1 border-b border-zinc-800 bg-zinc-900/95 px-2 py-1.5 backdrop-blur">
      <span class="text-xs text-zinc-400">{{ pages.length }} pages<template v-if="selected.size > 1"> · {{ selected.size }} selected</template></span>
      <div class="flex-1" />
      <button class="btn" v-tip="'Move selected page(s) up'" @click="move(-1)">▲</button>
      <button class="btn" v-tip="'Move selected page(s) down'" @click="move(1)">▼</button>
      <button class="btn" v-tip="'Rotate selected page(s) 90° counter-clockwise (/Rotate)'" @click="rotate(-90)">⟲</button>
      <button class="btn" v-tip="'Rotate selected page(s) 90° clockwise (/Rotate)'" @click="rotate(90)">⟳</button>
      <button class="btn" v-tip="'Reverse the order of all pages'" @click="reverse">Reverse</button>
      <button class="btn btn-danger" v-tip="'Delete selected page(s)'" @click="remove">Delete</button>
    </div>
    <p class="mb-2 text-[11px] text-zinc-500">Click to select · Ctrl/Shift-click for multiple · drag to reorder. Reordering rebuilds the page tree as a single /Pages node (inherited attributes are copied onto each page).</p>

    <div class="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
      <div
        v-for="p in pages" :key="p.ref ? p.ref.objectNumber : p.i"
        draggable="true"
        class="flex cursor-pointer flex-col items-center gap-1 rounded-md border p-1.5 transition-colors"
        :class="[p.i === store.currentPage ? 'border-cyan-500 bg-cyan-950/40' : selected.has(p.i) ? 'border-cyan-800 bg-cyan-950/20' : 'border-zinc-800 hover:border-zinc-600', dragOver === p.i ? 'drag-over' : '']"
        tabindex="0"
        @click="select(p.i, $event)"
        @focus="locate(p.i, null)"
        @dragstart="onDragStart(p.i, $event)"
        @dragover.prevent="dragOver = p.i"
        @dragleave="dragOver = -1"
        @drop.prevent="onDrop(p.i)"
        @keydown.delete="remove"
      >
        <PageThumb :index="p.i" :width="72" />
        <div class="w-full text-center text-[10px] leading-tight">
          <div class="font-semibold text-zinc-200">{{ p.i + 1 }}</div>
          <div class="text-zinc-500" v-tip="'Media box size in points, object number'">{{ p.size }}<span v-if="p.rotate"> ⟳{{ p.rotate }}</span></div>
          <div class="font-mono text-zinc-600">{{ p.ref ? p.ref.objectNumber + ' 0 R' : 'direct' }}</div>
        </div>
      </div>
    </div>

    <template v-if="current">
      <div class="section-title">Page {{ store.currentPage + 1 }} attributes <span class="font-mono font-normal normal-case text-zinc-500">{{ current.ref?.objectNumber }} 0 R · {{ current.streams }} content stream(s) · {{ current.annots }} annotation(s)</span></div>
      <div class="space-y-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
        <div v-for="b in boxes" :key="b.key" class="flex flex-wrap items-center gap-2 text-xs">
          <span class="w-20 font-mono text-zinc-200 underline decoration-zinc-600 decoration-dotted underline-offset-2" v-tip="keyDoc(b.key)">/{{ b.key }}</span>
          <RectInput :model-value="b.value" @update:model-value="(v) => setBox(b.key, v)" @focus="locate(store.currentPage, b.value)" />
          <span v-if="b.effective" class="tag bg-zinc-800 text-zinc-500" v-tip="'Not set: the effective value (shown) comes from the default'">default</span>
          <span v-else-if="b.inheritedOnly" class="tag bg-zinc-800 text-zinc-400" v-tip="'Inherited from a parent /Pages node'">inherited</span>
          <button v-if="b.own && b.key !== 'MediaBox'" class="btn btn-icon" v-tip="'Remove this box from the page'" @click="removeBox(b.key)">✕</button>
          <button v-if="selected.size > 1" class="btn btn-icon" v-tip="'Apply this box to all selected pages'" @click="applyBoxToSelection(b.key)">→ sel</button>
        </div>
        <div class="flex flex-wrap items-center gap-3 pt-1 text-xs">
          <label class="flex items-center gap-1"><span class="font-mono text-zinc-200" v-tip="keyDoc('Rotate')">/Rotate</span>
            <select class="inp" :value="rotateVal" @change="setRotate($event.target.value)" @focus="locate(store.currentPage, null)">
              <option v-for="r in [0, 90, 180, 270]" :key="r" :value="r">{{ r }}°</option>
            </select>
          </label>
          <label class="flex items-center gap-1"><span class="font-mono text-zinc-200" v-tip="keyDoc('UserUnit')">/UserUnit</span>
            <input type="number" step="any" min="0" class="inp w-16" :value="userUnit" placeholder="1" @change="setUserUnit($event.target.value)" />
          </label>
          <label class="flex items-center gap-1"><span class="font-mono text-zinc-200" v-tip="keyDoc('Tabs')">/Tabs</span>
            <select class="inp" :value="tabsVal" @change="setTabs($event.target.value)">
              <option value="">(none)</option>
              <option value="R">R – row order</option>
              <option value="C">C – column order</option>
              <option value="S">S – structure order</option>
            </select>
          </label>
        </div>
      </div>
      <button class="btn mt-2" @click="showAll = !showAll">{{ showAll ? 'Hide' : 'Show' }} full page dictionary</button>
      <div v-if="showAll && current.ref" class="mt-1 rounded-md border border-zinc-800 bg-zinc-900/60 p-1">
        <ObjectNode :key="current.ref.objectNumber" :owner="current.ref" :path="[]" start-open :removable="false" />
      </div>
    </template>
  </div>
</template>
