// Export/import of the offline engine's persistent state. The engine mounts
// /crawl on IndexedDB (Emscripten IDBFS: database '/crawl', object store
// 'FILE_DATA', schema v21 — values {timestamp: Date, mode: number,
// contents?: bytes} keyed by absolute path; directory entries carry no
// contents). That store is readable and writable directly from the main
// thread, so export/import needs no engine at all — and reading IDBFS while
// the engine runs is still coherent: its content is always the last
// pocketzot_persist checkpoint, i.e. exactly what a crash-resume would boot
// from. Importing under a live engine is NOT safe (its next persist would
// clobber the imported state) — the boot.ts hook guards that.
//
// Pack format (one downloadable binary):
//   bytes 0–7    ASCII magic "PZSAVE1\n"
//   bytes 8–11   uint32 LE manifest byte length
//   manifest     UTF-8 JSON {exportedAt, build?, files:[{path, mode,
//                mtimeMs, offset, size}]} — offsets relative to data start
//   data         file contents, concatenated
//
// Regenerable caches are excluded from export: saves/db + saves/des (the
// prewarm pack reseeds them; ~10 MB, and stale across engine builds) and the
// prewarm stamp file itself (its absence just makes the next boot reseed).

export interface SavedFile {
  path: string
  mode: number
  mtimeMs: number
  data: Uint8Array
}

export interface SavePackMeta {
  exportedAt: string
  build?: string
}

const MOUNT = '/crawl'
const STORE = 'FILE_DATA'
// Mirrors IDBFS.DB_VERSION in the engine glue, so a fresh-device import
// creates the database at the exact schema the engine expects to open.
const IDBFS_DB_VERSION = 21
const MAGIC = 'PZSAVE1\n'

function isRegenerable(path: string): boolean {
  return path.startsWith(`${MOUNT}/saves/db/`)
    || path.startsWith(`${MOUNT}/saves/des/`)
    || path === `${MOUNT}/.pocketzot-prewarm`
}

// --- Pack format (pure) ------------------------------------------------------

export function packSave(files: SavedFile[], meta: SavePackMeta): Uint8Array {
  let offset = 0
  const manifest = {
    ...meta,
    files: files.map((f) => {
      const entry = { path: f.path, mode: f.mode, mtimeMs: f.mtimeMs, offset, size: f.data.byteLength }
      offset += f.data.byteLength
      return entry
    }),
  }
  const magic = new TextEncoder().encode(MAGIC)
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  const out = new Uint8Array(magic.byteLength + 4 + manifestBytes.byteLength + offset)
  out.set(magic, 0)
  new DataView(out.buffer).setUint32(magic.byteLength, manifestBytes.byteLength, true)
  out.set(manifestBytes, magic.byteLength + 4)
  let at = magic.byteLength + 4 + manifestBytes.byteLength
  for (const f of files) {
    out.set(f.data, at)
    at += f.data.byteLength
  }
  return out
}

export function unpackSave(bytes: ArrayBuffer | Uint8Array): { meta: SavePackMeta; files: SavedFile[] } {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const headerLen = MAGIC.length + 4
  if (view.byteLength < headerLen) throw new Error('not a PocketZot save pack (too short)')
  if (new TextDecoder().decode(view.subarray(0, MAGIC.length)) !== MAGIC)
    throw new Error('not a PocketZot save pack (bad magic)')
  const manifestLen = new DataView(view.buffer, view.byteOffset).getUint32(MAGIC.length, true)
  const dataStart = headerLen + manifestLen
  if (dataStart > view.byteLength) throw new Error('save pack truncated (manifest)')
  let manifest: SavePackMeta & { files?: unknown }
  try {
    manifest = JSON.parse(new TextDecoder().decode(view.subarray(headerLen, dataStart))) as typeof manifest
  } catch {
    throw new Error('save pack manifest is not valid JSON')
  }
  if (!Array.isArray(manifest.files)) throw new Error('save pack manifest has no file list')
  const files = manifest.files.map((raw): SavedFile => {
    const f = raw as { path?: unknown; mode?: unknown; mtimeMs?: unknown; offset?: unknown; size?: unknown }
    const { path, mode, mtimeMs, offset, size } = f
    if (typeof path !== 'string' || typeof offset !== 'number' || typeof size !== 'number')
      throw new Error('save pack manifest entry malformed')
    // Every path must live under the mount, with no traversal segments — a
    // crafted pack must not be able to plant keys the engine wouldn't own.
    if (!path.startsWith(`${MOUNT}/`) || path.split('/').includes('..'))
      throw new Error(`save pack path outside ${MOUNT}: ${path}`)
    const start = dataStart + offset
    if (offset < 0 || size < 0 || start + size > view.byteLength)
      throw new Error(`save pack truncated (${path})`)
    return {
      path,
      mode: typeof mode === 'number' ? mode : 0o100664,
      mtimeMs: typeof mtimeMs === 'number' ? mtimeMs : Date.now(),
      // slice, not subarray: a subarray view structured-clones its ENTIRE
      // backing buffer into IndexedDB — every record would carry the whole
      // pack.
      data: view.slice(start, start + size),
    }
  })
  const meta: SavePackMeta = { exportedAt: String(manifest.exportedAt ?? '') }
  if (typeof manifest.build === 'string') meta.build = manifest.build
  return { meta, files }
}

