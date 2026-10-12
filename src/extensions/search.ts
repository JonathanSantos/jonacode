/**
 * Find & replace panel (Mod-f / Mod-Alt-f or Ctrl-h). Single-line queries are
 * matched line by line; multi-line ones (a newline in the text, `\n` or `\r` in
 * a regex) run on the lines joined with `\n`, one window at a time. Only the
 * rendered lines are highlighted and matches are counted in background slices,
 * so million-line documents stay responsive.
 */
import type { Editor, Extension } from '../editor.ts'
import type { Command, KeyBinding } from '../keymap.ts'
import { selFrom, selTo, type Selection } from '../state/selection.ts'
import { cmpPos, eqPos, splitLines, type ChangeSpec, type Pos } from '../state/text.ts'
import { injectStyle } from '../view/style.ts'

export interface SearchQuery {
  search: string
  replace: string
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
}

export interface SearchOptions extends Partial<Omit<SearchQuery, 'search' | 'replace'>> {
  /** Stop counting after this many matches. Default 1,000,000. */
  maxCount?: number
}

interface Match {
  from: Pos
  to: Pos
  /** The regex match, for `$1` in replacements (multi-line matches taken from the count don't have it). */
  groups?: RegExpExecArray | null
}

/** A replaced range (sorted and not overlapping in a list). */
export interface Replacement {
  from: Pos
  to: Pos
  insert: string
}

/** Lines `first…` joined with `\n`; `starts[i]` is the offset of line `first + i`. */
export interface LineText {
  text: string
  starts: Uint32Array
  first: number
}

/** A regex walking a {@link LineText}; `chunk` adapts so that one `exec` takes a few ms. */
export interface Scanner {
  re: RegExp
  chunk: number
}

const states = new WeakMap<Editor, SearchPanel>()
/** "Select all matches" stops here: more cursors than this isn't useful. */
const MAX_CURSORS = 10000
/** Context around a multi-line search window: longer matches may be cut. */
const MARGIN = 16384
/** Textarea line height and vertical padding + border (px); it grows up to 4 rows. */
const ROW = 16
const ROWS_EXTRA = 10

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when a query can match across lines: a newline in the text, or `\n` / `\r` in a regex (`\s` alone doesn't count). */
export function isMultiline(q: Pick<SearchQuery, 'search' | 'regexp'>): boolean {
  return /[\n\r]/.test(q.search) || (q.regexp && /(?:^|[^\\])(?:\\\\)*\\[nr]/.test(q.search))
}

/**
 * Builds the regex of a query (null when empty or invalid). Multi-line queries
 * get the `m` flag and run on lines joined with `\n` (`\r\n` means `\n`).
 */
export function searchRegExp(q: SearchQuery): RegExp | null {
  if (!q.search) return null
  const multi = isMultiline(q)
  let source = !q.regexp
    ? splitLines(q.search).map(escapeRe).join('\\n')
    : multi
      ? q.search.replace(/\\r\\n|\\[\s\S]|\r\n?/g, (s) => (s === '\\r\\n' ? '\\n' : s[0] === '\r' ? '\n' : s))
      : q.search
  if (q.wholeWord) source = `(?<![\\p{L}\\p{N}_$])(?:${source})(?![\\p{L}\\p{N}_$])`
  const flags = (multi ? 'gm' : 'g') + (q.caseSensitive ? '' : 'i')
  try {
    return new RegExp(source, flags + 'u')
  } catch {
    try {
      return new RegExp(source, flags)
    } catch {
      return null
    }
  }
}

/** Past the character at `i` (a whole code point in unicode mode, or `exec` backs up into the pair and loops). */
function advance(s: string, i: number, unicode: boolean): number {
  const c = s.charCodeAt(i)
  return unicode && c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? i + 2 : i + 1
}

function lineMatches(re: RegExp, text: string, line: number, out: Match[]): void {
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (!m[0].length) {
      re.lastIndex = advance(text, m.index, re.unicode)
      continue
    }
    out.push({ from: { line, col: m.index }, to: { line, col: m.index + m[0].length }, groups: m })
  }
}

/** Expands `$&`, `$1`, `$<name>`, `$$` and `\n`, `\t`, `\\` in a regex replacement. */
export function expandReplacement(replacement: string, m: RegExpExecArray | null | undefined, regexp: boolean): string {
  if (!regexp) return replacement
  return replacement.replace(/\$(\$|&|\d{1,2}|<[^>]*>)|\\([nt\\])/g, (all, ref: string | undefined, esc: string | undefined) => {
    if (esc) return esc === 'n' ? '\n' : esc === 't' ? '\t' : '\\'
    if (ref === '$') return '$'
    if (!m) return all
    if (ref === '&') return m[0]
    if (ref![0] === '<') return m.groups?.[ref!.slice(1, -1)] ?? ''
    return m[+ref!] ?? all
  })
}

/** Joins `lines[from…to)` with `\n` and records where each line starts. */
export function joinLines(lines: readonly string[], from = 0, to = lines.length): LineText {
  const part = from || to < lines.length ? lines.slice(from, to) : lines
  const starts = new Uint32Array(part.length)
  for (let i = 0, off = 0; i < part.length; i++) {
    starts[i] = off
    off += part[i]!.length + 1
  }
  return { text: part.join('\n'), starts, first: from }
}

