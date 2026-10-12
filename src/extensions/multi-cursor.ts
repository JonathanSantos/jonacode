/**
 * Ways to create extra cursors. The core always supports several ranges;
 * this extension adds the gestures and shortcuts (VS Code style):
 *
 * - Alt+click: add / remove a cursor · Alt+Shift+drag: column selection
 * - Mod-d: select the next occurrence · Mod-Shift-l: select all occurrences
 * - Mod-Alt-↑ / Mod-Alt-↓: add a cursor above / below
 */
import type { Editor, Extension } from '../editor.ts'
import type { Command, KeyBinding } from '../keymap.ts'
import { isEmpty, selFrom, selTo, type Selection } from '../state/selection.ts'
import { cmpPos, type Pos } from '../state/text.ts'
import { wordRangeAt } from '../util/text.ts'

function wordAt(ed: Editor, pos: Pos): Selection {
  const [from, to] = wordRangeAt(ed.doc.line(pos.line), pos.col, ed.language.wordChars)
  return { anchor: { line: pos.line, col: from }, head: { line: pos.line, col: to } }
}

/** Occurrences of a single-line `query`, in document order. */
function* occurrences(ed: Editor, query: string, start: Pos = { line: 0, col: 0 }): Generator<Selection> {
  const doc = ed.doc
  const n = doc.lineCount
  for (let k = 0; k <= n; k++) {
    const line = (start.line + k) % n
    const text = doc.line(line)
    let col = k === 0 ? start.col : 0
    const limit = k === n ? start.col : Infinity // wrapped back to the start line
    for (;;) {
      const i = text.indexOf(query, col)
      if (i < 0 || i >= limit) break
      yield { anchor: { line, col: i }, head: { line, col: i + query.length } }
      col = i + Math.max(1, query.length)
    }
  }
}

/** Mod-d: selects the word at the cursor, then adds the next occurrence of the selection. */
export const selectNextOccurrence: Command = (ed) => {
  const main = ed.selection
  if (isEmpty(main)) {
    ed.dispatch({ selection: { ranges: ed.ranges.map((r) => (isEmpty(r) ? wordAt(ed, r.head) : r)), main: ed.mainIndex }, origin: 'select' })
    return true
  }
  const query = ed.doc.slice(selFrom(main), selTo(main))
  if (query.includes('\n')) return true
  const taken = (r: Selection) => ed.ranges.some((x) => cmpPos(selFrom(x), r.anchor) === 0 && cmpPos(selTo(x), r.head) === 0)
  for (const found of occurrences(ed, query, selTo(main))) {
    if (taken(found)) continue
    ed.dispatch({ selection: { ranges: [...ed.ranges, found], main: ed.ranges.length }, scrollIntoView: true, origin: 'select' })
    return true
  }
  return true
}

/** Mod-Shift-l: a cursor on every occurrence of the selection (or of the word at the cursor). */
export const selectAllOccurrences: Command = (ed) => {
  const main = isEmpty(ed.selection) ? wordAt(ed, ed.selection.head) : ed.selection
  const query = ed.doc.slice(selFrom(main), selTo(main))
  if (!query || query.includes('\n')) return true
  const ranges = [...occurrences(ed, query)]
  const index = ranges.findIndex((r) => cmpPos(r.anchor, selFrom(main)) === 0)
  ed.dispatch({ selection: { ranges, main: Math.max(0, index) }, origin: 'select' })
  return true
}

function addCursorVertical(ed: Editor, dir: -1 | 1): boolean {
  const ranges = ed.ranges
  const edge = dir < 0 ? ranges[0]! : ranges[ranges.length - 1]!
  const c = ed.coordsAtPos(edge.head)
  const x = edge.goalX ?? c.x
  const y = c.top + dir * ed.lineHeight + ed.lineHeight / 2
  const last = ed.lineBlock(ed.doc.lineCount - 1)
  if (y < ed.coordsAtPos({ line: 0, col: 0 }).top || y >= last.top + last.height) return true
  const head = ed.posAtCoords(x, y)
  ed.dispatch({ selection: { ranges: [...ranges, { anchor: head, head, goalX: x }], main: ranges.length }, scrollIntoView: true, origin: 'select' })
  return true
}

export const addCursorAbove: Command = (ed) => addCursorVertical(ed, -1)
export const addCursorBelow: Command = (ed) => addCursorVertical(ed, 1)

export const multiCursorKeymap: readonly KeyBinding[] = [
  { key: 'Mod-d', run: selectNextOccurrence },
  { key: 'Mod-Shift-l', run: selectAllOccurrences },
  { key: 'Mod-Alt-ArrowUp', run: addCursorAbove },
  { key: 'Mod-Alt-ArrowDown', run: addCursorBelow },
]

export interface MultiCursorOptions {
  /** Mouse modifier that adds a cursor. Default: Alt (Option on macOS). */
  addCursor?: (event: MouseEvent) => boolean
  /** Mouse modifier for column (box) selection. Default: Alt+Shift. */
  columnSelect?: (event: MouseEvent) => boolean
  /** Install the keyboard shortcuts. Default true. */
  keymap?: boolean
}

export function multiCursor(options: MultiCursorOptions = {}): Extension {
  return (editor) => {
    editor.addCursorModifier({ kind: 'rect', test: options.columnSelect ?? ((e) => e.altKey && e.shiftKey) })
    editor.addCursorModifier({ kind: 'add', test: options.addCursor ?? ((e) => e.altKey && !e.shiftKey) })
    if (options.keymap !== false) editor.addKeymap(multiCursorKeymap)
  }
}
