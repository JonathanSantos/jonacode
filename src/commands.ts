/**
 * Editing commands. Each one is a plain function `(editor) => boolean` that
 * works on every cursor, so the ones you don't bind are dropped by
 * tree-shaking.
 */
import type { Editor } from './editor.ts'
import type { Command, KeyBinding } from './keymap.ts'
import { cursor, isEmpty, selFrom, selTo, type Selection } from './state/selection.ts'
import { cmpPos, type ChangeSpec, type Pos } from './state/text.ts'
import {
  indentLength, indentWidth, makeIndent, nextCharBoundary, prevCharBoundary, visualColumn, wordEnd, wordStart,
} from './util/text.ts'

// ---------------------------------------------------------------------------
// Helpers

/** Replaces every range with the result of `fn`. */
export function mapRanges(ed: Editor, fn: (range: Selection) => Selection, scrollIntoView = true): boolean {
  ed.dispatch({ selection: { ranges: ed.ranges.map(fn), main: ed.mainIndex }, scrollIntoView, origin: 'select' })
  return true
}

function moveHeads(ed: Editor, extend: boolean, fn: (range: Selection) => Pos): boolean {
  return mapRanges(ed, (r) => {
    const head = fn(r)
    return { anchor: extend ? r.anchor : head, head }
  })
}

/** First and last line touched by a selection (a selection ending at column 0 excludes that line). */
export function selectedLineRange(sel: Selection): [number, number] {
  const from = selFrom(sel)
  const to = selTo(sel)
  return [from.line, to.col === 0 && to.line > from.line ? to.line - 1 : to.line]
}

/** Line blocks touched by all ranges, sorted and merged when adjacent. */
export function selectedLineBlocks(ranges: readonly Selection[]): [number, number][] {
  const blocks: [number, number][] = []
  for (const r of ranges) {
    const [a, b] = selectedLineRange(r)
    const last = blocks[blocks.length - 1]
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else blocks.push([a, b])
  }
  return blocks
}

function charMove(ed: Editor, dir: -1 | 1, extend: boolean): boolean {
  const doc = ed.doc
  return mapRanges(ed, (r) => {
    if (!extend && !isEmpty(r)) return cursor(dir < 0 ? selFrom(r) : selTo(r))
    const { head } = r
    const text = doc.line(head.line)
    let p = head
    if (dir < 0) {
      if (head.col > 0) p = { line: head.line, col: prevCharBoundary(text, head.col) }
      else if (head.line > 0) p = { line: head.line - 1, col: doc.line(head.line - 1).length }
    } else {
      if (head.col < text.length) p = { line: head.line, col: nextCharBoundary(text, head.col) }
      else if (head.line < doc.lineCount - 1) p = { line: head.line + 1, col: 0 }
    }
    return { anchor: extend ? r.anchor : p, head: p }
  })
}

function wordMove(ed: Editor, dir: -1 | 1, extend: boolean): boolean {
  const doc = ed.doc
  const chars = ed.language.wordChars
  return moveHeads(ed, extend, ({ head }) => {
    const text = doc.line(head.line)
    if (dir < 0) {
      if (head.col > 0) return { line: head.line, col: wordStart(text, head.col, chars) }
      if (head.line > 0) return { line: head.line - 1, col: doc.line(head.line - 1).length }
    } else {
      if (head.col < text.length) return { line: head.line, col: wordEnd(text, head.col, chars) }
      if (head.line < doc.lineCount - 1) return { line: head.line + 1, col: 0 }
    }
    return head
  })
}

/** Moves by visual rows (so it follows wrapped lines), keeping the preferred x. */
function verticalMove(ed: Editor, rows: number, extend: boolean): boolean {
  const lh = ed.lineHeight
  const docTop = ed.coordsAtPos({ line: 0, col: 0 }).top
  return mapRanges(ed, (r) => {
    const start = !extend && !isEmpty(r) ? (rows < 0 ? selFrom(r) : selTo(r)) : r.head
    const c = ed.coordsAtPos(start)
    const x = r.goalX ?? c.x
    const y = c.top + rows * lh + lh / 2
    let head = y < docTop ? { line: 0, col: 0 } : ed.posAtCoords(x, y)
    // One row up/down landed in the empty rows of a block widget (they belong to the line): the neighbour line instead.
    const next = start.line + rows
    if ((rows === 1 || rows === -1) && head.line === start.line && ed.coordsAtPos(head).top === c.top && next >= 0 && next < ed.doc.lineCount) {
      const b = ed.lineBlock(next)
      head = ed.posAtCoords(x, rows < 0 ? b.top + b.height - lh / 2 : b.top + lh / 2)
    }
    return { anchor: extend ? r.anchor : head, head, goalX: x }
  })
}

