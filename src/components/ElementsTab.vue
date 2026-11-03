<script setup>
// Elements of the current page: content-stream element tree, annotations and resources.
import { computed, ref, watch, nextTick, onBeforeUnmount, provide } from 'vue'
import { store, ctx, mutate, locate, locateRef, notify, download, baseName } from '../core/store.js'
import { listPages, analyzePage, writePageOps, writePageContent, inherited, makeEnv, normRect, fontDictByName } from '../core/pages.js'
import { fontInfo, decodeText } from '../core/fonts.js'
import { buildTree, walkTree, nodeBox, opFocusBox, opToString, opToDisplay, tokBytes, guessText, tokToString, TEXT_SHOW, parseContent } from '../core/contentStream.js'
import {
  N, deref, nameStr, numArray, numVal, PDFArray, PDFDict, PDFRef, PDFStream, PDFNumber, cloneObj, stringText,
  fmtBytes, fmtNum, latin1, fromLatin1,
} from '../core/pdfobj.js'
import { imageInfo, imageBlob, fontFileOf, isImageXObject } from '../core/images.js'
import { decodeStreamAsync } from '../core/pdfobj.js'
import ElementNode from './ElementNode.vue'
import ObjectNode from './ObjectNode.vue'
import GlyphDialog from './GlyphDialog.vue'

const pageCount = computed(() => store.pageCount)
const page = computed(() => { store.rev; return listPages(ctx())[store.currentPage] })

/* ---------- analysis ---------- */
const analysis = computed(() => {
  store.rev
  const p = page.value
  if (!p) return null
  const a = analyzePage(ctx(), p.dict)
  const tree = buildTree(a.ops)
  // stable ids = index paths
  const assign = (n, id) => { n.id = id; if (n.children) n.children.forEach((c, i) => assign(c, id ? `${id}.${i}` : String(i))) }
  assign(tree, '')
  tree.id = 'root'
  return { ...a, tree }
})
const ops = computed(() => analysis.value?.ops || [])
const boxes = computed(() => analysis.value?.boxes || [])
const resources = computed(() => { store.rev; return page.value ? inherited(ctx(), page.value.dict, 'Resources') : null })

const opEnv = makeOpEnv(() => boxes.value, () => resources.value, (box) => locate(store.currentPage, box))
provide('opEnv', opEnv)

const sel = ref(new Set())
const expanded = ref(new Set())
watch(() => store.currentPage, () => { sel.value = new Set(); expanded.value = new Set(); annSel.value = new Set() })

/* ---------- op environment for line editors ---------- */
function makeOpEnv(getBoxes, getRes, loc) {
  return {
    boxes: getBoxes,
    locate: loc,
    font: (name) => { const f = fontDictByName(ctx(), getRes(), name); return f ? fontInfo(ctx(), f) : null },
    fontLabel: (name) => {
      const f = fontDictByName(ctx(), getRes(), name)
      if (!f) return 'Font resource not found'
      const i = fontInfo(ctx(), f)
      return `→ ${i.baseFont || '(no BaseFont)'} · ${i.type}${i.composite ? ' (composite, multi-byte codes)' : ''} · ${i.embedded ? 'embedded' : 'not embedded'}${i.hasToUnicode ? ' · has ToUnicode' : ' · no ToUnicode'}`
    },
    xobject: (name) => {
      const x = resXObject(name)
      if (!x) return 'XObject resource not found'
      if (isImageXObject(ctx(), x.obj)) { const inf = imageInfo(ctx(), x.obj); return `→ Image ${inf.width}×${inf.height} ${inf.colorSpace} ${inf.filters.join(',')} (object ${x.ref?.objectNumber})` }
      return `→ Form XObject (object ${x.ref?.objectNumber})`
    },
  }
}

/* ---------- labels ---------- */
const thumbCache = new Map()
const thumbs = ref({})
async function ensureThumb(name, stream) {
  const key = `${name}:${store.rev}`
  if (thumbCache.has(key)) return
  thumbCache.set(key, true)
  try {
    const info = imageInfo(ctx(), stream)
    if (info.width * info.height > 16e6) return
    const { blob, ext } = await imageBlob(ctx(), stream, true)
    if (!['jpg', 'png'].includes(ext)) return
    if (thumbs.value[name]) URL.revokeObjectURL(thumbs.value[name])
    thumbs.value = { ...thumbs.value, [name]: URL.createObjectURL(blob) }
  } catch { /* ignore */ }
}
onBeforeUnmount(() => Object.values(thumbs.value).forEach((u) => URL.revokeObjectURL(u)))

