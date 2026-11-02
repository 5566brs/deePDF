<script setup>
// XMP metadata (RDF/XML) editor: structured property list + raw XML.
import { computed, ref, watch } from 'vue'
import { store, ctx, mutate, notify } from '../core/store.js'
import { decodeStream, setStreamData, filtersOf, PDFStream } from '../core/pdfobj.js'
import { parseIsoDate } from '../core/pdfDate.js'
import DateInput from './DateInput.vue'

const props = defineProps({ streamRef: Object, info: Object })

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const PROP_DOCS = {
  'dc:title': 'Document title (language alternatives).',
  'dc:creator': 'Authors (ordered list).',
  'dc:description': 'Description / subject (language alternatives).',
  'dc:subject': 'Keywords (unordered bag).',
  'dc:format': 'MIME type of the document (application/pdf).',
  'dc:rights': 'Copyright / usage rights statement.',
  'xmp:CreateDate': 'Date the document was created.',
  'xmp:ModifyDate': 'Date the document was last modified.',
  'xmp:MetadataDate': 'Date the metadata was last changed.',
  'xmp:CreatorTool': 'Application that created the original document (≙ Info /Creator).',
  'pdf:Producer': 'Application that produced the PDF (≙ Info /Producer).',
  'pdf:Keywords': 'Keywords (≙ Info /Keywords).',
  'pdf:PDFVersion': 'PDF version.',
  'pdf:Trapped': 'Trapping status (≙ Info /Trapped).',
  'xmpMM:DocumentID': 'Unique identifier of the document (all versions).',
  'xmpMM:InstanceID': 'Unique identifier of this version of the document.',
  'pdfaid:part': 'PDF/A conformance part (1, 2, 3, 4).',
  'pdfaid:conformance': 'PDF/A conformance level (A, B, U).',
}

const xmlText = ref('')
const dirty = ref(false)
const parseError = ref('')
const rawMode = ref(false)

function load() {
  const s = ctx().lookup(props.streamRef)
  if (!(s instanceof PDFStream)) { xmlText.value = ''; return }
  const d = decodeStream(ctx(), s)
  xmlText.value = new TextDecoder('utf-8').decode(d.bytes)
  dirty.value = false
}
watch(() => [store.rev, props.streamRef], load, { immediate: true })

const dom = computed(() => {
  const body = xmlText.value.replace(/^﻿/, '')
  try {
    const doc = new DOMParser().parseFromString(body, 'application/xml')
    const err = doc.getElementsByTagName('parsererror')[0]
    parseError.value = err ? err.textContent.split('\n')[0] : ''
    return err ? null : doc
  } catch (e) { parseError.value = String(e); return null }
})

/** Flatten properties: { id, name, kind: 'attr'|'text'|'li', node, value, lang } */
const propsList = computed(() => {
  const doc = dom.value
  if (!doc) return []
  const out = []
  let seq = 0
  for (const desc of doc.getElementsByTagNameNS(RDF, 'Description')) {
    for (const a of [...desc.attributes]) {
      if (a.name.startsWith('xmlns') || a.namespaceURI === RDF) continue
      out.push({ id: seq++, name: a.name, kind: 'attr', node: a, value: a.value })
    }
    for (const el of [...desc.children]) {
      const container = [...el.children].find((c) => c.namespaceURI === RDF && ['Alt', 'Seq', 'Bag'].includes(c.localName))
      if (container) {
        const lis = [...container.children].filter((c) => c.localName === 'li')
        lis.forEach((li, k) => {
          if (li.children.length) return
          out.push({ id: seq++, name: el.tagName, kind: 'li', node: li, value: li.textContent, lang: li.getAttribute('xml:lang'), container: container.localName, idx: k, count: lis.length })
        })
        if (!lis.length) out.push({ id: seq++, name: el.tagName, kind: 'empty', node: container, value: '', container: container.localName })
      } else if (!el.children.length) {
        out.push({ id: seq++, name: el.tagName, kind: 'text', node: el, value: el.textContent })
      } else {
        out.push({ id: seq++, name: el.tagName, kind: 'complex', node: el, value: `(${el.children.length} nested elements – edit in raw XML)` })
      }
    }
  }
  return out
})

const isDateProp = (p) => /Date$/.test(p.name) || (!!parseIsoDate(p.value) && /^\d{4}-\d{2}/.test(p.value))

function serialize(doc) {
  let s = new XMLSerializer().serializeToString(doc)
  if (!s.startsWith('<?xpacket') && /^<\?xml/.test(s)) s = s.replace(/^<\?xml[^>]*\?>\s*/, '')
  return s
}
function setProp(p, v) {
  if (p.kind === 'attr') p.node.value = v
  else if (p.kind === 'empty') {
    const li = p.node.ownerDocument.createElementNS(RDF, 'rdf:li')
    if (p.container === 'Alt') li.setAttribute('xml:lang', 'x-default')
    li.textContent = v
    p.node.appendChild(li)
  } else p.node.textContent = v
  xmlText.value = serialize(dom.value)
  dirty.value = true
}
function addLi(p) {
  const li = p.node.ownerDocument.createElementNS(RDF, 'rdf:li')
  li.textContent = ''
  p.node.parentNode.appendChild(li)
  xmlText.value = serialize(dom.value)
  dirty.value = true
}
function removeProp(p) {
  if (p.kind === 'attr') p.node.ownerElement.removeAttributeNode(p.node)
  else if (p.kind === 'li') p.node.remove()
  else if (p.kind === 'empty') p.node.parentNode.remove()
  else p.node.remove()
  xmlText.value = serialize(dom.value)
  dirty.value = true
}

