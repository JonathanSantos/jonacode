/**
 * Inline suggestions ("ghost text"): when typing stops, a source — your
 * function, calling whatever model you like — is asked for the text that
 * should follow the cursor, and it's shown dimmed in place. Tab accepts it
 * (one undo step), Mod-ArrowRight accepts the next word, Escape dismisses it
 * and Alt-\ asks right away. Typing the suggested characters keeps it; any
 * other edit or cursor move drops it and aborts the request. Sources may
 * stream (async iterables). Themes can set the color with `--jc-ghost`;
 * translate the screen reader text with the `phrases` option.
 *
 * ```ts
 * inlineSuggestion(async function* ({ prefix, suffix, language }, signal) {
 *   const res = await fetch('/complete', { method: 'POST', body: JSON.stringify({ prefix, suffix, language }), signal })
 *   const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
 *   for (let r; !(r = await reader.read()).done;) yield r.value
 * })
 * ```
 */
import { setDecorations, type Decoration } from '../decorations.ts'
import type { ChangeEvent, Editor, Extension } from '../editor.ts'
import type { Command, KeyBinding } from '../keymap.ts'
import { isEmpty } from '../state/selection.ts'
import { cmpPos, eqPos, type Pos } from '../state/text.ts'
import { tokenClass } from '../theme/theme.ts'
import { charCategory, escapeHTML } from '../util/text.ts'
import { injectStyle } from '../view/style.ts'
import { fimContext } from './context.ts'

export interface SuggestionRequest {
  /** Text before the cursor. */
  prefix: string
  /** Text after the cursor. */
  suffix: string
  /** Name of the editor's language. */
  language: string
  /** Cursor line and column, 0-based. */
  line: number
  col: number
  editor: Editor
}

/** Returns the text to insert at the cursor: a string, a Promise, or an async iterable of chunks (streaming). Abort when `signal` fires. */
export type SuggestionSource = (request: SuggestionRequest, signal: AbortSignal) =>
  string | null | undefined | Promise<string | null | undefined> | AsyncIterable<string>

export interface InlineSuggestionOptions {
  /** Ask automatically after typing stops for this long (ms, default 350). */
  delay?: number
  /** Ask automatically while typing (default true); false = only with the trigger key. */
  auto?: boolean
  /** Extra condition to ask (default: single empty cursor, not read-only, and the rest of the line is empty or only closing brackets/quotes/punctuation). */
  when?: (editor: Editor) => boolean
  /** Called when a suggestion (or part of it) is accepted. */
  onAccept?: (text: string, editor: Editor) => void
}

// ---------------------------------------------------------------------------
// Helpers (pure)

const CLOSING = /^[\s)\]}>'"`;,.:]*$/

/** Whether the rest of a line leaves room for a suggestion: empty, or only closing brackets, quotes and punctuation. */
export const suggestsAfter = (rest: string): boolean => CLOSING.test(rest)

/**
 * Cleans a raw suggestion for a cursor followed by `after`: drops trailing
 * whitespace and a tail that repeats the text after the cursor (FIM models
 * often write the `)` or `}` that's already there) — when that tail is only
 * closing punctuation, or ends where a line of `after` ends. Returns `''`
 * when nothing but whitespace is left.
 */
export function trimSuggestion(text: string, after: string): string {
  text = text.replace(/\s+$/, '')
  const last = text.charCodeAt(text.length - 1)
  for (let k = Math.min(text.length, after.length); k > 0; k--) {
    if (after.charCodeAt(k - 1) !== last) continue
    const tail = after.slice(0, k)
    if (tail.trim() && text.endsWith(tail) && (CLOSING.test(tail) || k === after.length || after[k] === '\n')) {
      text = text.slice(0, -k)
      break
    }
  }
  return text.trim() ? text : ''
}

/** What's left of `suggestion` after the user typed `typed` (null when they typed something else). */
export function typeThrough(suggestion: string, typed: string): string | null {
  return suggestion.startsWith(typed) ? suggestion.slice(typed.length) : null
}