function fontIsTwoByte(fontName) {
  const res = resources.value
  const fonts = res instanceof PDFDict ? deref(ctx(), res.get(N('Font'))) : null
  const f = fonts instanceof PDFDict ? deref(ctx(), fonts.get(N(fontName))) : null
  return f instanceof PDFDict && nameStr(deref(ctx(), f.get(N('Subtype')))) === 'Type0'
}

function textOf(node) {
  let font = null, size = null, s = ''
  const det = boxes.value.details || []
  for (let i = node.from; i <= node.to; i++) {
    const o = ops.value[i]
    if (!TEXT_SHOW.has(o.op)) continue
    const d = det[i] || {}
    font = d.font || font; size = d.size || size
    const fi = d.font ? opEnv.font(d.font) : null
    const dec = (tok) => {
      const t = fi ? decodeText(fi, tokBytes(tok)) : guessText(tokBytes(tok), false)
      return d.reversed ? [...t].reverse().join('') : t
    }
    const arg = o.op === 'TJ' ? o.args[0] : o.args[o.args.length - 1]
    if (!arg) continue
    let part = ''
    if (arg.t === 'arr') {
      for (const el of arg.v) {
        if (el.t === 'str' || el.t === 'hex') part += dec(el)
        else if (el.t === 'num' && parseFloat(el.v) < -200) part += ' '
      }
    } else part = dec(arg)
    s = d.reversed ? part + s : s + part
    if (o.op === "'" || o.op === '"') s += ' '
    if (s.length > 200) break
  }
  return { s, font, size }
}

function describe(node) {
  const o = ops.value
  switch (node.type) {
    case 'text': {
      const t = textOf(node)
      return { label: t.s.trim() || '(no visible text)', tip: `Text${t.font ? ` · font /${t.font} ${t.size}pt` : ''}\n${t.s}` }
    }
    case 'group': {
      const kinds = new Set()
      walkTree(node, (n) => { if (n !== node && n.type !== 'op') kinds.add(n.type) })
      const t = kinds.has('text') ? textOf(node).s.trim() : ''
      const cm = o.slice(node.from, node.to + 1).find((x) => x.op === 'cm')
      return { label: `Group${kinds.size ? ' · ' + [...kinds].join(', ') : ''}${t ? ' · “' + t.slice(0, 40) + '”' : ''}`, tip: cm ? `First matrix: ${opToDisplay(cm)}` : '' }
    }
    case 'marked': {
      const op = o[node.from]
      return { label: `${op.op} ${op.args.map(tokToString).join(' ')}`, mono: true }
    }
    case 'path': {
      const names = [...new Set(o.slice(node.from, node.to + 1).map((x) => x.op))]
      const b = nodeBox(node, boxes.value)
      return { label: `Path ${names.join(' ')}`, tip: b ? `≈ ${fmtNum(b[2] - b[0])} × ${fmtNum(b[3] - b[1])} pt` : '', mono: false }
    }
    case 'xobject': {
      const name = o[node.from].args[0]?.v
      const xo = resXObject(name)
      if (xo && isImageXObject(ctx(), xo.obj)) {
        const inf = imageInfo(ctx(), xo.obj)
        ensureThumb(name, xo.obj)
        return { label: `/${name} image ${inf.width}×${inf.height} ${inf.colorSpace} ${inf.filters.join(',')} ${fmtBytes(inf.size)}`, thumb: thumbs.value[name], badge: 'img' }
      }
      return { label: `/${name} ${xo ? nameStr(deref(ctx(), xo.obj.dict?.get(N('Subtype')))) || 'XObject' : '(missing resource)'}`, badge: 'form' }
    }
    case 'inline': {
      const d = o[node.from].inline
      const w = d.dict.find(([k]) => k === 'W' || k === 'Width')?.[1]?.v
      const h = d.dict.find(([k]) => k === 'H' || k === 'Height')?.[1]?.v
      return { label: `Inline image ${w}×${h} (${fmtBytes(d.data.length)})` }
    }
    case 'shading': return { label: `Shading ${o[node.from].args.map(tokToString).join(' ')}`, mono: true }
    default: return { label: opToDisplay(o[node.from]), mono: true }
  }
}

function resXObject(name) {
  const res = resources.value
  const xo = res instanceof PDFDict ? deref(ctx(), res.get(N('XObject'))) : null
  if (!(xo instanceof PDFDict) || !name) return null
  const ref = xo.get(N(name))
  const obj = deref(ctx(), ref)
  return obj instanceof PDFStream ? { ref, obj } : null
}

