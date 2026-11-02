<script setup>
// Four-number rectangle editor [llx lly urx ury].
const props = defineProps({ modelValue: Array, labels: { type: Array, default: () => ['llx', 'lly', 'urx', 'ury'] } })
const emit = defineEmits(['update:modelValue', 'focus'])
const tips = {
  llx: 'Lower-left X (points from the left edge of the user space)',
  lly: 'Lower-left Y (points from the bottom)',
  urx: 'Upper-right X',
  ury: 'Upper-right Y',
}
function set(i, v) {
  const n = parseFloat(v)
  if (!isFinite(n)) return
  const arr = props.modelValue.slice()
  arr[i] = n
  emit('update:modelValue', arr)
}
</script>

<template>
  <div class="flex min-w-0 items-center gap-1" @focusin="emit('focus')">
    <label v-for="(l, i) in labels" :key="l" class="flex min-w-0 items-center gap-0.5" v-tip="tips[l] || l">
      <span class="text-[10px] text-zinc-500">{{ l }}</span>
      <input type="number" step="any" class="inp w-16" :value="modelValue[i]" @change="set(i, $event.target.value)" />
    </label>
    <span class="ml-1 whitespace-nowrap text-[10px] text-zinc-500">{{ Math.round(Math.abs(modelValue[2] - modelValue[0])) }}×{{ Math.round(Math.abs(modelValue[3] - modelValue[1])) }}</span>
  </div>
</template>
