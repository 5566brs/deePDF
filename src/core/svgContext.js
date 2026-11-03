// A CanvasRenderingContext2D look-alike that records pdf.js drawing calls as SVG markup.
// pdf.js does all PDF interpretation (fonts, colour spaces, shadings, images); we only translate
// canvas primitives into vector SVG elements.

const f = (n) => {
  if (!isFinite(n)) return '0'
  const r = Math.round(n * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function mul(m, n) { // m · n  (apply n first, then m) for canvas-style [a b c d e f]
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}
function inv(m) {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!det) return null
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
}
const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
const mstr = (m) => `matrix(${m.map(f).join(' ')})`
const isIdentity = (m) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0

/* ---------- recording Path2D ---------- */

const NativePath2D = typeof Path2D !== 'undefined' ? Path2D : class {}
export class RecPath2D extends NativePath2D {
  constructor(arg) {
    super(arg)
    this._cmds = []
    if (arg instanceof RecPath2D) this._cmds = arg._cmds.slice()
    else if (typeof arg === 'string') this._cmds.push(['raw', arg])
  }
  moveTo(x, y) { super.moveTo(x, y); this._cmds.push(['M', x, y]) }
  lineTo(x, y) { super.lineTo(x, y); this._cmds.push(['L', x, y]) }
  bezierCurveTo(a, b, c, d, e, g) { super.bezierCurveTo(a, b, c, d, e, g); this._cmds.push(['C', a, b, c, d, e, g]) }
  quadraticCurveTo(a, b, c, d) { super.quadraticCurveTo(a, b, c, d); this._cmds.push(['Q', a, b, c, d]) }
  closePath() { super.closePath(); this._cmds.push(['Z']) }
  rect(x, y, w, h) { super.rect(x, y, w, h); this._cmds.push(['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']) }
  addPath(p, m) {
    super.addPath(p, m)
    const mm = m ? [m.a ?? 1, m.b ?? 0, m.c ?? 0, m.d ?? 1, m.e ?? 0, m.f ?? 0] : null
    for (const c of p._cmds || []) this._cmds.push(mm ? transformCmd(c, mm) : c)
  }
}
function transformCmd(c, m) {
  if (c[0] === 'Z' || c[0] === 'raw') return c
  const out = [c[0]]
  for (let i = 1; i < c.length; i += 2) { const [x, y] = ap(m, c[i], c[i + 1]); out.push(x, y) }
  return out
}
function cmdsToD(cmds) {
  let d = ''
  for (const c of cmds) {
    if (c[0] === 'raw') { d += c[1]; continue }
    d += c[0]
    for (let i = 1; i < c.length; i++) d += (i > 1 ? ' ' : '') + f(c[i])
  }
  return d
}

/* ---------- gradients / patterns ---------- */

class RecGradient {
  constructor(kind, args) { this.kind = kind; this.args = args; this.stops = [] }
  addColorStop(o, c) { this.stops.push([o, c]) }
}
class RecPattern {
  constructor(href, w, h, rep) { this.href = href; this.w = w; this.h = h; this.rep = rep; this.m = [1, 0, 0, 1, 0, 0] }
  setTransform(m) { this.m = m ? [m.a, m.b, m.c, m.d, m.e, m.f] : [1, 0, 0, 1, 0, 0] }
}

/* ---------- image → data URL ---------- */

const imgCache = new WeakMap()
function imageToDataURL(img, report) {
  if (img && typeof img === 'object' && imgCache.has(img)) return imgCache.get(img)
  let w = img.width || img.naturalWidth || img.videoWidth, h = img.height || img.naturalHeight || img.videoHeight
  if (img instanceof ImageData) { w = img.width; h = img.height }
  if (!w || !h) return null
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const x = c.getContext('2d')
  if (img instanceof ImageData) x.putImageData(img, 0, 0)
  else x.drawImage(img, 0, 0)
  const url = c.toDataURL('image/png')
  report.rasterBytes += url.length
  const rec = { url, w, h }
  if (img && typeof img === 'object') imgCache.set(img, rec)
  return rec
}

const BLEND = new Set(['multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'])

/* ---------- the context ---------- */

export class SvgRecorder {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.canvas = { width, height, style: {}, getContext: () => this, __svgRecorder: true }
    this.stack = []
    this.s = {
      m: [1, 0, 0, 1, 0, 0], fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
      miterLimit: 10, dash: [], dashOffset: 0, globalAlpha: 1, gco: 'source-over', font: '10px sans-serif', filter: 'none',
      clips: [], textAlign: 'start', textBaseline: 'alphabetic', direction: 'inherit', smoothing: true, letterSpacing: '0px',
    }
    this.path = []
    this.defs = []
    this.items = [] // { clips, markup } | text runs
    this.ids = 0
    this.fonts = new Set()
    this.report = { rasterImages: 0, patterns: 0, unsupported: new Map(), rasterBytes: 0, paths: 0, texts: 0 }
    this.measure = document.createElement('canvas').getContext('2d')
  }
  flag(what) { this.report.unsupported.set(what, (this.report.unsupported.get(what) || 0) + 1) }
  id(p) { return `${p}${++this.ids}` }

  // --- state properties
  get fillStyle() { return this.s.fillStyle } set fillStyle(v) { this.s.fillStyle = v }
  get strokeStyle() { return this.s.strokeStyle } set strokeStyle(v) { this.s.strokeStyle = v }
  get lineWidth() { return this.s.lineWidth } set lineWidth(v) { if (isFinite(v)) this.s.lineWidth = v }
  get lineCap() { return this.s.lineCap } set lineCap(v) { this.s.lineCap = v }
  get lineJoin() { return this.s.lineJoin } set lineJoin(v) { this.s.lineJoin = v }
  get miterLimit() { return this.s.miterLimit } set miterLimit(v) { this.s.miterLimit = v }
  get lineDashOffset() { return this.s.dashOffset } set lineDashOffset(v) { this.s.dashOffset = v }
  get globalAlpha() { return this.s.globalAlpha } set globalAlpha(v) { if (isFinite(v)) this.s.globalAlpha = v }
  get globalCompositeOperation() { return this.s.gco } set globalCompositeOperation(v) { this.s.gco = v }
  get font() { return this.s.font } set font(v) { this.s.font = v }
  get filter() { return this.s.filter } set filter(v) { this.s.filter = v }
  get textAlign() { return this.s.textAlign } set textAlign(v) { this.s.textAlign = v }
  get textBaseline() { return this.s.textBaseline } set textBaseline(v) { this.s.textBaseline = v }
  get direction() { return this.s.direction } set direction(v) { this.s.direction = v }
  get imageSmoothingEnabled() { return this.s.smoothing } set imageSmoothingEnabled(v) { this.s.smoothing = v }
  get imageSmoothingQuality() { return 'high' } set imageSmoothingQuality(v) { void v }
  get letterSpacing() { return this.s.letterSpacing } set letterSpacing(v) { this.s.letterSpacing = v }
  get fontKerning() { return 'auto' } set fontKerning(v) { void v }
  get shadowColor() { return 'transparent' } set shadowColor(v) { void v }
  get shadowBlur() { return 0 } set shadowBlur(v) { void v }
  get shadowOffsetX() { return 0 } set shadowOffsetX(v) { void v }
  get shadowOffsetY() { return 0 } set shadowOffsetY(v) { void v }

  save() { this.stack.push({ ...this.s, dash: this.s.dash.slice(), clips: this.s.clips.slice() }) }
  restore() { const s = this.stack.pop(); if (s) this.s = s }
  reset() { this.stack = []; this.s.m = [1, 0, 0, 1, 0, 0]; this.s.clips = [] }

  // --- transforms
  getTransform() { const m = this.s.m; return new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]) }
  setTransform(a, b, c, d, e, g) {
    if (a === undefined) this.s.m = [1, 0, 0, 1, 0, 0]
    else if (typeof a === 'object') this.s.m = [a.a, a.b, a.c, a.d, a.e, a.f]
    else this.s.m = [a, b, c, d, e, g]
  }
  resetTransform() { this.s.m = [1, 0, 0, 1, 0, 0] }
  transform(a, b, c, d, e, g) { this.s.m = mul(this.s.m, [a, b, c, d, e, g]) }
  translate(x, y) { this.transform(1, 0, 0, 1, x, y) }
  scale(x, y) { this.transform(x, 0, 0, y, 0, 0) }
  rotate(r) { const c = Math.cos(r), s = Math.sin(r); this.transform(c, s, -s, c, 0, 0) }

  // --- path (device space)
  beginPath() { this.path = [] }
  moveTo(x, y) { this.path.push(['M', ...ap(this.s.m, x, y)]) }
  lineTo(x, y) { this.path.push(['L', ...ap(this.s.m, x, y)]) }
  bezierCurveTo(a, b, c, d, e, g) { this.path.push(['C', ...ap(this.s.m, a, b), ...ap(this.s.m, c, d), ...ap(this.s.m, e, g)]) }
  quadraticCurveTo(a, b, c, d) { this.path.push(['Q', ...ap(this.s.m, a, b), ...ap(this.s.m, c, d)]) }
  closePath() { this.path.push(['Z']) }
  rect(x, y, w, h) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath() }
  arc(x, y, r, a0, a1, ccw) {
    // approximate with line segments (pdf.js rarely uses arcs)
    const steps = 32
    let sweep = a1 - a0
    if (ccw && sweep > 0) sweep -= Math.PI * 2
    if (!ccw && sweep < 0) sweep += Math.PI * 2
    for (let k = 0; k <= steps; k++) {
      const t = a0 + (sweep * k) / steps
      const px = x + r * Math.cos(t), py = y + r * Math.sin(t)
      if (k === 0 && !this.path.length) this.moveTo(px, py); else this.lineTo(px, py)
    }
  }
  ellipse() { this.flag('ellipse') }
  roundRect(x, y, w, h) { this.rect(x, y, w, h) }

  /** path for the current operation: { d, m } in current user space */
  #pathFor(arg) {
    if (arg && arg._cmds) return { d: cmdsToD(arg._cmds), m: this.s.m }
    if (arg && typeof arg === 'object' && !(arg instanceof RecPath2D)) { this.flag('opaque Path2D'); return null }
    const im = inv(this.s.m)
    if (!im) return { d: cmdsToD(this.path), m: [1, 0, 0, 1, 0, 0] }
    return { d: cmdsToD(this.path.map((c) => transformCmd(c, im))), m: this.s.m }
  }

  #paint(kind, style) {
    if (typeof style === 'string') {
      const col = parseColor(style)
      return { attr: `${kind}="${esc(col.c)}"${col.a < 1 ? ` ${kind}-opacity="${f(col.a)}"` : ''}` }
    }
    if (style instanceof RecGradient) {
      const gid = this.id('g')
      const stops = style.stops.map(([o, c]) => { const col = parseColor(c); return `<stop offset="${f(o)}" stop-color="${esc(col.c)}"${col.a < 1 ? ` stop-opacity="${f(col.a)}"` : ''}/>` }).join('')
      const a = style.args
      if (style.kind === 'linear') this.defs.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(a[2])}" y2="${f(a[3])}">${stops}</linearGradient>`)
      else this.defs.push(`<radialGradient id="${gid}" gradientUnits="userSpaceOnUse" fx="${f(a[0])}" fy="${f(a[1])}" fr="${f(a[2])}" cx="${f(a[3])}" cy="${f(a[4])}" r="${f(a[5])}">${stops}</radialGradient>`)
      return { attr: `${kind}="url(#${gid})"` }
    }
    if (style instanceof RecPattern) {
      const pid = this.id('p')
      this.report.patterns++
      this.defs.push(`<pattern id="${pid}" patternUnits="userSpaceOnUse" width="${f(style.w)}" height="${f(style.h)}" patternTransform="${mstr(style.m)}"><image href="${style.href}" width="${f(style.w)}" height="${f(style.h)}" preserveAspectRatio="none"/></pattern>`)
      return { attr: `${kind}="url(#${pid})"` }
    }
    this.flag('unknown paint style')
    return { attr: `${kind}="#000"` }
  }

  #common() {
    let s = ''
    const a = this.s.globalAlpha
    if (a < 1) s += ` opacity="${f(a)}"`
    if (this.s.gco !== 'source-over') {
      if (BLEND.has(this.s.gco)) s += ` style="mix-blend-mode:${this.s.gco}"`
      else this.flag(`composite operation "${this.s.gco}"`)
    }
    if (this.s.filter && this.s.filter !== 'none') this.flag('canvas filter')
    return s
  }
  #push(markup) { this.items.push({ clips: this.s.clips.slice(), markup }) }

  fill(a, b) {
    const rule = typeof a === 'string' ? a : b
    const p = this.#pathFor(typeof a === 'object' ? a : null)
    if (!p || !p.d) return
    const paint = this.#paint('fill', this.s.fillStyle)
    this.report.paths++
    this.#push(`<path d="${p.d}"${isIdentity(p.m) ? '' : ` transform="${mstr(p.m)}"`} ${paint.attr}${rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${this.#common()}/>`)
  }
  stroke(a) {
    const p = this.#pathFor(typeof a === 'object' ? a : null)
    if (!p || !p.d) return
    const paint = this.#paint('stroke', this.s.strokeStyle)
    this.report.paths++
    let st = ` stroke-width="${f(this.s.lineWidth)}"`
    if (this.s.lineCap !== 'butt') st += ` stroke-linecap="${this.s.lineCap}"`
    if (this.s.lineJoin !== 'miter') st += ` stroke-linejoin="${this.s.lineJoin}"`
    if (this.s.miterLimit !== 4) st += ` stroke-miterlimit="${f(this.s.miterLimit)}"`
    if (this.s.dash.length) st += ` stroke-dasharray="${this.s.dash.map(f).join(' ')}"${this.s.dashOffset ? ` stroke-dashoffset="${f(this.s.dashOffset)}"` : ''}`
    this.#push(`<path d="${p.d}"${isIdentity(p.m) ? '' : ` transform="${mstr(p.m)}"`} fill="none" ${paint.attr}${st}${this.#common()}/>`)
  }
  clip(a, b) {
    const rule = typeof a === 'string' ? a : b
    const p = this.#pathFor(typeof a === 'object' ? a : null)
    if (!p) return
    const cid = this.id('c')
    this.defs.push(`<clipPath id="${cid}" clipPathUnits="userSpaceOnUse"><path d="${p.d || 'M0 0'}"${isIdentity(p.m) ? '' : ` transform="${mstr(p.m)}"`}${rule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`)
    this.s.clips.push(cid)
  }
  fillRect(x, y, w, h) {
    // skip the opaque page background painted first
    if (!this.items.length && isIdentity(this.s.m) && x <= 0 && y <= 0 && w >= this.width && h >= this.height && /^(#fff(fff)?|white|rgb\(255, ?255, ?255\))$/i.test(String(this.s.fillStyle))) return
    const saved = this.path
    this.path = []
    this.rect(x, y, w, h)
    this.fill()
    this.path = saved
  }
  strokeRect(x, y, w, h) { const saved = this.path; this.path = []; this.rect(x, y, w, h); this.stroke(); this.path = saved }
  clearRect() { /* transparent output by default */ }
  setLineDash(d) { this.s.dash = Array.isArray(d) ? d.slice() : [] }
  getLineDash() { return this.s.dash.slice() }
  isPointInPath() { return false }
  isPointInStroke() { return false }

  // --- gradients / patterns
  createLinearGradient(...a) { return new RecGradient('linear', a) }
  createRadialGradient(...a) { return new RecGradient('radial', a) }
  createConicGradient() { this.flag('conic gradient'); return new RecGradient('linear', [0, 0, 1, 0]) }
  createPattern(img, rep) {
    const d = imageToDataURL(img, this.report)
    if (!d) return null
    return new RecPattern(d.url, d.w, d.h, rep)
  }

  // --- text
  #fontAttrs() {
    const m = String(this.s.font).match(/^\s*((?:(?:normal|italic|oblique|bold|bolder|lighter|\d{3}|small-caps)\s+)*)([\d.]+)px\s+(.+)$/)
    if (!m) return { attrs: '', size: 10, family: '' }
    const words = m[1].trim().split(/\s+/).filter(Boolean)
    const italic = words.find((w) => w === 'italic' || w === 'oblique')
    const weight = words.find((w) => /^(bold|bolder|lighter|\d{3})$/.test(w))
    const fam = m[3].trim()
    const first = fam.match(/^"([^"]+)"|^([^,]+)/)
    const family = first ? (first[1] || first[2]).trim() : ''
    if (family) this.fonts.add(family)
    return { family, attrs: ` font-family="${esc(fam)}" font-size="${f(+m[2])}"${italic ? ` font-style="${italic}"` : ''}${weight && weight !== 'normal' && weight !== '400' ? ` font-weight="${weight}"` : ''}`, size: +m[2] }
  }
  #text(kind, text, x, y) {
    if (text === undefined || text === null || text === '') return
    const fa = this.#fontAttrs()
    const paint = this.#paint(kind, kind === 'fill' ? this.s.fillStyle : this.s.strokeStyle)
    const extra = kind === 'stroke' ? ` fill="none" stroke-width="${f(this.s.lineWidth)}"` : ''
    const anchor = this.s.textAlign === 'center' ? ' text-anchor="middle"' : this.s.textAlign === 'right' || this.s.textAlign === 'end' ? ' text-anchor="end"' : ''
    const head = `<text${isIdentity(this.s.m) ? '' : ` transform="${mstr(this.s.m)}"`}${fa.attrs} direction="ltr" unicode-bidi="bidi-override" ${paint.attr}${extra}${anchor}${this.#common()} xml:space="preserve"`
    const last = this.items[this.items.length - 1]
    const single = text.length === 1
    if (single && last && last.run && last.head === head && last.y === y && sameClips(last.clips, this.s.clips)) {
      last.xs.push(x); last.chars.push(text); return
    }
    this.report.texts++
    this.items.push({ clips: this.s.clips.slice(), run: true, head, y, xs: [x], chars: [text], family: fa.family, font: this.s.font, size: fa.size })
  }
  fillText(t, x, y) { this.#text('fill', t, x, y) }
  strokeText(t, x, y) { this.#text('stroke', t, x, y) }
  measureText(t) { this.measure.font = this.s.font; return this.measure.measureText(t) }

  // --- images
  drawImage(img, ...a) {
    if (img && img.__svgRecorder) { this.flag('self-composited canvas'); return }
    if (img === this.canvas) { this.flag('self-composited canvas'); return }
    const d = imageToDataURL(img, this.report)
    if (!d) { this.flag(`unreadable image source (${img?.constructor?.name} ${img?.width}×${img?.height})`); return }
    this.report.rasterImages++
    let sx = 0, sy = 0, sw = d.w, sh = d.h, dx, dy, dw, dh
    if (a.length === 2) { [dx, dy] = a; dw = d.w; dh = d.h }
    else if (a.length === 4) { [dx, dy, dw, dh] = a }
    else { [sx, sy, sw, sh, dx, dy, dw, dh] = a }
    const smooth = this.s.smoothing ? '' : ' style="image-rendering:pixelated"'
    const tr = isIdentity(this.s.m) ? '' : ` transform="${mstr(this.s.m)}"`
    if (sx === 0 && sy === 0 && sw === d.w && sh === d.h) {
      this.#push(`<image href="${d.url}" x="${f(dx)}" y="${f(dy)}" width="${f(dw)}" height="${f(dh)}" preserveAspectRatio="none"${tr}${smooth}${this.#common()}/>`)
    } else {
      this.#push(`<g${tr}${this.#common()}><svg x="${f(dx)}" y="${f(dy)}" width="${f(dw)}" height="${f(dh)}" viewBox="${f(sx)} ${f(sy)} ${f(sw)} ${f(sh)}" preserveAspectRatio="none"><image href="${d.url}" width="${d.w}" height="${d.h}"${smooth}/></svg></g>`)
    }
  }
  createImageData(w, h) { return typeof w === 'object' ? new ImageData(w.width, w.height) : new ImageData(w, h) }
  getImageData(x, y, w, h) { this.flag('pixel read-back (getImageData)'); return new ImageData(Math.max(1, w), Math.max(1, h)) }
  putImageData(data, dx, dy) {
    const d = imageToDataURL(data, this.report)
    if (!d) return
    this.report.rasterImages++
    this.items.push({ clips: [], markup: `<image href="${d.url}" x="${f(dx)}" y="${f(dy)}" width="${d.w}" height="${d.h}"/>` })
  }

  /** Build the SVG body (defs + nested clip groups). translate(family) → Map fontChar → Unicode */
  body(translate) {
    let out = ''
    const open = []
    for (const it of this.items) {
      let k = 0
      while (k < open.length && k < it.clips.length && open[k] === it.clips[k]) k++
      while (open.length > k) { out += '</g>'; open.pop() }
      for (let j = k; j < it.clips.length; j++) { out += `<g clip-path="url(#${it.clips[j]})">`; open.push(it.clips[j]) }
      if (it.run) {
        const tr = translate ? translate(it.family) : null
        // pdf.js does not draw space glyphs: re-insert spaces where the gap is word-sized
        this.measure.font = it.font
        const chars = [], xsOut = []
        for (let k = 0; k < it.chars.length; k++) {
          if (k > 0) {
            const prevEnd = it.xs[k - 1] + this.measure.measureText(it.chars[k - 1]).width
            if (it.xs[k] - prevEnd > it.size * 0.18) { chars.push(' '); xsOut.push(prevEnd) }
          }
          chars.push(tr ? tr.get(it.chars[k]) ?? it.chars[k] : it.chars[k])
          xsOut.push(it.xs[k])
        }
        const text = chars.join('')
        const xs = xsOut.length === text.length ? xsOut.map(f).join(' ') : f(it.xs[0])
        out += `${it.head} x="${xs}" y="${f(it.y)}">${esc(text)}</text>`
      } else out += it.markup
    }
    while (open.length) { out += '</g>'; open.pop() }
    return `<defs>${this.defs.join('')}</defs>${out}`
  }
}

function sameClips(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function parseColor(c) {
  if (typeof c !== 'string') return { c: '#000', a: 1 }
  const m = c.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i)
  if (m) {
    const hex = [m[1], m[2], m[3]].map((v) => Math.round(+v).toString(16).padStart(2, '0')).join('')
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]
    return { c: '#' + hex, a }
  }
  if (/^#[0-9a-f]{8}$/i.test(c)) return { c: c.slice(0, 7), a: parseInt(c.slice(7), 16) / 255 }
  return { c, a: 1 }
}

/** Temporarily replace the global Path2D so pdf.js builds recordable paths. */
export function withRecordingPath2D(fn) {
  const orig = globalThis.Path2D
  globalThis.Path2D = RecPath2D
  const done = () => { globalThis.Path2D = orig }
  return Promise.resolve().then(fn).finally(done)
}
