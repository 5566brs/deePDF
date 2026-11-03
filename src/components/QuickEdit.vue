<script setup>
// Quick actions for the current selection: edit its text directly, move it.
import { ref, watch, computed } from 'vue'
import { encodeRun } from '../core/textEdit.js'

const props = defineProps({
  runs: Array, // from textRuns()
  move: Object, // { ok, reason, label }
  rev: Number,
})
const emit = defineEmits(['apply-text', 'move', 'focus-run'])

const drafts = ref({})
const feedback = ref({})
watch(() => [props.runs, props.rev], () => { drafts.value = {}; feedback.value = {} })

function onInput(run, v) {
  drafts.value = { ...drafts.value, [run.index]: v }
  if (v === run.text) { feedback.value = { ...feedback.value, [run.index]: undefined }; return }
  const r = encodeRun(run, v)
  feedback.value = {
    ...feedback.value,
    [run.index]: r.op ? { ok: true, op: r.op, note: r.note } : { ok: false, msg: r.missing.length ? `Not in this font: ${r.missing.join(' ')}` : r.note },
  }
}
function apply(run) {
  const fb = feedback.value[run.index]
  if (!fb || !fb.ok) return
  emit('apply-text', run.index, fb.op)
}
function applyAll() {
  for (const r of props.runs) apply(r)
}
const pending = computed(() => Object.values(feedback.value).filter((f) => f && f.ok).length)

const step = ref(1)
const mx = ref(0)
const my = ref(0)
function nudge(x, y, e) {
  const s = (e && e.shiftKey ? 10 : 1) * step.value
  emit('move', x * s, y * s)
}
function onKey(e) {
  const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }
  if (!map[e.key]) return
  e.preventDefault()
  nudge(...map[e.key], e)
}
</script>

<template>
  <div class="mb-2 space-y-2 rounded-md border border-cyan-900/70 bg-cyan-950/20 p-2 text-xs">
    <!-- text -->
    <div v-if="runs.length">
      <div class="mb-1 flex items-center gap-2">
        <span class="font-semibold text-cyan-200">Edit text</span>
        <span class="text-[10px] text-zinc-500">Enter applies · characters must exist in the (embedded) font</span>
        <div class="flex-1" />
        <button v-if="pending > 1" class="btn btn-primary" @click="applyAll">Apply all ({{ pending }})</button>
      </div>
      <div v-for="(r, k) in runs" :key="r.index" class="mb-1">
        <div class="flex items-center gap-1">
          <span class="w-9 shrink-0 text-right font-mono text-[10px] text-zinc-500" v-tip="`Operation #${r.index} (${r.op.op}) · font /${r.fontName} ${r.size ?? ''}pt${r.reversed ? '\nStored in visual order (/ReversedChars) – shown and typed in logical order' : ''}`">#{{ r.index }}</span>
          <input
            :data-quick-text="k"
            class="inp min-w-0 flex-1 py-1 text-[13px] text-zinc-50"
            dir="auto"
            :value="drafts[r.index] ?? r.text"
            :disabled="!r.font"
            :placeholder="r.font ? '' : 'font not found'"
            v-tip="r.mappable ? 'Type the new text' : 'Some characters of this string have no Unicode mapping (shown as �); typing replaces the whole string'"
            @focus="emit('focus-run', r)"
            @input="onInput(r, $event.target.value)"
            @keydown.enter.prevent="apply(r)"
            @keydown.esc="drafts = { ...drafts, [r.index]: undefined }; feedback = { ...feedback, [r.index]: undefined }"
          />
          <button v-if="feedback[r.index]?.ok" class="btn btn-primary btn-icon" @click="apply(r)">✓</button>
        </div>
        <div v-if="feedback[r.index]" class="ml-10 text-[10px]" :class="feedback[r.index].ok ? 'text-emerald-300' : 'text-red-300'">
          {{ feedback[r.index].ok ? (feedback[r.index].note || 'Ready – press Enter') : feedback[r.index].msg }}
        </div>
      </div>
    </div>

    <!-- move -->
    <div class="flex flex-wrap items-center gap-1" tabindex="-1" @keydown="onKey">
      <span class="font-semibold text-cyan-200">Move</span>
      <template v-if="move.ok">
        <button class="btn btn-icon" v-tip="'Left (Shift = ×10)'" @click="nudge(-1, 0, $event)">←</button>
        <button class="btn btn-icon" v-tip="'Right (Shift = ×10)'" @click="nudge(1, 0, $event)">→</button>
        <button class="btn btn-icon" v-tip="'Up (Shift = ×10)'" @click="nudge(0, 1, $event)">↑</button>
        <button class="btn btn-icon" v-tip="'Down (Shift = ×10)'" @click="nudge(0, -1, $event)">↓</button>
        <label class="flex items-center gap-0.5 text-[10px] text-zinc-500" v-tip="'Step in points (1 pt = 1/72 inch)'">step<input v-model.number="step" type="number" min="0" step="any" class="inp w-12" /></label>
        <span class="mx-1 h-4 w-px bg-zinc-700" />
        <label class="flex items-center gap-0.5 text-[10px] text-zinc-500">dx<input v-model.number="mx" type="number" step="any" class="inp w-14" /></label>
        <label class="flex items-center gap-0.5 text-[10px] text-zinc-500">dy<input v-model.number="my" type="number" step="any" class="inp w-14" /></label>
        <button class="btn" :disabled="!mx && !my" @click="emit('move', +mx || 0, +my || 0); mx = 0; my = 0">Apply</button>
        <span class="text-[10px] text-zinc-500">{{ move.label }} · arrow keys (Shift ×10) · or drag the dashed box in the preview</span>
      </template>
      <span v-else class="text-[10px] text-amber-300/90">{{ move.reason }}</span>
    </div>
  </div>
</template>