function pageMove(ed: Editor, dir: -1 | 1, extend: boolean): boolean {
  const page = Math.max(1, Math.floor(ed.viewportHeight / ed.lineHeight) - 1)
  ed.scrollBy(dir * page * ed.lineHeight)
  return verticalMove(ed, dir * page, extend)
}

function lineStart(ed: Editor, extend: boolean): boolean {
  return moveHeads(ed, extend, ({ head }) => {
    const indent = indentLength(ed.doc.line(head.line))
    return { line: head.line, col: head.col === indent ? 0 : indent }
  })
}

function lineEnd(ed: Editor, extend: boolean): boolean {
  return moveHeads(ed, extend, ({ head }) => ({ line: head.line, col: ed.doc.line(head.line).length }))
}

function docEdge(ed: Editor, head: Pos, extend: boolean): boolean {
  ed.dispatch({ selection: extend ? { anchor: ed.selection.anchor, head } : cursor(head), scrollIntoView: true, origin: 'select' })
  return true
}

// ---------------------------------------------------------------------------
// Cursor movement

export const cursorCharLeft: Command = (ed) => charMove(ed, -1, false)
export const cursorCharRight: Command = (ed) => charMove(ed, 1, false)
export const selectCharLeft: Command = (ed) => charMove(ed, -1, true)
export const selectCharRight: Command = (ed) => charMove(ed, 1, true)
export const cursorWordLeft: Command = (ed) => wordMove(ed, -1, false)
export const cursorWordRight: Command = (ed) => wordMove(ed, 1, false)
export const selectWordLeft: Command = (ed) => wordMove(ed, -1, true)
export const selectWordRight: Command = (ed) => wordMove(ed, 1, true)
export const cursorLineUp: Command = (ed) => verticalMove(ed, -1, false)
export const cursorLineDown: Command = (ed) => verticalMove(ed, 1, false)
export const selectLineUp: Command = (ed) => verticalMove(ed, -1, true)
export const selectLineDown: Command = (ed) => verticalMove(ed, 1, true)
export const cursorPageUp: Command = (ed) => pageMove(ed, -1, false)
export const cursorPageDown: Command = (ed) => pageMove(ed, 1, false)
export const selectPageUp: Command = (ed) => pageMove(ed, -1, true)
export const selectPageDown: Command = (ed) => pageMove(ed, 1, true)
export const cursorLineStart: Command = (ed) => lineStart(ed, false)
export const cursorLineEnd: Command = (ed) => lineEnd(ed, false)
export const selectLineStart: Command = (ed) => lineStart(ed, true)
export const selectLineEnd: Command = (ed) => lineEnd(ed, true)
export const cursorDocStart: Command = (ed) => docEdge(ed, { line: 0, col: 0 }, false)
export const cursorDocEnd: Command = (ed) => docEdge(ed, ed.doc.end, false)
export const selectDocStart: Command = (ed) => docEdge(ed, { line: 0, col: 0 }, true)
export const selectDocEnd: Command = (ed) => docEdge(ed, ed.doc.end, true)

export const selectAll: Command = (ed) => {
  ed.dispatch({ selection: { anchor: { line: 0, col: 0 }, head: ed.doc.end }, origin: 'select' })
  return true
}

/** Selects the whole line(s); repeating it extends the selection by one line. */
export const selectLine: Command = (ed) => {
  const doc = ed.doc
  return mapRanges(ed, (r) => {
    const from = selFrom(r)
    const to = selTo(r)
    const full = !isEmpty(r) && from.col === 0 && to.col === 0
    const last = full ? to.line : selectedLineRange(r)[1]
    const head = last + 1 < doc.lineCount ? { line: last + 1, col: 0 } : { line: last, col: doc.line(last).length }
    return { anchor: { line: from.line, col: 0 }, head }
  })
}

/** Escape: with several cursors, keep only the main one. */
export const collapseSelections: Command = (ed) => {
  if (ed.ranges.length < 2) return false
  ed.dispatch({ selection: ed.selection, origin: 'select' })
  return true
}

