/**
 * "Go to line" panel (Ctrl-g, like VS Code on every platform). Accepts `120`,
 * `120:8` (line:column), `+20` / `-20` (relative) and `50%` (of the document).
 * Translate it with the editor's `phrases` option (`Go to line`, `Line`).
 */
import type { Editor, Extension } from '../editor.ts'
import type { Command, KeyBinding } from '../keymap.ts'
import type { Pos } from '../state/text.ts'
import { injectStyle } from '../view/style.ts'

const panels = new WeakMap<Editor, { open(): void; close(): boolean }>()

/** Parses what the user typed into a position (null when invalid). */
export function parseLineTarget(input: string, editor: Editor): Pos | null {
  const m = /^\s*([+-]?)(\d+)(%?)(?:\s*[:,]\s*(\d+))?\s*$/.exec(input)
  if (!m) return null
  const count = editor.doc.lineCount
  const n = Number(m[2])
  const current = editor.selection.head.line
  let line = m[3] ? Math.round((n / 100) * (count - 1)) : m[1] === '+' ? current + n : m[1] === '-' ? current - n : n - 1
  line = Math.max(0, Math.min(count - 1, line))
  const col = m[4] ? Math.max(0, Number(m[4]) - 1) : 0
  return { line, col: Math.min(col, editor.doc.line(line).length) }
}

export const openGotoLine: Command = (ed) => {
  const panel = panels.get(ed)
  if (!panel) return false
  panel.open()
  return true
}

export const gotoLineKeymap: readonly KeyBinding[] = [
  { key: 'Ctrl-g', run: openGotoLine },
  { key: 'Escape', run: (ed) => panels.get(ed)?.close() ?? false },
]

export function gotoLine(): Extension {
  return (editor) => {
    injectStyle(editor.dom, 'goto-line', GOTO_CSS)
    const doc = editor.dom.ownerDocument
    const dom = doc.createElement('form')
    dom.className = 'jc-goto'
    dom.hidden = true
    dom.innerHTML = '<label><span></span><input type="text" inputmode="numeric" autocomplete="off" spellcheck="false"></label><small></small>'
    const label = dom.querySelector('span')!
    const input = dom.querySelector('input')!
    const hint = dom.querySelector('small')!
    editor.dom.appendChild(dom)

    const close = () => {
      if (dom.hidden) return false
      dom.hidden = true
      editor.focus()
      return true
    }
    const open = () => {
      label.textContent = editor.phrase('Go to line')
      hint.textContent = `1–${editor.doc.lineCount.toLocaleString()}`
      input.placeholder = `${editor.selection.head.line + 1}`
      input.setAttribute('aria-label', editor.phrase('Line'))
      input.classList.remove('jc-goto-invalid')
      dom.hidden = false
      input.value = ''
      input.focus()
    }
    dom.addEventListener('mousedown', (e) => e.stopPropagation())
    dom.addEventListener('submit', (e) => {
      e.preventDefault()
      const pos = parseLineTarget(input.value || input.placeholder, editor)
      if (!pos) {
        input.classList.add('jc-goto-invalid')
        return
      }
      close()
      editor.dispatch({ selection: { anchor: pos, head: pos }, scrollIntoView: 'center', origin: 'select.goto' })
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    })
    input.addEventListener('input', () => input.classList.remove('jc-goto-invalid'))
    panels.set(editor, { open, close })
    editor.addKeymap(gotoLineKeymap, 'high')
    return () => {
      dom.remove()
      panels.delete(editor)
    }
  }
}

const GOTO_CSS = `
.jc-goto{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:11;display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:10px;
background:color-mix(in srgb,var(--jc-bg) 88%,var(--jc-fg));border:1px solid color-mix(in srgb,var(--jc-fg) 16%,transparent);box-shadow:0 10px 30px -10px #0008;
font:13px/1 var(--jc-ui-font,system-ui,sans-serif);color:var(--jc-fg);max-width:calc(100% - 24px)}
.jc-goto[hidden]{display:none}
.jc-goto label{display:flex;align-items:center;gap:8px;white-space:nowrap}
.jc-goto input{width:110px;height:26px;padding:0 8px;border-radius:6px;border:1px solid color-mix(in srgb,var(--jc-fg) 18%,transparent);
background:var(--jc-bg);color:var(--jc-fg);font:13px var(--jc-font-family,ui-monospace,monospace);outline:none}
.jc-goto input:focus{border-color:var(--jc-caret)}
.jc-goto input.jc-goto-invalid{border-color:#e06c75}
.jc-goto small{opacity:.6;font-variant-numeric:tabular-nums;white-space:nowrap}
`
