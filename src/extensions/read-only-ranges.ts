/**
 * Read-only ranges: regions of the document nobody can change — not the
 * user, not commands, not an AI (its edits fail with a message). Typing right
 * before or after a region works, unless that edge is inclusive
 * (`inclusiveStart` / `inclusiveEnd`, or `sticky` for the ends of the
 * document); undo and redo always do. The regions follow the edits around them.
 *
 * ```ts
 * createEditor(el, { extensions: [readOnlyRanges([])] })
 * setReadOnlyRanges(editor, [{ from: { line: 10, col: 0 }, to: { line: 12, col: 1 } }])
 * // "Only lines 27 to 29 are yours": nothing can be typed before line 1 or after the last one either.
 * setReadOnlyRanges(editor, [lineRange(editor, 1, 26, { sticky: true }), lineRange(editor, 30, Infinity, { sticky: true })])
 * ```
 */
import { setDecorations, type Decoration } from '../decorations.ts'
import type { Editor, Extension } from '../editor.ts'
import { cmpPos, mapPos, type Change, type Pos } from '../state/text.ts'
import { injectStyle } from '../view/style.ts'

export interface ProtectedRange {
  from: Pos
  to: Pos
  /** Inserting exactly at `from` is refused too (by default, text typed right before a range stays out of it). */
  inclusiveStart?: boolean
  /** Inserting exactly at `to` is refused too. */
  inclusiveEnd?: boolean
}

export interface ReadOnlyRangesOptions {
  /** Class of the regions (default `jc-readonly`; lines also get `<class>-line`). */
  className?: string
  /** Called when a change is rejected, e.g. to show a message. */
  onReject?: (editor: Editor, origin: string) => void
}

interface State {
  ranges: ProtectedRange[]
  options: ReadOnlyRangesOptions
  dispose: () => void
}

const SET = 'readonly'
const states = new WeakMap<Editor, State>()

/** Whether a change touches a range: removes a char inside it, or inserts inside it (at an edge only when that edge is inclusive). */
export function blocksChange(r: ProtectedRange, c: Change): boolean {
  if (cmpPos(c.from, c.to) < 0) return cmpPos(c.from, r.to) < 0 && cmpPos(c.to, r.from) > 0
  const start = cmpPos(c.from, r.from)
  const end = cmpPos(c.from, r.to)
  return (start > 0 || (!start && !!r.inclusiveStart)) && (end < 0 || (!end && !!r.inclusiveEnd))
}

/**
 * Ranges after changes: text inserted at their edges stays outside (a range
 * never grows: at an inclusive edge only undo, redo and remote edits get to
 * insert); emptied ranges go away.
 */
function mapRanges(ranges: readonly ProtectedRange[], changes: readonly Change[]): ProtectedRange[] {
  const out: ProtectedRange[] = []
  for (const r of ranges) {
    let { from, to } = r
    for (const c of changes) {
      from = mapPos(from, c, 1)
      to = mapPos(to, c, -1)
    }
    if (cmpPos(from, to) < 0) out.push(from === r.from && to === r.to ? r : { ...r, from, to })
  }
  return out
}

function draw(editor: Editor, st: State): void {
  if (!editor.dom) return
  const cls = st.options.className ?? 'jc-readonly'
  const decos: Decoration[] = []
  for (const r of st.ranges) {
    for (let l = r.from.line; l <= r.to.line; l++) {
      // Whole lines get a full-width background; partly protected ones a mark on the protected part.
      const a = l === r.from.line ? r.from.col : 0
      const b = l === r.to.line ? r.to.col : Infinity
      const whole = a === 0 && b >= editor.doc.line(l).length
      if (!whole) decos.push({ from: { line: l, col: a }, to: { line: l, col: Math.min(b, editor.doc.line(l).length) }, class: cls })
      decos.push({ from: { line: l, col: 0 }, line: true, class: cls + '-line' + (whole ? ' ' + cls : '') })
    }
  }
  setDecorations(editor, SET, decos)
}

/** Installed on first use, for as long as the extension is there (or for good, through `setReadOnlyRanges` alone). */
function install(editor: Editor): State {
  return states.get(editor) ?? editor.untracked(() => setup(editor))
}