function ensureProp(doc, desc, qname, ns, value, container) {
  let el = [...desc.children].find((c) => c.tagName === qname)
  const attr = desc.getAttributeNode(qname)
  if (attr && !container) { attr.value = value; return }
  if (attr) desc.removeAttributeNode(attr)
  if (!el) { el = doc.createElementNS(ns, qname); desc.appendChild(el) }
  if (container) {
    el.textContent = ''
    const c = doc.createElementNS(RDF, 'rdf:' + container)
    const values = Array.isArray(value) ? value : [value]
    for (const v of values) {
      const li = doc.createElementNS(RDF, 'rdf:li')
      if (container === 'Alt') li.setAttribute('xml:lang', 'x-default')
      li.textContent = v
      c.appendChild(li)
    }
    el.appendChild(c)
  } else el.textContent = value
}
const NS = {
  dc: 'http://purl.org/dc/elements/1.1/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
}
function syncFromInfo() {
  const doc = dom.value
  if (!doc) return
  const desc = doc.getElementsByTagNameNS(RDF, 'Description')[0]
  if (!desc) { notify('No rdf:Description found', 'error'); return }
  for (const [p, uri] of Object.entries(NS)) if (!desc.lookupNamespaceURI(p)) desc.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:' + p, uri)
  const i = props.info || {}
  if (i.Title) ensureProp(doc, desc, 'dc:title', NS.dc, i.Title, 'Alt')
  if (i.Author) ensureProp(doc, desc, 'dc:creator', NS.dc, [i.Author], 'Seq')
  if (i.Subject) ensureProp(doc, desc, 'dc:description', NS.dc, i.Subject, 'Alt')
  if (i.Keywords) ensureProp(doc, desc, 'pdf:Keywords', NS.pdf, i.Keywords)
  if (i.Producer) ensureProp(doc, desc, 'pdf:Producer', NS.pdf, i.Producer)
  if (i.Creator) ensureProp(doc, desc, 'xmp:CreatorTool', NS.xmp, i.Creator)
  if (i.CreationDateIso) ensureProp(doc, desc, 'xmp:CreateDate', NS.xmp, i.CreationDateIso)
  if (i.ModDateIso) ensureProp(doc, desc, 'xmp:ModifyDate', NS.xmp, i.ModDateIso)
  xmlText.value = serialize(doc)
  dirty.value = true
  notify('XMP updated from /Info – remember to save')
}

function save() {
  if (dom.value === null && !confirm('The XML does not parse. Save anyway?')) return
  const bytes = new TextEncoder().encode(xmlText.value)
  mutate('Edit XMP metadata', (c) => {
    const s = c.lookup(props.streamRef)
    setStreamData(c, s, bytes, filtersOf(c, s).length ? 'keep' : 'none')
  })
}
</script>

<template>
  <div class="rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-xs">
    <div class="mb-2 flex flex-wrap items-center gap-1">
      <span class="font-mono text-violet-300/80">{{ streamRef.objectNumber }} 0 R</span>
      <span v-if="parseError" class="text-red-300">XML error: {{ parseError }}</span>
      <div class="flex-1" />
      <button class="btn" :class="{ 'border-cyan-600 text-cyan-300': rawMode }" @click="rawMode = !rawMode">Raw XML</button>
      <button class="btn" v-tip="'Copy Title, Author, Subject, Keywords, Creator, Producer and dates from /Info into XMP so both agree'" @click="syncFromInfo">Sync from /Info</button>
      <button class="btn btn-primary" :disabled="!dirty" @click="save">Save XMP</button>
    </div>
    <textarea v-if="rawMode" v-model="xmlText" spellcheck="false" class="inp h-80 w-full resize-y whitespace-pre font-mono text-[11px]" @input="dirty = true" />
    <div v-else class="space-y-1">
      <div v-for="p in propsList" :key="p.id" class="group flex items-center gap-2">
        <span class="w-40 shrink-0 truncate font-mono text-zinc-200" :class="{ 'underline decoration-zinc-600 decoration-dotted underline-offset-2': PROP_DOCS[p.name] }" v-tip="(PROP_DOCS[p.name] || p.name) + (p.container ? `\n(rdf:${p.container}${p.lang ? ', ' + p.lang : ''})` : '')">
          {{ p.name }}<span v-if="p.kind === 'li' && p.count > 1" class="text-zinc-500">[{{ p.idx + 1 }}]</span>
        </span>
        <DateInput v-if="isDateProp(p) && p.kind !== 'complex'" iso :model-value="p.value" @update:model-value="(v) => setProp(p, v)" />
        <input v-else-if="p.kind !== 'complex'" class="inp min-w-0 flex-1" dir="auto" :value="p.value" @change="setProp(p, $event.target.value)" />
        <span v-else class="flex-1 text-zinc-500">{{ p.value }}</span>
        <button v-if="p.kind === 'li' && (p.container === 'Seq' || p.container === 'Bag')" class="btn btn-icon opacity-0 group-hover:opacity-100" v-tip="'Add another item'" @click="addLi(p)">+</button>
        <button class="btn btn-icon opacity-0 group-hover:opacity-100" v-tip="'Remove'" @click="removeProp(p)">✕</button>
      </div>
      <div v-if="!propsList.length" class="text-zinc-500">No simple properties found{{ dom ? '' : ' (XML does not parse)' }}.</div>
    </div>
  </div>
</template>