/* ---------- selection & focus ---------- */
function nodeById(id) {
  let found = null
  if (analysis.value) walkTree(analysis.value.tree, (n) => { if (n.id === id) found = n })
  return found
}
function select(node, e) {
  const s = new Set(e && (e.ctrlKey || e.metaKey || e.shiftKey) ? sel.value : [])
  if (e && (e.ctrlKey || e.metaKey) && s.has(node.id)) s.delete(node.id)
  else s.add(node.id)
  sel.value = s
  focusNode(node)
}
function toggle(node) {
  const s = new Set(expanded.value)
  s.has(node.id) ? s.delete(node.id) : s.add(node.id)
  expanded.value = s
}
function focusNode(node) {
  const b = node.type === 'op' ? opFocusBox(boxes.value, node.from) : nodeBox(node, boxes.value)
  locate(store.currentPage, b)
}
function focusOp(i) {
  locate(store.currentPage, opFocusBox(boxes.value, i))
}

// click in preview → select the smallest element containing the point
watch(() => store.pick, async (p) => {
  if (!p || p.page !== store.currentPage || store.tab !== 'elements' || !analysis.value) return
  let best = null, bestArea = Infinity, bestPath = []
  const visit = (n, path) => {
    if (n.id !== 'root') {
      const b = nodeBox(n, boxes.value)
      if (b && p.x >= b[0] - 2 && p.x <= b[2] + 2 && p.y >= b[1] - 2 && p.y <= b[3] + 2) {
        const area = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]))
        if (area <= bestArea) { best = n; bestArea = area; bestPath = path }
      }
    }
    if (n.children) n.children.forEach((c) => visit(c, [...path, n.id]))
  }
  visit(analysis.value.tree, [])
  if (!best) return
  const ex = new Set(expanded.value)
  bestPath.forEach((id) => ex.add(id))
  expanded.value = ex
  sel.value = new Set([best.id])
  focusNode(best)
  await nextTick()
  document.querySelector(`[data-node="${best.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
})

/* ---------- rebuilding ---------- */
function emitNode(node, transform, out) {
  const o = ops.value
  if (!node.children) { for (let i = node.from; i <= node.to; i++) out.push(o[i]); return }
  if (node.id !== 'root') out.push(o[node.from])
  const kids = transform ? transform(node, node.children) : node.children
  for (const k of kids) {
    if (k.raw) out.push(...k.raw)
    else emitNode(k, transform, out)
  }
  if (node.id !== 'root' && !node.unclosed && node.to > node.from) out.push(o[node.to])
}
function rebuild(label, transform) {
  const out = []
  emitNode(analysis.value.tree, transform, out)
  mutate(label, (c) => writePageOps(c, listPages(c)[store.currentPage].dict, out))
}
function effectiveSel() {
  // drop nodes whose ancestor is also selected
  const ids = [...sel.value]
  return new Set(ids.filter((id) => !ids.some((o) => o !== id && id.startsWith(o + '.'))))
}

const dx = ref(0)
const dy = ref(0)
function actDuplicate() {
  const s = effectiveSel()
  if (!s.size) return
  const offset = +dx.value || +dy.value
  rebuild(`Duplicate ${s.size} element(s)`, (parent, kids) => {
    const chosen = kids.filter((k) => s.has(k.id))
    if (!chosen.length) return kids
    const last = kids.indexOf(chosen[chosen.length - 1])
    const copies = []
    for (const k of chosen) {
      const segment = []
      emitNode(k, null, segment)
      if (offset && parent.type !== 'text') {
        copies.push({ raw: [{ op: 'q', args: [] }, { op: 'cm', args: ['1', '0', '0', '1', String(+dx.value || 0), String(+dy.value || 0)].map((v) => ({ t: 'num', v })) }, ...segment, { op: 'Q', args: [] }] })
      } else copies.push({ raw: segment })
    }
    const res = kids.slice()
    res.splice(last + 1, 0, ...copies)
    return res
  })
  if (offset && [...s].some((id) => nodeById(id.split('.').slice(0, -1).join('.'))?.type === 'text')) notify('Offset is not applied inside text objects (q/cm are not allowed there)', 'warn')
}
function actDelete() {
  const s = effectiveSel()
  if (!s.size) return
  rebuild(`Delete ${s.size} element(s)`, (parent, kids) => kids.filter((k) => !s.has(k.id)))
  sel.value = new Set()
}
function actMove(delta) {
  const s = effectiveSel()
  if (!s.size) return
  const newSel = new Set()
  rebuild(`Move element(s) ${delta < 0 ? 'up' : 'down'}`, (parent, kids) => {
    const arr = kids.slice()
    const flags = arr.map((k) => s.has(k.id))
    const idx = [...arr.keys()]
    if (delta < 0) {
      for (let i = 1; i < arr.length; i++) if (flags[i] && !flags[i - 1]) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];[flags[i - 1], flags[i]] = [flags[i], flags[i - 1]];[idx[i - 1], idx[i]] = [idx[i], idx[i - 1]] }
    } else {
      for (let i = arr.length - 2; i >= 0; i--) if (flags[i] && !flags[i + 1]) { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];[flags[i + 1], flags[i]] = [flags[i], flags[i + 1]];[idx[i + 1], idx[i]] = [idx[i], idx[i + 1]] }
    }
    arr.forEach((k, i) => { if (s.has(k.id)) newSel.add(parent.id === 'root' ? String(i) : `${parent.id}.${i}`) })
    return arr
  })
  sel.value = newSel
}
function actZ(front) {
  const s = effectiveSel()
  if (!s.size) return
  const newSel = new Set()
  rebuild(front ? 'Bring to front' : 'Send to back', (parent, kids) => {
    const chosen = kids.filter((k) => s.has(k.id))
    if (!chosen.length) return kids
    const rest = kids.filter((k) => !s.has(k.id))
    const arr = front ? [...rest, ...chosen] : [...chosen, ...rest]
    arr.forEach((k, i) => { if (s.has(k.id)) newSel.add(parent.id === 'root' ? String(i) : `${parent.id}.${i}`) })
    return arr
  })
  sel.value = newSel
}
function replaceOp(i, repl) {
  const arr = ops.value.slice()
  arr.splice(i, 1, ...repl)
  mutate(`Edit operation #${i}`, (c) => writePageOps(c, listPages(c)[store.currentPage].dict, arr))
}

