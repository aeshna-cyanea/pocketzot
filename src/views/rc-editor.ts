// Full-screen editor for the offline engine's options (RC) file.
//
// The engine reads /crawl/init.txt on every boot: pre.js sets
// ENV.CRAWL_DIR = '/crawl/', and find_crawlrc()'s first candidate is
// {crawl_dir}/init.txt (initfile.cc) — no -rc argv needed. The file lives
// inside the IDBFS mount, so the backup Export packs it automatically (it's
// not on save-transfer's regenerable-exclusion list). Editing is only safe
// while no engine runs — the offline lobby (the sole caller) is mounted
// exactly then; a live engine's next persist would clobber the write.
//
// Escape discards; only Save writes.

import { readOfflineFile, writeOfflineFiles } from '../offline/save-transfer'
import { mountOverlay } from './overlay'

const RC_PATH = '/crawl/init.txt'

// Seeded into the textarea as real starter content when no rc exists yet —
// enabling an example is deleting its '#', not retyping the line. It only
// becomes a file on Save.
const DEFAULT_RC = [
  '# Crawl options, one per line.',
  '# For example:',
  '# default_manual_training = true',
  '# show_travel_trail = true',
  '# travel_delay = -1',
  '',
].join('\n')

export async function openRcEditor(onSaved: (notice: string) => void): Promise<void> {
  const existing = await readOfflineFile(RC_PATH)

  const el = document.createElement('div')
  el.className = 'rc-editor'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.setAttribute('aria-label', 'Options file')
  el.innerHTML = `
    <div class="rc-editor-header">
      <span class="rc-editor-title">Options file</span>
      <span class="rc-editor-path">init.txt</span>
    </div>
    <textarea class="rc-editor-text" spellcheck="false" autocapitalize="off"
              autocorrect="off" autocomplete="off"></textarea>
    <div class="rc-editor-error" role="alert" hidden></div>
    <div class="rc-editor-footer">
      <button type="button" class="rc-editor-esc" aria-label="Discard">⎋</button>
      <button type="button" class="rc-editor-save">Save</button>
    </div>
  `
  const text = el.querySelector<HTMLTextAreaElement>('.rc-editor-text')!
  // An existing file (even an emptied one) shows as-is; only a never-created
  // rc gets the starter template.
  text.value = existing ? new TextDecoder().decode(existing) : DEFAULT_RC

  const close = mountOverlay(el)
  el.querySelector('.rc-editor-esc')!.addEventListener('click', close)

  const saveBtn = el.querySelector<HTMLButtonElement>('.rc-editor-save')!
  const errEl = el.querySelector<HTMLElement>('.rc-editor-error')!
  saveBtn.addEventListener('click', () => {
    saveBtn.disabled = true
    void writeOfflineFiles([{
      path: RC_PATH,
      mode: 0o100664,
      mtimeMs: Date.now(),
      data: new TextEncoder().encode(text.value),
    }]).then(() => {
      close()
      onSaved('Options saved.')
    }).catch((e: unknown) => {
      saveBtn.disabled = false
      errEl.hidden = false
      errEl.textContent = `Could not save: ${e instanceof Error ? e.message : String(e)}`
    })
  })

  // Desktop convenience only: on touch devices an auto-focus would throw the
  // keyboard over half the screen before the user has read anything.
  if (navigator.maxTouchPoints === 0) text.focus()
}
