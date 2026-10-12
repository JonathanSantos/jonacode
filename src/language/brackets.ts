import type { Editor } from '../editor.ts'
import type { Pos } from '../state/text.ts'
import type { Token, TokenType } from './language.ts'

/** Brackets inside these tokens are ignored when matching. */
const SKIPPED = /^(string|comment|regexp)/

function typeAt(tokens: readonly Token[], col: number): TokenType {
  let lo = 0
  let hi = tokens.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const t = tokens[mid]!
    if (col < t.from) hi = mid - 1
    else if (col >= t.to) lo = mid + 1
    else return t.type
  }
  return null
}

const skipped = (type: TokenType) => !!type && SKIPPED.test(type)

export interface BracketMatch {
  /** The bracket next to the cursor. */
  from: Pos
  /** Its partner, or null when unmatched. */
  to: Pos | null
}

/**
 * Finds the bracket right before (or at) `pos` and its matching partner.
 * Brackets inside strings, comments and regexes are ignored.
 */
export function matchBracket(editor: Editor, pos: Pos, maxLines = 3000): BracketMatch | null {
  const pairs = editor.language.brackets
  if (!pairs.length) return null
  const doc = editor.doc
  const text = doc.line(pos.line)
  let tokens: Token[] | null = null
  for (const col of [pos.col - 1, pos.col]) {
    if (col < 0 || col >= text.length) continue
    const ch = text[col]!
    const pair = pairs.find(([o, c]) => o === ch || c === ch)
    if (!pair) continue
    tokens ??= editor.getTokens(pos.line)
    if (skipped(typeAt(tokens, col))) continue
    const forward = pair[0] === ch
    const [open, close] = pair
    const lastLine = forward ? Math.min(doc.lineCount - 1, pos.line + maxLines) : Math.max(0, pos.line - maxLines)
    let depth = 0
    for (let line = pos.line; forward ? line <= lastLine : line >= lastLine; line += forward ? 1 : -1) {
      const t = doc.line(line)
      const toks = line === pos.line ? tokens : editor.getTokens(line)
      let i = line === pos.line ? col : forward ? 0 : t.length - 1
      for (; forward ? i < t.length : i >= 0; i += forward ? 1 : -1) {
        const c = t[i]
        if (c !== open && c !== close) continue
        if (skipped(typeAt(toks, i))) continue
        if (c === (forward ? open : close)) depth++
        else if (--depth === 0) return { from: { line: pos.line, col }, to: { line, col: i } }
      }
    }
    return { from: { line: pos.line, col }, to: null }
  }
  return null
}
