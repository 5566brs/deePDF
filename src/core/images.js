// Image XObject extraction in original format (or PNG for raw pixel data).
import {
  PDFArray, PDFDict, PDFName, PDFStream, N, deref, nameStr, numVal, numArray,
  decodeStream, rawBytes, filtersOf, stringBytes,
} from './pdfobj.js'

const NATIVE = {
  DCTDecode: { ext: 'jpg', mime: 'image/jpeg', browser: true },
  JPXDecode: { ext: 'jp2', mime: 'image/jp2', browser: false },
  JBIG2Decode: { ext: 'jb2', mime: 'application/octet-stream', browser: false },
  CCITTFaxDecode: { ext: 'ccitt', mime: 'application/octet-stream', browser: false },
}

export function imageInfo(ctx, stream) {
  const d = stream.dict
  const cs = deref(ctx, d.get(N('ColorSpace')))
  let csName = nameStr(cs)
  if (cs instanceof PDFArray) csName = nameStr(deref(ctx, cs.get(0))) + '[]'
  return {
    width: numVal(deref(ctx, d.get(N('Width')))) || 0,
    height: numVal(deref(ctx, d.get(N('Height')))) || 0,
    bpc: numVal(deref(ctx, d.get(N('BitsPerComponent')))) || (deref(ctx, d.get(N('ImageMask')))?.asBoolean?.() ? 1 : 8),
    colorSpace: csName || (deref(ctx, d.get(N('ImageMask')))?.asBoolean?.() ? 'Mask' : '?'),
    filters: filtersOf(ctx, stream),
    size: rawBytes(stream).length,
  }
}

/**
 * Get exportable bytes of an image in its original encoding.
 * Returns { bytes, ext, mime, kind: 'native'|'pixels'|'raw', note }
 */
export function extractImage(ctx, stream) {
  const dec = decodeStream(ctx, stream)
  const rem = dec.remaining
  if (rem.length && NATIVE[rem[0]]) {
    const n = NATIVE[rem[0]]
    return { bytes: dec.bytes, ext: n.ext, mime: n.mime, kind: 'native', browser: n.browser, note: rem[0] }
  }
  if (dec.error || rem.length) return { bytes: rawBytes(stream), ext: 'bin', mime: 'application/octet-stream', kind: 'raw', note: dec.error || rem.join(',') }
  return { bytes: dec.bytes, ext: 'raw', mime: 'application/octet-stream', kind: 'pixels' }
}

function colorConverter(ctx, cs) {
  cs = deref(ctx, cs)
  const name = nameStr(cs)
  if (name === 'DeviceGray' || name === 'CalGray' || name === 'G') return { n: 1, conv: (c) => [c[0], c[0], c[0]] }
  if (name === 'DeviceRGB' || name === 'CalRGB' || name === 'RGB') return { n: 3, conv: (c) => c }
  if (name === 'DeviceCMYK' || name === 'CMYK') return { n: 4, conv: cmyk }
  if (cs instanceof PDFArray) {
    const fam = nameStr(deref(ctx, cs.get(0)))
    if (fam === 'ICCBased') {
      const s = deref(ctx, cs.get(1))
      const nn = s instanceof PDFStream ? numVal(deref(ctx, s.dict.get(N('N')))) : 3
      return nn === 1 ? colorConverter(ctx, N('DeviceGray')) : nn === 4 ? colorConverter(ctx, N('DeviceCMYK')) : colorConverter(ctx, N('DeviceRGB'))
    }
    if (fam === 'CalRGB' || fam === 'Lab') return colorConverter(ctx, N('DeviceRGB'))
    if (fam === 'CalGray') return colorConverter(ctx, N('DeviceGray'))
    if (fam === 'Indexed' || fam === 'I') {
      const base = colorConverter(ctx, cs.get(1))
      const lookupObj = deref(ctx, cs.get(3))
      let table
      if (lookupObj instanceof PDFStream) table = decodeStream(ctx, lookupObj).bytes
      else table = stringBytes(lookupObj)
      return {
        n: 1,
        indexed: true,
        conv: (c) => {
          const i = Math.round((c[0] / 255) * 255) // c[0] is raw index (scaled later)
          const comps = []
          for (let k = 0; k < base.n; k++) comps.push(table[i * base.n + k] ?? 0)
          return base.conv(comps)
        },
      }
    }
    if (fam === 'Separation' || fam === 'DeviceN') {
      return { n: fam === 'DeviceN' ? (deref(ctx, cs.get(1))?.size?.() || 1) : 1, conv: (c) => [255 - c[0], 255 - c[0], 255 - c[0]] }
    }
  }
  return { n: 3, conv: (c) => c }
}

