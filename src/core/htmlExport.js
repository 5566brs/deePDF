// Print-faithful, self-contained HTML export.
// Each page is one inline <svg>: every vector drawing becomes its own <path>, text becomes <text> using the
// embedded font programs (as @font-face data URIs), raster images stay <image>. The result is verified by
// rasterising the SVG and comparing it pixel-by-pixel with pdf.js' own canvas rendering.
import { richDoc, pdfjs } from './preview.js'
import { SvgRecorder, withRecordingPath2D } from './svgContext.js'
import { remapFont, fontDictIndex } from './fontRemap.js'
import { ctx } from './store.js'

if (typeof Uint8Array.prototype.toBase64 !== 'function') {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Uint8Array.prototype, 'toBase64', {
    value() {
      let s = ''
      for (let i = 0; i < this.length; i += 0x8000) s += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000))
      return btoa(s)
    },
  })
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function renderPageSvg(page, scale, fontCache, index) {
  const vp = page.getViewport({ scale })
  const w = Math.ceil(vp.width), h = Math.ceil(vp.height)
  const rec = new SvgRecorder(w, h)
  await page.render({ canvasContext: rec, viewport: vp, intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE }).promise
  const fontRules = []
  const missingFonts = []
  for (const name of rec.fonts) {
    let font = null
    try { font = page.commonObjs.get(name) } catch { /* not a pdf.js font */ }
    if (!font) continue
    if (!fontCache.has(name)) {
      const remap = remapFont(ctx(), index, font)
      const rule = remap ? remap.rule : font.createFontFaceRule ? font.createFontFaceRule() : null
      fontCache.set(name, { rule, translate: remap ? remap.translate : null, label: font.name || name })
    }
    const fc = fontCache.get(name)
    if (fc.rule) fontRules.push({ name, rule: fc.rule })
    else missingFonts.push(fc.label)
  }
  const vp1 = page.getViewport({ scale: 1 })
  const body = rec.body((family) => fontCache.get(family)?.translate || null)
  const untranslated = rec.items.filter((it) => it.run && !fontCache.get(it.family)?.translate).length
  return { w, h, wPt: vp1.width, hPt: vp1.height, body, fontRules, missingFonts, report: rec.report, untranslated }
}

function standaloneSvg(p, fontCss) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${p.w}" height="${p.h}" viewBox="0 0 ${p.w} ${p.h}"><style>${fontCss}</style>${p.body}</svg>`
}

async function rasterSvg(svg, w, h) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    // give embedded fonts a moment (SVG-as-image loads data: fonts synchronously in Chromium/Firefox)
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const x = c.getContext('2d', { willReadFrequently: true })
    x.fillStyle = '#fff'
    x.fillRect(0, 0, w, h)
    x.drawImage(img, 0, 0, w, h)
    return x.getImageData(0, 0, w, h)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function referenceRaster(page, scale, w, h) {
  const vp = page.getViewport({ scale })
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const x = c.getContext('2d', { willReadFrequently: true })
  x.fillStyle = '#fff'
  x.fillRect(0, 0, w, h)
  await page.render({ canvas: c, canvasContext: x, viewport: vp, intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE }).promise
  return x.getImageData(0, 0, w, h)
}

/** Compare two renderings. Tolerates anti-aliasing (1px neighbourhood). */
function compare(a, b) {
  const { width: w, height: h } = a
  const A = a.data, B = b.data
  const T = 56
  const near = (i, j) => Math.max(Math.abs(A[i] - B[j]), Math.abs(A[i + 1] - B[j + 1]), Math.abs(A[i + 2] - B[j + 2])) <= T
  const isInk = (D, i) => D[i] < 245 || D[i + 1] < 245 || D[i + 2] < 245
  let ink = 0, bad = 0
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 1.5e6))) // sample big pages
  const tw = Math.ceil(w / 4), th = Math.ceil(h / 4)
  const thumb = new ImageData(tw, th)
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4
      const inkHere = isInk(A, i) || isInk(B, i)
      if (inkHere) ink++
      let ok = near(i, i)
      if (!ok) {
        for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1 && !ok; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          if (near(i, (yy * w + xx) * 4)) ok = true
        }
      }
      if (!ok) bad++
      const t = (Math.floor(y / 4) * tw + Math.floor(x / 4)) * 4
      if (!ok) { thumb.data[t] = 230; thumb.data[t + 1] = 30; thumb.data[t + 2] = 30; thumb.data[t + 3] = 255 }
      else if (inkHere && thumb.data[t + 3] === 0) { thumb.data[t] = 120; thumb.data[t + 1] = 120; thumb.data[t + 2] = 120; thumb.data[t + 3] = 120 }
    }
  }
  const c = document.createElement('canvas')
  c.width = tw; c.height = th
  c.getContext('2d').putImageData(thumb, 0, 0)
  return { ink, bad, similarity: ink ? 1 - bad / ink : 1, diffUrl: c.toDataURL('image/png') }
}