/* ---------- export ---------- */
function selectedNodes() {
  const s = effectiveSel()
  const out = []
  if (analysis.value) walkTree(analysis.value.tree, (n) => { if (s.has(n.id)) out.push(n) })
  return out.length ? out : analysis.value.tree.children
}
function nodeJSON(n) {
  const seg = []
  emitNode(n, null, seg)
  const b = nodeBox(n, boxes.value)
  const res = { type: n.type, opRange: [n.from, n.to], bbox: b ? b.map((x) => +x.toFixed(3)) : null }
  if (n.type === 'text' || n.type === 'group') res.text = textOf(n).s
  if (n.type === 'xobject') res.xobject = ops.value[n.from].args[0]?.v
  res.operations = seg.map((o) => (o.inline ? { op: 'BI', dict: Object.fromEntries(o.inline.dict.map(([k, v]) => [k, tokToString(v)])), dataLength: o.inline.data.length } : { op: o.op, operands: o.args.map(tokToString) }))
  res.source = seg.map((o) => opToDisplay(o)).join('\n')
  return res
}
function exportSel(fmt) {
  const nodes = selectedNodes()
  const name = `${baseName()}-p${store.currentPage + 1}-elements`
  if (fmt === 'json') download(JSON.stringify({ page: store.currentPage + 1, elements: nodes.map(nodeJSON) }, null, 2), name + '.json', 'application/json')
  else {
    const seg = []
    for (const n of nodes) emitNode(n, null, seg)
    download(fromLatin1(seg.map(opToString).join('\n') + '\n'), name + '.txt', 'text/plain')
  }
}

/* ---------- raw editor ---------- */
const rawOpen = ref(false)
const rawText = ref('')
watch([rawOpen, () => store.rev, () => store.currentPage], () => {
  if (!rawOpen.value || !page.value) return
  const { ops: o } = analysis.value
  rawText.value = o.map(opToString).join('\n')
}, { immediate: true })
function saveRaw() {
  mutate('Edit page content (raw)', (c) => writePageContent(c, listPages(c)[store.currentPage].dict, fromLatin1(rawText.value + '\n')))
}