/** Index of the first of the `n` sorted numbers of `arr` that is >= `x` (`n` when none). */
export function lowerBound(arr: ArrayLike<number>, n: number, x: number): number {
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]! < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function offsetToPos(t: LineText, offset: number): Pos {
  const i = Math.max(0, lowerBound(t.starts, t.starts.length, offset + 1) - 1)
  return { line: t.first + i, col: offset - t.starts[i]! }
}

export function posToOffset(t: LineText, pos: Pos): number {
  return t.starts[pos.line - t.first]! + pos.col
}

/** Starts small: a regex that rescans to the window end at each position costs the window size squared. */
export const scanner = (re: RegExp): Scanner => ({ re, chunk: 1024 })

/**
 * Calls `each` for the non-empty matches starting in `from…until`, in order,
 * until it returns false. `exec` only sees a window of `chunk` characters plus
 * some context, so a slow regex never blocks for long and the scan can stop at
 * `deadline` (a `performance.now()` time). Returns where to resume, or -1 when
 * done.
 */
export function scanMatches(
  t: LineText, sc: Scanner, from: number, until: number, deadline: number,
  each: (from: number, to: number, m: RegExpExecArray) => boolean | void,
): number {
  const { text, starts } = t
  const re = sc.re
  const len = text.length
  let p = from
  let found = 0
  while (p < until) {
    const margin = Math.min(MARGIN, sc.chunk)
    // From the line start (for `^` and lookbehinds), up to `margin` back.
    const a = Math.max(starts[lowerBound(starts, starts.length, p + 1) - 1]!, p - margin)
    const last = p + sc.chunk + margin >= len
    let end = last ? len : p + sc.chunk
    if (!last && (text.charCodeAt(end) & 0xfc00) === 0xdc00) end++ // don't split a surrogate pair
    const slice = text.slice(a, last ? len : end + margin)
    const t0 = performance.now()
    let next = end
    let m: RegExpExecArray | null
    re.lastIndex = p - a
    while ((m = re.exec(slice))) {
      const s = a + m.index
      if (s >= end || s >= until) break
      const e = s + m[0].length
      if (e === s) {
        re.lastIndex = advance(slice, m.index, re.unicode)
        continue
      }
      if (e > next) next = e
      if (each(s, e, m) === false || ((++found & 1023) === 0 && performance.now() > deadline)) return e
    }
    const dt = performance.now() - t0
    sc.chunk = dt > 8 ? Math.max(1024, sc.chunk >> 2) : dt > 3 ? Math.max(1024, sc.chunk >> 1) : dt < 1 && sc.chunk < 1 << 21 ? sc.chunk * 4 : sc.chunk
    if (last) return -1
    p = next
    if (p < until && performance.now() > deadline) return p
  }
  return -1
}

/** The last match starting in `lo…hi`, searched backwards in growing steps. */
function lastMatch(t: LineText, sc: Scanner, lo: number, hi: number): Match | null {
  for (let size = 4096; hi > lo; size *= 4) {
    const i = lowerBound(t.starts, t.starts.length, hi - size + 1) - 1
    const from = Math.max(lo, i < 0 ? 0 : t.starts[i]!)
    let found = null as Match | null
    scanMatches(t, sc, from, hi, Infinity, (s, e, m) => {
      found = { from: offsetToPos(t, s), to: offsetToPos(t, e), groups: m }
    })
    if (found) return found
    hi = from
  }
  return null
}

/**
 * The changes replacing `reps` (sorted), last to first. When many of them add
 * or remove line breaks in a long document (each one shifts the whole line
 * array), they are merged into a single change.
 */
export function replaceChanges(lines: readonly string[], reps: readonly Replacement[]): ChangeSpec[] {
  let breaking = 0
  for (const r of reps) if (r.from.line !== r.to.line || /[\r\n]/.test(r.insert)) breaking++
  if (reps.length < 2 || breaking * lines.length <= 2e6) return reps.slice().reverse()
  const out: string[] = []
  let cur = ''
  let at = reps[0]!.from
  for (const r of reps) {
    if (r.from.line === at.line) cur += lines[at.line]!.slice(at.col, r.from.col)
    else {
      out.push(cur + lines[at.line]!.slice(at.col))
      for (let l = at.line + 1; l < r.from.line; l++) out.push(lines[l]!)
      cur = lines[r.from.line]!.slice(0, r.from.col)
    }
    const parts = splitLines(r.insert)
    cur += parts[0]
    for (let k = 1; k < parts.length; k++) {
      out.push(cur)
      cur = parts[k]!
    }
    at = r.to
  }
  out.push(cur)
  return [{ from: reps[0]!.from, to: at, insert: out }]
}

