<script setup>
// Recursive row for a content element (group / text / path / image …) of a page.
import { computed } from 'vue'
import { ELEMENT_DOCS } from '../core/docs.js'
import OpLine from './OpLine.vue'

defineOptions({ name: 'ElementNode' })
const props = defineProps({
  node: Object, ops: Array, sel: Set, expanded: Set, depth: { type: Number, default: 0 }, describe: Function, rev: Number,
})
const emit = defineEmits(['select', 'toggle', 'replace-op', 'focus-node', 'focus-op'])

const isOpen = computed(() => props.expanded.has(props.node.id))
const isContainer = computed(() => !!props.node.children)
const opCount = computed(() => props.node.to - props.node.from + 1)
const info = computed(() => { props.rev; return props.describe(props.node) })

const TYPE_STYLE = {
  group: ['q…Q', 'bg-violet-900/60 text-violet-200'],
  text: ['text', 'bg-emerald-900/60 text-emerald-200'],
  marked: ['tag', 'bg-zinc-700 text-zinc-200'],
  compat: ['BX', 'bg-zinc-700 text-zinc-300'],
  path: ['path', 'bg-sky-900/60 text-sky-200'],
  xobject: ['Do', 'bg-pink-900/60 text-pink-200'],
  shading: ['sh', 'bg-fuchsia-900/60 text-fuchsia-200'],
  inline: ['BI', 'bg-pink-900/60 text-pink-200'],
  op: ['op', 'bg-zinc-800 text-zinc-400'],
}
const LIMIT = 300
const kids = computed(() => (props.node.children || []))
</script>

<template>
  <div>
    <div
      class="group flex min-h-[26px] cursor-pointer items-center gap-1.5 rounded py-0.5 pr-1 text-xs hover:bg-zinc-700/30"
      :class="{ 'row-sel': sel.has(node.id) }"
      :style="{ paddingLeft: depth * 14 + 2 + 'px' }"
      :data-node="node.id"
      tabindex="0"
      @click="emit('select', node, $event)"
      @focus="emit('focus-node', node)"
      @dblclick="emit('toggle', node)"
    >
      <button class="w-4 shrink-0 text-zinc-500 hover:text-white" @click.stop="emit('toggle', node)">{{ isOpen ? '▾' : '▸' }}</button>
      <input type="checkbox" class="shrink-0" :checked="sel.has(node.id)" @click.stop="emit('select', node, { ctrlKey: true })" />
      <span class="tag shrink-0" :class="(TYPE_STYLE[node.type] || TYPE_STYLE.op)[1]" v-tip="ELEMENT_DOCS[node.type]">{{ info.badge || (TYPE_STYLE[node.type] || TYPE_STYLE.op)[0] }}</span>
      <img v-if="info.thumb" :src="info.thumb" class="h-5 w-5 shrink-0 rounded-sm bg-white object-contain" alt="" />
      <span class="min-w-0 flex-1 truncate" :class="info.mono ? 'font-mono text-zinc-400' : 'text-zinc-200'" :dir="info.mono ? 'ltr' : 'auto'" v-tip="info.tip || ''">{{ info.label }}</span>
      <span v-if="node.unclosed" class="tag bg-amber-900 text-amber-200" v-tip="'Not properly closed in the content stream'">unclosed</span>
      <span class="shrink-0 font-mono text-[10px] text-zinc-600" v-tip="`Operations #${node.from}–#${node.to}`">{{ opCount }}</span>
    </div>
    <template v-if="isOpen">
      <template v-if="isContainer">
        <OpLine :op="ops[node.from]" :index="node.from" :depth="depth + 1.4" @replace="(r) => emit('replace-op', node.from, r)" @focus="emit('focus-op', node.from)" />
        <ElementNode
          v-for="c in kids.slice(0, LIMIT)" :key="c.id"
          :node="c" :ops="ops" :sel="sel" :expanded="expanded" :depth="depth + 1" :describe="describe" :rev="rev"
          @select="(n, e) => emit('select', n, e)" @toggle="(n) => emit('toggle', n)"
          @replace-op="(i, r) => emit('replace-op', i, r)" @focus-node="(n) => emit('focus-node', n)" @focus-op="(i) => emit('focus-op', i)"
        />
        <div v-if="kids.length > LIMIT" class="py-1 text-[11px] text-zinc-500" :style="{ paddingLeft: (depth + 1) * 14 + 24 + 'px' }">… {{ kids.length - LIMIT }} more elements (use the raw editor or Objects tab)</div>
        <OpLine v-if="!node.unclosed && node.to > node.from" :op="ops[node.to]" :index="node.to" :depth="depth + 1.4" @replace="(r) => emit('replace-op', node.to, r)" @focus="emit('focus-op', node.to)" />
      </template>
      <template v-else>
        <OpLine
          v-for="i in opCount" :key="node.from + i - 1"
          :op="ops[node.from + i - 1]" :index="node.from + i - 1" :depth="depth + 1.4"
          @replace="(r) => emit('replace-op', node.from + i - 1, r)" @focus="emit('focus-op', node.from + i - 1)"
        />
      </template>
    </template>
  </div>
</template>
