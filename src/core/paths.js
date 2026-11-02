// Addressing values inside indirect objects by path, so UI survives undo/redo.
import { PDFDict, PDFArray, PDFStream, PDFRef } from './pdfobj.js'
import { PDFName } from 'pdf-lib'

/** owner: PDFRef or 'trailer'. path: array of string keys / numeric indices. */
export function resolvePath(ctx, owner, path) {
  let v
  if (owner === 'trailer') {
    if (!path.length) return { trailer: true }
    v = ctx.trailerInfo[path[0]]
    path = path.slice(1)
  } else {
    v = ctx.lookup(owner)
  }
  for (const step of path) {
    if (v instanceof PDFStream) v = v.dict
    if (typeof step === 'number') {
      if (!(v instanceof PDFArray)) return undefined
      v = v.get(step)
    } else {
      if (!(v instanceof PDFDict)) return undefined
      v = v.get(PDFName.of(step))
    }
    if (v === undefined) return undefined
  }
  return v
}

export function containerOf(ctx, owner, path) {
  const parent = resolvePath(ctx, owner, path.slice(0, -1))
  return parent instanceof PDFStream ? parent.dict : parent
}

export function setAtPath(ctx, owner, path, value) {
  if (owner === 'trailer') {
    if (path.length === 1) { ctx.trailerInfo[path[0]] = value; return }
  } else if (!path.length) {
    ctx.assign(owner, value)
    return
  }
  const c = containerOf(ctx, owner, path)
  const last = path[path.length - 1]
  if (c instanceof PDFArray && typeof last === 'number') c.set(last, value)
  else if (c instanceof PDFDict) c.set(PDFName.of(String(last)), value)
  else throw new Error('Cannot set value here')
}

export function deleteAtPath(ctx, owner, path) {
  if (owner === 'trailer' && path.length === 1) { delete ctx.trailerInfo[path[0]]; return }
  const c = containerOf(ctx, owner, path)
  const last = path[path.length - 1]
  if (c instanceof PDFArray && typeof last === 'number') c.remove(last)
  else if (c instanceof PDFDict) c.delete(PDFName.of(String(last)))
}

export function ownerKey(owner) {
  return owner === 'trailer' ? 'trailer' : owner instanceof PDFRef ? `${owner.objectNumber} ${owner.generationNumber}` : '?'
}
