/**
 * Autocomplete: a list of completions under the cursor, fed by completion
 * sources — the language's words and the words of the document by default, or
 * your own (sync or async). Fuzzy matching (`gEBI` → `getElementById`), keys
 * (Ctrl-Space, arrows, PageUp/PageDown, Enter/Tab, Escape), mouse and touch,
 * and listbox semantics for screen readers. Translate it with the editor's
 * `phrases` option (`Completions`).
 */
import type { Editor, Extension } from '../editor.ts'
import type { Command, KeyBinding } from '../keymap.ts'
import type { Language } from '../language/language.ts'
import { isEmpty } from '../state/selection.ts'
import type { Pos } from '../state/text.ts'
import { tokenClass } from '../theme/theme.ts'
import { CHAR_WORD, charCategory, escapeHTML } from '../util/text.ts'
import { createFloating } from '../view/floating.ts'
import { injectStyle } from '../view/style.ts'

export interface Completion {
  label: string
  /** `keyword`, `variable`, `function`, `method`, `type`, `class`, `property`, `constant`, `snippet`, `text`… (sets the icon). */
  type?: string
  /** Short text shown dimmed after the label. */
  detail?: string
  /** Longer description, shown under the list while the option is selected. */
  info?: string
  /** Text inserted instead of the label, or a function doing the edit (`from..to` is the word being replaced). */
  apply?: string | ((editor: Editor, completion: Completion, from: Pos, to: Pos) => void)
  /** Ranking nudge (-99..99) among options that match equally well. */
  boost?: number
}

export interface CompletionContext {
  editor: Editor
  /** The cursor. */
  pos: Pos
  /**
   * The word being completed: `text` is its part before the cursor (the
   * query); `to` includes the word chars after the cursor, replaced on accept.
   */
  word: { from: Pos; to: Pos; text: string }
  /** Opened with Ctrl-Space (then `word.text` may be empty). */
  explicit: boolean
  /** Aborted when the result isn't needed anymore (the cursor left the word, the list closed). */
  signal: AbortSignal
}

/**
 * Returns the candidates for a word; the list filters and ranks them. It is
 * queried once per word start: typing or deleting inside the word only
 * re-filters.
 */
export type CompletionSource = (ctx: CompletionContext) => readonly Completion[] | null | Promise<readonly Completion[] | null>

export interface AutocompleteOptions {
  /** Default: `[languageWords(), documentWords()]`. */
  sources?: readonly CompletionSource[]
  /** Open while typing a word (default true). Otherwise only with Ctrl-Space. */
  activateOnTyping?: boolean
  /** Word chars typed before the list opens by itself. Default 1. */
  minLength?: number
  /** Options listed at most. Default 100. */
  maxOptions?: number
}

// ---------------------------------------------------------------------------
// Matching and ranking

export interface CompletionMatch {
  /**
   * Higher is better: exact (1000) > prefix (800) > case-insensitive prefix (600) >
   * word starts, `gEBI` → getElementById (400) > substring (200) > subsequence (0).
   * Kinds are 200 apart, so `boost` only reorders options within a kind.
   */
  score: number
  /** Matched parts of the label, as flat `[from, to, from, to…]` offsets. */
  ranges: number[]
}

/** Start of a word part: the start, after a non-alphanumeric char, or an upper case letter after a lower case one. */
function wordStart(s: string, i: number): boolean {
  if (!i) return true
  const c = s.charCodeAt(i)
  const p = s.charCodeAt(i - 1)
  const upper = (x: number) => x > 64 && x < 91
  const alnum = (x: number) => (x > 47 && x < 58) || upper(x) || (x > 96 && x < 123) || x > 127
  return alnum(p) ? upper(c) && !upper(p) : alnum(c)
}

/** Appends `i` to flat ranges, extending the last one when adjacent. */
function mark(out: number[], i: number): void {
  if (out[out.length - 1] === i) out[out.length - 1] = i + 1
  else out.push(i, i + 1)
}

