/**
 * Inline diff: shows how the document differs from an original text (the
 * saved file, the document before an AI edit…). Deleted lines appear in a
 * block above the change, inserted lines are tinted, changed characters are
 * highlighted on both sides, a gutter marks each chunk, and every chunk has
 * Accept / Reject buttons. The diff follows the edits (only the region around
 * each edit is compared again, so typing stays cheap in big documents).
 *
 * ```ts
 * const editor = createEditor(el, { value, extensions: [basicSetup(), diffView({ original: value })] })
 * const before = editor.getValue()
 * await agent.edit(editor)             // the AI rewrites some code…
 * setOriginal(editor, before)          // …and the user reviews each change
 * ```
 *
 * Keys: F7 / Shift-F7 go to the next / previous chunk, Mod-Alt-Enter accepts
 * the chunk at the cursor and Mod-Alt-Backspace rejects it.
 */
import { setDecorations, type Decoration } from '../decorations.ts'
import type { Editor, Extension } from '../editor.ts'
import type { Command, KeyBinding } from '../keymap.ts'
import type { Token } from '../language/language.ts'
import { diffChars, diffLines, diffToChanges, type DiffChunk } from '../state/diff.ts'
import { spliceArray, splitLines, type Change } from '../state/text.ts'
import { tokenClass } from '../theme/theme.ts'
import { escapeHTML } from '../util/text.ts'
import { injectStyle } from '../view/style.ts'

export type { DiffChunk }

// ---------------------------------------------------------------------------
// Pure chunk logic (shared with the merge view)

/** Lines `[from, to)` of the old document became lines `[from, to + delta)` of the new one. */
export interface LineEdit {
  from: number
  to: number
  delta: number
}

/** The lines a transaction's changes (applied in order) touched, in the coordinates of the document before them. */
export function editedLines(changes: readonly Change[]): LineEdit | null {
  let s = -1
  let e = 0
  let delta = 0
  for (const c of changes) {
    const f = c.from.line
    const t = c.to.line
    const n = c.inserted.length
    const d = n - 1 - (t - f)
    // The span covers every touched line, in the coordinates of the document so far.
    if (s < 0) (s = f), (e = f + n)
    else (e = e > t + 1 ? e + d : f + n), (s = Math.min(s, f))
    delta += d
  }
  return s < 0 ? null : { from: s, to: e - delta, delta }
}

export interface ChunkUpdate {
  chunks: DiffChunk[]
  /** Chunks before `to` are the same objects or new ones; from `to` on, they are shifted copies of `old[oldTo..]`. */
  to: number
  oldTo: number
}

/**
 * Updates the chunks after an edit of side `side` (`a` and `b` are the new
 * texts): only the edited lines, widened to the chunks they touch, are
 * compared again; chunks elsewhere are kept (shifted). `maxCost` bounds the
 * work (see `diffLines`): past it, the rest of the region is one coarse chunk.
 */
export function updateChunks(
  chunks: readonly DiffChunk[], a: readonly string[], b: readonly string[], edit: LineEdit, side: 'a' | 'b' = 'b', maxCost?: number,
): ChunkUpdate {
  const onB = side === 'b'
  const xf = onB ? 'fromB' : 'fromA'
  const xt = onB ? 'toB' : 'toA'
  const yt = onB ? 'toA' : 'toB'
  let s = edit.from
  let e = edit.to
  // Widen to every chunk that overlaps or touches the edited lines.
  let lo = 0
  let hi = chunks.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (chunks[mid]![xt] < s) lo = mid + 1
    else hi = mid
  }
  let j = lo
  for (; j < chunks.length && chunks[j]![xf] <= e; j++) {
    s = Math.min(s, chunks[j]![xf])
    e = Math.max(e, chunks[j]![xt])
  }
  // Outside chunks, lines of both sides pair one to one.
  const prev = chunks[lo - 1]
  const last = chunks[j - 1] ?? prev
  const ys = prev ? s - prev[xt] + prev[yt] : s
  const ye = last ? e - last[xt] + last[yt] : e
  const xe = e + edit.delta
  const [fa, ta, fb, tb] = onB ? [ys, ye, s, xe] : [s, xe, ys, ye]
  const found = diffLines(a.slice(fa, ta), b.slice(fb, tb), { maxCost })
  for (const c of found) (c.fromA += fa), (c.toA += fa), (c.fromB += fb), (c.toB += fb)
  const d = edit.delta
  let after = chunks.slice(j)
  if (d) after = after.map((c) => (onB ? { ...c, fromB: c.fromB + d, toB: c.toB + d } : { ...c, fromA: c.fromA + d, toA: c.toA + d }))
  return { chunks: [...chunks.slice(0, lo), ...found, ...after], to: lo + found.length, oldTo: j }
}