function setup(editor: Editor): State {
  let st: State | undefined
  const offFilter = editor.addChangeFilter((changes, origin, ed) => {
    // Undo / redo, and edits from other people in a collaborative session, aren't this user's typing.
    if (origin === 'undo' || origin === 'redo' || origin === 'setValue' || origin === 'remote') return true
    let ranges: readonly ProtectedRange[] = st!.ranges
    for (const c of changes) {
      if (ranges.some((r) => blocksChange(r, c))) {
        st!.options.onReject?.(ed, origin)
        return false
      }
      // The next change is in the coordinates left by this one.
      ranges = mapRanges(ranges, [c])
    }
    return true
  })
  const offChange = editor.on('change', ({ changes }) => {
    if (!st!.ranges.length) return
    const next = mapRanges(st!.ranges, changes)
    const moved = next.length !== st!.ranges.length || next.some((r, i) => r.from.line !== st!.ranges[i]!.from.line || r.to.line !== st!.ranges[i]!.to.line)
    st!.ranges = next
    // Line decorations stick to their line: redraw when a range changed lines (after the
    // decorations of this change were mapped, or ours would be mapped twice).
    if (moved && editor.dom) queueMicrotask(() => {
      if (states.get(editor) === st) draw(editor, st!)
    })
  })
  st = {
    ranges: [],
    options: {},
    dispose() {
      offFilter()
      offChange()
      states.delete(editor)
      if (editor.dom) setDecorations(editor, SET, [])
    },
  }
  states.set(editor, st)
  if (editor.dom) injectStyle(editor.dom, 'readonly', READONLY_CSS)
  return st
}

/** Protects ranges of the document from every edit (except undo / redo). */
export function readOnlyRanges(ranges: readonly ProtectedRange[], options: ReadOnlyRangesOptions = {}): Extension {
  return (editor) => {
    const st = install(editor)
    st.options = options
    setReadOnlyRanges(editor, ranges)
    return st.dispose
  }
}

/** Replaces the protected ranges (installs the protection if the extension isn't there). */
export function setReadOnlyRanges(editor: Editor, ranges: readonly ProtectedRange[]): void {
  const st = install(editor)
  st.ranges = ranges
    .map((r) => {
      const from = editor.doc.clamp(r.from)
      const to = editor.doc.clamp(r.to)
      if (cmpPos(from, to) <= 0) return { ...r, from, to }
      // Given backwards: the edges swap with their flags.
      const out: ProtectedRange = { from: to, to: from }
      if (r.inclusiveEnd) out.inclusiveStart = true
      if (r.inclusiveStart) out.inclusiveEnd = true
      return out
    })
    .filter((r) => cmpPos(r.from, r.to) < 0)
    .sort((a, b) => cmpPos(a.from, b.from))
  draw(editor, st)
}

/** The protected ranges, mapped through the edits made since they were set. */
export function getReadOnlyRanges(editor: Editor): ProtectedRange[] {
  return states.get(editor)?.ranges.slice() ?? []
}

/**
 * Whole lines `fromLine..toLine` (1-based, inclusive) as a range: start of the
 * first to end of the last. With `sticky`, an edge at the very start or end of
 * the document is inclusive: nothing can be typed before the first line or
 * after the last one.
 */
export function lineRange(editor: Editor, fromLine: number, toLine: number, options: { sticky?: boolean } = {}): ProtectedRange {
  const last = editor.doc.lineCount - 1
  const a = Math.max(0, Math.min(last, fromLine - 1))
  const b = Math.max(a, Math.min(last, toLine - 1))
  const range: ProtectedRange = { from: { line: a, col: 0 }, to: { line: b, col: editor.doc.line(b).length } }
  if (options.sticky && !a) range.inclusiveStart = true
  if (options.sticky && b === last) range.inclusiveEnd = true
  return range
}

const READONLY_CSS = `
.jc-readonly{background:color-mix(in srgb,var(--jc-fg) 7%,transparent)}
.jc-deco-below .jc-readonly-line{box-shadow:inset 2px 0 color-mix(in srgb,var(--jc-fg) 35%,transparent)}
`