/** Where `pos` ends up once `reps` (sorted) are applied; inside a replaced range, at its end. */
export function mapThrough(pos: Pos, reps: readonly Replacement[]): Pos {
  let dLine = 0
  let line = -1
  let dCol = 0
  for (const r of reps) {
    if (cmpPos(r.from, pos) >= 0) break
    if (cmpPos(r.to, pos) > 0) pos = r.to
    const parts = splitLines(r.insert)
    const col = r.from.line === line ? r.from.col + dCol : r.from.col
    dLine += parts.length - 1 - (r.to.line - r.from.line)
    dCol = (parts.length === 1 ? col + parts[0]!.length : parts[parts.length - 1]!.length) - r.to.col
    line = r.to.line
  }
  return { line: pos.line + dLine, col: pos.line === line ? pos.col + dCol : pos.col }
}

function endOfInsert(from: Pos, text: string): Pos {
  const parts = splitLines(text)
  const last = parts[parts.length - 1]!.length
  return parts.length === 1 ? { line: from.line, col: from.col + last } : { line: from.line + parts.length - 1, col: last }
}

class SearchPanel {
  editor: Editor
  query: SearchQuery
  maxCount: number
  dom: HTMLElement
  input: HTMLTextAreaElement
  replaceInput: HTMLTextAreaElement
  countEl: HTMLElement
  open = false
  re: RegExp | null = null
  /** The query spans lines: searched on the joined document. */
  multi = false
  total = 0
  capped = false
  /** Counting still running in the background. */
  counting = false
  /** `cum[i]`: matches before line `i` (filled while counting), for "3 / 1,204". */
  private cum: Uint32Array | null = null
  /** Lines below this one are counted. */
  private countedTo = 0
  private countGen = 0
  private countTimer: ReturnType<typeof setTimeout> | null = null
  /** The joined document (multi-line queries), built lazily for `textVersion`. */
  private text: LineText | null = null
  private textVersion = -1
  /** Multi-line matches found by the count (offsets in `text`), `found` of them. */
  private starts = new Uint32Array(0)
  private ends = new Uint32Array(0)
  private found = 0
  /** Every multi-line match starting before this offset is in `starts`. */
  private scanned = 0
  /** Typing a multi-line query: jump to the first match after `from` once the count finds it. */
  private pending: { sel: Selection; from: Pos } | null = null