/* ---------- annotations ---------- */
const annots = computed(() => {
  store.rev
  const p = page.value
  if (!p) return []
  const c = ctx()
  const arr = deref(c, p.dict.get(N('Annots')))
  if (!(arr instanceof PDFArray)) return []
  return arr.asArray().map((r, i) => {
    const d = deref(c, r)
    if (!(d instanceof PDFDict)) return { i, ref: r instanceof PDFRef ? r : null, subtype: '?', rect: null, text: '' }
    const rect = numArray(c, d.get(N('Rect')))
    const contents = d.get(N('Contents')) ? stringText(deref(c, d.get(N('Contents')))) : ''
    const t = d.get(N('T')) ? stringText(deref(c, d.get(N('T')))) : ''
    const act = deref(c, d.get(N('A')))
    const uri = act instanceof PDFDict && act.get(N('URI')) ? stringText(deref(c, act.get(N('URI')))) : ''
    return { i, ref: r instanceof PDFRef ? r : null, subtype: nameStr(deref(c, d.get(N('Subtype')))) || '?', rect: rect ? normRect(rect) : null, text: contents || uri || t }
  })
})
const annSel = ref(new Set())
const annOpen = ref(new Set())
function annToggleSel(i) { const s = new Set(annSel.value); s.has(i) ? s.delete(i) : s.add(i); annSel.value = s }
function annToggleOpen(i) { const s = new Set(annOpen.value); s.has(i) ? s.delete(i) : s.add(i); annOpen.value = s }
function annFocus(a) { if (a.rect) locate(store.currentPage, a.rect); else if (a.ref) locateRef(a.ref) }
function withAnnots(label, fn) {
  mutate(label, (c) => {
    const p = listPages(c)[store.currentPage]
    let arr = p.dict.get(N('Annots'))
    let a = deref(c, arr)
    if (!(a instanceof PDFArray)) { a = PDFArray.withContext(c); p.dict.set(N('Annots'), a) }
    fn(c, a, p)
  })
}
function annDuplicate() {
  const s = [...annSel.value].sort((x, y) => x - y)
  if (!s.length) return
  withAnnots(`Duplicate ${s.length} annotation(s)`, (c, a, p) => {
    const copies = []
    for (const i of s) {
      const src = deref(c, a.get(i))
      if (!(src instanceof PDFDict)) continue
      const copy = cloneObj(src, c)
      copy.delete(N('Popup'))
      copy.delete(N('Parent'))
      copy.delete(N('NM'))
      if (p.ref) copy.set(N('P'), p.ref)
      const r = numArray(c, copy.get(N('Rect')))
      if (r && (+dx.value || +dy.value)) copy.set(N('Rect'), c.obj([r[0] + +dx.value, r[1] + +dy.value, r[2] + +dx.value, r[3] + +dy.value].map((v) => PDFNumber.of(v))))
      copies.push(c.register(copy))
    }
    const last = s[s.length - 1]
    copies.forEach((r, k) => a.insert(last + 1 + k, r))
    if (copies.some((r) => nameStr(deref(c, deref(c, r).get(N('Subtype')))) === 'Widget')) notify('Duplicated widgets are not added to the AcroForm field list', 'warn', 5000)
  })
}
function annMove(delta) {
  const s = annSel.value
  if (!s.size) return
  const ns = new Set()
  withAnnots('Reorder annotations', (c, a) => {
    const arr = a.asArray().slice()
    const idx = [...arr.keys()]
    const flags = idx.map((i) => s.has(i))
    const swap = (i, j) => { [arr[i], arr[j]] = [arr[j], arr[i]];[flags[i], flags[j]] = [flags[j], flags[i]] }
    if (delta < 0) { for (let i = 1; i < arr.length; i++) if (flags[i] && !flags[i - 1]) swap(i, i - 1) }
    else { for (let i = arr.length - 2; i >= 0; i--) if (flags[i] && !flags[i + 1]) swap(i, i + 1) }
    arr.forEach((v, i) => { a.set(i, v); if (flags[i]) ns.add(i) })
  })
  annSel.value = ns
}
function annDelete() {
  const s = [...annSel.value].sort((x, y) => y - x)
  if (!s.length) return
  withAnnots(`Delete ${s.length} annotation(s)`, (c, a) => {
    for (const i of s) {
      const r = a.get(i)
      a.remove(i)
      const d = deref(c, r)
      if (r instanceof PDFRef && d instanceof PDFDict && nameStr(deref(c, d.get(N('Subtype')))) !== 'Widget') {
        const pop = d.get(N('Popup'))
        c.delete(r)
        if (pop instanceof PDFRef) {
          for (let k = a.size() - 1; k >= 0; k--) if (a.get(k) === pop) a.remove(k)
          c.delete(pop)
        }
      }
    }
  })
  annSel.value = new Set()
}

