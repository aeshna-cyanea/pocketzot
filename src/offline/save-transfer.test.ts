import { describe, it, expect } from 'vitest'
import { packSave, unpackSave, type SavedFile } from './save-transfer'

function file(path: string, bytes: number[], mode = 0o100664, mtimeMs = 1_752_000_000_000): SavedFile {
  return { path, mode, mtimeMs, data: new Uint8Array(bytes) }
}

const META = { exportedAt: '2026-07-12T05:00:00.000Z', build: 'abc123' }

describe('save pack round-trip', () => {
  it('preserves files, metadata, modes and mtimes exactly', () => {
    const files = [
      file('/crawl/saves/local.cs', [0x00, 0xff, 0x7f, 0x80, 1, 2, 3]),
      file('/crawl/morgue/morgue-local-20260712.txt', Array.from('Goodbye, local.').map(c => c.charCodeAt(0))),
      file('/crawl/scores', [], 0o100600, 42),
    ]
    const { meta, files: out } = unpackSave(packSave(files, META))
    expect(meta).toEqual(META)
    expect(out).toEqual(files)
  })

  it('round-trips an empty file list', () => {
    const { meta, files } = unpackSave(packSave([], { exportedAt: 'x' }))
    expect(files).toEqual([])
    expect(meta.build).toBeUndefined()
  })

  it('accepts an ArrayBuffer input', () => {
    const pack = packSave([file('/crawl/scores', [9])], META)
    // Copy into a fresh buffer so byteOffset handling is exercised too.
    const buf = pack.slice().buffer
    expect(unpackSave(buf).files[0]!.data).toEqual(new Uint8Array([9]))
  })

  it('unpacked data is an independent copy, not a view into the pack', () => {
    const pack = packSave([file('/crawl/scores', [1, 2, 3])], META)
    const { files } = unpackSave(pack)
    // A subarray view would structured-clone the whole pack per record when
    // written to IndexedDB; require a compact copy.
    expect(files[0]!.data.buffer.byteLength).toBe(3)
  })
})

describe('save pack validation', () => {
  it('rejects non-pack bytes and truncated headers', () => {
    expect(() => unpackSave(new Uint8Array([1, 2, 3]))).toThrow(/too short/)
    expect(() => unpackSave(new Uint8Array(64))).toThrow(/bad magic/)
  })

  it('rejects a manifest length pointing past the buffer', () => {
    const pack = packSave([file('/crawl/scores', [9])], META)
    expect(() => unpackSave(pack.subarray(0, 20))).toThrow(/truncated/)
  })

  it('rejects file data extending past the buffer', () => {
    const pack = packSave([file('/crawl/scores', [1, 2, 3])], META)
    expect(() => unpackSave(pack.subarray(0, pack.byteLength - 1))).toThrow(/truncated \(\/crawl\/scores\)/)
  })

  it('rejects paths outside the mount and traversal segments', () => {
    for (const path of ['/etc/passwd', 'saves/local.cs', '/crawl/../evil', '/crawlother/x']) {
      const pack = packSave([{ path, mode: 0o100664, mtimeMs: 0, data: new Uint8Array([1]) }], META)
      expect(() => unpackSave(pack), path).toThrow(/outside \/crawl/)
    }
  })
})
