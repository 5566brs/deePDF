<script setup>
// One content-stream operation, editable as PDF syntax.
// When active: token chips explain every operand, the caret position is followed on the page preview,
// strings show their decoded text and glyphs (duplicate / delete / re-type text through the font's encoding).
import { computed, ref, watch, inject, nextTick } from 'vue'
import { opToDisplay, parseContent, opFocusBox, tokBytes } from '../core/contentStream.js'
import { layoutOp, tokenAt, byteAtCaret } from '../core/opDocs.js'
import { escapeLiteral, toHex } from '../core/pdfobj.js'
import { opDoc } from '../core/docs.js'

const props = defineProps({ op: Object, index: Number, selected: Boolean, depth: { type: Number, default: 0 } })
const emit = defineEmits(['replace', 'focus', 'select'])
const env = inject('opEnv', null)

const text = ref('')
const inputEl = ref(null)
const active = ref(false)
const caretTok = ref(null)
const openStr = ref(null) // key of the string token whose glyph panel is open
const readonly = computed(() => !!props.op.inline)
watch(() => props.op, () => { text.value = opToDisplay(props.op) }, { immediate: true })

const detail = computed(() => (env && env.boxes() && env.boxes().details ? env.boxes().details[props.index] || {} : {}))
const helpers = computed(() => ({ font: env?.font, fontLabel: env?.fontLabel, xobject: env?.xobject, opDoc }))
const liveOp = computed(() => {
  if (text.value === opToDisplay(props.op)) return props.op
  try { const p = parseContent(text.value); return p.length === 1 ? p[0] : props.op } catch { return props.op }
})
const layout = computed(() => (active.value ? layoutOp(liveOp.value, detail.value, helpers.value) : null))
const chips = computed(() => (layout.value ? layout.value.tokens.filter((t) => t.kind !== 'arr') : []))
const stringToks = computed(() => (layout.value ? layout.value.tokens.filter((t) => t.glyphs) : []))
const caretInfo = computed(() => {
  const t = caretTok.value
  if (!t) return ''
  return t.doc.split('\n').slice(0, 2).join(' — ')
})
const inputTip = computed(() => {
  const head = caretTok.value ? `At caret: ${caretTok.value.doc}\n\n` : ''
  return head + (readonly.value ? 'Inline image data cannot be edited here; use the raw editor.' : opDoc(props.op.op) + '\n\nEdit operands and operator (PDF syntax). Several operations may be entered; an empty value deletes the operation.')
})