  constructor(editor: Editor, options: SearchOptions) {
    this.editor = editor
    this.maxCount = options.maxCount ?? 1_000_000
    this.query = { search: '', replace: '', caseSensitive: !!options.caseSensitive, wholeWord: !!options.wholeWord, regexp: !!options.regexp }
    const t = (s: string) => editor.phrase(s)
    const doc = editor.dom.ownerDocument
    this.dom = doc.createElement('div')
    this.dom.className = 'jc-search'
    this.dom.setAttribute('role', 'search')
    this.dom.hidden = true
    this.dom.innerHTML = `
      <div class="jc-search-row">
        <button type="button" class="jc-search-btn jc-search-expand" data-act="toggleReplace" aria-label="${t('Toggle replace')}" aria-expanded="false">›</button>
        <textarea class="jc-search-input" rows="1" wrap="off" spellcheck="false" autocomplete="off" placeholder="${t('Find')}" aria-label="${t('Find')}"></textarea>
        <button type="button" class="jc-search-btn jc-search-opt" data-opt="caseSensitive" title="${t('Match case')}" aria-pressed="false">Aa</button>
        <button type="button" class="jc-search-btn jc-search-opt" data-opt="wholeWord" title="${t('Whole word')}" aria-pressed="false"><u>ab</u></button>
        <button type="button" class="jc-search-btn jc-search-opt" data-opt="regexp" title="${t('Regular expression')}" aria-pressed="false">.*</button>
        <span class="jc-search-count" aria-live="polite"></span>
        <button type="button" class="jc-search-btn" data-act="prev" title="${t('Previous match')} (Shift+Enter)" aria-label="${t('Previous match')}">↑</button>
        <button type="button" class="jc-search-btn" data-act="next" title="${t('Next match')} (Enter)" aria-label="${t('Next match')}">↓</button>
        <button type="button" class="jc-search-btn" data-act="all" title="${t('Select all matches')} (Alt+Enter)" aria-label="${t('Select all matches')}">⋮</button>
        <button type="button" class="jc-search-btn" data-act="close" title="${t('Close')} (Escape)" aria-label="${t('Close')}">✕</button>
      </div>
      <div class="jc-search-row jc-search-replace" hidden>
        <textarea class="jc-replace-input" rows="1" wrap="off" spellcheck="false" autocomplete="off" placeholder="${t('Replace')}" aria-label="${t('Replace')}"></textarea>
        <button type="button" class="jc-search-btn jc-search-text" data-act="replace">${t('Replace')}</button>
        <button type="button" class="jc-search-btn jc-search-text" data-act="replaceAll">${t('Replace all')}</button>
      </div>`
    this.input = this.dom.querySelector('.jc-search-input')!
    this.replaceInput = this.dom.querySelector('.jc-replace-input')!
    this.countEl = this.dom.querySelector('.jc-search-count')!
    editor.dom.appendChild(this.dom)
    this.syncToggles()

    this.dom.addEventListener('mousedown', (e) => {
      e.stopPropagation()
      // Clicking a button keeps the focus where it was (a field or the editor), so Escape still closes the panel.
      if ((e.target as Element).closest('button')) e.preventDefault()
    })
    // Escape from anywhere in the panel (a button reached with Tab, too).
    this.dom.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        this.close()
      }
    })
    this.dom.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest('button')
      if (!btn) return
      const opt = btn.dataset.opt as 'caseSensitive' | 'wholeWord' | 'regexp' | undefined
      if (opt) {
        this.query[opt] = !this.query[opt]
        this.syncToggles()
        this.update(true)
        return
      }
      const act = btn.dataset.act
      if (act === 'next') this.find(1)
      else if (act === 'prev') this.find(-1)
      else if (act === 'all') this.selectAll()
      else if (act === 'close') this.close()
      else if (act === 'replace') this.replace()
      else if (act === 'replaceAll') this.replaceAll()
      else if (act === 'toggleReplace') this.toggleReplace()
    })
    this.input.addEventListener('input', () => this.onInput(false))
    this.replaceInput.addEventListener('input', () => this.onInput(true))
    this.input.addEventListener('keydown', (e) => this.onKey(e, false))
    this.replaceInput.addEventListener('keydown', (e) => this.onKey(e, true))
  }

  private onInput(inReplace: boolean): void {
    if (inReplace) {
      this.query.replace = this.replaceInput.value
      this.fit(this.replaceInput)
    } else {
      this.query.search = this.input.value
      this.fit(this.input)
      this.update(true)
    }
  }

  private onKey(e: KeyboardEvent, inReplace: boolean): void {
    if (e.isComposing) return
    const mod = e.metaKey || e.ctrlKey
    const field = inReplace ? this.replaceInput : this.input
    if (e.key === 'Escape') this.close()
    else if (e.key === 'Enter' && mod && !e.altKey && !e.shiftKey) {
      // Ctrl / Cmd + Enter types a newline (multi-line query or replacement).
      field.setRangeText('\n', field.selectionStart, field.selectionEnd, 'end')
      this.onInput(inReplace)
    } else if (e.key === 'Enter' && inReplace) mod ? this.replaceAll() : this.replace()
    else if (e.key === 'Enter' && e.altKey) this.selectAll()
    else if (e.key === 'Enter') this.find(e.shiftKey ? -1 : 1)
    else if (e.key === 'F3') this.find(e.shiftKey ? -1 : 1)
    else if (mod && e.key.toLowerCase() === 'f') this.openPanel(false)
    else return
    e.preventDefault()
  }

  /** Grows a field with its lines (up to 4 rows, then it scrolls). */
  fit(field: HTMLTextAreaElement): void {
    const rows = field.value.split('\n').length
    field.style.height = rows > 1 ? `${Math.min(4, rows) * ROW + ROWS_EXTRA}px` : ''
    field.style.overflowY = rows > 4 ? 'auto' : ''
  }

  setField(field: HTMLTextAreaElement, value: string): void {
    field.value = value
    this.fit(field)
  }

  syncToggles(): void {
    for (const btn of this.dom.querySelectorAll<HTMLElement>('[data-opt]')) {
      btn.setAttribute('aria-pressed', String(this.query[btn.dataset.opt as 'regexp']))
    }
  }

  toggleReplace(show?: boolean): void {
    const row = this.dom.querySelector<HTMLElement>('.jc-search-replace')!
    row.hidden = !(show ?? row.hidden)
    this.dom.querySelector('[data-act="toggleReplace"]')!.setAttribute('aria-expanded', String(!row.hidden))
    this.dom.classList.toggle('jc-search-replacing', !row.hidden)
  }

  openPanel(replace: boolean): void {
    const ed = this.editor
    const sel = ed.selection
    const from = selFrom(sel)
    const to = selTo(sel)
    // The selection (newlines included, `\n` in regex mode) becomes the query, unless it's huge.
    const lines = to.line - from.line < 1000 ? ed.doc.sliceLines(from, to) : []
    const selected = lines.join('\n')
    if (selected && selected.length <= 10000) {
      this.query.search = this.query.regexp ? lines.map(escapeRe).join('\\n') : selected
      this.setField(this.input, this.query.search)
    }
    this.open = true
    this.dom.hidden = false
    ed.dom.classList.add('jc-search-open')
    if (replace) this.toggleReplace(true)
    if (replace && selected) this.replaceInput.focus()
    else {
      this.input.focus()
      this.input.select()
    }
    this.update(false)
  }

  close(): void {
    this.open = false
    this.dom.hidden = true
    // The joined document and the multi-line matches can be large: let them go.
    if (this.multi) {
      this.countGen++
      if (this.countTimer) clearTimeout(this.countTimer)
      this.countTimer = null
      this.counting = false
    }
    this.text = null
    this.starts = this.ends = new Uint32Array(0)
    this.found = this.scanned = 0
    this.pending = null
    this.editor.dom.classList.remove('jc-search-open')
    this.editor.focus()
    this.editor.requestRender()
  }

  /** Query changed: recompile, jump to the first match after the cursor, recount. */
  update(jump: boolean): void {
    this.multi = isMultiline(this.query)
    this.re = searchRegExp(this.query)
    this.input.classList.toggle('jc-search-invalid', !!this.query.search && !this.re)
    this.found = this.scanned = 0
    this.pending = null
    if (!this.multi) this.text = null
    if (jump && this.re) {
      const sel = this.editor.selection
      // Multi-line: the count jumps once it finds it, instead of a search that could scan the whole document per key.
      if (this.multi) this.pending = { sel, from: selFrom(sel) }
      else {
        const m = this.findFrom(selFrom(sel), 1, true)
        if (m) this.select(m)
      }
    }
    this.recount()
    this.editor.requestRender()
  }

  /** The document changed: multi-line offsets are stale. */
  docChanged(): void {
    this.text = null
    this.found = this.scanned = 0
    this.pending = null
    // Rebuilding a huge joined document on every keystroke would lag: wait for a pause.
    if (this.open) this.recount(this.multi && this.editor.doc.lineCount > 100_000 ? 250 : 30)
  }

  recount(delay = 30): void {
    if (this.countTimer) clearTimeout(this.countTimer)
    const gen = ++this.countGen
    this.countTimer = setTimeout(() => {
      this.countTimer = null
      this.count(gen)
    }, delay)
  }

  /** Counts in slices of ~8 ms; a newer query or edit (a new `gen`) abandons it. */
  private count(gen: number): void {
    const re = this.re
    this.total = 0
    this.capped = false
    this.countedTo = 0
    this.counting = !!re
    if (re && this.multi) return this.countMulti(gen, re)
    const lines = this.editor.doc.lines
    const n = lines.length
    const cum = (this.cum = new Uint32Array(n + 1))
    let total = 0
    let i = 0
    const step = () => {
      if (gen !== this.countGen || !re) return
      const deadline = performance.now() + 8
      for (; i < n; i++) {
        cum[i] = total
        re.lastIndex = 0
        const text = lines[i]!
        let m: RegExpExecArray | null
        while ((m = re.exec(text))) {
          if (!m[0].length) re.lastIndex = advance(text, m.index, re.unicode)
          else total++
        }
        if (total >= this.maxCount) {
          this.capped = true
          break
        }
        if ((i & 511) === 511 && performance.now() > deadline) {
          i++
          this.countedTo = i
          this.total = total
          this.renderCount()
          this.countTimer = setTimeout(step, 0)
          return
        }
      }
      if (i >= n) cum[n] = total
      this.countedTo = i
      this.total = total
      this.counting = false
      this.renderCount()
    }
    step()
    this.renderCount()
  }

  /** Multi-line count: records every match's offsets (up to `maxCount`), resuming where the last slice stopped. */
  private countMulti(gen: number, re: RegExp): void {
    const t = this.docText()
    const sc = scanner(re)
    const len = t.text.length
    this.found = this.scanned = 0
    const step = () => {
      if (gen !== this.countGen) return
      const at = scanMatches(t, sc, this.scanned, len, performance.now() + 8, (s, e) => {
        this.push(s, e)
        if (this.found >= this.maxCount) return false
      })
      this.capped = this.found >= this.maxCount
      this.scanned = at < 0 ? len + 1 : at
      this.total = this.found
      const done = at < 0 || this.capped
      if (done) {
        this.counting = false
        this.editor.requestRender()
      } else this.countTimer = setTimeout(step, 0)
      this.jumpPending(done)
      this.renderCount()
    }
    step()
  }

  private push(s: number, e: number): void {
    if (this.found === this.starts.length) {
      const size = Math.max(1024, this.found * 2)
      const starts = new Uint32Array(size)
      const ends = new Uint32Array(size)
      starts.set(this.starts)
      ends.set(this.ends)
      this.starts = starts
      this.ends = ends
    }
    this.starts[this.found] = s
    this.ends[this.found++] = e
  }

  private jumpPending(done: boolean): void {
    const p = this.pending
    const t = this.readyText()
    if (!p || !t) return
    if (this.editor.selection !== p.sel) {
      this.pending = null
      return
    }
    const i = lowerBound(this.starts, this.found, posToOffset(t, p.from))
    if (i >= this.found && !done) return
    this.pending = null
    const m = i < this.found ? this.hitAt(t, i) : this.capped ? this.findMulti(p.from, 1, true) : this.found ? this.hitAt(t, 0) : null
    if (m) this.select(m)
  }

  /** The joined document, rebuilt after edits (15-50 ms for a million lines). */
  private docText(): LineText {
    const ed = this.editor
    if (!this.text || this.textVersion !== ed.version) {
      this.text = joinLines(ed.doc.lines)
      this.textVersion = ed.version
    }
    return this.text
  }

  private readyText(): LineText | null {
    return this.text && this.textVersion === this.editor.version ? this.text : null
  }

  private hitAt(t: LineText, i: number): Match {
    return { from: offsetToPos(t, this.starts[i]!), to: offsetToPos(t, this.ends[i]!) }
  }

  renderCount(): void {
    if (!this.query.search) {
      this.countEl.textContent = ''
      return
    }
    if (!this.re) {
      this.countEl.textContent = this.editor.phrase('Invalid')
      return
    }
    if (!this.total) {
      this.countEl.textContent = this.counting ? '…' : this.editor.phrase('No results')
      return
    }
    const current = this.currentIndex()
    const total = this.total.toLocaleString() + (this.capped ? '+' : this.counting ? '…' : '')
    this.countEl.textContent = current > 0 ? `${current.toLocaleString()} / ${total}` : total
  }

  /** 1-based index of the match equal to the main selection (0 when none, or not counted yet). */
  private currentIndex(): number {
    const re = this.re
    const cum = this.cum
    const sel = this.editor.selection
    const from = selFrom(sel)
    const to = selTo(sel)
    if (this.multi) {
      const t = this.readyText()
      if (!re || !t) return 0
      const s = posToOffset(t, from)
      const i = lowerBound(this.starts, this.found, s)
      return i < this.found && this.starts[i] === s && this.ends[i] === posToOffset(t, to) ? i + 1 : 0
    }
    // Counts before the line come from the background pass; only this line is scanned.
    if (!re || !cum || from.line >= this.countedTo) return 0
    const found: Match[] = []
    lineMatches(re, this.editor.doc.line(from.line), from.line, found)
    const i = found.findIndex((m) => eqPos(m.from, from) && eqPos(m.to, to))
    return i < 0 ? 0 : cum[from.line]! + i + 1
  }

  /** Next / previous match from `pos` (wrapping around). */
  findFrom(pos: Pos, dir: 1 | -1, inclusive = false): Match | null {
    const re = this.re
    if (!re) return null
    if (this.multi) return this.findMulti(pos, dir, inclusive)
    const doc = this.editor.doc
    const n = doc.lineCount
    for (let k = 0; k <= n; k++) {
      const line = (pos.line + dir * k + n * (k + 1)) % n
      const found: Match[] = []
      lineMatches(re, doc.line(line), line, found)
      if (dir > 0) {
        for (const m of found) {
          const c = cmpPos(m.from, pos)
          if (k === n ? c < 0 : k > 0 || (inclusive ? c >= 0 : c > 0)) return m
        }
      } else {
        for (let i = found.length - 1; i >= 0; i--) {
          const m = found[i]!
          const c = cmpPos(m.from, pos)
          if (k === n ? c > 0 : k > 0 || c < 0) return m
        }
      }
    }
    return null
  }

  /** Multi-line `findFrom`: the matches counted so far, then a windowed search of the rest. */
  private findMulti(pos: Pos, dir: 1 | -1, inclusive: boolean): Match | null {
    const t = this.docText()
    const sc = scanner(this.re!)
    const len = t.text.length
    const p = posToOffset(t, this.editor.doc.clamp(pos))
    const n = this.found
    const known = this.scanned
    if (dir > 0) {
      const from = inclusive ? p : p + 1
      const i = lowerBound(this.starts, n, from)
      if (i < n) return this.hitAt(t, i)
      let hit = null as Match | null
      const first = (s: number, e: number, m: RegExpExecArray) => {
        hit = { from: offsetToPos(t, s), to: offsetToPos(t, e), groups: m }
        return false
      }
      scanMatches(t, sc, Math.max(from, known), len, Infinity, first)
      if (!hit && n) return this.hitAt(t, 0)
      if (!hit) scanMatches(t, sc, known, Math.min(from, len), Infinity, first)
      return hit
    }
    const before = p > known ? lastMatch(t, sc, known, p) : null
    if (before) return before
    const i = lowerBound(this.starts, n, p) - 1
    if (i >= 0) return this.hitAt(t, i)
    // Wrap around: the last match of the document.
    return lastMatch(t, sc, Math.max(p, known), len) ?? (n ? this.hitAt(t, n - 1) : null)
  }

  /** Calls `each` for the multi-line matches in order (up to `limit`), reusing what the count found. */
  private eachMulti(limit: number, needGroups: boolean, each: (from: Pos, to: Pos, m: RegExpExecArray | null) => void): void {
    const t = this.docText()
    let k = 0
    let at = 0
    if (!needGroups) {
      for (; k < this.found && k < limit; k++) each(offsetToPos(t, this.starts[k]!), offsetToPos(t, this.ends[k]!), null)
      at = this.scanned
    }
    if (k >= limit) return
    scanMatches(t, scanner(this.re!), at, t.text.length, Infinity, (s, e, m) => {
      each(offsetToPos(t, s), offsetToPos(t, e), m)
      return ++k < limit
    })
  }

  /** The regex match starting at `pos` (multi-line). */
  private groupsAt(pos: Pos): RegExpExecArray | null {
    const t = this.docText()
    let found = null as RegExpExecArray | null
    scanMatches(t, scanner(this.re!), posToOffset(t, pos), t.text.length, Infinity, (_s, _e, m) => {
      found = m
      return false
    })
    return found
  }

  select(m: Match): void {
    this.editor.dispatch({ selection: { anchor: m.from, head: m.to }, scrollIntoView: 'center', origin: 'select.search' })
  }

  find(dir: 1 | -1): boolean {
    if (!this.re) return false
    const sel = this.editor.selection
    // From an empty cursor, a match starting right there counts as the next one.
    const m = this.findFrom(selFrom(sel), dir, dir > 0 && sel.anchor.line === sel.head.line && sel.anchor.col === sel.head.col)
    if (m) this.select(m)
    this.renderCount()
    return true
  }

  /** All matches become cursors. */
  selectAll(): void {
    const re = this.re
    if (!re) return
    const ranges: Selection[] = []
    if (this.multi) this.eachMulti(MAX_CURSORS, false, (anchor, head) => ranges.push({ anchor, head }))
    else {
      const found: Match[] = []
      const lines = this.editor.doc.lines
      for (let i = 0; i < lines.length && found.length < MAX_CURSORS; i++) lineMatches(re, lines[i]!, i, found)
      for (const m of found) ranges.push({ anchor: m.from, head: m.to })
    }
    if (!ranges.length) return
    this.editor.dispatch({ selection: { ranges, main: 0 }, origin: 'select.search' })
    this.editor.focus()
  }

  replace(): void {
    const ed = this.editor
    if (!this.re || ed.options.readOnly) return
    const sel = ed.selection
    const current = this.findFrom(selFrom(sel), 1, true)
    if (current && eqPos(current.from, selFrom(sel)) && eqPos(current.to, selTo(sel))) {
      // A match taken from the multi-line count has no groups: search it again.
      const groups = current.groups ?? this.groupsAt(current.from)
      const text = expandReplacement(this.query.replace, groups, this.query.regexp)
      ed.dispatch({ changes: { from: current.from, to: current.to, insert: text }, origin: 'input.replace' })
      const next = this.findFrom(endOfInsert(current.from, text), 1, true)
      if (next) this.select(next)
    } else {
      this.find(1)
    }
    this.recount()
  }

  replaceAll(): void {
    const ed = this.editor
    const re = this.re
    if (!re || ed.options.readOnly) return
    const q = this.query
    const reps: Replacement[] = []
    if (this.multi) {
      const needGroups = q.regexp && /\$[&\d<]/.test(q.replace)
      this.eachMulti(Infinity, needGroups, (from, to, m) => reps.push({ from, to, insert: expandReplacement(q.replace, m, q.regexp) }))
    } else {
      const found: Match[] = []
      const lines = ed.doc.lines
      for (let i = 0; i < lines.length; i++) lineMatches(re, lines[i]!, i, found)
      for (const m of found) reps.push({ from: m.from, to: m.to, insert: expandReplacement(q.replace, m.groups, q.regexp) })
    }
    if (!reps.length) return
    const changes = replaceChanges(ed.doc.lines, reps)
    // One merged change would move the cursor to its end: map the main range through the replacements instead.
    const sel = ed.selection
    const selection = changes.length < reps.length ? { anchor: mapThrough(sel.anchor, reps), head: mapThrough(sel.head, reps) } : undefined
    ed.dispatch({ changes, selection, origin: 'input.replace' })
    this.recount()
  }

  /** Highlights the matches of the rendered lines. */
  draw(dom: HTMLElement): void {
    const re = this.re
    const ed = this.editor
    let html = ''
    if (this.open && re) {
      const { from, to } = ed.visibleRange
      const sel = ed.selection
      const found: Match[] = []
      if (this.multi) this.visibleMulti(from, to, found)
      else for (let line = from; line <= to; line++) lineMatches(re, ed.doc.line(line), line, found)
      for (const m of found) {
        const current = eqPos(m.from, selFrom(sel)) && eqPos(m.to, selTo(sel))
        for (const r of ed.rangeRects(m.from, m.to)) {
          html += `<div class="jc-search-match${current ? ' jc-search-current' : ''}" style="left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px"></div>`
        }
      }
    }
    if (dom.innerHTML !== html) dom.innerHTML = html
  }

  /** Multi-line matches touching lines `vf…vt`: from the count, or searched around them until it gets there. */
  private visibleMulti(vf: number, vt: number, out: Match[]): void {
    const doc = this.editor.doc
    vt = Math.min(vt, doc.lineCount - 1)
    if (vf > vt) return
    const ctx = Math.max(0, vf - 32)
    const full = this.readyText()
    const t = full ?? joinLines(doc.lines, ctx, Math.min(doc.lineCount, vt + 33))
    const n = full ? this.found : 0
    const known = full ? this.scanned : 0
    const vs = posToOffset(t, { line: vf, col: 0 })
    const ve = posToOffset(t, { line: vt, col: doc.line(vt).length })
    for (let i = lowerBound(this.ends, n, vs + 1); i < n && this.starts[i]! <= ve; i++) out.push(this.hitAt(t, i))
    if (known > ve) return
    // A pathological regex may leave some unhighlighted, but can't stall scrolling.
    scanMatches(t, scanner(this.re!), Math.max(known, posToOffset(t, { line: ctx, col: 0 })), ve + 1, performance.now() + 20, (s, e) => {
      if (e > vs) out.push({ from: offsetToPos(t, s), to: offsetToPos(t, e) })
    })
  }

  destroy(): void {
    if (this.countTimer) clearTimeout(this.countTimer)
    this.dom.remove()
    this.editor.dom.classList.remove('jc-search-open')
  }
}

