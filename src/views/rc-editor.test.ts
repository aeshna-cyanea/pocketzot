// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedFile } from '../offline/save-transfer'

// The editor's only IO is these two save-transfer calls; fake them so the
// tests need no IndexedDB (happy-dom has none).
const readOfflineFile = vi.fn<(path: string) => Promise<Uint8Array | null>>()
const writeOfflineFiles = vi.fn<(files: SavedFile[]) => Promise<number>>()
vi.mock('../offline/save-transfer', () => ({
  readOfflineFile: (path: string) => readOfflineFile(path),
  writeOfflineFiles: (files: SavedFile[]) => writeOfflineFiles(files),
}))

import { openRcEditor } from './rc-editor'

const onSaved = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  readOfflineFile.mockResolvedValue(null)
  writeOfflineFiles.mockResolvedValue(1)
})

afterEach(() => {
  document.body.innerHTML = ''
})

const textarea = () => document.querySelector<HTMLTextAreaElement>('.rc-editor-text')!
const button = (cls: string) => document.querySelector<HTMLButtonElement>(cls)!

// Editor writes resolve through promise chains; flush microtasks.
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('openRcEditor', () => {
  it('loads the existing rc into the textarea', async () => {
    readOfflineFile.mockResolvedValue(new TextEncoder().encode('rest_delay = -1\n'))
    await openRcEditor(onSaved)
    expect(readOfflineFile).toHaveBeenCalledWith('/crawl/init.txt')
    expect(textarea().value).toBe('rest_delay = -1\n')
  })

  it('seeds the commented starter template when no rc exists', async () => {
    await openRcEditor(onSaved)
    expect(textarea().value).toContain('# default_manual_training = true')
    // Every template line is a comment — saving it untouched must be inert.
    for (const line of textarea().value.split('\n')) {
      if (line !== '') expect(line.startsWith('#')).toBe(true)
    }
  })

  it('shows an existing-but-emptied rc as-is, not the template', async () => {
    readOfflineFile.mockResolvedValue(new Uint8Array(0))
    await openRcEditor(onSaved)
    expect(textarea().value).toBe('')
  })

  it('Save writes the edited text to /crawl/init.txt, closes, and notifies', async () => {
    await openRcEditor(onSaved)
    textarea().value = 'show_more = false\n'
    button('.rc-editor-save').click()
    await settle()
    expect(writeOfflineFiles).toHaveBeenCalledTimes(1)
    const files = writeOfflineFiles.mock.calls[0]![0]
    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe('/crawl/init.txt')
    expect(new TextDecoder().decode(files[0]!.data)).toBe('show_more = false\n')
    expect(document.querySelector('.rc-editor')).toBeNull()
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('Esc discards without writing', async () => {
    readOfflineFile.mockResolvedValue(new TextEncoder().encode('original'))
    await openRcEditor(onSaved)
    textarea().value = 'edited but abandoned'
    button('.rc-editor-esc').click()
    expect(writeOfflineFiles).not.toHaveBeenCalled()
    expect(document.querySelector('.rc-editor')).toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('the Escape key discards without writing', async () => {
    await openRcEditor(onSaved)
    textarea().value = 'edited'
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(writeOfflineFiles).not.toHaveBeenCalled()
    expect(document.querySelector('.rc-editor')).toBeNull()
  })

  it('a failed write keeps the editor open and shows the error', async () => {
    writeOfflineFiles.mockRejectedValue(new Error('quota exceeded'))
    await openRcEditor(onSaved)
    textarea().value = 'x'
    button('.rc-editor-save').click()
    await settle()
    expect(document.querySelector('.rc-editor')).not.toBeNull()
    const err = document.querySelector<HTMLElement>('.rc-editor-error')!
    expect(err.hidden).toBe(false)
    expect(err.textContent).toContain('quota exceeded')
    expect(button('.rc-editor-save').disabled).toBe(false)
    expect(onSaved).not.toHaveBeenCalled()
  })
})
