/**
 * Inline edit with AI (Mod-k, like Cursor): a prompt opens above the selected
 * lines; the instruction goes to a source — your function, calling whatever
 * model you like — and its answer streams into a preview below them. The
 * document isn't touched while it streams (keep editing elsewhere; the target
 * follows your edits). When it ends, the lines are replaced in one undo step,
 * unless you changed them meanwhile: then nothing is overwritten and the
 * result stays there to copy or ask again. With an empty selection the
 * cursor's line is the target (on a blank line: code is written there).
 * Translate it with the `phrases` option.
 *
 * ```ts
 * inlineEdit(async function* ({ instruction, text, before, after, language }, signal) {
 *   yield* streamFromMyModel(`Rewrite this ${language} code: ${instruction}\n${text}`, signal)
 * }, { onApply: (ed, before) => setOriginal(ed, before) })   // review it with diffView
 * ```
 */
import { setDecorations, type Decoration } from '../decorations.ts'
import type { Editor, Extension } from '../editor.ts'
import type { Command, KeyBinding } from '../keymap.ts'
import { selFrom, selTo } from '../state/selection.ts'
import { cmpPos, mapPos, type Pos } from '../state/text.ts'
import { tokenClass } from '../theme/theme.ts'
import { escapeHTML } from '../util/text.ts'
import { injectStyle } from '../view/style.ts'

export interface InlineEditRequest {
  /** What the user typed. */
  instruction: string
  /** The selected text, extended to whole lines (the part to rewrite). */
  text: string
  /** Its range (whole lines). */
  from: Pos
  to: Pos
  /** Text around it (≈2000 chars before, 1000 after, whole lines): `before + text + after` is that part of the document. */
  before: string
  after: string
  /** Name of the language at `from`. */
  language: string
  editor: Editor
}

/** Returns the replacement for `text`: a string, a Promise, or an async iterable of chunks (streaming). */
export type InlineEditSource = (request: InlineEditRequest, signal: AbortSignal) =>
  string | Promise<string> | AsyncIterable<string>

export interface InlineEditOptions {
  /** Called right before the replacement is applied, with the document before it — e.g. `(ed, before) => setOriginal(ed, before)` to review it with diffView. */
  onApply?: (editor: Editor, before: string, range: { from: Pos; to: Pos }) => void
  /** Placeholder of the instruction field. */
  placeholder?: string
}

// ---------------------------------------------------------------------------
// Helpers (pure)

/** Lines `from..to` as a range (start of the first, end of the last). */
export function wholeLines(doc: { line(n: number): string }, from: number, to: number): { from: Pos; to: Pos } {
  return { from: { line: from, col: 0 }, to: { line: to, col: doc.line(to).length } }
}

/** The whole lines a selection touches (one ending at column 0 of a line leaves that line out). */
export function editRange(doc: { line(n: number): string }, from: Pos, to: Pos): { from: Pos; to: Pos } {
  return wholeLines(doc, from.line, to.col || to.line === from.line ? to.line : to.line - 1)
}

/**
 * Removes a ``` fence wrapping the whole answer — also a partial one while it
 * streams in (an opening line not finished yet, a closing fence half typed).
 */
