<script setup>
// Inline editor for a scalar PDF value. Emits `commit` with a new PDF object.
import { computed, ref, watch } from 'vue'
import {
  kindOf, PDFNumber, PDFBool, PDFName, PDFRef, stringText, stringBytes, makeString, makeStringFromBytes,
  toHex, fromHex, parseRefKey, numArray, PDFArray,
} from '../core/pdfobj.js'
import { looksLikePdfDate } from '../core/pdfDate.js'
import { NAME_SUGGESTIONS } from '../core/docs.js'
import { ctx } from '../core/store.js'
import { BOX_KEYS } from '../core/pages.js'
import DateInput from './DateInput.vue'
import RectInput from './RectInput.vue'

const props = defineProps({ value: Object, keyName: [String, Number], rev: Number })
const emit = defineEmits(['commit', 'focus', 'goto'])

const kind = computed(() => { props.rev; return kindOf(props.value) })
const DATE_KEYS = new Set(['CreationDate', 'ModDate', 'M', 'LastModified', 'Date'])
const RECT_KEYS = new Set([...BOX_KEYS, 'Rect', 'BBox', 'FontBBox'])

const text = computed(() => {
  props.rev
  const v = props.value
  switch (kind.value) {
    case 'number': return String(v.asNumber())
    case 'name': return v.decodeText()
    case 'string': case 'hex': return hexMode.value ? toHex(stringBytes(v), ' ') : stringText(v)
    case 'ref': return `${v.objectNumber} ${v.generationNumber}`
    default: return ''
  }
})
const hexMode = ref(false)
watch(() => props.value, () => { if (kind.value === 'hex' && stringBytes(props.value).some?.((b) => b < 32 && b !== 10 && b !== 13 && b !== 9)) hexMode.value = true }, { immediate: true })

const isDate = computed(() => (kind.value === 'string' || kind.value === 'hex') && (DATE_KEYS.has(props.keyName) || looksLikePdfDate(stringText(props.value))))
const rect = computed(() => {
  props.rev
  if (kind.value !== 'array' || !RECT_KEYS.has(props.keyName)) return null
  const r = numArray(ctx(), props.value)
  return r && r.length === 4 ? r : null
})
const suggestions = computed(() => NAME_SUGGESTIONS[props.keyName] || null)
const listId = computed(() => (suggestions.value ? 'dl-' + props.keyName : undefined))
const binary = computed(() => {
  if (kind.value !== 'string' && kind.value !== 'hex') return false
  const b = stringBytes(props.value)
  if (b[0] === 0xfe && b[1] === 0xff) return false
  for (const x of b) if (x < 9 || (x > 13 && x < 32)) return true
  return false
})

function commitText(v) {
  switch (kind.value) {
    case 'number': {
      const n = parseFloat(v)
      if (isFinite(n)) emit('commit', PDFNumber.of(n))
      break
    }
    case 'name': if (v) emit('commit', PDFName.of(v.replace(/^\//, ''))); break
    case 'string': case 'hex': {
      const asHex = kind.value === 'hex'
      if (hexMode.value) emit('commit', makeStringFromBytes(fromHex(v), asHex))
      else emit('commit', makeString(v, asHex))
      break
    }
    case 'ref': {
      const r = parseRefKey(v)
      if (r) emit('commit', r)
      break
    }
  }
}
function commitRect(arr) {
  const a = PDFArray.withContext(ctx())
  for (const n of arr) a.push(PDFNumber.of(n))
  emit('commit', a)
}
</script>

<template>
  <div class="flex min-w-0 flex-1 items-center gap-1" @focusin="emit('focus')">
    <template v-if="kind === 'bool'">
      <select class="inp w-20" :value="String(value.asBoolean())" @change="emit('commit', $event.target.value === 'true' ? PDFBool.True : PDFBool.False)">
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    </template>
    <template v-else-if="kind === 'number'">
      <input type="number" step="any" class="inp w-28" :value="text" @change="commitText($event.target.value)" />
    </template>
    <template v-else-if="kind === 'name'">
      <span class="font-mono text-xs text-zinc-500">/</span>
      <input class="inp min-w-0 flex-1 text-sky-300" :value="text" :list="listId" @change="commitText($event.target.value)" />
      <datalist v-if="suggestions" :id="listId"><option v-for="s in suggestions" :key="s" :value="s" /></datalist>
    </template>
    <template v-else-if="(kind === 'string' || kind === 'hex') && isDate && !hexMode">
      <DateInput :model-value="text" @update:model-value="commitText" />
    </template>
    <template v-else-if="kind === 'string' || kind === 'hex'">
      <span class="font-mono text-xs text-zinc-500">{{ kind === 'hex' ? '<' : '(' }}</span>
      <input class="inp min-w-0 flex-1 text-amber-200" :value="text" :dir="hexMode ? 'ltr' : 'auto'" @change="commitText($event.target.value)" />
      <span class="font-mono text-xs text-zinc-500">{{ kind === 'hex' ? '>' : ')' }}</span>
      <button class="btn btn-icon text-[10px]" :class="{ 'text-cyan-300': hexMode }" v-tip="hexMode ? 'Editing raw bytes as hex – click for text' : (binary ? 'Contains binary bytes – click to edit as hex bytes' : 'Edit raw bytes as hex')" @click="hexMode = !hexMode">hex</button>
    </template>
    <template v-else-if="kind === 'ref'">
      <input class="inp w-20 text-violet-300" :value="text" v-tip="'Object number and generation of the referenced object'" @change="commitText($event.target.value)" />
      <span class="font-mono text-xs text-zinc-500">R</span>
      <button class="btn btn-icon text-[10px]" v-tip="'Show this object in the flat object list'" @click="emit('goto', value)">go</button>
    </template>
    <template v-else-if="rect">
      <RectInput :model-value="rect" @update:model-value="commitRect" />
    </template>
    <template v-else-if="kind === 'null'">
      <span class="font-mono text-xs text-zinc-500">null</span>
    </template>
  </div>
</template>