/** Every query char at a word start (`gebi`), or also right after the previous match when `runs` (`getElBy`). */
function byWord(label: string, lower: string, lq: string, runs: boolean): number[] | null {
  const out: number[] = []
  let i = 0
  for (const ch of lq) {
    if (!(runs && out[out.length - 1] === i && lower[i] === ch)) {
      while (i < lower.length && !(lower[i] === ch && wordStart(label, i))) i++
      if (i >= lower.length) return null
    }
    mark(out, i++)
  }
  return out
}

function match(label: string, lower: string, q: string, lq: string): CompletionMatch | null {
  const n = q.length
  if (label.startsWith(q)) return { score: n === label.length ? 1000 : 800, ranges: n ? [0, n] : [] }
  if (lower.startsWith(lq)) return { score: 600, ranges: [0, n] }
  if (lower.indexOf(lq[0]!) < 0) return null
  const words = byWord(label, lower, lq, false) ?? byWord(label, lower, lq, true)
  if (words) return { score: 400, ranges: words }
  // Single chars only match at word starts: anything else is noise.
  if (n < 2) return null
  const at = lower.indexOf(lq)
  if (at > 0) return { score: 200, ranges: [at, at + n] }
  // Subsequence, starting at a word start.
  let i = 0
  while (i < lower.length && !(lower[i] === lq[0] && wordStart(label, i))) i++
  if (i >= lower.length) return null
  const out: number[] = []
  for (const ch of lq) {
    i = lower.indexOf(ch, i)
    if (i < 0) return null
    mark(out, i++)
  }
  return { score: 0, ranges: out }
}

/** Fuzzy-matches a label against what was typed (null: no match). */
export function fuzzyMatch(label: string, query: string): CompletionMatch | null {
  return match(label, label.toLowerCase(), query, query.toLowerCase())
}

interface Candidate { c: Completion; lower: string; i: number }
interface Option { c: Completion; score: number; ranges: number[]; i: number }

const richness = (c: Completion) => +!!c.type + 2 * +!!c.detail + 2 * +!!c.info + +!!c.apply

/** Merges source results in order, keeping one option per label (the richest). */
function candidates(lists: readonly (readonly Completion[] | null | undefined)[]): Candidate[] {
  const byLabel = new Map<string, Candidate>()
  for (const list of lists) {
    for (const c of list ?? []) {
      const prev = byLabel.get(c.label)
      if (!prev) byLabel.set(c.label, { c, lower: c.label.toLowerCase(), i: byLabel.size })
      else if (richness(c) > richness(prev.c)) prev.c = c
    }
  }
  return [...byLabel.values()]
}

/** Best matches first: match kind + boost, then shorter labels, then source order. */
function rank(cands: readonly Candidate[], query: string, max: number): Option[] {
  const lq = query.toLowerCase()
  const out: Option[] = []
  for (const { c, lower, i } of cands) {
    const m = match(c.label, lower, query, lq)
    if (m) out.push({ c, score: m.score + (c.boost ?? 0), ranges: m.ranges, i })
  }
  out.sort((a, b) => b.score - a.score || (query ? a.c.label.length - b.c.label.length : 0) || a.i - b.i)
  return out.length > max ? out.slice(0, max) : out
}

/** Filters and ranks completions like the list does (deduplicated by label). */
export function filterCompletions(list: readonly Completion[], query: string, max = 100): { completion: Completion; score: number; ranges: number[] }[] {
  return rank(candidates([list]), query, max).map((o) => ({ completion: o.c, score: o.score, ranges: o.ranges }))
}

// ---------------------------------------------------------------------------
// Sources

/** A fixed list of words or completions. */
export function completeFromList(list: readonly (string | Completion)[]): CompletionSource {
  const options = list.map((c) => (typeof c === 'string' ? { label: c } : c))
  return () => options
}

const languageLists = new WeakMap<Language, { list: Completion[]; lower: Completion[] | null }>()

/**
 * The words of the language at the cursor (`completions` of its spec, e.g.
 * JavaScript inside an HTML `<script>`), typed `keyword`. A list written all
 * in upper case (SQL) follows the case of the query: `sel` → `select`.
 */