/** The start of `text` up to the end of its next word (leading whitespace and line breaks included). */
export function nextWord(text: string, wordChars = ''): string {
  let i = 0
  while (i < text.length && /\s/.test(text[i]!)) i++
  const cat = i < text.length ? charCategory(text[i]!, wordChars) : 0
  while (i < text.length && text[i] !== '\n' && charCategory(text[i]!, wordChars) === cat) i++
  return text.slice(0, i)
}

/** Reads a source's answer: a string, a Promise, or chunks (`update` gets the text so far). */
async function drain(
  res: ReturnType<SuggestionSource>, signal: AbortSignal, update: (text: string) => void,
): Promise<string> {
  const r = await res
  if (r == null || typeof r === 'string') return r ?? ''
  let text = ''
  for await (const chunk of r) {
    if (signal.aborted) break
    update((text += chunk))
  }
  return text
}

// ---------------------------------------------------------------------------
// Commands

interface Controller {
  accept(word: boolean): boolean
  dismiss(): boolean
  request(manual: boolean): boolean
  show(text: string): void
  text(): string
}

const controllers = new WeakMap<Editor, Controller>()

/** Inserts the whole suggestion (false when none is shown). */
export const acceptSuggestion: Command = (ed) => controllers.get(ed)?.accept(false) ?? false
/** Inserts the suggestion up to the end of its next word. */
export const acceptSuggestionWord: Command = (ed) => controllers.get(ed)?.accept(true) ?? false
/** Hides the suggestion and aborts the request (false when none was shown). */
export const dismissSuggestion: Command = (ed) => controllers.get(ed)?.dismiss() ?? false
/** Asks for a suggestion now, wherever the cursor is. */
export const requestSuggestion: Command = (ed) => controllers.get(ed)?.request(true) ?? false

export const suggestionKeymap: readonly KeyBinding[] = [
  { key: 'Tab', run: acceptSuggestion },
  { key: 'Mod-ArrowRight', run: acceptSuggestionWord },
  { key: 'Escape', run: dismissSuggestion },
  { key: 'Alt-\\', run: requestSuggestion },
]

/** Shows `text` as the suggestion at the cursor (for apps that fetch on their own; needs `inlineSuggestion()`). */
export function showSuggestion(editor: Editor, text: string): void {
  controllers.get(editor)?.show(text)
}

/** The suggestion shown now, as it would be inserted (null when there's none). */
export function currentSuggestion(editor: Editor): string | null {
  return controllers.get(editor)?.text() || null
}

// ---------------------------------------------------------------------------
// The extension

const SET = 'ai-suggestion'

const defaultWhen = (ed: Editor) => {
  const { head } = ed.selection
  return suggestsAfter(ed.doc.line(head.line).slice(head.col))
}

/** Text after `pos`: the rest of its line and a few more lines (for `trimSuggestion`). */
function textAfter(editor: Editor, pos: Pos): string {
  const { doc } = editor
  let s = doc.line(pos.line).slice(pos.col)
  for (let l = pos.line + 1; l < Math.min(doc.lineCount, pos.line + 10); l++) s += '\n' + doc.line(l)
  return s
}

/** Syntax-colored HTML of a line from `col` on. */
function restHTML(editor: Editor, pos: Pos): string {
  const text = editor.doc.line(pos.line)
  let html = ''
  if (pos.col < text.length) {
    for (const t of editor.getTokens(pos.line)) {
      if (t.to <= pos.col) continue
      const s = escapeHTML(text.slice(Math.max(t.from, pos.col), t.to))
      html += t.type ? `<span class="${tokenClass(t.type)}">${s}</span>` : s
    }
  }
  return html
}

/**
 * Inline suggestions from `source`, asked after typing stops (or with Alt-\).
 * `showSuggestion()` shows your own; `currentSuggestion()` reads it.
 */
