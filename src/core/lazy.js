// Disk-backed stream data.
// Large binary streams (images, font programs, embedded files) are kept as Blob references —
// slices of the opened File, or Blobs stored in IndexedDB — instead of in-memory byte arrays.
// They are read on demand through a small LRU cache.

export class LazyContents {
  constructor(blob, origin = 'file') {
    this.blob = blob
    this.length = blob.size
    this.origin = origin // 'file' | 'idb' | 'memory-blob'
  }
  // pdf-lib may call these on stream contents
  slice() { throw new Error('Stream data is stored on disk; load it first') }
}

export const isLazy = (c) => c instanceof LazyContents

/* ---------- LRU cache ---------- */
const cache = new Map()
let cacheBytes = 0
export const cacheConfig = { budget: 96 * 1024 * 1024 }

function touch(key, bytes) {
  if (cache.has(key)) { cache.delete(key); cache.set(key, bytes); return }
  cache.set(key, bytes)
  cacheBytes += bytes.length
  for (const [k, v] of cache) {
    if (cacheBytes <= cacheConfig.budget || k === key) break
    cache.delete(k)
    cacheBytes -= v.length
  }
}

export function cachedBytes(lazy) {
  const b = cache.get(lazy)
  if (b) touch(lazy, b)
  return b || null
}

export async function loadLazy(lazy) {
  const hit = cachedBytes(lazy)
  if (hit) return hit
  const bytes = new Uint8Array(await lazy.blob.arrayBuffer())
  touch(lazy, bytes)
  return bytes
}

export function cacheStats() {
  return { entries: cache.size, bytes: cacheBytes }
}

/* ---------- IndexedDB blob store ---------- */
let dbp = null
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('deepdf-blobs', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('blobs')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
  }
  return dbp
}
export async function idbPutBlob(key, blob) {
  const d = await db()
  await new Promise((res, rej) => {
    const tx = d.transaction('blobs', 'readwrite')
    tx.objectStore('blobs').put(blob, key)
    tx.oncomplete = res
    tx.onerror = () => rej(tx.error)
  })
}
export async function idbGetBlob(key) {
  const d = await db()
  return new Promise((res, rej) => {
    const tx = d.transaction('blobs', 'readonly')
    const r = tx.objectStore('blobs').get(key)
    r.onsuccess = () => res(r.result || null)
    r.onerror = () => rej(r.error)
  })
}
export async function idbClear(prefix) {
  const d = await db()
  await new Promise((res, rej) => {
    const tx = d.transaction('blobs', 'readwrite')
    const st = tx.objectStore('blobs')
    const r = st.openCursor()
    r.onsuccess = () => {
      const c = r.result
      if (!c) return
      if (!prefix || String(c.key).startsWith(prefix)) c.delete()
      c.continue()
    }
    tx.oncomplete = res
    tx.onerror = () => rej(tx.error)
  })
}

/** Move bytes to IndexedDB and get back a disk-backed LazyContents. */
export async function offloadToIdb(key, bytes) {
  await idbPutBlob(key, new Blob([bytes]))
  const blob = await idbGetBlob(key)
  return new LazyContents(blob, 'idb')
}