export function languageWords(): CompletionSource {
  return ({ editor, pos, word }) => {
    const lang = editor.languageAt(pos)
    let entry = languageLists.get(lang)
    if (!entry) {
      const words = lang.completions
      const list = words.map((label) => ({ label, type: 'keyword' }))
      const upper = words.length > 0 && words.every((w) => w === w.toUpperCase())
      languageLists.set(lang, (entry = { list, lower: upper ? list.map((c) => ({ ...c, label: c.label.toLowerCase() })) : null }))
    }
    return entry.lower && /^[a-z]/.test(word.text) ? entry.lower : entry.list
  }
}

const wordRegExps = new Map<string, RegExp>()

/**
 * Distinct words of `lines` (2+ chars, with a letter), scanning outwards from
 * `pos` (closest lines first) up to `maxLines` above and below, without the
 * word at `pos`. Stops after `max` words.
 */
export function scanWords(lines: readonly string[], pos: Pos, wordChars = '', maxLines = 2000, max = 5000): string[] {
  let re = wordRegExps.get(wordChars)
  if (!re) {
    const extra = wordChars.replace(/[\\\]^-]/g, '\\$&')
    const chars = `\\p{L}\\p{N}\\p{M}_${extra}`
    // Not inside a number or another word (`0x1f`, `10px`).
    wordRegExps.set(wordChars, (re = new RegExp(`(?<![${chars}])[\\p{L}_${extra}][${chars}]*`, 'gu')))
  }
  const seen = new Set<string>()
  const out: string[] = []
  let budget = 2e6
  for (let d = 0; d <= maxLines && out.length < max && budget > 0; d++) {
    const above = pos.line - d
    const below = pos.line + d
    if (above < 0 && below >= lines.length) break
    for (const n of d ? [above, below] : [above]) {
      const text = lines[n]
      if (text === undefined) continue
      budget -= text.length
      re.lastIndex = 0
      for (let m; (m = re.exec(text)); ) {
        const w = m[0]
        if (w.length < 2 || seen.has(w) || (n === pos.line && m.index <= pos.col && pos.col <= m.index + w.length)) continue
        seen.add(w)
        if (/\p{L}/u.test(w)) out.push(w)
      }
    }
  }
  return out.length > max ? out.slice(0, max) : out
}

/** Words of the document around the cursor (closest first), typed `text`. Cached per document version. */
export function documentWords(options: { maxLines?: number } = {}): CompletionSource {
  const cache = new WeakMap<Editor, { key: string; list: Completion[] }>()
  return ({ editor, pos, word }) => {
    const key = `${editor.version}:${word.from.line}:${word.from.col}`
    const hit = cache.get(editor)
    if (hit?.key === key) return hit.list
    const list = scanWords(editor.doc.lines, pos, editor.languageAt(pos).wordChars, options.maxLines)
      .map((label) => ({ label, type: 'text' }))
    cache.set(editor, { key, list })
    return list
  }
}

// ---------------------------------------------------------------------------
// Commands

interface Controller {
  start(): void
  close(): boolean
  accept(): boolean
  move(dir: number, page?: boolean): boolean
}

const controllers = new WeakMap<Editor, Controller>()

/** Opens the list for the word at the cursor (even an empty one). */
export const startCompletion: Command = (ed) => {
  const ctl = controllers.get(ed)
  if (!ctl || ed.options.readOnly) return false
  ctl.start()
  return true
}

/** Closes the list (false when it wasn't open). */
export const closeCompletion: Command = (ed) => controllers.get(ed)?.close() ?? false

/** Inserts the selected option (false when the list isn't open). */
export const acceptCompletion: Command = (ed) => controllers.get(ed)?.accept() ?? false

const move = (dir: number, page?: boolean): Command => (ed) => controllers.get(ed)?.move(dir, page) ?? false

export const completionKeymap: readonly KeyBinding[] = [
  { key: 'Ctrl-Space', run: startCompletion },
  { key: 'ArrowDown', run: move(1) },
  { key: 'ArrowUp', run: move(-1) },
  { key: 'PageDown', run: move(1, true) },
  { key: 'PageUp', run: move(-1, true) },
  { key: 'Enter', run: acceptCompletion },
  { key: 'Tab', run: acceptCompletion },
  { key: 'Escape', run: closeCompletion },
]