const OP_CLASS = (op) => {
  if (['BT', 'ET', 'Tf', 'Td', 'TD', 'Tm', 'T*', 'Tc', 'Tw', 'Tz', 'TL', 'Ts', 'Tr'].includes(op)) return 'text-emerald-300'
  if (['Tj', 'TJ', "'", '"'].includes(op)) return 'text-amber-300'
  if (['q', 'Q', 'cm'].includes(op)) return 'text-violet-300'
  if (['Do', 'BI', 'sh'].includes(op)) return 'text-pink-300'
  if (['m', 'l', 'c', 'v', 'y', 'h', 're', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n', 'W', 'W*'].includes(op)) return 'text-sky-300'
  return 'text-zinc-300'
}
const KIND_CLASS = { num: 'border-zinc-600 text-zinc-100', name: 'border-sky-700 text-sky-300', str: 'border-amber-700 text-amber-200', hex: 'border-amber-700 text-amber-200', op: 'border-violet-700 text-violet-200 font-semibold', dict: 'border-emerald-700 text-emerald-200', bool: 'border-pink-700 text-pink-200' }

function locateBox(key, byte) {
  if (!env) return
  const box = opFocusBox(env.boxes() || [], props.index, key === 'op' ? null : key, byte)
  env.locate(box)
}
function trackCaret() {
  const el = inputEl.value
  if (!el || !layout.value) return
  const pos = el.selectionStart ?? 0
  const t = tokenAt(layout.value, pos)
  caretTok.value = t
  if (!t) return
  let byte
  if (t.tok && (t.tok.t === 'str' || t.tok.t === 'hex')) byte = byteAtCaret(t.tok, pos - t.start)
  locateBox(t.key, byte)
}
function onFocus() {
  active.value = true
  emit('focus')
  nextTick(trackCaret)
}
function onBlur(e) {
  // keep the panel open while interacting with it
  void e
  setTimeout(() => { if (document.activeElement !== inputEl.value && !rootEl.value?.contains(document.activeElement)) { active.value = false; caretTok.value = null } }, 150)
}
const rootEl = ref(null)
function selectToken(t) {
  const el = inputEl.value
  if (!el) return
  el.focus()
  el.setSelectionRange(t.start, t.end)
  caretTok.value = t
  locateBox(t.key)
}

function commit() {
  if (readonly.value) return
  if (text.value === opToDisplay(props.op)) return
  let ops
  try { ops = parseContent(text.value) } catch { return }
  emit('replace', ops)
}

/* ---------- string / glyph editing ---------- */
function cloneOp(o) { return { op: o.op, args: JSON.parse(JSON.stringify(o.args)) } }
function setTokBytes(key, bytes, preferHex) {
  const o = cloneOp(props.op)
  const [a, b] = key.slice(1).split('.').map(Number)
  const old = b === undefined ? o.args[a] : o.args[a].v[b]
  const useHex = preferHex ?? old.t === 'hex'
  const tok = useHex ? { t: 'hex', v: toHex(bytes) } : { t: 'str', v: escapeLiteral(bytes) }
  if (b === undefined) o.args[a] = tok
  else o.args[a].v[b] = tok
  emit('replace', [o])
}
function dupGlyph(t, g) {
  const bytes = tokBytes(t.tok)
  const out = new Uint8Array(bytes.length + (g.end - g.start))
  out.set(bytes.subarray(0, g.end), 0)
  out.set(bytes.subarray(g.start, g.end), g.end)
  out.set(bytes.subarray(g.end), g.end + (g.end - g.start))
  setTokBytes(t.key, out)
}
function delGlyph(t, g) {
  const bytes = tokBytes(t.tok)
  const out = new Uint8Array(bytes.length - (g.end - g.start))
  out.set(bytes.subarray(0, g.start), 0)
  out.set(bytes.subarray(g.end), g.start)
  setTokBytes(t.key, out)
}
function glyphTip(g) {
  return [
    `Code ${g.label}${g.name ? ` · glyph /${g.name}` : ''}`,
    g.uni != null ? `Unicode: “${g.uni}” (${[...g.uni].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ')})` : 'No Unicode mapping for this code',
    g.width != null ? `Advance width: ${g.width} / 1000 em` : '',
    'Hover to locate on the page · ⧉ duplicate · ✕ delete',
  ].filter(Boolean).join('\n')
}
function locateGlyph(t, g) { locateBox(t.key, g.start) }

// decoded text editing
const visual = ref(false)
watch(active, (a) => { if (a && detail.value.reversed) visual.value = true })
const textDraft = ref({})
const textFeedback = ref({})
const decoded = (t) => {
  const s = t.glyphs.map((g) => g.uni ?? '�').join('')
  return visual.value ? [...s].reverse().join('') : s
}
function onTextInput(t, v) {
  textDraft.value = { ...textDraft.value, [t.key]: v }
  const font = detail.value.font && env ? env.font(detail.value.font) : null
  if (!font) { textFeedback.value = { ...textFeedback.value, [t.key]: { err: 'Font not found – cannot encode' } }; return }
  const logical = visual.value ? [...v].reverse().join('') : v
  const r = font.encode(logical)
  textFeedback.value = {
    ...textFeedback.value,
    [t.key]: r.missing.length
      ? { err: `Not available in this font${font.composite ? ' subset' : ''}: ${[...new Set(r.missing)].join(' ')} — these characters cannot be encoded` }
      : { ok: `${r.bytes.length} byte(s) · ${toHex(r.bytes, ' ').slice(0, 60)}${r.bytes.length > 20 ? '…' : ''}`, bytes: r.bytes },
  }
}
function applyText(t) {
  const fb = textFeedback.value[t.key]
  if (!fb || !fb.bytes) return
  setTokBytes(t.key, fb.bytes, (detail.value.font && env?.font(detail.value.font)?.composite) || undefined)
  textDraft.value = { ...textDraft.value, [t.key]: undefined }
  textFeedback.value = { ...textFeedback.value, [t.key]: undefined }
}
</script>

<template>
  <div ref="rootEl" class="py-px" :class="{ 'row-sel': selected, 'rounded bg-zinc-800/70 ring-1 ring-cyan-800/60': active }" :style="{ paddingLeft: depth * 14 + 'px' }">
    <div class="group flex items-center gap-1 pr-1">
      <span class="w-10 shrink-0 cursor-pointer text-right font-mono text-[10px] text-zinc-600 select-none" v-tip="'Operation #' + index + ' – click to select'" @click="emit('select', $event)">{{ index }}</span>
      <span class="w-7 shrink-0 text-center font-mono text-[11px] font-semibold" :class="OP_CLASS(op.op)" v-tip="opDoc(op.op)">{{ op.op || '?' }}</span>
      <input
        ref="inputEl"
        v-model="text"
        class="inp flex-1"
        dir="ltr"
        :readonly="readonly"
        :class="{ 'opacity-70': readonly }"
        spellcheck="false"
        v-tip="inputTip"
        @focus="onFocus"
        @blur="onBlur"
        @keyup="trackCaret"
        @click="trackCaret"
        @select="trackCaret"
        @input="trackCaret"
        @change="commit"
        @keydown.enter="$event.target.blur()"
      />
    </div>
    <div v-if="active && layout" class="ml-[4.5rem] mt-0.5 space-y-1 pb-1 pr-1">
      <div class="flex flex-wrap items-center gap-1">
        <button
          v-for="t in chips" :key="t.key"
          tabindex="0"
          class="max-w-[14rem] truncate rounded border bg-zinc-900 px-1 font-mono text-[10px] leading-4 hover:bg-zinc-700"
          :class="[KIND_CLASS[t.kind] || KIND_CLASS.num, caretTok && caretTok.key === t.key ? 'ring-1 ring-cyan-400' : '']"
          v-tip="t.doc"
          @mouseenter="locateBox(t.key)"
          @mousedown.prevent="selectToken(t)"
        ><span v-if="t.color" class="mr-0.5 inline-block h-2 w-2 rounded-sm align-middle" :style="{ background: t.color }" />{{ t.text }}</button>
      </div>
      <div v-if="caretInfo" class="truncate text-[10px] text-cyan-300/90" v-tip="caretTok?.doc">▸ {{ caretInfo }}</div>

      <!-- strings: decoded text + glyphs -->
      <div v-for="t in stringToks" :key="'s' + t.key" class="rounded border border-amber-900/50 bg-zinc-950/60 p-1">
        <div class="flex items-center gap-1">
          <span class="font-mono text-[10px] text-amber-300/80" v-tip="'Decoded with the font\'s ToUnicode map / encoding'">{{ t.key }}</span>
          <input
            class="inp min-w-0 flex-1 text-[12px] text-amber-100"
            dir="auto"
            :value="textDraft[t.key] ?? decoded(t)"
            v-tip="'Readable text of this string. Type to replace it: the text is encoded back through the font (only characters that exist in the font can be used). Enter applies.'"
            @mousedown.stop
            @input="onTextInput(t, $event.target.value)"
            @keydown.enter.prevent="applyText(t)"
          />
          <button class="btn btn-icon text-[10px]" :class="{ 'text-cyan-300': visual }" v-tip="'Show/enter text reversed. Some PDFs store right-to-left text in visual (reversed) order – e.g. inside /ReversedChars marked content, which is detected automatically.'" @mousedown.prevent @click="visual = !visual">⇄</button>
          <button class="btn btn-icon text-[10px]" :class="{ 'text-cyan-300': openStr === t.key }" v-tip="'Show glyphs'" @mousedown.prevent @click="openStr = openStr === t.key ? null : t.key">glyphs</button>
          <button v-if="textFeedback[t.key]?.bytes" class="btn btn-primary btn-icon text-[10px]" @mousedown.prevent @click="applyText(t)">apply</button>
        </div>
        <div v-if="textFeedback[t.key]" class="mt-0.5 text-[10px]" :class="textFeedback[t.key].err ? 'text-red-300' : 'text-emerald-300'">{{ textFeedback[t.key].err || 'Encodes to ' + textFeedback[t.key].ok }}</div>
        <div v-if="openStr === t.key" class="mt-1 flex flex-wrap gap-0.5">
          <div
            v-for="(g, gi) in t.glyphs" :key="gi"
            class="group/g relative flex min-w-[1.9rem] flex-col items-center rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 hover:border-cyan-500"
            v-tip="glyphTip(g)"
            @mouseenter="locateGlyph(t, g)"
          >
            <span class="text-[14px] leading-4 text-zinc-100" dir="ltr">{{ g.uni === ' ' ? '␣' : g.uni ?? '?' }}</span>
            <span class="font-mono text-[8px] text-zinc-500">{{ g.label.slice(2) }}</span>
            <div class="absolute -top-2 right-0 hidden gap-px group-hover/g:flex">
              <button class="rounded bg-zinc-700 px-0.5 text-[9px] leading-3 hover:bg-cyan-700" @mousedown.prevent @click="dupGlyph(t, g)">⧉</button>
              <button class="rounded bg-zinc-700 px-0.5 text-[9px] leading-3 hover:bg-red-700" @mousedown.prevent @click="delGlyph(t, g)">✕</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
