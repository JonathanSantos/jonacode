import type { Editor, Extension } from '../editor.ts'
import { cursor, isEmpty, selFrom, selTo, type Selection } from '../state/selection.ts'
import type { Pos } from '../state/text.ts'

/** Auto-close only when the next char is one of these (or the end of the line). */
const CLOSE_BEFORE = ')]}>;:,.= \t'
const QUOTES = `"'\``

/** Whether the cursor is inside a string or a comment (not right after a closing quote). */
function inStringOrComment(ed: Editor, pos: Pos): boolean {
  if (pos.col === 0) return false
  const line = ed.doc.line(pos.line)
  for (const t of ed.getTokens(pos.line)) {
    if (pos.col <= t.from || pos.col > t.to) continue
    if (!t.type || !/(^|\s)(string|comment|regexp)/.test(t.type)) return false
    const closed = t.to === pos.col && t.to - t.from > 1 && QUOTES.includes(line[pos.col - 1]!) && line[t.from] === line[pos.col - 1]
    return !closed
  }
  return false
}

type Action = 'plain' | 'wrap' | 'over' | 'pair'

function decide(ed: Editor, r: Selection, text: string, opening?: readonly [string, string], closing?: readonly [string, string]): Action {
  if (!isEmpty(r)) return opening ? 'wrap' : 'plain'
  const { head } = r
  const line = ed.doc.line(head.line)
  const next = line[head.col] ?? ''
  const prev = line[head.col - 1] ?? ''
  if (closing && next === text) return 'over'
  if (!opening) return 'plain'
  const [open, close] = opening
  if (next && !CLOSE_BEFORE.includes(next)) return 'plain'
  // Quotes are not closed right after a word char (it's probably an apostrophe).
  if (open === close && (/[\p{L}\p{N}_$]/u.test(prev) || prev === open)) return 'plain'
  if (inStringOrComment(ed, head)) return 'plain'
  return 'pair'
}

function handleInput(ed: Editor, text: string): boolean {
  if (text.length !== 1) return false
  const pairs = ed.languageAt(ed.selection.head).closePairs
  const opening = pairs.find(([open]) => open === text)
  const closing = pairs.find(([, close]) => close === text)
  if (!opening && !closing) return false
  // Nothing special for any cursor: let the default insertion (and auto-outdent) run.
  if (ed.ranges.every((r) => decide(ed, r, text, opening, closing) === 'plain')) return false

  ed.changeByRange((r) => {
    const from = selFrom(r)
    const to = selTo(r)
    switch (decide(ed, r, text, opening, closing)) {
      case 'over':
        return { range: cursor({ line: r.head.line, col: r.head.col + 1 }) }
      case 'pair':
        return { changes: { from, insert: opening![0] + opening![1] }, range: cursor({ line: from.line, col: from.col + opening![0].length }) }
      case 'wrap': {
        const [open, close] = opening!
        const shift = (p: Pos) => (p.line === from.line ? { line: p.line, col: p.col + open.length } : p)
        return { changes: [{ from: to, insert: close }, { from, insert: open }], range: { anchor: shift(r.anchor), head: shift(r.head) } }
      }
      default:
        return { changes: { from, to, insert: text }, range: cursor({ line: from.line, col: from.col + text.length }) }
    }
  }, { origin: 'input', scrollIntoView: true })
  return true
}

/** Backspace between an empty pair `(|)` deletes both chars. */
function deletePair(ed: Editor): boolean {
  const pairs = ed.languageAt(ed.selection.head).closePairs
  const isPair = (r: Selection) => {
    if (!isEmpty(r)) return false
    const line = ed.doc.line(r.head.line)
    const prev = line[r.head.col - 1]
    const next = line[r.head.col]
    return !!prev && !!next && pairs.some(([o, c]) => o === prev && c === next)
  }
  if (!ed.ranges.every(isPair)) return false
  ed.changeByRange(({ head }) => ({
    changes: { from: { line: head.line, col: head.col - 1 }, to: { line: head.line, col: head.col + 1 } },
    range: cursor({ line: head.line, col: head.col - 1 }),
  }), { origin: 'delete.backward' })
  return true
}

/** Auto-closes brackets and quotes, types over closing chars and wraps selections. */
export function closeBrackets(): Extension {
  return (editor) => {
    editor.addInputHandler(handleInput)
    editor.addKeymap([{ key: 'Backspace', run: deletePair }])
  }
}