// ---------------------------------------------------------------------------
// Deletion

/** Deletes each non-empty range, or the span `fn` returns for each cursor. */
function deleteBy(ed: Editor, origin: string, fn: (r: Selection) => [Pos, Pos] | null): boolean {
  ed.changeByRange((r) => {
    if (!isEmpty(r)) return { changes: { from: selFrom(r), to: selTo(r) }, range: cursor(selFrom(r)) }
    const span = fn(r)
    if (!span) return null
    const [from, to] = cmpPos(span[0], span[1]) <= 0 ? span : [span[1], span[0]]
    return { changes: { from, to }, range: cursor(from) }
  }, { origin, scrollIntoView: true })
  return true
}

export const deleteCharBackward: Command = (ed) => deleteBy(ed, 'delete.backward', ({ head }) => {
  const doc = ed.doc
  if (head.col === 0) return head.line > 0 ? [{ line: head.line - 1, col: doc.line(head.line - 1).length }, head] : null
  const text = doc.line(head.line)
  let col = prevCharBoundary(text, head.col)
  // Inside space indentation, delete back to the previous tab stop.
  const { tabSize, insertSpaces } = ed.options
  if (insertSpaces && /^ +$/.test(text.slice(0, head.col))) col = Math.floor((head.col - 1) / tabSize) * tabSize
  return [{ line: head.line, col }, head]
})

export const deleteCharForward: Command = (ed) => deleteBy(ed, 'delete.forward', ({ head }) => {
  const doc = ed.doc
  const text = doc.line(head.line)
  if (head.col < text.length) return [head, { line: head.line, col: nextCharBoundary(text, head.col) }]
  return head.line < doc.lineCount - 1 ? [head, { line: head.line + 1, col: 0 }] : null
})

export const deleteWordBackward: Command = (ed) => deleteBy(ed, 'delete.word', ({ head }) => {
  const doc = ed.doc
  if (head.col === 0) return head.line > 0 ? [{ line: head.line - 1, col: doc.line(head.line - 1).length }, head] : null
  return [{ line: head.line, col: wordStart(doc.line(head.line), head.col, ed.language.wordChars) }, head]
})

export const deleteWordForward: Command = (ed) => deleteBy(ed, 'delete.word', ({ head }) => {
  const doc = ed.doc
  const text = doc.line(head.line)
  if (head.col < text.length) return [head, { line: head.line, col: wordEnd(text, head.col, ed.language.wordChars) }]
  return head.line < doc.lineCount - 1 ? [head, { line: head.line + 1, col: 0 }] : null
})

export const deleteToLineStart: Command = (ed) => deleteBy(ed, 'delete.line', ({ head }) => {
  if (head.col > 0) return [{ line: head.line, col: 0 }, head]
  return head.line > 0 ? [{ line: head.line - 1, col: ed.doc.line(head.line - 1).length }, head] : null
})

export const deleteToLineEnd: Command = (ed) => deleteBy(ed, 'delete.line', ({ head }) => {
  const len = ed.doc.line(head.line).length
  if (head.col < len) return [head, { line: head.line, col: len }]
  return head.line < ed.doc.lineCount - 1 ? [head, { line: head.line + 1, col: 0 }] : null
})

export const deleteLine: Command = (ed) => {
  const doc = ed.doc
  const blocks = selectedLineBlocks(ed.ranges)
  const changes: ChangeSpec[] = []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const [a, b] = blocks[i]!
    if (b < doc.lineCount - 1) changes.push({ from: { line: a, col: 0 }, to: { line: b + 1, col: 0 } })
    else if (a > 0) changes.push({ from: { line: a - 1, col: doc.line(a - 1).length }, to: { line: b, col: doc.line(b).length } })
    else changes.push({ from: { line: 0, col: 0 }, to: { line: b, col: doc.line(b).length } })
  }
  let removed = 0
  const col = ed.selection.head.col
  const ranges = blocks.map(([a, b]) => {
    const line = a - removed
    removed += b - a + 1
    return cursor({ line, col })
  })
  ed.dispatch({ changes, selection: { ranges, main: ranges.length - 1 }, origin: 'delete.line', scrollIntoView: true })
  return true
}

// ---------------------------------------------------------------------------
// Insertion & indentation