// ---------------------------------------------------------------------------
// The extension

/** Icon token color for completion types that aren't token types themselves. */
const ICON_TOKEN: Record<string, string> = {
  method: 'function', class: 'type', interface: 'type', enum: 'type', namespace: 'type', field: 'property', snippet: 'string',
}
/** Label start relative to the list's left edge (border + padding + icon + gap): the label lines up with the word. */
const LABEL_X = 29
const ARIA = ['aria-controls', 'aria-expanded', 'aria-activedescendant']
let lists = 0

export function autocomplete(options: AutocompleteOptions = {}): Extension {
  const sources = options.sources ?? [languageWords(), documentWords()]
  const onTyping = options.activateOnTyping !== false
  const minLength = options.minLength ?? 1
  const maxOptions = options.maxOptions ?? 100
  return (editor) => {
    injectStyle(editor.dom, 'autocomplete', AUTOCOMPLETE_CSS)
    const floating = createFloating(editor, 'jc-ac')
    const el = floating.el
    const id = 'jc-ac-' + lists++
    el.innerHTML = `<ul role="listbox" id="${id}"></ul><div class="jc-ac-info" hidden></div>`
    const list = el.firstChild as HTMLUListElement
    const info = el.lastChild as HTMLDivElement
    const input = editor.inputDOM
    input.setAttribute('aria-autocomplete', 'list')

    /** Tracking a word (the list may still be hidden: nothing matches yet, or scrolled out). */
    let active = false
    let explicit = false
    /** The list is shown (has options). */
    let open = false
    let accepting = false
    let word: CompletionContext['word'] = { from: { line: 0, col: 0 }, to: { line: 0, col: 0 }, text: '' }
    let results: (readonly Completion[] | null | undefined)[] = []
    let cands: Candidate[] = []
    let opts: Option[] = []
    let selected = 0
    let abort: AbortController | null = null
    let generation = 0

    const wordAt = (pos: Pos): CompletionContext['word'] => {
      const text = editor.doc.line(pos.line)
      const chars = editor.languageAt(pos).wordChars
      const isWord = (c: string | undefined) => !!c && charCategory(c, chars) === CHAR_WORD
      let a = pos.col
      let b = pos.col
      while (a > 0 && isWord(text[a - 1])) a--
      while (isWord(text[b])) b++
      return { from: { line: pos.line, col: a }, to: { line: pos.line, col: b }, text: text.slice(a, pos.col) }
    }

    const place = () => {
      // Top layer boxes are positioned in viewport pixels: shift left so the labels line up with the word.
      if (open && floating.show(word.from)) el.style.left = Math.max(4, parseFloat(el.style.left) - LABEL_X) + 'px'
    }

    const hide = () => {
      open = false
      floating.hide()
      for (const a of ARIA) input.removeAttribute(a)
    }

    /** The list is on screen (not scrolled out). */
    const shown = () => open && floating.visible

    const close = (): boolean => {
      if (!active) return false
      const wasOpen = shown()
      active = explicit = false
      abort?.abort()
      abort = null
      generation++
      results = []
      cands = []
      opts = []
      hide()
      return wasOpen
    }

    const select = (i: number, scroll = true) => {
      list.children[selected]?.setAttribute('aria-selected', 'false')
      selected = i
      const li = list.children[i] as HTMLElement | undefined
      if (!li) return
      li.setAttribute('aria-selected', 'true')
      input.setAttribute('aria-activedescendant', li.id)
      const text = opts[i]!.c.info ?? ''
      if (text !== info.textContent || info.hidden !== !text) {
        info.textContent = text
        info.hidden = !text
        place()
      }
      if (scroll) {
        const top = li.offsetTop
        if (top < list.scrollTop) list.scrollTop = top
        else if (top + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + li.offsetHeight - list.clientHeight
      }
    }

    const label = (o: Option) => {
      const { label: text } = o.c
      let html = ''
      let at = 0
      for (let k = 0; k < o.ranges.length; k += 2) {
        html += escapeHTML(text.slice(at, o.ranges[k])) + '<b>' + escapeHTML(text.slice(o.ranges[k], o.ranges[k + 1])) + '</b>'
        at = o.ranges[k + 1]!
      }
      return html + escapeHTML(text.slice(at))
    }

    /** Re-filters the candidates with the current word (`keep`: stay on the selected option, for async arrivals). */
    const refresh = (keep = false) => {
      const prev = keep && open ? opts[selected]?.c : undefined
      opts = rank(cands, word.text, maxOptions)
      const only = opts.length === 1 && opts[0]!.c.label === word.text && !opts[0]!.c.apply
      if (!opts.length || only) return hide()
      list.innerHTML = opts.map((o, i) => {
        const type = o.c.type ?? ''
        const token = ICON_TOKEN[type] ?? (type === 'text' ? '' : type)
        return `<li role="option" id="${id}-${i}" aria-selected="false"><span class="jc-ac-icon ${token && tokenClass(token)}" aria-hidden="true">${
          escapeHTML(type === 'text' ? 'w' : type[0] ?? '')}</span><span class="jc-ac-label">${label(o)}</span>${
          o.c.detail ? `<span class="jc-ac-detail">${escapeHTML(o.c.detail)}</span>` : ''}</li>`
      }).join('')
      list.setAttribute('aria-label', editor.phrase('Completions'))
      list.scrollTop = 0
      open = true
      input.setAttribute('aria-controls', id)
      input.setAttribute('aria-expanded', 'true')
      selected = 0
      select(Math.max(0, prev ? opts.findIndex((o) => o.c === prev) : 0))
      place()
    }

    /** Queries the sources for a word; sync results show at once, async ones are merged when they arrive. */
    const start = (w: CompletionContext['word'], isExplicit: boolean) => {
      close()
      active = true
      explicit = isExplicit
      word = w
      const ctl = (abort = new AbortController())
      const gen = generation
      const ctx: CompletionContext = { editor, pos: editor.selection.head, word: w, explicit: isExplicit, signal: ctl.signal }
      results = sources.map((source, k) => {
        let res: ReturnType<CompletionSource>
        try {
          res = source(ctx)
        } catch (e) {
          console.error(e)
          return null
        }
        if (!res || !('then' in res)) return res
        res.then((list) => {
          // Stale: the list moved on (another word, closed…).
          if (gen !== generation) return
          results[k] = list
          cands = candidates(results)
          refresh(true)
        }, (e) => gen === generation && console.error(e))
        return null
      })
      cands = candidates(results)
      refresh()
    }

    /** Follows the cursor: re-filters in the same word, closes when it leaves it, opens when typing a new one. */
    const sync = (typed: boolean) => {
      const sel = editor.selection
      if (editor.options.readOnly || editor.ranges.length > 1 || !isEmpty(sel)) return void close()
      const w = wordAt(sel.head)
      if (active && w.from.line === word.from.line && w.from.col === word.from.col && (w.text || explicit)) {
        const changed = w.text !== word.text
        word = w
        if (changed) refresh()
        return
      }
      close()
      if (typed && onTyping && w.text.length >= minLength && !/^\d/.test(w.text) && !inCommentOrString(sel.head)) start(w, false)
    }

    const inCommentOrString = (pos: Pos) =>
      editor.getTokens(pos.line).some((t) => t.from < pos.col && pos.col <= t.to && /(^|\s)(comment|string)/.test(t.type ?? ''))

    const accept = (i = selected): boolean => {
      const o = opts[i]
      if (!shown() || !o) return false
      const { c } = o
      const { from, to } = word
      close()
      accepting = true
      try {
        if (typeof c.apply === 'function') c.apply(editor, c, from, to)
        // The cursor maps to the end of the inserted text.
        else editor.dispatch({ changes: { from, to, insert: c.apply ?? c.label }, origin: 'input.complete', scrollIntoView: true })
      } finally {
        accepting = false
      }
      return true
    }

    controllers.set(editor, {
      start: () => {
        const sel = editor.selection
        if (editor.ranges.length === 1 && isEmpty(sel)) start(wordAt(sel.head), true)
      },
      close,
      accept: () => accept(),
      move: (dir, page) => {
        if (!shown()) return false
        const n = opts.length
        const row = (list.firstElementChild as HTMLElement).offsetHeight || 1
        const i = selected + dir * (page ? Math.max(1, Math.floor(list.clientHeight / row) - 1) : 1)
        select(page ? Math.max(0, Math.min(n - 1, i)) : (i + n) % n)
        return true
      },
    })

    editor.addKeymap(completionKeymap, 'high')
    editor.on('change', (e) => {
      if (accepting) return
      if (e.origin === 'input' || (active && e.origin.startsWith('delete'))) sync(e.origin === 'input')
      else close()
    })
    editor.on('selection', () => active && !accepting && sync(false))
    editor.on('blur', close)
    editor.on('render', place)
    // A click in the text closes it (clicks on the list don't get here).
    editor.addMouseHandler(() => {
      close()
      return false
    })

    const optionAt = (e: Event) => {
      const li = (e.target as Element).closest?.('li')
      return li ? Array.prototype.indexOf.call(list.children, li) : -1
    }
    // Keep the focus (and the virtual keyboard) in the editor.
    el.addEventListener('mousedown', (e) => e.preventDefault())
    el.addEventListener('mousemove', (e) => {
      const i = optionAt(e)
      if (i >= 0 && i !== selected) select(i, false)
    })
    el.addEventListener('click', (e) => {
      const i = optionAt(e)
      if (i >= 0) accept(i)
    })
    // Page scrolls and resizes move the editor under the (fixed) list.
    const doc = editor.dom.ownerDocument
    const win = doc.defaultView
    const onScroll = (e: Event) => e.target !== list && place()
    doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
    win?.addEventListener('resize', place)

    return () => {
      close()
      floating.destroy()
      input.removeAttribute('aria-autocomplete')
      controllers.delete(editor)
      doc.removeEventListener('scroll', onScroll, { capture: true })
      win?.removeEventListener('resize', place)
    }
  }
}

const AUTOCOMPLETE_CSS = `
.jc-ac{min-width:220px}
.jc-ac ul{position:relative;margin:0;padding:3px;max-height:226px;overflow:auto;list-style:none;overscroll-behavior:contain;
scrollbar-width:thin;scrollbar-color:var(--jc-scrollbar) transparent}
.jc-ac li{display:flex;align-items:center;gap:6px;height:22px;padding:0 10px 0 4px;border-radius:5px;cursor:pointer;white-space:nowrap}
.jc-ac li[aria-selected=true]{background:color-mix(in srgb,var(--jc-caret) 22%,transparent)}
.jc-ac-icon{flex:none;display:grid;place-items:center;width:16px;height:16px;border-radius:4px;color:color-mix(in srgb,var(--jc-fg) 70%,transparent);
background:color-mix(in srgb,currentColor 15%,transparent);font:600 10px/1 var(--jc-font-family,ui-monospace,monospace);font-style:normal;text-transform:uppercase}
.jc-ac-label{overflow:hidden;text-overflow:ellipsis;font-family:var(--jc-font-family,ui-monospace,monospace)}
.jc-ac-label b{font-weight:700;color:color-mix(in srgb,var(--jc-caret) 75%,var(--jc-fg))}
.jc-ac-detail{margin-left:auto;padding-left:18px;overflow:hidden;text-overflow:ellipsis;font-size:12px;opacity:.55}
.jc-ac-info{width:0;min-width:100%;max-height:132px;overflow:auto;padding:6px 10px;border-top:1px solid color-mix(in srgb,var(--jc-fg) 14%,transparent);
font-size:12px;white-space:pre-wrap;opacity:.85}
.jc-ac-info[hidden]{display:none}
@media (forced-colors:active){.jc-ac li[aria-selected=true]{forced-color-adjust:none;background:Highlight;color:HighlightText}}
`
