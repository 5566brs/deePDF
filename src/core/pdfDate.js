// PDF date strings: D:YYYYMMDDHHmmSSOHH'mm'

export function parsePdfDate(s) {
  if (!s) return null
  const m = String(s).trim().match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:([Zz+\-])\s*(\d{2})?'?\s*(\d{2})?'?)?/)
  if (!m) return null
  const [, Y, Mo = '01', D = '01', H = '00', Mi = '00', S = '00', sign, oh = '00', om = '00'] = m
  let offset = null // minutes east of UTC; null = unspecified (local)
  if (sign === 'Z' || sign === 'z') offset = 0
  else if (sign === '+' || sign === '-') offset = (sign === '-' ? -1 : 1) * (parseInt(oh, 10) * 60 + parseInt(om, 10))
  return { Y: +Y, Mo: +Mo, D: +D, H: +H, Mi: +Mi, S: +S, offset }
}

const p2 = (n) => String(Math.abs(n)).padStart(2, '0')

export function formatPdfDate(p) {
  let s = `D:${String(p.Y).padStart(4, '0')}${p2(p.Mo)}${p2(p.D)}${p2(p.H)}${p2(p.Mi)}${p2(p.S)}`
  if (p.offset === 0) s += 'Z'
  else if (p.offset !== null && p.offset !== undefined) s += `${p.offset < 0 ? '-' : '+'}${p2(Math.trunc(Math.abs(p.offset) / 60))}'${p2(Math.abs(p.offset) % 60)}'`
  return s
}

export function nowParts() {
  const d = new Date()
  return { Y: d.getFullYear(), Mo: d.getMonth() + 1, D: d.getDate(), H: d.getHours(), Mi: d.getMinutes(), S: d.getSeconds(), offset: -d.getTimezoneOffset() }
}

export function toLocalInput(p) {
  return `${String(p.Y).padStart(4, '0')}-${p2(p.Mo)}-${p2(p.D)}T${p2(p.H)}:${p2(p.Mi)}:${p2(p.S)}`
}
export function fromLocalInput(v, offset) {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return null
  return { Y: +m[1], Mo: +m[2], D: +m[3], H: +m[4], Mi: +m[5], S: +(m[6] || 0), offset }
}

/** ISO-8601 (XMP) dates */
export function parseIsoDate(s) {
  const m = String(s || '').trim().match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/)
  if (!m) return null
  let offset = null
  if (m[7] === 'Z') offset = 0
  else if (m[7]) { const t = m[7].replace(':', ''); offset = (t[0] === '-' ? -1 : 1) * (+t.slice(1, 3) * 60 + +t.slice(3, 5)) }
  return { Y: +m[1], Mo: +(m[2] || 1), D: +(m[3] || 1), H: +(m[4] || 0), Mi: +(m[5] || 0), S: +(m[6] || 0), offset }
}
export function formatIsoDate(p) {
  let s = `${String(p.Y).padStart(4, '0')}-${p2(p.Mo)}-${p2(p.D)}T${p2(p.H)}:${p2(p.Mi)}:${p2(p.S)}`
  if (p.offset === 0) s += 'Z'
  else if (p.offset !== null && p.offset !== undefined) s += `${p.offset < 0 ? '-' : '+'}${p2(Math.trunc(Math.abs(p.offset) / 60))}:${p2(Math.abs(p.offset) % 60)}`
  return s
}

export function looksLikePdfDate(s) {
  return /^D:\d{4}/.test(String(s || ''))
}

export const TZ_OPTIONS = (() => {
  const out = [{ v: 'none', label: 'unspecified' }, { v: '0', label: 'UTC (Z)' }]
  for (let m = -12 * 60; m <= 14 * 60; m += 30) {
    if (m === 0) continue
    out.push({ v: String(m), label: `UTC${m < 0 ? '−' : '+'}${p2(Math.trunc(Math.abs(m) / 60))}:${p2(Math.abs(m) % 60)}` })
  }
  return out
})()