export function inlineSuggestion(source: SuggestionSource, options: InlineSuggestionOptions = {}): Extension {
  const delay = options.delay ?? 350
  const when = options.when ?? defaultWhen
  return (editor) => {
    injectStyle(editor.dom, 'ai-suggest', SUGGEST_CSS)
    const doc = editor.dom.ownerDocument
    const div = (cls: string) => {
      const el = doc.createElement('div')
      el.className = cls
      return el
    }
    const inline = div('jc-ghost')
    const block = div('jc-ghost jc-ghost-block')
    const live = div('jc-sr-only')
    live.setAttribute('aria-live', 'polite')
    editor.dom.appendChild(live)

    /** Waiting to ask, asking or showing, for a cursor at `at`. */
    let active = false
    let streaming = false
    let at: Pos = { line: 0, col: 0 }
    /** The source's answer so far, and how much of it was typed or accepted since. */
    let raw = ''
    let skip = 0
    let gen = 0
    let told = -1
    let abort: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let sayTimer: ReturnType<typeof setTimeout> | undefined
    let accepting = false
    let queued = false
    let painted = false

    const shown = () => (active ? trimSuggestion(raw.slice(skip), textAfter(editor, at)) : '')

    const paint = () => {
      queued = false
      if (editor.isDestroyed) return
      const text = shown()
      if (!text) return clear()
      const lines = text.split('\n')
      const rest = restHTML(editor, at)
      const multi = lines.length > 1
      const tail = rest && `<span class="jc-ghost-rest"${multi ? ' style="visibility:hidden"' : ''}>${rest}</span>`
      // Over the rest of the line, the widget hides the real text with the line's background.
      inline.classList.toggle('jc-ghost-cover', !!rest)
      inline.classList.toggle('jc-ghost-active', !!editor.dom.querySelector('.jc-active-line-layer'))
      inline.innerHTML = escapeHTML(lines[0]!) + tail
      // Cut at the right edge of the content (it must not make the editor scroll).
      inline.style.maxWidth = Math.max(0, editor.contentDOM.clientWidth - editor.coordsAtPos(at).x) + 'px'
      const decos: Decoration[] = [{ from: at, widget: inline }]
      if (multi) {
        block.innerHTML = escapeHTML(lines.slice(1).join('\n')) + (rest && `<span class="jc-ghost-rest">${rest}</span>`)
        decos.push({ from: { line: at.line, col: 0 }, block: 'below', lines: lines.length - 1, widget: block })
      }
      setDecorations(editor, SET, decos)
      painted = true
      // Screen readers hear about each new suggestion once, when it stops changing.
      clearTimeout(sayTimer)
      const g = gen
      if (told !== g) sayTimer = setTimeout(() => {
        if (g !== gen || !shown()) return
        told = g
        const first = lines.find((l) => l.trim())!.trim()
        live.textContent = editor.phrase('Suggestion: {text}. Tab to accept.').replace('{text}', first)
      }, 600)
    }

    /** Repaints after the current transaction (decorations map positions through it first). */
    const schedule = () => {
      if (!queued) {
        queued = true
        queueMicrotask(paint)
      }
    }

    const clear = () => {
      if (painted) setDecorations(editor, SET, [])
      painted = false
    }

    const dismiss = (): boolean => {
      const had = !!shown()
      clearTimeout(timer)
      clearTimeout(sayTimer)
      abort?.abort()
      abort = null
      gen++
      active = streaming = false
      raw = ''
      skip = 0
      if (live.textContent) live.textContent = ''
      clear()
      return had
    }

    const request = (manual: boolean): boolean => {
      dismiss()
      const sel = editor.selection
      if (editor.options.readOnly || editor.ranges.length > 1 || !isEmpty(sel)) return false
      if (!manual && !(editor.hasFocus && when(editor))) return false
      active = streaming = true
      at = sel.head
      const g = gen
      const ctl = (abort = new AbortController())
      const update = (text: string) => {
        if (g !== gen) return
        raw = text
        schedule()
      }
      let res: ReturnType<SuggestionSource>
      try {
        res = source({ ...fimContext(editor), editor }, ctl.signal)
      } catch (e) {
        console.error('[jonacode] suggestion failed', e)
        dismiss()
        return true
      }
      drain(res, ctl.signal, update).then((text) => {
        if (g !== gen) return
        streaming = false
        update(text)
        if (!shown()) dismiss()
      }, (e) => {
        if (g !== gen) return
        if (!ctl.signal.aborted) console.error('[jonacode] suggestion failed', e)
        dismiss()
      })
      return true
    }

    /** The user typed the next chars of the suggestion: keep the rest. */
    const typedThrough = (e: ChangeEvent): boolean => {
      const text = shown()
      const c = e.changes[0]!
      const { head } = editor.selection
      if (!text || e.changes.length > 1 || !eqPos(c.from, at) || !eqPos(c.to, at) || editor.ranges.length > 1 ||
          !isEmpty(editor.selection) || cmpPos(head, at) <= 0) return false
      const typed = editor.doc.slice(at, head)
      const rest = typeThrough(text, typed)
      if (rest === null || (!rest && !streaming)) return false
      skip += typed.length
      at = head
      schedule()
      return true
    }

    const accept = (word: boolean): boolean => {
      const text = shown()
      // An open completion list keeps Tab.
      if (!text || (!word && editor.inputDOM.getAttribute('aria-expanded') === 'true')) return false
      const part = word ? nextWord(text, editor.languageAt(at).wordChars) : text
      const version = editor.version
      accepting = true
      try {
        // The cursor maps to the end of the inserted text.
        editor.dispatch({ changes: { from: at, insert: part }, origin: 'input.suggestion', scrollIntoView: true })
      } finally {
        accepting = false
      }
      if (editor.version === version) {
        dismiss()
        return true
      }
      skip += part.length
      at = editor.selection.head
      if (part === text && !streaming) dismiss()
      else schedule()
      options.onAccept?.(part, editor)
      return true
    }

    controllers.set(editor, {
      accept,
      dismiss,
      request,
      show: (text) => {
        dismiss()
        const sel = editor.selection
        if (editor.ranges.length > 1 || !isEmpty(sel)) return
        active = true
        at = sel.head
        raw = text
        schedule()
      },
      text: shown,
    })

    editor.addKeymap(suggestionKeymap, 'high')
    editor.on('change', (e) => {
      if (accepting || typedThrough(e)) return
      dismiss()
      if (options.auto !== false && (e.origin === 'input' || e.origin === 'input.complete')) {
        active = true
        at = editor.selection.head
        timer = setTimeout(() => request(false), delay)
      }
    })
    editor.on('selection', (sel) => {
      if (active && !accepting && (editor.ranges.length > 1 || !isEmpty(sel) || !eqPos(sel.head, at))) dismiss()
    })
    editor.on('blur', () => void dismiss())

    return () => {
      dismiss()
      live.remove()
      controllers.delete(editor)
    }
  }
}

const SUGGEST_CSS = `
.jc-widget.jc-ghost{z-index:-1;pointer-events:none;white-space:pre;tab-size:var(--jc-tab-size,4);overflow:hidden;text-overflow:ellipsis;
color:var(--jc-ghost,color-mix(in srgb,var(--jc-fg) 45%,transparent));font-style:italic}
.jc-ghost-cover{background:var(--jc-bg)}
.jc-ghost-cover.jc-ghost-active{background:linear-gradient(var(--jc-active-line),var(--jc-active-line)),var(--jc-bg)}
.jc-ghost-rest{color:var(--jc-fg);font-style:normal}
.jc-block.jc-ghost-block{padding-left:var(--jc-pad-x);white-space:pre}
.jc-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
`