function cmyk(c) {
  const [C, M, Y, K] = c.map((v) => v / 255)
  return [255 * (1 - C) * (1 - K), 255 * (1 - M) * (1 - K), 255 * (1 - Y) * (1 - K)]
}

/** Convert decoded pixel data to RGBA ImageData-compatible array. */
export function pixelsToRGBA(ctx, stream, data) {
  const d = stream.dict
  const w = numVal(deref(ctx, d.get(N('Width')))) || 0
  const h = numVal(deref(ctx, d.get(N('Height')))) || 0
  const isMask = deref(ctx, d.get(N('ImageMask')))?.asBoolean?.() || false
  const bpc = isMask ? 1 : numVal(deref(ctx, d.get(N('BitsPerComponent')))) || 8
  const cc = isMask ? { n: 1, conv: (c) => [c[0], c[0], c[0]] } : colorConverter(ctx, d.get(N('ColorSpace')) || N('DeviceGray'))
  const decodeArr = numArray(ctx, d.get(N('Decode')))
  const n = cc.n
  const rowBits = w * n * bpc
  const rowBytes = Math.ceil(rowBits / 8)
  const out = new Uint8ClampedArray(w * h * 4)
  const max = (1 << bpc) - 1
  const comps = new Array(n)
  for (let y = 0; y < h; y++) {
    const rowOff = y * rowBytes
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < n; k++) {
        const bitPos = (x * n + k) * bpc
        let v
        if (bpc === 8) v = data[rowOff + (bitPos >> 3)] ?? 0
        else if (bpc === 16) v = data[rowOff + (bitPos >> 3)] ?? 0
        else {
          const byte = data[rowOff + (bitPos >> 3)] ?? 0
          v = (byte >> (8 - bpc - (bitPos & 7))) & max
        }
        if (cc.indexed) comps[k] = bpc === 16 ? v : v
        else {
          let f = bpc === 16 ? v / 255 : v / max
          if (decodeArr) f = decodeArr[k * 2] + f * (decodeArr[k * 2 + 1] - decodeArr[k * 2])
          comps[k] = f * 255
        }
      }
      let rgb
      if (isMask) {
        const on = decodeArr && decodeArr[0] === 1 ? comps[0] > 127 : comps[0] < 127
        rgb = on ? [0, 0, 0] : [255, 255, 255]
        const o = (y * w + x) * 4
        out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = on ? 255 : 0
        continue
      }
      rgb = cc.conv(comps)
      const o = (y * w + x) * 4
      out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255
    }
  }
  return { w, h, rgba: out }
}

/** Produce a Blob for preview or download. */
export async function imageBlob(ctx, stream, preferPng = false) {
  const ex = extractImage(ctx, stream)
  if (ex.kind === 'native' && (!preferPng || ex.browser)) return { blob: new Blob([ex.bytes], { type: ex.mime }), ext: ex.ext, ex }
  if (ex.kind === 'pixels') {
    const { w, h, rgba } = pixelsToRGBA(ctx, stream, ex.bytes)
    if (!w || !h || w * h > 64e6) return { blob: new Blob([ex.bytes]), ext: 'raw', ex }
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0)
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'))
    return { blob, ext: 'png', ex }
  }
  return { blob: new Blob([ex.bytes], { type: ex.mime }), ext: ex.ext, ex }
}

export function isImageXObject(ctx, o) {
  return o instanceof PDFStream && nameStr(deref(ctx, o.dict.get(N('Subtype')))) === 'Image'
}

const FONT_FILES = { FontFile: { ext: 'pfb', label: 'Type 1' }, FontFile2: { ext: 'ttf', label: 'TrueType' }, FontFile3: { ext: 'cff', label: 'CFF/OpenType' } }

export function fontFileOf(ctx, fontDict) {
  let fd = deref(ctx, fontDict.get(N('FontDescriptor')))
  if (!fd) {
    const desc = deref(ctx, fontDict.get(N('DescendantFonts')))
    const cid = desc instanceof PDFArray ? deref(ctx, desc.get(0)) : null
    if (cid instanceof PDFDict) fd = deref(ctx, cid.get(N('FontDescriptor')))
  }
  if (!(fd instanceof PDFDict)) return null
  for (const key of Object.keys(FONT_FILES)) {
    const ref = fd.get(N(key))
    const s = deref(ctx, ref)
    if (s instanceof PDFStream) {
      let ext = FONT_FILES[key].ext
      const st = nameStr(deref(ctx, s.dict.get(N('Subtype'))))
      if (st === 'OpenType') ext = 'otf'
      return { stream: s, ref, ext, label: FONT_FILES[key].label + (st ? ` (${st})` : '') }
    }
  }
  return null
}

export { PDFName }
