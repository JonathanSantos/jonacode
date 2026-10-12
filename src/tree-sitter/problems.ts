/**
 * Syntax problems from a tree-sitter tree, with quick fixes for the common
 * slips: a missing token (`MISSING ")"`), a stray token (a trailing comma in
 * JSON, an extra `}`), an unclosed bracket or block (`foo(a, b`, a bash `if`
 * without `fi`) and an unterminated string. Pure: works on the tree and the
 * document lines, so it runs anywhere (editor, worker, server, tests).
 */
import type { ChangeSpec, Pos } from '../state/text.ts'
import type { TSNode, TSPoint } from './types.ts'

export interface SyntaxFix {
  /** Button label, e.g. "Insert `)`". */
  label: string
  changes: ChangeSpec[]
}

export interface SyntaxProblem {
  from: Pos
  to: Pos
  severity: 'error'
  message: string
  fixes: SyntaxFix[]
}

export interface ProblemOptions {
  /** Translates UI texts (placeholders like `{token}` are filled after). */
  phrase?: (text: string) => string
  /** Grammar name (`javascript`, `json`, `shell`…): enables its specific fixes. */
  grammar?: string
  /** At most this many problems (default 200). */
  max?: number
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSE = new Set([')', ']', '}'])
/** Block keywords that need a closing keyword (bash). */
const KEYWORDS: Record<string, Record<string, string>> = { shell: { if: 'fi', do: 'done', case: 'esac' } }
const KEYWORD_CLOSE: Record<string, Set<string>> = { shell: new Set(['fi', 'done', 'esac']) }
const QUOTES = new Set(['"', "'", '`'])
const MAX_LEAVES = 4000

const pos = (p: TSPoint): Pos => ({ line: p.row, col: p.column })
const code = (s: string) => '`' + s + '`'
const indentOf = (text: string) => /^[ \t]*/.exec(text)![0]

/** Leaf tokens of a node, in order (at most `MAX_LEAVES`). */
function leaves(node: TSNode, out: TSNode[] = []): TSNode[] {
  if (out.length >= MAX_LEAVES) return out
  if (!node.childCount) out.push(node)
  else for (const c of node.children) if (c) leaves(c, out)
  return out
}

/** The first ERROR node inside `node` (depth-first), or null. */
function firstErrorIn(node: TSNode): TSNode | null {
  for (const c of node.children) {
    if (!c || !c.hasError || c.isMissing) continue
    const found = c.isError ? c : firstErrorIn(c)
    if (found) return found
  }
  return null
}

/** The deepest ERROR when errors nest (the precise spot). */
function innermostError(err: TSNode): TSNode {
  let e = err
  for (let next = firstErrorIn(e); next; next = firstErrorIn(e)) e = next
  return e
}

export function findSyntaxProblems(root: TSNode, lines: readonly string[], options: ProblemOptions = {}): SyntaxProblem[] {
  const t = options.phrase ?? ((s: string) => s)
  const say = (text: string, token = '') => t(text).replace('{token}', code(token))
  const max = options.max ?? 200
  const grammar = options.grammar ?? ''
  const out: SyntaxProblem[] = []
  const endOfLine = (line: number): Pos => ({ line, col: (lines[line] ?? '').length })
  /** One line at most: big ERROR nodes would underline half the file. */
  const firstLine = (from: Pos, to: Pos): Pos => (to.line > from.line ? endOfLine(from.line) : to)

  /** Set when the first error explains the ones after it (they're the parser's recovery): stop there. */
  let stop = false
  const nextLine = (line: number): string => {
    for (let l = line + 1; l < lines.length; l++) if (lines[l]!.trim()) return lines[l]!.trim()
    return ''
  }

  const missing = (node: TSNode) => {
    const at = pos(node.startPosition)
    const token = node.type
    // JSON: the parser closes the object/array early when a comma is missing at the end of a line.
    if (grammar === 'json' && (token === '}' || token === ']') && at.col >= (lines[at.line] ?? '').trimEnd().length && /^["\d\-tfn{[]/.test(nextLine(at.line))) {
      const eol = { line: at.line, col: (lines[at.line] ?? '').trimEnd().length }
      out.push({
        from: eol, to: eol, severity: 'error', message: say('Missing {token}', ','),
        fixes: [{ label: say('Insert {token}', ','), changes: [{ from: eol, insert: ',' }] }],
      })
      stop = true
      return
    }
    if (node.isNamed) {
      out.push({ from: at, to: at, severity: 'error', message: say('Missing {token}', token.replace(/_/g, ' ')), fixes: [] })
    } else {
      // A closer that tree-sitter put at the end of the file: close the block where its indentation ends instead.
      let change: ChangeSpec = { from: at, insert: token }
      const opener = node.parent?.child(0)
      if (CLOSE.has(token) && opener && OPEN[opener.type] === token && at.line > opener.startPosition.row) {
        const { at: where, newline } = closeAt(opener, at)
        // Indented like the innermost block still open there (the line above that opens one).
        let indent = indentOf(lines[opener.startPosition.row] ?? '')
        const inner = indentOf(lines[where.line] ?? '').length
        for (let l = where.line; l > opener.startPosition.row; l--) {
          const text = lines[l] ?? ''
          if (text.trimEnd().endsWith(opener.type) && indentOf(text).length < inner) {
            indent = indentOf(text)
            break
          }
        }
        change = { from: where, insert: newline ? '\n' + indent + token : token }
      }
      out.push({
        from: at, to: at, severity: 'error', message: say('Missing {token}', token),
        fixes: [{ label: say('Insert {token}', token), changes: [change] }],
      })
    }
  }

  /** Where closers go: after the last line of the block the opener starts (by indentation), not at the end of the file. */
  const closeAt = (opener: TSNode, errEnd: Pos): { at: Pos; newline: boolean } => {
    const row = opener.startPosition.row
    const indent = indentOf(lines[row] ?? '')
    let last = row
    for (let l = row + 1; l <= errEnd.line && l < lines.length; l++) {
      const text = lines[l]!
      if (!text.trim()) continue
      if (indentOf(text).length <= indent.length) break
      last = l
    }
    return { at: last === errEnd.line ? errEnd : endOfLine(last), newline: last > row }
  }

  const error = (err: TSNode) => {
    const from = pos(err.startPosition)
    const to = pos(err.endPosition)
    const tokens = leaves(err)
    // A single stray token: remove it.
    if (tokens.length === 1 && !tokens[0]!.isNamed) {
      const tok = tokens[0]!
      const a = pos(tok.startPosition)
      const b = pos(tok.endPosition)
      out.push({
        from: a, to: b, severity: 'error', message: say('Unexpected {token}', tok.type),
        fixes: [{ label: say('Remove {token}', tok.type), changes: [{ from: a, to: b }] }],
      })
      return
    }
    // JSON: a value right after another one (`{"a": 1 "b": 2}`): a comma is missing after it.
    if (grammar === 'json' && err.childCount === 1 && err.child(0)?.isNamed && /^(object|array)$/.test(err.parent?.type ?? '')) {
      out.push({
        from, to: firstLine(from, to), severity: 'error', message: say('Missing {token}', ','),
        fixes: [{ label: say('Insert {token}', ','), changes: [{ from: to, insert: ',' }] }],
      })
      return
    }
    // An unterminated string: close it at the end of its line.
    const first = tokens[0]
    if (first && QUOTES.has(first.type) && !tokens.slice(1).some((tk) => tk.type === first.type)) {
      const a = pos(first.startPosition)
      const eol = endOfLine(a.line)
      out.push({
        from: a, to: eol, severity: 'error', message: t('Unterminated string'),
        fixes: [{ label: t('Close the string'), changes: [{ from: eol, insert: first.type }] }],
      })
      return
    }
    // Brackets (and block keywords) opened inside the error and never closed.
    const openers = KEYWORDS[grammar] ?? {}
    const closers = KEYWORD_CLOSE[grammar]
    const stack: TSNode[] = []
    const stray: TSNode[] = []
    for (const tk of tokens) {
      if (tk.isNamed) continue
      if (OPEN[tk.type] || openers[tk.type]) stack.push(tk)
      else if (CLOSE.has(tk.type) || closers?.has(tk.type)) {
        const top = stack[stack.length - 1]
        if (top && (OPEN[top.type] ?? openers[top.type]) === tk.type) stack.pop()
        else if (!top) stray.push(tk)
      }
    }
    // A closer without an opener (`foo())`): remove it.
    if (!stack.length && stray.length === 1) {
      const tok = stray[0]!
      const a = pos(tok.startPosition)
      const b = pos(tok.endPosition)
      out.push({
        from: a, to: b, severity: 'error', message: say('Unexpected {token}', tok.type),
        fixes: [{ label: say('Remove {token}', tok.type), changes: [{ from: a, to: b }] }],
      })
      return
    }
    if (stack.length) {
      const opener = stack[0]!
      const closing = stack.map((tk) => ({ text: OPEN[tk.type] ?? openers[tk.type]!, indent: indentOf(lines[tk.startPosition.row] ?? '') })).reverse()
      const { at, newline } = closeAt(opener, to)
      // Brackets on one line close inline; blocks (and keywords) get their own lines, indented like their openers.
      const insert = newline || closing.some((c) => c.text.length > 1)
        ? closing.map((c) => '\n' + c.indent + c.text).join('')
        : closing.map((c) => c.text).join('')
      const a = pos(opener.startPosition)
      out.push({
        from: a, to: pos(opener.endPosition), severity: 'error', message: say('Unclosed {token}', opener.type),
        fixes: [{ label: say('Insert {token}', closing.map((c) => c.text).join(' ')), changes: [{ from: at, insert }] }],
      })
      return
    }
    // Anything else: point at the innermost error, no automatic fix.
    const inner = innermostError(err)
    const a = pos(inner.startPosition)
    const b = firstLine(a, pos(inner.endPosition))
    const near = (lines[a.line] ?? '').slice(a.col, a.line === b.line ? b.col : undefined).trim().slice(0, 40)
    out.push({ from: a, to: b, severity: 'error', message: near ? say('Syntax error near {token}', near) : t('Syntax error'), fixes: [] })
  }

  const walk = (node: TSNode) => {
    if (out.length >= max || stop) return
    if (node.isMissing) return missing(node)
    if (node.isError) return error(node)
    if (!node.hasError) return
    for (const c of node.children) if (c) walk(c)
  }
  walk(root)
  return out
}

/** All the fixes that can go in one transaction (non-overlapping, last first). */
export function combineFixes(problems: readonly SyntaxProblem[]): ChangeSpec[] {
  const specs = problems.flatMap((p) => (p.fixes[0] ? p.fixes[0].changes : []))
  const key = (s: ChangeSpec) => [s.from.line, s.from.col] as const
  specs.sort((a, b) => key(b)[0] - key(a)[0] || key(b)[1] - key(a)[1])
  const out: ChangeSpec[] = []
  let floor: Pos | null = null
  for (const s of specs) {
    const end = s.to ?? s.from
    if (floor && (end.line > floor.line || (end.line === floor.line && end.col > floor.col))) continue
    out.push(s)
    floor = s.from
  }
  return out
}