// --- IndexedDB access --------------------------------------------------------

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'))
  })
}

function txnDone(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'))
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function openRaw(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = version === undefined ? indexedDB.open(MOUNT) : indexedDB.open(MOUNT, version)
    r.onupgradeneeded = () => {
      // Mirror the store IDBFS creates (including the timestamp index), so
      // the engine's own open(…, 21) later finds everything in place.
      const db = r.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE)
        store.createIndex('timestamp', 'timestamp')
      }
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'))
    r.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'))
  })
}

// Open the engine's IDBFS database, creating it at the engine's schema
// version when absent (fresh-device import). A version-less open never
// downgrades an existing database, so a future IDBFS version bump stays
// compatible as long as the store name holds.
async function openDb(): Promise<IDBDatabase> {
  let db = await openRaw()
  if (!db.objectStoreNames.contains(STORE)) {
    const version = Math.max(IDBFS_DB_VERSION, db.version + 1)
    db.close()
    db = await openRaw(version)
  }
  return db
}

// Whether a resumable save exists in the engine's IDBFS (any
// /crawl/saves/*.cs file), without creating the database as a side effect —
// this runs on every login-screen mount, most of which never touch offline
// play. Returns null when the browser can't be probed non-creatingly
// (indexedDB.databases missing); callers fall back to the offline-state
// record's guess.
export async function hasOfflineSave(): Promise<boolean | null> {
  try {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return null
    const dbs = await indexedDB.databases()
    if (!dbs.some((d) => d.name === MOUNT)) return false
    const db = await openRaw()
    try {
      if (!db.objectStoreNames.contains(STORE)) return false
      const keys = await request(db.transaction(STORE, 'readonly').objectStore(STORE)
        .getAllKeys(IDBKeyRange.bound(`${MOUNT}/saves/`, `${MOUNT}/saves/\uffff`)))
      return keys.some((k) => typeof k === 'string' && /^[^/]+\.cs$/.test(k.slice(`${MOUNT}/saves/`.length)))
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

// Snapshot every real file under the mount (one readonly transaction —
// atomic vs the engine's own syncfs batches), minus regenerable caches.
export async function readOfflineFiles(): Promise<SavedFile[]> {
  const db = await openDb()
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    // Both getAll* return ascending key order, so index i pairs up.
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
    const out: SavedFile[] = []
    keys.forEach((key, i) => {
      if (typeof key !== 'string' || !key.startsWith(`${MOUNT}/`) || isRegenerable(key)) return
      const v = values[i] as { timestamp?: unknown; mode?: unknown; contents?: unknown } | undefined
      const c = v?.contents
      if (c == null) return // directory entry
      let data: Uint8Array
      if (c instanceof ArrayBuffer) data = new Uint8Array(c.slice(0))
      else if (ArrayBuffer.isView(c)) data = new Uint8Array(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength))
      else return
      const ts = v?.timestamp
      out.push({
        path: key,
        mode: typeof v?.mode === 'number' ? v.mode : 0o100664,
        mtimeMs: ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts : Date.now(),
        data,
      })
    })
    return out
  } finally {
    db.close()
  }
}

// Write files (plus synthesized parent-directory entries — a fresh device
// has none) in one readwrite transaction. Existing entries at the same paths
// are overwritten; nothing else is touched.
export async function writeOfflineFiles(files: SavedFile[]): Promise<number> {
  const db = await openDb()
  try {
    const txn = db.transaction(STORE, 'readwrite')
    const store = txn.objectStore(STORE)
    const dirs = new Set<string>()
    for (const f of files) {
      let d = f.path
      while ((d = d.slice(0, d.lastIndexOf('/'))).length >= MOUNT.length) dirs.add(d)
    }
    // 0o40775: directory bit + the permissions Emscripten's mkdir defaults to.
    for (const d of dirs) store.put({ timestamp: new Date(), mode: 0o40775 }, d)
    for (const f of files) store.put({ timestamp: new Date(f.mtimeMs), mode: f.mode, contents: f.data }, f.path)
    await txnDone(txn)
    return files.length
  } finally {
    db.close()
  }
}