/* ---------- resources ---------- */
const xobjects = computed(() => {
  store.rev
  const c = ctx()
  const res = resources.value
  const xo = res instanceof PDFDict ? deref(c, res.get(N('XObject'))) : null
  if (!(xo instanceof PDFDict)) return []
  return xo.entries().map(([k, ref]) => {
    const o = deref(c, ref)
    const name = k.decodeText()
    if (!(o instanceof PDFStream)) return { name, ref, missing: true }
    const img = isImageXObject(c, o)
    if (img) ensureThumb(name, o)
    return { name, ref, img, info: img ? imageInfo(c, o) : null, subtype: nameStr(deref(c, o.dict.get(N('Subtype')))) }
  })
})
const fonts = computed(() => {
  store.rev
  const c = ctx()
  const res = resources.value
  const fo = res instanceof PDFDict ? deref(c, res.get(N('Font'))) : null
  if (!(fo instanceof PDFDict)) return []
  return fo.entries().map(([k, ref]) => {
    const f = deref(c, ref)
    if (!(f instanceof PDFDict)) return { name: k.decodeText(), ref }
    return {
      name: k.decodeText(), ref,
      base: nameStr(deref(c, f.get(N('BaseFont')))) || '',
      subtype: nameStr(deref(c, f.get(N('Subtype')))) || '',
      file: fontFileOf(c, f),
      info: fontInfo(c, f),
    }
  })
})
function focusXObject(x) {
  const i = ops.value.findIndex((o) => o.op === 'Do' && o.args[0]?.v === x.name)
  if (i >= 0) locate(store.currentPage, boxes.value[i])
}
async function exportXObject(x, png) {
  const o = deref(ctx(), x.ref)
  const { blob, ext } = await imageBlob(ctx(), o, png)
  download(blob, `${baseName()}-p${store.currentPage + 1}-${x.name}.${ext}`)
}
async function exportFont(f) {
  const d = await decodeStreamAsync(ctx(), f.file.stream)
  download(d.bytes, `${baseName()}-${(f.base || f.name).replace(/[^\w.+-]/g, '_')}.${f.file.ext}`)
}
const glyphFont = ref(null)
const objOpen = ref(new Set())
function toggleObj(key) { const s = new Set(objOpen.value); s.has(key) ? s.delete(key) : s.add(key); objOpen.value = s }
</script>

