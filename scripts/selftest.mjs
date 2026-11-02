// Quick self-test of the core (node): node scripts/selftest.mjs file.pdf
import { readFileSync } from 'node:fs'
import { PDFParser } from 'pdf-lib'
import { listPages, analyzePage, writePageOps, setPageOrder, deletePages } from '../src/core/pages.js'
import { buildTree, opToDisplay } from '../src/core/contentStream.js'
import { exportPdf, validate } from '../src/core/exporter.js'
import { contextToJSON, contextFromJSON } from '../src/core/jsonDesc.js'
import { detectSignatures } from '../src/core/signature.js'
import { extractImage } from '../src/core/images.js'
import { PDFStream, N, deref, nameStr } from '../src/core/pdfobj.js'

const bytes = new Uint8Array(readFileSync(process.argv[2]))
const ctx = await PDFParser.forBytesWithOptions(bytes, 1000, false, false).parseDocument()
const pages = listPages(ctx)
console.log('pages', pages.length, 'objects', ctx.enumerateIndirectObjects().length)
const a = analyzePage(ctx, pages[0].dict)
console.log('ops', a.ops.length, 'errors', a.errors)
const tree = buildTree(a.ops)
for (const n of tree.children) console.log(' ', n.type, n.from, n.to, a.boxes.slice(n.from, n.to + 1).find(Boolean)?.map(Math.round), opToDisplay(a.ops[n.from]).slice(0, 60))
// duplicate first group and write back
const ops2 = [...a.ops, ...a.ops.slice(tree.children[0].from, tree.children[0].to + 1)]
writePageOps(ctx, pages[0].dict, ops2)
console.log('after write ops', analyzePage(ctx, pages[0].dict).ops.length)
setPageOrder(ctx, [pages[2].ref, pages[0].ref, pages[1].ref])
deletePages(ctx, [pages[1].ref])
console.log('pages now', listPages(ctx).map((p) => p.ref.objectNumber))
console.log('sig', detectSignatures(ctx).signed)
for (const [r, o] of ctx.enumerateIndirectObjects()) if (o instanceof PDFStream && nameStr(deref(ctx, o.dict.get(N('Subtype')))) === 'Image') { const e = extractImage(ctx, o); console.log('image', r.objectNumber, e.kind, e.ext, e.bytes.length) }
console.log('validate', validate(ctx).issues.map((i) => i.msg))
for (const objectStreams of [false, true]) for (const compression of ['keep', 'compress', 'decompress']) {
  const r = await exportPdf(ctx, { compression, objectStreams, removeUnused: true, renumber: true, fixDangling: true, stripSignature: true, updateModDate: true })
  console.log('export', objectStreams, compression, r.bytes.length, r.verify.ok, r.verify.checked, r.verify.problems.slice(0, 3))
}
const json = contextToJSON(ctx)
const ctx2 = contextFromJSON(JSON.parse(JSON.stringify(json)))
const r2 = await exportPdf(ctx2, { compression: 'keep', objectStreams: false, removeUnused: false, renumber: false })
console.log('json roundtrip', JSON.stringify(json).length, r2.verify.ok, listPages(ctx2).length)