/** Enter: keeps the indentation, indents after an opening bracket and splits `{|}` in three lines. */
export const insertNewline: Command = (ed) => {
  ed.changeByRange((r) => {
    const from = selFrom(r)
    const lang = ed.languageAt(from)
    const to = selTo(r)
    const line = ed.doc.line(from.line)
    const before = line.slice(0, from.col)
    const after = ed.doc.line(to.line).slice(to.col)
    const indent = line.slice(0, Math.min(indentLength(line), from.col))
    const increase = !!lang.indent.increase?.test(before)
    let insert = '\n' + indent + (increase ? ed.indentUnit : '')
    const caretCol = insert.length - 1
    if (increase && lang.indent.decrease?.test(after)) insert += '\n' + indent
    // Trailing whitespace before the cursor is removed (so blank lines stay clean).
    const start = { line: from.line, col: before.trimEnd().length }
    return { changes: { from: start, to, insert }, range: cursor({ line: from.line + 1, col: caretCol }) }
  }, { origin: 'input', scrollIntoView: true })
  return true
}

function indentLines(ed: Editor, dir: 1 | -1): boolean {
  const { tabSize, insertSpaces } = ed.options
  const doc = ed.doc
  const blocks = selectedLineBlocks(ed.ranges)
  const changes: ChangeSpec[] = []
  const deltas = new Map<number, number>()
  for (let i = blocks.length - 1; i >= 0; i--) {
    const [a, b] = blocks[i]!
    for (let l = b; l >= a; l--) {
      const text = doc.line(l)
      const len = indentLength(text)
      if (dir > 0 && len === text.length && a !== b) continue
      const width = indentWidth(text.slice(0, len), tabSize)
      const next = dir > 0 ? (Math.floor(width / tabSize) + 1) * tabSize : Math.max(0, Math.ceil(width / tabSize) - 1) * tabSize
      const indent = makeIndent(next, tabSize, insertSpaces)
      if (indent === text.slice(0, len)) continue
      changes.push({ from: { line: l, col: 0 }, to: { line: l, col: len }, insert: indent })
      deltas.set(l, indent.length - len)
    }
  }
  if (!changes.length) return true
  const ranges = ed.ranges.map((r) => {
    const multi = r.anchor.line !== r.head.line
    const map = (p: Pos): Pos => {
      const d = deltas.get(p.line)
      if (!d || (multi && p.col === 0)) return p
      return { line: p.line, col: Math.max(0, p.col + d) }
    }
    return { anchor: map(r.anchor), head: map(r.head) }
  })
  ed.dispatch({ changes, selection: { ranges, main: ed.mainIndex }, origin: 'indent' })
  return true
}

/** Tab: indents the selected lines, or inserts spaces up to the next tab stop. */
export const indentMore: Command = (ed) => {
  if (ed.ranges.some((r) => r.anchor.line !== r.head.line)) return indentLines(ed, 1)
  const { tabSize, insertSpaces } = ed.options
  ed.changeByRange((r) => {
    const from = selFrom(r)
    const col = visualColumn(ed.doc.line(from.line), from.col, tabSize)
    const text = insertSpaces ? ' '.repeat(tabSize - (col % tabSize)) : '\t'
    return { changes: { from, to: selTo(r), insert: text }, range: cursor({ line: from.line, col: from.col + text.length }) }
  }, { origin: 'input', scrollIntoView: true })
  return true
}

export const indentLess: Command = (ed) => indentLines(ed, -1)
export const indentSelection: Command = (ed) => indentLines(ed, 1)

/** Opens a new line below the current one (Mod-Enter). */
export const insertLineAfter: Command = (ed) => {
  ed.changeByRange(({ head }) => {
    const text = ed.doc.line(head.line)
    const indent = text.slice(0, indentLength(text)) + (ed.languageAt(head).indent.increase?.test(text) ? ed.indentUnit : '')
    return {
      changes: { from: { line: head.line, col: text.length }, insert: '\n' + indent },
      range: cursor({ line: head.line + 1, col: indent.length }),
    }
  }, { origin: 'input', scrollIntoView: true })
  return true
}

/** Opens a new line above the current one (Mod-Shift-Enter). */
export const insertLineBefore: Command = (ed) => {
  ed.changeByRange(({ head }) => {
    const text = ed.doc.line(head.line)
    const indent = text.slice(0, indentLength(text))
    return { changes: { from: { line: head.line, col: 0 }, insert: indent + '\n' }, range: cursor({ line: head.line, col: indent.length }) }
  }, { origin: 'input', scrollIntoView: true })
  return true
}

