<script setup>
// One content-stream operation, editable as PDF syntax.
import { computed, ref, watch } from 'vue'
import { opToDisplay, parseContent } from '../core/contentStream.js'
import { opDoc } from '../core/docs.js'

const props = defineProps({ op: Object, index: Number, selected: Boolean, depth: { type: Number, default: 0 } })
const emit = defineEmits(['replace', 'focus', 'select'])

const text = ref('')
const readonly = computed(() => !!props.op.inline)
watch(() => props.op, () => { text.value = opToDisplay(props.op) }, { immediate: true })

const OP_CLASS = (op) => {
  if (['BT', 'ET', 'Tf', 'Td', 'TD', 'Tm', 'T*', 'Tc', 'Tw', 'Tz', 'TL', 'Ts', 'Tr'].includes(op)) return 'text-emerald-300'
  if (['Tj', 'TJ', "'", '"'].includes(op)) return 'text-amber-300'
  if (['q', 'Q', 'cm'].includes(op)) return 'text-violet-300'
  if (['Do', 'BI', 'sh'].includes(op)) return 'text-pink-300'
  if (['m', 'l', 'c', 'v', 'y', 'h', 're', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n', 'W', 'W*'].includes(op)) return 'text-sky-300'
  return 'text-zinc-300'
}

function commit() {
  if (readonly.value) return
  if (text.value === opToDisplay(props.op)) return
  let ops
  try { ops = parseContent(text.value) } catch (e) { return }
  emit('replace', ops)
}
</script>

<template>
  <div class="group flex items-center gap-1 py-px pr-1" :class="{ 'row-sel': selected }" :style="{ paddingLeft: depth * 14 + 'px' }">
    <span class="w-10 shrink-0 cursor-pointer text-right font-mono text-[10px] text-zinc-600 select-none" v-tip="'Operation #' + index + ' – click to select'" @click="emit('select', $event)">{{ index }}</span>
    <span class="w-7 shrink-0 text-center font-mono text-[11px] font-semibold" :class="OP_CLASS(op.op)" v-tip="opDoc(op.op)">{{ op.op || '?' }}</span>
    <input
      v-model="text"
      class="inp flex-1"
      :readonly="readonly"
      :class="{ 'opacity-70': readonly }"
      spellcheck="false"
      v-tip="readonly ? 'Inline image data cannot be edited here; use the raw editor.' : 'Edit operands and operator (PDF syntax). Several operations may be entered; an empty value deletes the operation.'"
      @focus="emit('focus')"
      @change="commit"
      @keydown.enter="$event.target.blur()"
    />
  </div>
</template>