const withPanel = (fn: (panel: SearchPanel) => boolean | void): Command => (ed) => {
  const panel = states.get(ed)
  if (!panel) return false
  return fn(panel) !== false
}

export const openSearch: Command = withPanel((p) => p.openPanel(false))
export const openReplace: Command = withPanel((p) => p.openPanel(true))
export const findNext: Command = withPanel((p) => (p.query.search ? p.find(1) : p.openPanel(false)))
export const findPrevious: Command = withPanel((p) => (p.query.search ? p.find(-1) : p.openPanel(false)))
export const closeSearch: Command = withPanel((p) => (p.open ? p.close() : false))
export const replaceAll: Command = withPanel((p) => p.replaceAll())
export const selectAllMatches: Command = withPanel((p) => (p.re ? p.selectAll() : false))

/** Reads or changes the query programmatically. */
export function setSearchQuery(editor: Editor, query: Partial<SearchQuery>): void {
  const panel = states.get(editor)
  if (!panel) return
  Object.assign(panel.query, query)
  panel.setField(panel.input, panel.query.search)
  panel.setField(panel.replaceInput, panel.query.replace)
  panel.syncToggles()
  panel.update(false)
}

export const searchKeymap: readonly KeyBinding[] = [
  { key: 'Mod-f', run: openSearch },
  { key: 'Mod-Alt-f', win: 'Ctrl-h', linux: 'Ctrl-h', run: openReplace },
  { key: 'F3', run: findNext, shift: findPrevious },
  { key: 'Mod-g', run: findNext, shift: findPrevious },
  { key: 'Escape', run: closeSearch },
]