// ---------------------------------------------------------------------------
// Lines

function moveLines(ed: Editor, dir: 1 | -1): boolean {
  const doc = ed.doc
  const blocks = selectedLineBlocks(ed.ranges)
  if (blocks.some(([a, b]) => (dir < 0 ? a === 0 : b >= doc.lineCount - 1))) return true
  const changes: ChangeSpec[] = blocks.map(([a, b]) => {
    const block = doc.lines.slice(a, b + 1)
    return dir < 0
      ? { from: { line: a - 1, col: 0 }, to: { line: b, col: doc.line(b).length }, insert: [...block, doc.line(a - 1)] }
      : { from: { line: a, col: 0 }, to: { line: b + 1, col: doc.line(b + 1).length }, insert: [doc.line(b + 1), ...block] }
  })
  const shift = (p: Pos) => ({ line: p.line + dir, col: p.col })
  ed.dispatch({
    changes,
    selection: { ranges: ed.ranges.map((r) => ({ anchor: shift(r.anchor), head: shift(r.head) })), main: ed.mainIndex },
    origin: 'move',
    scrollIntoView: true,
  })
  return true
}

function copyLines(ed: Editor, dir: 1 | -1): boolean {
  const doc = ed.doc
  const blocks = selectedLineBlocks(ed.ranges)
  const changes: ChangeSpec[] = []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const [a, b] = blocks[i]!
    const block = doc.lines.slice(a, b + 1)
    changes.push(dir < 0
      ? { from: { line: a, col: 0 }, insert: [...block, ''] }
      : { from: { line: b, col: doc.line(b).length }, insert: ['', ...block] })
  }
  // Each range moves down by the lines inserted above it (and its own copy when copying down).
  const ranges = ed.ranges.map((r) => {
    const line = selFrom(r).line
    let shift = 0
    for (const [a, b] of blocks) {
      if (b < line || (a <= line && dir > 0)) shift += b - a + 1
    }
    const move = (p: Pos) => ({ line: p.line + shift, col: p.col })
    return { anchor: move(r.anchor), head: move(r.head) }
  })
  ed.dispatch({ changes, selection: { ranges, main: ed.mainIndex }, origin: 'copy.line', scrollIntoView: true })
  return true
}

export const moveLineUp: Command = (ed) => moveLines(ed, -1)
export const moveLineDown: Command = (ed) => moveLines(ed, 1)
export const copyLineUp: Command = (ed) => copyLines(ed, -1)
export const copyLineDown: Command = (ed) => copyLines(ed, 1)

// ---------------------------------------------------------------------------
// Comments

function toggleLineComment(ed: Editor, token: string): boolean {
  const doc = ed.doc
  const blocks = selectedLineBlocks(ed.ranges)
  let minIndent = Infinity
  let commented = true
  let blank = true
  for (const [a, b] of blocks) {
    for (let l = a; l <= b; l++) {
      const text = doc.line(l)
      const ind = indentLength(text)
      if (ind === text.length) continue
      blank = false
      minIndent = Math.min(minIndent, ind)
      if (!text.startsWith(token, ind)) commented = false
    }
  }
  const changes: ChangeSpec[] = []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const [a, b] = blocks[i]!
    for (let l = b; l >= a; l--) {
      const text = doc.line(l)
      const ind = indentLength(text)
      if (ind === text.length && !blank) continue
      if (commented && !blank) {
        const end = ind + token.length + (text[ind + token.length] === ' ' ? 1 : 0)
        changes.push({ from: { line: l, col: ind }, to: { line: l, col: end } })
      } else {
        changes.push({ from: { line: l, col: blank ? ind : minIndent }, insert: token + ' ' })
      }
    }
  }
  ed.dispatch({ changes, origin: 'comment' })
  return true
}

function toggleBlockComment(ed: Editor, [open, close]: readonly [string, string]): boolean {
  ed.changeByRange((r) => {
    const from = selFrom(r)
    const to = selTo(r)
    const text = ed.doc.slice(from, to)
    let insert: string
    if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
      insert = text.slice(open.length, text.length - close.length)
      if (insert.startsWith(' ') && insert.endsWith(' ') && insert.length > 1) insert = insert.slice(1, -1)
    } else insert = `${open} ${text} ${close}`
    const lines = insert.split('\n')
    const end = lines.length === 1 ? { line: from.line, col: from.col + insert.length } : { line: from.line + lines.length - 1, col: lines[lines.length - 1]!.length }
    return { changes: { from, to, insert }, range: { anchor: from, head: end } }
  }, { origin: 'comment' })
  return true
}

