<script setup>
// Editor for PDF (D:YYYYMMDDHHmmSS+HH'mm') or ISO-8601 (XMP) date strings.
import { computed, ref, watch } from 'vue'
import { parsePdfDate, formatPdfDate, parseIsoDate, formatIsoDate, nowParts, toLocalInput, fromLocalInput, TZ_OPTIONS } from '../core/pdfDate.js'

const props = defineProps({ modelValue: String, iso: Boolean })
const emit = defineEmits(['update:modelValue', 'focus'])

const parts = computed(() => (props.iso ? parseIsoDate(props.modelValue) : parsePdfDate(props.modelValue)))
const raw = ref(props.modelValue || '')
const showRaw = ref(false)
watch(() => props.modelValue, (v) => { raw.value = v || '' })

const fmt = (p) => (props.iso ? formatIsoDate(p) : formatPdfDate(p))
const local = computed(() => (parts.value ? toLocalInput(parts.value) : ''))
const tz = computed(() => (parts.value && parts.value.offset !== null ? String(parts.value.offset) : 'none'))

function setLocal(v) {
  const off = parts.value ? parts.value.offset : null
  const p = fromLocalInput(v, off)
  if (p) emit('update:modelValue', fmt(p))
}
function setTz(v) {
  const p = parts.value || nowParts()
  emit('update:modelValue', fmt({ ...p, offset: v === 'none' ? null : +v }))
}
function now() { emit('update:modelValue', fmt(nowParts())) }
const human = computed(() => {
  const p = parts.value
  if (!p) return 'Unparseable date'
  const d = p.offset === null ? new Date(p.Y, p.Mo - 1, p.D, p.H, p.Mi, p.S) : new Date(Date.UTC(p.Y, p.Mo - 1, p.D, p.H, p.Mi, p.S) - p.offset * 60000)
  return isNaN(d) ? 'Invalid date' : d.toString()
})
</script>

<template>
  <div class="flex min-w-0 flex-wrap items-center gap-1" @focusin="emit('focus')">
    <input type="datetime-local" step="1" class="inp w-[13.5rem]" :value="local" v-tip="human" @change="setLocal($event.target.value)" />
    <select class="inp w-28" :value="tz" v-tip="'Time-zone offset stored with the date'" @change="setTz($event.target.value)">
      <option v-for="o in TZ_OPTIONS" :key="o.v" :value="o.v">{{ o.label }}</option>
    </select>
    <button class="btn btn-icon" v-tip="'Set to current date and time'" @click="now">now</button>
    <button class="btn btn-icon" :class="{ 'text-cyan-300': showRaw }" v-tip="'Edit the raw date string'" @click="showRaw = !showRaw">raw</button>
    <input v-if="showRaw" class="inp w-56" v-model="raw" @change="emit('update:modelValue', raw)" />
  </div>
</template>