export function stripFence(text: string): string {
  if (/^\s*(`{1,2}|```[\w.+#-]*)$/.test(text)) return ''
  const open = /^\s*```[^\n`]*\n/.exec(text)
  return open ? text.slice(open[0].length).replace(/(^|\n)`{1,3}\s*$/, '') : text
}

/** Fits a model's answer to the text it replaces: no wrapping fence (unless the text has one) and no extra final line break. */
export function cleanResult(result: string, original: string): string {
  if (!/^\s*```/.test(original)) result = stripFence(result)
  return !original.endsWith('\n') && result.endsWith('\n') ? result.slice(0, -1) : result
}

/** Text before and after a range, whole lines, at most `max` chars each (the lines are joined with `\n`). */
export function surroundings(lines: readonly string[], from: Pos, to: Pos, max: [number, number] = [2000, 1000]): { before: string; after: string } {
  let before = lines[from.line]!.slice(0, from.col)
  for (let l = from.line - 1; l >= 0 && before.length < max[0]; l--) before = lines[l] + '\n' + before
  if (before.length > max[0]) before = before.slice(before.indexOf('\n', before.length - max[0] - 1) + 1)
  let after = lines[to.line]!.slice(to.col)
  for (let l = to.line + 1; l < lines.length && after.length < max[1]; l++) after += '\n' + lines[l]
  if (after.length > max[1]) after = after.slice(0, Math.max(0, after.lastIndexOf('\n', max[1])))
  return { before, after }
}

// ---------------------------------------------------------------------------
// Commands

const controllers = new WeakMap<Editor, { open(): boolean; close(): boolean }>()

/** Opens the prompt for the selected lines (or focuses it while an edit is running). */
export const openInlineEdit: Command = (ed) => controllers.get(ed)?.open() ?? false
/** Stops the running edit and closes the prompt (false when it isn't open). */
export const cancelInlineEdit: Command = (ed) => controllers.get(ed)?.close() ?? false

export const inlineEditKeymap: readonly KeyBinding[] = [
  { key: 'Mod-k', run: openInlineEdit },
  { key: 'Escape', run: cancelInlineEdit },
]

// ---------------------------------------------------------------------------
// The extension

const SET = 'ai-inline-edit'
/** Preview rows shown at most (it scrolls past that). */
const MAX_ROWS = 15

interface Session {
  from: Pos
  to: Pos
  /** `idle`: typing the instruction; `busy`: the answer is streaming; `done`: answered but not applied (the code changed). */
  phase: 'idle' | 'busy' | 'done'
  abort?: AbortController
  /** The text sent, and the answer so far. */
  text: string
  result: string
  message: string
}

/** Inline edit with AI on Mod-k: `source` rewrites the selected lines following the user's instruction. */
export function inlineEdit(source: InlineEditSource, options: InlineEditOptions = {}): Extension {
  return (editor) => {
    injectStyle(editor.dom, 'ai-inline-edit', INLINE_EDIT_CSS)
    const doc = editor.dom.ownerDocument
    const t = (s: string) => editor.phrase(s)
    const prompt = doc.createElement('div')
    prompt.className = 'jc-ie'
    prompt.innerHTML = '<div class="jc-ie-box"><span class="jc-ie-icon" aria-hidden="true">✦</span>' +
      '<input type="text" autocomplete="off" spellcheck="false"><small></small><button type="button" class="jc-ie-copy"></button>' +
      '<button type="button" class="jc-ie-send"></button><button type="button" class="jc-ie-close">✕</button></div><div class="jc-ie-msg" aria-live="polite"></div>'
    const [input, hint, copy, send, closer, msg] = ['input', 'small', '.jc-ie-copy', '.jc-ie-send', '.jc-ie-close', '.jc-ie-msg']
      .map((q) => prompt.querySelector(q)) as [HTMLInputElement, HTMLElement, HTMLButtonElement, HTMLButtonElement, HTMLButtonElement, HTMLElement]
    const preview = doc.createElement('div')
    preview.className = 'jc-ie-preview'
    preview.innerHTML = '<pre></pre>'
    const pre = preview.firstChild as HTMLPreElement

    let s: Session | null = null
    let gen = 0
    let last = ''
    let frame = 0

    const colored = (text: string, from: Pos): string => {
      const lang = editor.languageAt(from)
      let state = lang.initialState
      return text.split('\n').map((line) => {
        const r = lang.tokenize(line, state)
        state = r.state
        return r.tokens.map((k) => {
          const x = escapeHTML(line.slice(k.from, k.to))
          return k.type ? `<span class="${tokenClass(k.type)}">${x}</span>` : x
        }).join('')
      }).join('\n')
    }

    const paint = () => {
      frame = 0
      if (editor.isDestroyed) return
      if (!s) return setDecorations(editor, SET, [])
      const { from, to, phase, result } = s
      const busy = phase === 'busy'
      prompt.classList.toggle('jc-ie-busy', busy)
      input.readOnly = busy
      input.placeholder = options.placeholder ?? t('Edit with AI… (Enter to send, Esc to cancel)')
      input.setAttribute('aria-label', t('Edit with AI'))
      hint.textContent = busy ? t('Generating…')
        : from.line === to.line ? t('Line {line}').replace('{line}', String(from.line + 1))
        : t('Lines {from}–{to}').replace('{from}', String(from.line + 1)).replace('{to}', String(to.line + 1))
      send.textContent = busy ? t('Stop') : t('Send')
      copy.textContent = t('Copy')
      copy.hidden = phase !== 'done'
      closer.title = t('Close')
      closer.setAttribute('aria-label', closer.title)
      msg.textContent = s.message
      const decos: Decoration[] = [{ from: { line: from.line, col: 0 }, block: 'above', lines: s.message ? 3 : 2, widget: prompt }]
      if (busy || phase === 'done') {
        const follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4
        pre.innerHTML = result ? colored(result, from) : `<span class="jc-ie-wait">${escapeHTML(t('Generating…'))}</span>`
        if (follow) pre.scrollTop = pre.scrollHeight
        decos.push({ from: { line: to.line, col: 0 }, block: 'below', lines: Math.min(MAX_ROWS, result.split('\n').length), widget: preview })
      }
      const cls = phase === 'idle' ? 'jc-ie-target' : 'jc-ie-old'
      for (let l = from.line; l <= Math.min(to.line, from.line + 999); l++) decos.push({ from: { line: l, col: 0 }, line: true, class: cls })
      setDecorations(editor, SET, decos)
    }

    /** Repaints on the next frame (streamed chunks and edits arrive faster than that). */
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint)
    }

    const close = (refocus = false): boolean => {
      if (!s) return false
      s.abort?.abort()
      s = null
      gen++
      paint()
      if (refocus) editor.focus()
      return true
    }

    const open = (): boolean => {
      if (editor.options.readOnly) return false
      if (s?.phase === 'busy') {
        input.focus()
        return true
      }
      const keep = s ? input.value : ''
      close()
      const sel = editor.selection
      const range = editRange(editor.doc, selFrom(sel), selTo(sel))
      s = { ...range, phase: 'idle', text: '', result: '', message: '' }
      input.value = keep
      paint()
      // The prompt exists once its line is rendered: bring it to the middle when it's off screen.
      const view = editor.scrollDOM.getBoundingClientRect()
      const top = editor.contentDOM.getBoundingClientRect().top + editor.coordsAtPos(range.from).top
      if (top - 2 * editor.lineHeight < view.top || top + editor.lineHeight > view.bottom) editor.scrollIntoView(range.from, true)
      editor.flush()
      input.focus()
      if (!input.isConnected) requestAnimationFrame(() => input.focus())
      return true
    }

    const stop = () => {
      if (s?.phase !== 'busy') return
      s.abort?.abort()
      gen++
      Object.assign(s, { phase: 'idle', result: '', message: '' })
      paint()
      input.focus()
    }

    const fail = (session: Session, message: string) => {
      Object.assign(session, { phase: 'idle', result: '', message })
      paint()
    }

    const finish = (session: Session, result: string) => {
      const { from, to } = session
      if (cmpPos(from, to) > 0 || editor.doc.slice(from, to) !== session.text) {
        Object.assign(session, { phase: 'done', result, message: t('The code changed while the AI was writing: nothing was replaced. Send again, or copy the result.') })
        return paint()
      }
      const waiting = !editor.hasFocus
      const refocus = prompt.contains((prompt.getRootNode() as Document).activeElement)
      last = input.value
      input.value = ''
      close()
      if (result !== session.text) {
        try {
          options.onApply?.(editor, editor.getValue(), { from, to })
        } catch (e) {
          console.error('[jonacode] onApply failed', e)
        }
        const lines = result.split('\n')
        const end = { line: from.line + lines.length - 1, col: (lines.length > 1 ? 0 : from.col) + lines[lines.length - 1]!.length }
        // Someone typing elsewhere keeps their cursor; otherwise the new code is selected.
        editor.dispatch({
          changes: { from, to, insert: result }, origin: 'ai.edit',
          ...(waiting && { selection: { anchor: from, head: end }, scrollIntoView: true }),
        })
      }
      if (refocus) editor.focus()
    }

    const submit = () => {
      const instruction = input.value.trim()
      if (!s || s.phase === 'busy' || !instruction) return
      const session = s
      // Whole lines again: edits may have moved the ends.
      Object.assign(session, wholeLines(editor.doc, session.from.line, Math.max(session.from.line, session.to.line)))
      const { from, to } = session
      const text = editor.doc.slice(from, to)
      const ctl = new AbortController()
      const g = ++gen
      Object.assign(session, { phase: 'busy', abort: ctl, text, result: '', message: '' })
      last = instruction
      paint()
      const request: InlineEditRequest = {
        instruction, text, from, to, ...surroundings(editor.doc.lines, from, to), language: editor.languageAt(from).name, editor,
      }
      const failed = (e: unknown) => {
        if (g !== gen || ctl.signal.aborted) return
        const why = String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 160)
        fail(session, t('The AI request failed') + (why ? ': ' + why : ''))
      }
      let answer = ''
      const update = (chunk: string) => {
        if (g !== gen) return
        session.result = cleanResult((answer += chunk), text)
        schedule()
      }
      Promise.resolve().then(() => source(request, ctl.signal)).then(async (res) => {
        if (typeof res === 'string') answer = res
        else for await (const chunk of res) {
          if (ctl.signal.aborted) return
          update(chunk)
        }
        if (g === gen && !ctl.signal.aborted) finish(session, cleanResult(answer, text))
      }).catch(failed)
    }

    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return
      const key = e.key
      if (key === 'Enter' && !e.shiftKey) submit()
      else if (key === 'Escape') s?.phase === 'busy' ? stop() : close(true)
      else if (key === 'ArrowUp' && !input.value && last) input.value = last
      else if (!((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'k')) return
      e.preventDefault()
    })
    // Clicks on the prompt keep the focus in the field.
    prompt.addEventListener('mousedown', (e) => {
      if (e.target === input) return
      e.preventDefault()
      input.focus()
    })
    send.addEventListener('click', () => (s?.phase === 'busy' ? stop() : submit()))
    closer.addEventListener('click', () => close(true))
    copy.addEventListener('click', () => void navigator.clipboard?.writeText(s?.result ?? '').catch(() => {}))
    // Clicking elsewhere before sending anything cancels.
    prompt.addEventListener('focusout', () => setTimeout(() => {
      const active = (prompt.getRootNode() as Document).activeElement
      if (s?.phase === 'idle' && !s.message && prompt.isConnected && doc.hasFocus() && !prompt.contains(active)) close()
    }))

    controllers.set(editor, { open, close: () => close(true) })
    editor.addKeymap(inlineEditKeymap, 'high')
    editor.on('change', (e) => {
      if (!s) return
      if (e.origin === 'setValue') return void close()
      // The target follows the edits (text typed right before or after it stays out).
      for (const c of e.changes) {
        s.from = mapPos(s.from, c, 1)
        s.to = mapPos(s.to, c, -1)
      }
      schedule()
    })

    return () => {
      close()
      cancelAnimationFrame(frame)
      controllers.delete(editor)
    }
  }
}

