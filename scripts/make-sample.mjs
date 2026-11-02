// Generates a small sample PDF exercising text, images, vector paths, annotations and metadata.
// Usage: node scripts/make-sample.mjs [out.pdf]
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString } from 'pdf-lib'
import { writeFileSync } from 'node:fs'
import zlib from 'node:zlib'

const out = process.argv[2] || 'sample.pdf'
const doc = await PDFDocument.create()
doc.setTitle('deePDF sample')
doc.setAuthor('deePDF')
doc.setSubject('Sample document for testing')
doc.setKeywords(['pdf', 'sample'])
doc.setCreationDate(new Date('2024-01-02T03:04:05Z'))
const font = await doc.embedFont(StandardFonts.Helvetica)
const bold = await doc.embedFont(StandardFonts.HelveticaBold)

// tiny PNG (4x4 gradient) built by hand
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3
    raw[o] = (x * 255) / (w - 1); raw[o + 1] = (y * 255) / (h - 1); raw[o + 2] = 128
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const img = await doc.embedPng(png(16, 16))

for (let p = 1; p <= 3; p++) {
  const page = doc.addPage([595, 842])
  page.drawText(`Page ${p} – deePDF sample`, { x: 50, y: 780, size: 24, font: bold, color: rgb(0.1, 0.2, 0.5) })
  page.drawText('Low-level editing of PDF objects, streams and metadata.', { x: 50, y: 740, size: 12, font })
  page.drawRectangle({ x: 50, y: 500, width: 200, height: 150, color: rgb(0.9, 0.5, 0.2), borderColor: rgb(0, 0, 0), borderWidth: 2 })
  page.drawCircle({ x: 400, y: 575, size: 70, color: rgb(0.2, 0.7, 0.4) })
  page.drawImage(img, { x: 50, y: 250, width: 200, height: 200 })
  page.drawLine({ start: { x: 50, y: 200 }, end: { x: 545, y: 200 }, thickness: 1 })
  const annot = doc.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [300, 300, 330, 330],
    Contents: PDFString.of(`Note on page ${p}`), Open: false, Name: 'Comment', C: [1, 1, 0],
  })
  const link = doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [50, 735, 400, 755], Border: [0, 0, 1],
    A: { S: 'URI', URI: PDFString.of('https://example.com/') },
  })
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot), doc.context.register(link)]))
}
writeFileSync(out, await doc.save({ useObjectStreams: false }))
console.log('wrote', out)
