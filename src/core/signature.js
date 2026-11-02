// Detection and removal of digital signatures.
import { PDFDict, PDFArray, PDFRef, PDFStream, N, deref, nameStr, numVal, stringText } from './pdfobj.js'
import { catalog } from './pages.js'

function walkFields(ctx, arr, fn, depth = 0) {
  if (!(arr instanceof PDFArray) || depth > 32) return
  for (const r of arr.asArray()) {
    const f = deref(ctx, r)
    if (!(f instanceof PDFDict)) continue
    fn(f, r)
    walkFields(ctx, deref(ctx, f.get(N('Kids'))), fn, depth + 1)
  }
}

export function detectSignatures(ctx) {
  const cat = catalog(ctx)
  const res = { signed: false, fields: [], sigDicts: [], perms: false, dss: false, sigFlags: 0 }
  if (!cat) return res
  const acro = deref(ctx, cat.get(N('AcroForm')))
  if (acro instanceof PDFDict) {
    res.sigFlags = numVal(deref(ctx, acro.get(N('SigFlags')))) || 0
    walkFields(ctx, deref(ctx, acro.get(N('Fields'))), (f, ref) => {
      if (nameStr(deref(ctx, f.get(N('FT')))) !== 'Sig') return
      const v = deref(ctx, f.get(N('V')))
      const name = f.get(N('T')) ? stringText(deref(ctx, f.get(N('T')))) : '(unnamed)'
      let signer = ''
      if (v instanceof PDFDict && v.get(N('Name'))) signer = stringText(deref(ctx, v.get(N('Name'))))
      res.fields.push({ ref, name, signed: v instanceof PDFDict, signer })
    })
  }
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFStream ? null : obj
    if (!(d instanceof PDFDict)) continue
    if (d.get(N('ByteRange')) && d.get(N('Contents'))) res.sigDicts.push(ref)
  }
  res.perms = !!cat.get(N('Perms'))
  res.dss = !!cat.get(N('DSS'))
  res.signed = res.fields.some((f) => f.signed) || res.sigDicts.length > 0 || res.perms
  return res
}

/** Remove signature values (keeps the empty signature form fields). */
export function stripSignatures(ctx) {
  const cat = catalog(ctx)
  if (!cat) return 0
  let removed = 0
  const sigRefs = new Set()
  const acro = deref(ctx, cat.get(N('AcroForm')))
  if (acro instanceof PDFDict) {
    walkFields(ctx, deref(ctx, acro.get(N('Fields'))), (f) => {
      if (nameStr(deref(ctx, f.get(N('FT')))) !== 'Sig') return
      const v = f.get(N('V'))
      if (v !== undefined) {
        if (v instanceof PDFRef) sigRefs.add(v)
        f.delete(N('V'))
        removed++
      }
      f.delete(N('Lock'))
      f.delete(N('SV'))
    })
    acro.delete(N('SigFlags'))
  }
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(N('ByteRange')) && obj.get(N('Contents'))) sigRefs.add(ref)
  }
  for (const r of sigRefs) ctx.delete(r)
  if (cat.get(N('Perms'))) { cat.delete(N('Perms')); removed++ }
  if (cat.get(N('DSS'))) { cat.delete(N('DSS')); removed++ }
  return removed + sigRefs.size
}