<template>
  <div v-if="page" class="p-2">
    <!-- page selector & toolbar -->
    <div class="sticky top-0 z-10 -mx-2 -mt-2 mb-2 border-b border-zinc-800 bg-zinc-900/95 px-2 py-1.5 backdrop-blur">
      <div class="flex flex-wrap items-center gap-1">
        <button class="btn btn-icon" :disabled="store.currentPage <= 0" @click="store.currentPage--">‹</button>
        <span class="text-xs text-zinc-300">Page</span>
        <input type="number" min="1" :max="pageCount" class="inp w-14" :value="store.currentPage + 1" @change="store.currentPage = Math.min(pageCount, Math.max(1, +$event.target.value)) - 1" />
        <span class="text-xs text-zinc-500">/ {{ pageCount }}</span>
        <button class="btn btn-icon" :disabled="store.currentPage >= pageCount - 1" @click="store.currentPage++">›</button>
        <span class="ml-1 text-[11px] text-zinc-500">{{ ops.length }} ops · {{ fmtBytes(analysis.size) }}</span>
        <div class="flex-1" />
        <button class="btn" :class="{ 'border-cyan-600 text-cyan-300': rawOpen }" v-tip="'Edit the whole decoded content stream as text'" @click="rawOpen = !rawOpen">Raw</button>
      </div>
      <div class="mt-1 flex flex-wrap items-center gap-1">
        <span class="text-[11px]" :class="sel.size ? 'text-cyan-300' : 'text-zinc-500'">{{ sel.size ? `${sel.size} selected` : 'No selection' }}</span>
        <button class="btn" :disabled="!sel.size" v-tip="'Move up = draw earlier (further back)'" @click="actMove(-1)">▲</button>
        <button class="btn" :disabled="!sel.size" v-tip="'Move down = draw later (further front)'" @click="actMove(1)">▼</button>
        <button class="btn" :disabled="!sel.size" v-tip="'Send to back (first among siblings)'" @click="actZ(false)">⤒</button>
        <button class="btn" :disabled="!sel.size" v-tip="'Bring to front (last among siblings)'" @click="actZ(true)">⤓</button>
        <button class="btn" :disabled="!sel.size" v-tip="'Duplicate the selected elements (inserted after the last selected). Optional offset in points.'" @click="actDuplicate">Duplicate</button>
        <label class="flex items-center gap-0.5 text-[10px] text-zinc-500" v-tip="'Horizontal offset for duplicates (points)'">dx<input v-model="dx" type="number" step="any" class="inp w-12" /></label>
        <label class="flex items-center gap-0.5 text-[10px] text-zinc-500" v-tip="'Vertical offset for duplicates (points)'">dy<input v-model="dy" type="number" step="any" class="inp w-12" /></label>
        <button class="btn btn-danger" :disabled="!sel.size" @click="actDelete">Delete</button>
        <div class="flex-1" />
        <button class="btn" v-tip="'Export selected elements (or all) as PDF content syntax'" @click="exportSel('txt')">⇩ txt</button>
        <button class="btn" v-tip="'Export selected elements (or all) as JSON (operators, bounding boxes, text)'" @click="exportSel('json')">⇩ json</button>
        <button v-if="sel.size" class="btn" @click="sel = new Set()">Clear</button>
      </div>
    </div>

    <div v-if="analysis.errors.length" class="mb-2 rounded border border-amber-800 bg-amber-950/50 p-2 text-xs text-amber-200">{{ analysis.errors.join('; ') }}</div>

    <div v-if="rawOpen" class="mb-3">
      <textarea v-model="rawText" spellcheck="false" class="inp h-80 w-full resize-y whitespace-pre font-mono text-[11px] leading-snug" />
      <div class="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
        Saving replaces the page's content stream(s) with one stream (Flate-compressed if the original was).
        <div class="flex-1" />
        <button class="btn btn-primary" @click="saveRaw">Save content</button>
      </div>
    </div>

    <div class="section-title">Content <span class="font-normal normal-case text-zinc-500">· click an element in the preview to find it</span></div>
    <div class="rounded-md border border-zinc-800 bg-zinc-900/60 py-1">
      <ElementNode
        v-for="n in analysis.tree.children.slice(0, 500)" :key="n.id"
        :node="n" :ops="ops" :sel="sel" :expanded="expanded" :describe="describe" :rev="store.rev"
        @select="select" @toggle="toggle" @replace-op="replaceOp" @focus-node="focusNode" @focus-op="focusOp"
      />
      <div v-if="analysis.tree.children.length > 500" class="p-2 text-[11px] text-zinc-500">… {{ analysis.tree.children.length - 500 }} more top-level elements (use Raw)</div>
      <div v-if="!ops.length" class="p-2 text-xs text-zinc-500">This page has no content.</div>
    </div>

    <!-- annotations -->
    <div class="section-title">Annotations <span class="font-normal normal-case text-zinc-500">({{ annots.length }}) · order = drawing order</span></div>
    <div v-if="annots.length" class="rounded-md border border-zinc-800 bg-zinc-900/60">
      <div class="flex flex-wrap items-center gap-1 border-b border-zinc-800 p-1">
        <span class="text-[11px]" :class="annSel.size ? 'text-cyan-300' : 'text-zinc-500'">{{ annSel.size ? `${annSel.size} selected` : 'Select annotations' }}</span>
        <div class="flex-1" />
        <button class="btn" :disabled="!annSel.size" @click="annMove(-1)">▲</button>
        <button class="btn" :disabled="!annSel.size" @click="annMove(1)">▼</button>
        <button class="btn" :disabled="!annSel.size" v-tip="'Duplicate as new annotation objects (uses dx/dy offset from the toolbar)'" @click="annDuplicate">Duplicate</button>
        <button class="btn btn-danger" :disabled="!annSel.size" @click="annDelete">Delete</button>
      </div>
      <div v-for="a in annots" :key="a.i + ':' + (a.ref?.objectNumber ?? 'd')" class="border-b border-zinc-800/60 last:border-0">
        <div class="flex items-center gap-1.5 px-1 py-1 text-xs hover:bg-zinc-700/30" :class="{ 'row-sel': annSel.has(a.i) }" tabindex="0" @focus="annFocus(a)" @click="annFocus(a)">
          <input type="checkbox" :checked="annSel.has(a.i)" @click.stop="annToggleSel(a.i)" />
          <button class="w-4 text-zinc-500" @click.stop="annToggleOpen(a.i)">{{ annOpen.has(a.i) ? '▾' : '▸' }}</button>
          <span class="tag bg-yellow-900/60 text-yellow-200">{{ a.subtype }}</span>
          <span class="min-w-0 flex-1 truncate text-zinc-300" dir="auto">{{ a.text }}</span>
          <span class="font-mono text-[10px] text-zinc-500">{{ a.rect ? a.rect.map((v) => Math.round(v)).join(' ') : '' }}</span>
          <span class="font-mono text-[10px] text-violet-300/70">{{ a.ref ? a.ref.objectNumber + ' 0 R' : 'direct' }}</span>
        </div>
        <div v-if="annOpen.has(a.i) && a.ref" class="pb-1">
          <ObjectNode :owner="a.ref" :path="[]" start-open :removable="false" :depth="1" />
        </div>
      </div>
    </div>
    <div v-else class="text-xs text-zinc-500">No annotations on this page.</div>

    <!-- resources -->
    <div class="section-title">XObjects <span class="font-normal normal-case text-zinc-500">({{ xobjects.length }})</span></div>
    <div v-if="xobjects.length" class="space-y-1">
      <div v-for="x in xobjects" :key="x.name" class="rounded border border-zinc-800 bg-zinc-900/60">
        <div class="flex items-center gap-2 p-1.5 text-xs" tabindex="0" @focus="focusXObject(x)" @click="focusXObject(x)">
          <button class="w-4 text-zinc-500" @click.stop="toggleObj('x' + x.name)">{{ objOpen.has('x' + x.name) ? '▾' : '▸' }}</button>
          <img v-if="x.img && thumbs[x.name]" :src="thumbs[x.name]" class="h-8 w-8 rounded-sm bg-white object-contain" alt="" />
          <div class="min-w-0 flex-1">
            <div class="font-mono text-zinc-200">/{{ x.name }} <span class="text-violet-300/70">{{ x.ref?.objectNumber }} 0 R</span></div>
            <div class="truncate text-[11px] text-zinc-500">
              <template v-if="x.missing">missing object</template>
              <template v-else-if="x.img">Image {{ x.info.width }}×{{ x.info.height }} · {{ x.info.bpc }} bpc · {{ x.info.colorSpace }} · {{ x.info.filters.join(', ') || 'raw' }} · {{ fmtBytes(x.info.size) }}</template>
              <template v-else>{{ x.subtype }}</template>
            </div>
          </div>
          <template v-if="x.img">
            <button class="btn" v-tip="'Export in the original encoding (JPEG → .jpg, JPEG 2000 → .jp2, JBIG2 → .jb2); raw pixel data is exported as PNG'" @click.stop="exportXObject(x, false)">Export</button>
            <button class="btn" v-tip="'Export as PNG (if decodable by the browser)'" @click.stop="exportXObject(x, true)">PNG</button>
          </template>
        </div>
        <div v-if="objOpen.has('x' + x.name) && x.ref instanceof PDFRef" class="pb-1">
          <ObjectNode :owner="x.ref" :path="[]" start-open :removable="false" :depth="1" />
        </div>
      </div>
    </div>
    <div v-else class="text-xs text-zinc-500">No XObjects.</div>

    <div class="section-title">Fonts <span class="font-normal normal-case text-zinc-500">({{ fonts.length }})</span></div>
    <div v-if="fonts.length" class="space-y-1">
      <div v-for="f in fonts" :key="f.name" class="rounded border border-zinc-800 bg-zinc-900/60">
        <div class="flex items-center gap-2 p-1.5 text-xs">
          <button class="w-4 text-zinc-500" @click.stop="toggleObj('f' + f.name)">{{ objOpen.has('f' + f.name) ? '▾' : '▸' }}</button>
          <span class="font-mono text-zinc-200">/{{ f.name }}</span>
          <span class="min-w-0 flex-1 truncate text-zinc-400">{{ f.base }} <span class="text-zinc-600">{{ f.subtype }}</span></span>
          <span v-if="f.file" class="tag bg-emerald-900/60 text-emerald-300">embedded</span>
          <span v-else class="tag bg-zinc-800 text-zinc-500">not embedded</span>
          <button class="btn" v-tip="'Show the glyphs of this font: export outlines as SVG, copy codes'" @click="glyphFont = f">Glyphs</button>
          <button v-if="f.file" class="btn" v-tip="`Export the embedded font program (${f.file.label}) as .${f.file.ext}`" @click="exportFont(f)">Export</button>
        </div>
        <div v-if="objOpen.has('f' + f.name) && f.ref instanceof PDFRef" class="pb-1">
          <ObjectNode :owner="f.ref" :path="[]" start-open :removable="false" :depth="1" />
        </div>
      </div>
    </div>
    <div v-else class="text-xs text-zinc-500">No fonts.</div>
    <GlyphDialog v-if="glyphFont" :page-index="store.currentPage" :font="glyphFont" @close="glyphFont = null" />
  </div>
  <div v-else class="p-4 text-sm text-zinc-500">No page selected.</div>
</template>