const INLINE_EDIT_CSS = `
.jc-block.jc-ie{padding:0 12px 0 var(--jc-pad-x);font:13px/1.3 var(--jc-ui-font,system-ui,-apple-system,sans-serif);color:var(--jc-fg);font-style:normal}
.jc-ie-box{display:flex;align-items:center;gap:4px;box-sizing:border-box;height:calc(2 * var(--jc-lh) - 8px);max-width:640px;margin:4px 0;padding:0 3px 0 10px;
border-radius:8px;background:color-mix(in srgb,var(--jc-bg) 88%,var(--jc-fg));border:1px solid color-mix(in srgb,var(--jc-fg) 16%,transparent);
box-shadow:0 6px 18px -10px #0009}
.jc-ie-box:focus-within{border-color:color-mix(in srgb,var(--jc-ai-accent,#a78bfa) 70%,transparent)}
.jc-ie-icon{color:var(--jc-ai-accent,#a78bfa);font-size:12px}
.jc-ie-busy .jc-ie-icon{animation:jc-ie-pulse .8s ease-in-out infinite alternate}
@keyframes jc-ie-pulse{to{opacity:.25}}
.jc-ie input{flex:1;min-width:60px;height:100%;padding:0 4px;border:0;outline:0;background:none;color:inherit;font:inherit}
.jc-ie input::placeholder{color:color-mix(in srgb,var(--jc-fg) 45%,transparent)}
.jc-ie input:read-only{opacity:.6}
.jc-ie small{padding:0 4px;font-size:12px;opacity:.55;white-space:nowrap;font-variant-numeric:tabular-nums}
.jc-ie button{flex:none;height:calc(2 * var(--jc-lh) - 18px);max-height:28px;min-width:26px;padding:0 9px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;cursor:pointer;opacity:.75}
.jc-ie button:hover{opacity:1;background:color-mix(in srgb,var(--jc-fg) 12%,transparent)}
.jc-ie .jc-ie-send{opacity:1;background:color-mix(in srgb,var(--jc-ai-accent,#a78bfa) 24%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--jc-ai-accent,#a78bfa) 50%,transparent)}
.jc-ie .jc-ie-send:hover{background:color-mix(in srgb,var(--jc-ai-accent,#a78bfa) 38%,transparent)}
.jc-ie button[hidden]{display:none}
.jc-ie-msg{height:var(--jc-lh);line-height:var(--jc-lh);padding-left:10px;font-size:12px;color:var(--jc-error,#e06c75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jc-ie-msg:empty{display:none}
.jc-block.jc-ie-preview{background:var(--jc-ai-insert,color-mix(in srgb,#3fb950 13%,var(--jc-bg)));box-shadow:inset 3px 0 color-mix(in srgb,#3fb950 70%,transparent)}
.jc-ie-preview pre{box-sizing:border-box;height:100%;margin:0;padding-left:var(--jc-pad-x);overflow:auto;font:inherit;line-height:var(--jc-lh);
white-space:pre;tab-size:var(--jc-tab-size,4);color:var(--jc-fg);scrollbar-width:thin;scrollbar-color:var(--jc-scrollbar) transparent}
.jc-ie-wait{opacity:.5;font-style:italic;animation:jc-ie-pulse .8s ease-in-out infinite alternate}
.jc-ie-target{background:color-mix(in srgb,var(--jc-ai-accent,#a78bfa) 9%,transparent)}
.jc-ie-old{background:var(--jc-ai-delete,color-mix(in srgb,#f85149 12%,transparent))}
@media (prefers-reduced-motion:reduce){.jc-ie-busy .jc-ie-icon,.jc-ie-wait{animation:none}}
`