/**
 * Build the HTML export.
 * opts: { scale (raster/units resolution), verify (bool), title, onProgress(i, n) }
 * returns { html, pages: [{ index, similarity, report, missingFonts, diffUrl }], summary }
 */
export async function buildHtml(opts = {}) {
  const scale = opts.scale || 2
  const doc = await richDoc()
  const n = doc.numPages
  const pages = []
  const fontCss = new Map()
  const fontCache = new Map()
  const index = fontDictIndex(ctx())
  await withRecordingPath2D(async () => {
    for (let i = 0; i < n; i++) {
      opts.onProgress?.(i, n, 'drawing')
      const page = await doc.getPage(i + 1)
      const p = await renderPageSvg(page, scale, fontCache, index)
      for (const r of p.fontRules) fontCss.set(r.name, r.rule)
      pages.push({ index: i, ...p, page })
    }
  })
  const css = [...fontCss.values()].join('\n')
  if (opts.verify !== false) {
    for (const p of pages) {
      opts.onProgress?.(p.index, n, 'verifying')
      const pageCss = p.fontRules.map((r) => r.rule).join('\n')
      const [mine, ref] = await Promise.all([rasterSvg(standaloneSvg(p, pageCss), p.w, p.h), referenceRaster(p.page, scale, p.w, p.h)])
      Object.assign(p, compare(mine, ref))
    }
  }
  const sizes = [...new Set(pages.map((p) => `${p.wPt.toFixed(2)}x${p.hPt.toFixed(2)}`))]
  const pageRules = sizes.map((s, k) => { const [w, h] = s.split('x'); return `@page s${k} { size: ${w}pt ${h}pt; margin: 0 }\n.page.s${k} { page: s${k} }` }).join('\n')
  const first = sizes[0] ? sizes[0].split('x') : ['595', '842']
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="deePDF">
<title>${esc(opts.title || 'Document')}</title>
<style>
${css}
@page { size: ${first[0]}pt ${first[1]}pt; margin: 0 }
${pageRules}
html, body { margin: 0; padding: 0; background: #e5e5e5; }
.page { position: relative; margin: 16px auto; background: #fff; overflow: hidden; box-shadow: 0 2px 10px rgb(0 0 0 / .25); }
.page > svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
@media print {
  html, body { background: none; }
  .page { margin: 0; box-shadow: none; break-after: page; page-break-after: always; }
  .page:last-child { break-after: auto; page-break-after: auto; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
</style>
</head>
<body>
${pages.map((p) => {
    const k = sizes.indexOf(`${p.wPt.toFixed(2)}x${p.hPt.toFixed(2)}`)
    return `<section class="page s${k}" id="page-${p.index + 1}" style="width:${p.wPt.toFixed(2)}pt;height:${p.hPt.toFixed(2)}pt">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.w} ${p.h}" preserveAspectRatio="none">${p.body}</svg>
</section>`
  }).join('\n')}
</body>
</html>
`
  const summary = {
    pages: n,
    minSimilarity: pages.reduce((m, p) => Math.min(m, p.similarity ?? 1), 1),
    rasterImages: pages.reduce((s, p) => s + p.report.rasterImages, 0),
    patterns: pages.reduce((s, p) => s + p.report.patterns, 0),
    paths: pages.reduce((s, p) => s + p.report.paths, 0),
    texts: pages.reduce((s, p) => s + p.report.texts, 0),
    unsupported: pages.flatMap((p) => [...p.report.unsupported.entries()].map(([k, v]) => `p${p.index + 1}: ${k} ×${v}`)),
    missingFonts: [...new Set(pages.flatMap((p) => p.missingFonts))],
    untranslatedRuns: pages.reduce((s, p) => s + p.untranslated, 0),
    bytes: html.length,
  }
  return {
    html,
    summary,
    pages: pages.map((p) => ({ index: p.index, similarity: p.similarity, diffUrl: p.diffUrl, report: p.report, missingFonts: p.missingFonts })),
  }
}