/** Find & replace. Set `phrases` on the editor to translate the panel. */
export function search(options: SearchOptions = {}): Extension {
  return (editor) => {
    injectStyle(editor.dom, 'search', SEARCH_CSS)
    const panel = new SearchPanel(editor, options)
    states.set(editor, panel)
    editor.addKeymap(searchKeymap, 'high')
    editor.addLayer({ className: 'jc-search-layer', order: -0.5, render: (dom) => panel.draw(dom) })
    editor.on('change', () => panel.docChanged())
    editor.on('selection', () => panel.open && panel.renderCount())
    return () => {
      panel.destroy()
      states.delete(editor)
    }
  }
}

const SEARCH_CSS = `
.jc-search{position:absolute;top:8px;right:18px;z-index:10;display:grid;gap:6px;padding:6px;border-radius:10px;
background:var(--jc-search-bg,color-mix(in srgb,var(--jc-bg) 88%,var(--jc-fg)));border:1px solid color-mix(in srgb,var(--jc-fg) 16%,transparent);
box-shadow:0 10px 30px -10px #0008;font:13px/1 var(--jc-ui-font,system-ui,sans-serif);color:var(--jc-fg);max-width:calc(100% - 24px)}
.jc-search[hidden],.jc-search-row[hidden]{display:none}
.jc-search-row{display:flex;align-items:flex-start;gap:3px}
.jc-search textarea{display:block;box-sizing:border-box;min-width:0;flex:1 1 180px;width:180px;height:${ROW + ROWS_EXTRA}px;padding:4px 8px;border-radius:6px;border:1px solid color-mix(in srgb,var(--jc-fg) 18%,transparent);
background:var(--jc-bg);color:var(--jc-fg);font:13px/${ROW}px var(--jc-font-family,ui-monospace,monospace);outline:none;resize:none;overflow:hidden;white-space:pre;scrollbar-width:thin}
.jc-search textarea:focus{border-color:var(--jc-caret)}
.jc-search textarea.jc-search-invalid{border-color:#e06c75}
.jc-search-replace textarea{margin-left:25px}
.jc-search-btn{flex:none;height:26px;min-width:26px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.8}
.jc-search-btn:hover{opacity:1;background:color-mix(in srgb,var(--jc-fg) 12%,transparent)}
.jc-search-opt{font-family:var(--jc-font-family,ui-monospace,monospace);font-size:12px}
.jc-search-opt[aria-pressed="true"]{opacity:1;background:color-mix(in srgb,var(--jc-caret) 30%,transparent);box-shadow:inset 0 0 0 1px var(--jc-caret)}
.jc-search-expand{transition:transform .15s}.jc-search-expand[aria-expanded="true"]{transform:rotate(90deg)}
.jc-search-text{font-size:12px;border:1px solid color-mix(in srgb,var(--jc-fg) 18%,transparent)}
.jc-search-count{min-width:64px;padding:0 6px;text-align:center;font-size:12px;line-height:26px;opacity:.75;white-space:nowrap;font-variant-numeric:tabular-nums}
.jc-search-match{position:absolute;border-radius:2px;background:var(--jc-search-match,color-mix(in srgb,#e5c07b 26%,transparent))}
.jc-search-current{background:var(--jc-search-current,color-mix(in srgb,#e5c07b 55%,transparent));box-shadow:0 0 0 1px #e5c07b}
@media (max-width:520px){.jc-search{left:8px;right:8px;top:6px}.jc-search-row{flex-wrap:wrap}.jc-search textarea{flex-basis:100%}.jc-search-replace textarea{margin-left:0}}
`