/** Mod-/: toggles line comments (or a block comment when the language has no line comments). */
export const toggleComment: Command = (ed) => {
  const first = selFrom(ed.selection).line
  const text = ed.doc.line(first)
  const { line, block } = ed.languageAt({ line: first, col: indentLength(text) }).comments
  if (line) return toggleLineComment(ed, line)
  if (block) return toggleBlockComment(ed, block)
  return false
}

// ---------------------------------------------------------------------------
// History

export const undo: Command = (ed) => (ed.undo(), true)
export const redo: Command = (ed) => (ed.redo(), true)

// ---------------------------------------------------------------------------
// Keymaps

/** Essential bindings, always installed by the editor. */
export const defaultKeymap: readonly KeyBinding[] = [
  { key: 'ArrowLeft', run: cursorCharLeft, shift: selectCharLeft },
  { key: 'ArrowRight', run: cursorCharRight, shift: selectCharRight },
  { key: 'Ctrl-ArrowLeft', mac: 'Alt-ArrowLeft', run: cursorWordLeft, shift: selectWordLeft },
  { key: 'Ctrl-ArrowRight', mac: 'Alt-ArrowRight', run: cursorWordRight, shift: selectWordRight },
  { key: 'ArrowUp', run: cursorLineUp, shift: selectLineUp },
  { key: 'ArrowDown', run: cursorLineDown, shift: selectLineDown },
  { key: 'Home', run: cursorLineStart, shift: selectLineStart },
  { key: 'End', run: cursorLineEnd, shift: selectLineEnd },
  { mac: 'Cmd-ArrowLeft', run: cursorLineStart, shift: selectLineStart },
  { mac: 'Cmd-ArrowRight', run: cursorLineEnd, shift: selectLineEnd },
  { mac: 'Ctrl-a', run: cursorLineStart, shift: selectLineStart },
  { mac: 'Ctrl-e', run: cursorLineEnd, shift: selectLineEnd },
  { key: 'Ctrl-Home', mac: 'Cmd-ArrowUp', run: cursorDocStart, shift: selectDocStart },
  { key: 'Ctrl-End', mac: 'Cmd-ArrowDown', run: cursorDocEnd, shift: selectDocEnd },
  { key: 'PageUp', run: cursorPageUp, shift: selectPageUp },
  { key: 'PageDown', run: cursorPageDown, shift: selectPageDown },
  { key: 'Mod-a', run: selectAll },
  { key: 'Escape', run: collapseSelections },
  { key: 'Backspace', run: deleteCharBackward, shift: deleteCharBackward },
  { key: 'Delete', run: deleteCharForward },
  { key: 'Ctrl-Backspace', mac: 'Alt-Backspace', run: deleteWordBackward },
  { key: 'Ctrl-Delete', mac: 'Alt-Delete', run: deleteWordForward },
  { mac: 'Cmd-Backspace', run: deleteToLineStart },
  { mac: 'Cmd-Delete', run: deleteToLineEnd },
  { key: 'Enter', run: insertNewline, shift: insertNewline },
  { key: 'Tab', run: indentMore, shift: indentLess },
  { key: 'Mod-z', run: undo },
  { key: 'Mod-Shift-z', run: redo },
  { win: 'Ctrl-y', linux: 'Ctrl-y', run: redo },
]

/** Handy extras (VS Code style). Install with `keymap(editingKeymap)` — included in `basicSetup`. */
export const editingKeymap: readonly KeyBinding[] = [
  { key: 'Mod-/', run: toggleComment },
  { key: 'Alt-ArrowUp', run: moveLineUp },
  { key: 'Alt-ArrowDown', run: moveLineDown },
  { key: 'Shift-Alt-ArrowUp', run: copyLineUp },
  { key: 'Shift-Alt-ArrowDown', run: copyLineDown },
  { key: 'Mod-Shift-k', run: deleteLine },
  { key: 'Mod-Enter', run: insertLineAfter },
  { key: 'Mod-Shift-Enter', run: insertLineBefore },
  { key: 'Mod-l', run: selectLine },
  { key: 'Mod-]', run: indentSelection },
  { key: 'Mod-[', run: indentLess },
]