/** `[line index in the chunk, from col, to col]`. */
export type LineRange = readonly [number, number, number]

/** Changed characters of a chunk, per line of each side. */
export interface ChunkDetail {
  a: LineRange[]
  b: LineRange[]
}

/**
 * Offset ranges in `lines` joined with `\n` → ranges per line. Where a range
 * continues from the line above, the indentation isn't marked.
 */
function toLineRanges(lines: readonly string[], ranges: readonly (readonly [number, number])[]): LineRange[] {
  const out: LineRange[] = []
  let line = 0
  let start = 0
  for (const [from, to] of ranges) {
    while (line < lines.length - 1 && start + lines[line]!.length < from) start += lines[line++]!.length + 1
    for (let l = line, s = start; l < lines.length; s += lines[l++]!.length + 1) {
      const text = lines[l]!
      const f = from < s ? /^\s*/.exec(text)![0].length : from - s
      const t = Math.min(to, s + text.length) - s
      if (t > f) out.push([l, f, t])
      if (to <= s + text.length + 1) break
    }
  }
  return out
}

/** Adds the changed characters of `a` → `b` (lines from `line` on) to `out`, unless they're mostly rewritten. */
function refine(a: readonly string[], b: readonly string[], line: number, out: ChunkDetail): void {
  const ta = a.join('\n')
  const tb = b.join('\n')
  const chunks = diffChars(ta, tb, { maxCost: 1e5 })
  let ca = 0
  let cb = 0
  for (const c of chunks) (ca += c.toA - c.fromA), (cb += c.toB - c.fromB)
  if (ca > ta.length * 0.6 && cb > tb.length * 0.6) return
  for (const [l, f, t] of toLineRanges(a, chunks.map((c) => [c.fromA, c.toA] as const))) out.a.push([l + line, f, t])
  for (const [l, f, t] of toLineRanges(b, chunks.map((c) => [c.fromB, c.toB] as const))) out.b.push([l + line, f, t])
}

/**
 * Character-level changes inside a chunk that has lines on both sides (line
 * by line when both sides have as many lines), or null when it's too big or
 * rewritten (the line colors say it all).
 */
export function chunkDetail(a: readonly string[], b: readonly string[], maxChars = 20000): ChunkDetail | null {
  let size = 0
  for (const l of a) size += l.length
  for (const l of b) size += l.length
  if (!a.length || !b.length || size > maxChars) return null
  const out: ChunkDetail = { a: [], b: [] }
  if (a.length === b.length) a.forEach((l, i) => refine([l], [b[i]!], i, out))
  else refine(a, b, 0, out)
  return out.a.length || out.b.length ? out : null
}

/** Index of the first chunk that ends after `line` on side `side` (or is empty at it). */
export function chunkIndexAt(chunks: readonly DiffChunk[], line: number, side: 'a' | 'b' = 'b'): number {
  const f = side === 'b' ? 'fromB' : 'fromA'
  const t = side === 'b' ? 'toB' : 'toA'
  let lo = 0
  let hi = chunks.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const c = chunks[mid]!
    if (c[t] <= line && (c[f] < c[t] || c[f] < line)) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Whether two chunk lists have the same positions. */
export const sameChunks = (a: readonly DiffChunk[], b: readonly DiffChunk[]): boolean =>
  a.length === b.length && a.every((c, i) => c.fromA === b[i]!.fromA && c.toA === b[i]!.toA && c.fromB === b[i]!.fromB && c.toB === b[i]!.toB)

const flip = (c: DiffChunk): DiffChunk => ({ fromA: c.fromB, toA: c.toB, fromB: c.fromA, toB: c.toA })

/** Changes that give side B the text of side A in these chunks (descending, for one transaction). */
export function revertChanges(chunks: readonly DiffChunk[], a: readonly string[], b: readonly string[]): ReturnType<typeof diffToChanges> {
  return diffToChanges(b, a, chunks.map(flip))
}

// ---------------------------------------------------------------------------
// Shared rendering (inline diff and merge view)

/** Metadata that follows a chunk while it only moves (element of its widgets, character diff). */
export interface ChunkMeta {
  detail?: ChunkDetail | null
  el?: HTMLElement
}

/** Syntax-highlighted HTML of a line, with `marks` (column ranges) wrapped in `markClass`. */
export function lineHTML(text: string, tokens: readonly Token[], marks: readonly (readonly [number, number])[], markClass: string): string {
  let html = ''
  let m = 0
  const piece = (from: number, to: number, type: string | null) => {
    for (let p = from; p < to;) {
      while (m < marks.length && marks[m]![1] <= p) m++
      const mk = marks[m]
      const inside = !!mk && mk[0] <= p
      const end = Math.min(to, inside ? mk[1] : mk ? Math.max(mk[0], p) : to)
      const cls = (type ? tokenClass(type) : '') + (inside ? ' ' + markClass : '')
      const s = escapeHTML(text.slice(p, end))
      html += cls ? `<span class="${cls.trim()}">${s}</span>` : s
      p = end
    }
  }
  let pos = 0
  for (const t of tokens) {
    if (t.from > pos) piece(pos, t.from, null)
    piece(Math.max(pos, t.from), t.to, t.type ?? null)
    pos = Math.max(pos, t.to)
  }
  piece(pos, text.length, null)
  return html
}

/**
 * Draws line tints and character marks of the chunks on screen, for one side
 * of the diff. `detail` gives (and caches) the character diff of a chunk.
 */
export function drawChunks(
  ed: Editor, chunks: readonly DiffChunk[], side: 'a' | 'b', detail: (c: DiffChunk) => ChunkDetail | null | undefined,
): string {
  const { from, to } = ed.visibleRange
  const cls = side === 'b' ? 'jc-diff-ins' : 'jc-diff-del'
  let html = ''
  for (let i = chunkIndexAt(chunks, from, side); i < chunks.length; i++) {
    const c = chunks[i]!
    const start = side === 'b' ? c.fromB : c.fromA
    const end = side === 'b' ? c.toB : c.toA
    if (start > to) break
    if (start === end) continue
    for (let l = Math.max(start, from); l < end && l <= to; l++) {
      if (ed.isLineHidden(l)) continue
      const bl = ed.lineBlock(l)
      html += `<div class="jc-diff-line ${cls}" style="top:${bl.top}px;height:${bl.height}px"></div>`
    }
    const d = detail(c)
    if (!d) continue
    for (const [l, f, t] of d[side]) {
      const line = start + l
      if (line < from || line > to) continue
      for (const r of ed.rangeRects({ line, col: f }, { line, col: t })) {
        html += `<div class="jc-diff-mark ${cls}" style="left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px"></div>`
      }
    }
  }
  return html
}

/** Colors (themes and apps can override any of these variables) and the rules both views share. */
export const DIFF_CSS = `
:where(.jc-editor,.jc-merge){--jc-diff-green:#3fb950;--jc-diff-red:#f85149;--jc-diff-modified:#4c9ee8;
--jc-diff-inserted:color-mix(in srgb,var(--jc-diff-green) 13%,transparent);--jc-diff-inserted-strong:color-mix(in srgb,var(--jc-diff-green) 30%,transparent);
--jc-diff-deleted:color-mix(in srgb,var(--jc-diff-red) 13%,transparent);--jc-diff-deleted-strong:color-mix(in srgb,var(--jc-diff-red) 30%,transparent)}
.jc-diff-line{position:absolute;left:calc(-1 * var(--jc-pad-x));right:0}
.jc-diff-mark{position:absolute;border-radius:2px}
.jc-diff-line.jc-diff-ins{background:var(--jc-diff-inserted)}
.jc-diff-line.jc-diff-del{background:var(--jc-diff-deleted)}
.jc-diff-mark.jc-diff-ins{background:var(--jc-diff-inserted-strong)}
.jc-diff-mark.jc-diff-del,.jc-diff-del-mark{background:var(--jc-diff-deleted-strong);border-radius:2px}
`

// ---------------------------------------------------------------------------
// The inline diff extension

export interface DiffViewOptions {
  /** The text the document is compared against (saved file, the document before an AI edit…). */
  original: string
  /** Gutter markers (default true). */
  gutter?: boolean
  /** Accept / Reject buttons on each chunk (default true). */
  controls?: boolean
  /** Called when the chunks change. */
  onChange?: (chunks: readonly DiffChunk[], editor: Editor) => void
}

interface DiffState {
  options: DiffViewOptions
  /** Lines of the original. */
  lines: string[]
  /** The original as a string (null: join `lines` again). */
  text: string | null
  eol: string
  chunks: DiffChunk[]
  meta: WeakMap<DiffChunk, ChunkMeta>
  /** Pending full diff. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** Keeps the original (and accepted chunks) when the same extension is installed again. */
  installed: boolean
}

const KEY = 'diff'
/** Work limit of the diffs run on each edit (big regions get a coarse chunk until the next full diff). */
export const EDIT_COST = 1e5
const states = new WeakMap<Editor, DiffState>()

function metaOf(st: DiffState, c: DiffChunk): ChunkMeta {
  let m = st.meta.get(c)
  if (!m) st.meta.set(c, (m = {}))
  return m
}

function detailOf(ed: Editor, st: DiffState, c: DiffChunk): ChunkDetail | null {
  const m = metaOf(st, c)
  if (m.detail === undefined) {
    const big = c.toA - c.fromA > 200 || c.toB - c.fromB > 200
    m.detail = big ? null : chunkDetail(st.lines.slice(c.fromA, c.toA), ed.doc.lines.slice(c.fromB, c.toB))
  }
  return m.detail
}

/** Replaces the chunks, then redraws and notifies. */
function setChunks(ed: Editor, st: DiffState, chunks: DiffChunk[]): void {
  const before = st.chunks
  st.chunks = chunks
  setDecorations(ed, KEY, decorations(ed, st))
  ed.requestRender()
  if (!sameChunks(before, chunks)) st.options.onChange?.(chunks, ed)
}

/** Diffs everything again. Unless `fresh`, chunks that didn't change are kept (with their widgets). */
function fullDiff(ed: Editor, st: DiffState, fresh = false): void {
  clearTimeout(st.timer)
  st.timer = undefined
  const chunks = diffLines(st.lines, ed.doc.lines)
  if (fresh || !sameChunks(chunks, st.chunks)) setChunks(ed, st, chunks)
}

function onEdit(ed: Editor, st: DiffState, changes: readonly Change[]): void {
  const edit = editedLines(changes)
  if (!edit) return
  const old = st.chunks
  const u = updateChunks(old, st.lines, ed.doc.lines, edit, 'b', EDIT_COST)
  for (let i = u.to; i < u.chunks.length; i++) {
    const m = st.meta.get(old[i - u.to + u.oldTo]!)
    if (m) st.meta.set(u.chunks[i]!, m)
  }
  setChunks(ed, st, u.chunks)
  // Region diffs are valid but not always minimal (a block moved and moved back…), and big ones may be
  // coarse: once the edits pause, everything is diffed again (later in big documents).
  clearTimeout(st.timer)
  st.timer = setTimeout(() => st.installed && !ed.isDestroyed && fullDiff(ed, st), 300 + ed.doc.lineCount / 100)
}

/** The deleted lines of a chunk, highlighted, with the chunk's buttons on the first row. */
function deletedBlock(ed: Editor, st: DiffState, c: DiffChunk, m: ChunkMeta): HTMLElement {
  const doc = ed.dom.ownerDocument
  const el = doc.createElement('div')
  const marks = detailOf(ed, st, c)?.a ?? []
  const lang = ed.language
  let state = lang.initialState
  let html = ''
  let k = 0
  for (let i = c.fromA; i < c.toA; i++) {
    const text = st.lines[i]!
    const r = lang.tokenize(text, state)
    state = r.state
    const row: [number, number][] = []
    for (; k < marks.length && marks[k]![0] === i - c.fromA; k++) row.push([marks[k]![1], marks[k]![2]])
    html += `<div class="jc-diff-row">${lineHTML(text, r.tokens, row, 'jc-diff-del-mark')}</div>`
  }
  el.innerHTML = html
  if (st.options.controls !== false) el.firstElementChild!.appendChild(controls(ed, st, m))
  return el
}

/** Accept / Reject buttons of the chunk that owns `m`. */
function controls(ed: Editor, st: DiffState, m: ChunkMeta): HTMLElement {
  const doc = ed.dom.ownerDocument
  const box = doc.createElement('span')
  box.className = 'jc-diff-controls'
  for (const [name, run] of [['Accept', acceptChunk], ['Reject', rejectChunk]] as const) {
    const b = doc.createElement('button')
    b.type = 'button'
    b.className = 'jc-diff-' + name.toLowerCase()
    b.textContent = ed.phrase(name)
    b.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    b.addEventListener('click', () => {
      const c = st.chunks.find((x) => st.meta.get(x) === m)
      if (c) run(ed, c)
      ed.focus()
    })
    box.appendChild(b)
  }
  return box
}

function decorations(ed: Editor, st: DiffState): Decoration[] {
  const out: Decoration[] = []
  const last = ed.doc.lineCount - 1
  const buttons = st.options.controls !== false
  for (const c of st.chunks) {
    const m = metaOf(st, c)
    if (c.toA > c.fromA) {
      // Deleted lines go above the chunk (below the last line when it's at the very end).
      const end = c.fromB > last
      out.push({
        from: { line: end ? last : c.fromB, col: 0 }, block: end ? 'below' : 'above', lines: c.toA - c.fromA, class: 'jc-diff-deleted',
        widget: (e) => (m.el ??= deletedBlock(e, st, c, m)),
      })
    } else if (buttons) {
      out.push({ from: { line: c.fromB, col: ed.doc.line(c.fromB).length }, class: 'jc-diff-inline', widget: (e) => (m.el ??= controls(e, st, m)) })
    }
  }
  return out
}

/** The chunk a line belongs to (a chunk of deleted lines belongs to the line below it). */
function chunkAtLine(ed: Editor, st: DiffState, line: number): DiffChunk | undefined {
  const c = st.chunks[chunkIndexAt(st.chunks, line)]
  if (!c) return undefined
  if (c.fromB <= line && line < c.toB) return c
  if (c.fromB === c.toB && (c.fromB === line || (line === ed.doc.lineCount - 1 && c.fromB > line))) return c
  return undefined
}

function resolve(ed: Editor, chunk?: DiffChunk | number): { st: DiffState; c: DiffChunk } | null {
  const st = states.get(ed)
  if (!st?.installed) return null
  const c = chunk == null
    ? chunkAtLine(ed, st, ed.selection.head.line)
    : typeof chunk === 'number'
      ? st.chunks[chunk]
      : st.chunks.find((x) => x === chunk || sameChunks([x], [chunk]))
  return c ? { st, c } : null
}

/** Shows how the document differs from `options.original`, with Accept / Reject on each chunk. */
export function diffView(options: DiffViewOptions): Extension {
  return (editor) => {
    injectStyle(editor.dom, 'diff', DIFF_CSS)
    injectStyle(editor.dom, 'diff-view', DIFF_VIEW_CSS)
    const prev = states.get(editor)
    const text = prev && prev.options === options && !prev.installed ? (prev.text ?? prev.lines.join(prev.eol)) : options.original
    const st: DiffState = {
      options, lines: splitLines(text), text, eol: /\r\n?/.exec(text)?.[0] ?? '\n', chunks: [], meta: new WeakMap(), timer: undefined, installed: true,
    }
    states.set(editor, st)
    let last = ''
    const disposers: (() => void)[] = [
      editor.on('change', (e) => onEdit(editor, st, e.changes)),
      editor.addLayer({
        className: 'jc-diff-layer',
        order: -0.9,
        render: (dom, ed) => {
          const html = drawChunks(ed, st.chunks, 'b', (c) => detailOf(ed, st, c))
          if (html !== last) dom.innerHTML = last = html
        },
      }),
      editor.addKeymap(diffKeymap),
    ]
    if (options.gutter !== false) {
      disposers.push(editor.addGutter({
        className: 'jc-gutter-diff',
        width: () => '8px',
        cell: (line, ed) => {
          const c = chunkAtLine(ed, st, line)
          if (!c) return null
          const kind = c.fromB === c.toB ? (c.fromB > line ? 'jc-diff-g-del jc-diff-g-end' : 'jc-diff-g-del') : c.fromA === c.toA ? 'jc-diff-g-ins' : 'jc-diff-g-mod'
          return { text: '', className: kind }
        },
      }))
    }
    // Diffed now (getChunks works right away); drawn from a microtask, so that the decorations
    // machinery isn't installed as part of this extension (it would go with the next setExtensions).
    st.chunks = diffLines(st.lines, editor.doc.lines)
    queueMicrotask(() => {
      if (!st.installed) return
      setDecorations(editor, KEY, decorations(editor, st))
      options.onChange?.(st.chunks, editor)
    })
    return () => {
      for (const d of disposers) d()
      clearTimeout(st.timer)
      st.installed = false
      st.chunks = []
      setDecorations(editor, KEY, [])
    }
  }
}

/** Compares the document against a new original (everything is diffed again). No-op without `diffView()`. */
export function setOriginal(editor: Editor, text: string): void {
  const st = states.get(editor)
  if (!st?.installed) return
  st.lines = splitLines(text)
  st.text = text
  st.eol = /\r\n?/.exec(text)?.[0] ?? '\n'
  fullDiff(editor, st, true)
}

/** The current original (with the chunks accepted so far). */
export function getOriginal(editor: Editor): string | undefined {
  const st = states.get(editor)
  return st && (st.text ??= st.lines.join(st.eol))
}

/** The chunks, in document order: `fromA..toA` are lines of the original, `fromB..toB` lines of the document. */
export function getChunks(editor: Editor): readonly DiffChunk[] {
  return states.get(editor)?.chunks ?? []
}

/** Keeps a chunk (default: the one at the cursor): the original takes the document's text for it. */
export function acceptChunk(editor: Editor, chunk?: DiffChunk | number): boolean {
  const r = resolve(editor, chunk)
  if (!r) return false
  const { st, c } = r
  st.lines = spliceArray(st.lines, c.fromA, c.toA - c.fromA, editor.doc.lines.slice(c.fromB, c.toB))
  st.text = null
  const d = c.toB - c.fromB - (c.toA - c.fromA)
  const i = st.chunks.indexOf(c)
  const after = st.chunks.slice(i + 1).map((x) => {
    const moved = { ...x, fromA: x.fromA + d, toA: x.toA + d }
    const m = st.meta.get(x)
    if (m) st.meta.set(moved, m)
    return moved
  })
  setChunks(editor, st, [...st.chunks.slice(0, i), ...after])
  return true
}

/** Undoes a chunk (default: the one at the cursor): the document gets the original text back, in one undoable step. */
export function rejectChunk(editor: Editor, chunk?: DiffChunk | number): boolean {
  const r = resolve(editor, chunk)
  if (!r) return false
  editor.dispatch({ changes: revertChanges([r.c], r.st.lines, editor.doc.lines), origin: 'diff.reject' })
  return true
}

/** Keeps every change: the original becomes the document. */
export function acceptAll(editor: Editor): boolean {
  const st = states.get(editor)
  if (!st?.installed || !st.chunks.length) return false
  st.lines = editor.doc.lines.slice()
  st.text = null
  setChunks(editor, st, [])
  return true
}

/** Undoes every change (one undoable step). */
export function rejectAll(editor: Editor): boolean {
  const st = states.get(editor)
  if (!st?.chunks.length) return false
  editor.dispatch({ changes: revertChanges(st.chunks, st.lines, editor.doc.lines), origin: 'diff.reject' })
  return true
}

function jump(ed: Editor, dir: 1 | -1): boolean {
  const chunks = states.get(ed)?.chunks
  if (!chunks?.length) return false
  const last = ed.doc.lineCount - 1
  const line = ed.selection.head.line
  const starts = chunks.map((c) => Math.min(c.fromB, last))
  let i = dir > 0 ? starts.findIndex((s) => s > line) : starts.length - 1
  if (dir < 0) while (i >= 0 && starts[i]! >= line) i--
  if (i < 0) i = dir > 0 ? 0 : starts.length - 1
  ed.dispatch({ selection: { line: starts[i]!, col: 0 }, scrollIntoView: 'center', origin: 'select.diff' })
  return true
}

export const nextChunk: Command = (ed) => jump(ed, 1)
export const previousChunk: Command = (ed) => jump(ed, -1)

/** F7 / Shift-F7: next / previous chunk. Mod-Alt-Enter / Mod-Alt-Backspace: accept / reject the chunk at the cursor. */
export const diffKeymap: readonly KeyBinding[] = [
  { key: 'F7', run: nextChunk, shift: previousChunk },
  { key: 'Mod-Alt-Enter', run: (ed) => acceptChunk(ed) },
  { key: 'Mod-Alt-Backspace', run: (ed) => rejectChunk(ed) },
]

const DIFF_VIEW_CSS = `
.jc-diff-deleted{background:var(--jc-diff-deleted);box-shadow:inset 3px 0 var(--jc-diff-red)}
.jc-diff-row{height:var(--jc-lh);line-height:var(--jc-lh);padding-left:var(--jc-pad-x);white-space:pre;tab-size:var(--jc-tab-size,4)}
.jc-diff-controls{display:inline-flex;gap:4px;margin-left:3ch;height:var(--jc-lh);vertical-align:top;align-items:center;font:11px/16px system-ui,sans-serif}
.jc-diff-controls button{font:inherit;padding:0 7px;border-radius:4px;cursor:pointer;color:var(--jc-fg);--c:var(--jc-fg);
border:1px solid color-mix(in srgb,var(--c) 30%,transparent);background:color-mix(in srgb,var(--c) 12%,var(--jc-bg))}
.jc-diff-controls .jc-diff-accept{--c:var(--jc-diff-green)}
.jc-diff-controls button:hover{background:color-mix(in srgb,var(--c) 30%,var(--jc-bg))}
.jc-diff-controls button:focus-visible{outline:2px solid var(--jc-caret)}
.jc-readonly .jc-diff-controls{display:none}
.jc-gutter-diff .jc-gutter-cell{overflow:visible}
.jc-diff-g-ins::before,.jc-diff-g-mod::before,.jc-diff-g-del::before{content:'';position:absolute;right:0;width:3px;top:0;bottom:0;background:var(--jc-diff-green)}
.jc-diff-g-mod::before{background:var(--jc-diff-modified)}
.jc-diff-g-del::before{right:-2px;width:0;bottom:auto;top:-4px;border:4px solid transparent;border-left:5px solid var(--jc-diff-red);background:none}
.jc-diff-g-end::before{top:auto;bottom:-4px}
`
