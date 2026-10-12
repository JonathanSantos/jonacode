/**
 * Helpers to test grammars from any test runner (node:test, Vitest, Jest…):
 * they only return strings or throw plain `Error`s.
 *
 * They share a "caret" format: each code line is followed by marker lines,
 * one per token, with a run of `^` under the token, a space and its type
 * (`null` or `-` for plain text):
 *
 * ```
 * const answer = 42 // ok
 * ^^^^^ keyword
 *       ^^^^^^ variable
 * ```
 *
 * - Carets cover the token's text without its leading / trailing blanks.
 * - Tabs: the blanks before the carets mirror the tabs of the code line, so
 *   markers line up whatever the tab width, and code lines are kept verbatim.
 *   Columns are compared visually (tab stops every `tabSize`, default 4),
 *   so markers written with spaces under tabs work too.
 * - A code line that itself looks like a marker (blanks, `^`s, a space and a
 *   word) cannot be expressed; a line of carets alone is fine.
 *
 * @module
 */

import type { Language, Token, TokenType } from './language/language.ts'

export interface DescribeOptions {
  /** Also mark plain (`null`) and whitespace-only tokens. */
  all?: boolean
  /** Tab width used to size carets under tokens that contain tabs. Default 4. */
  tabSize?: number
}

export interface ExpectOptions {
  /** Carets may cover part of a token (by default they must cover all of it). */
  partial?: boolean
  /** On lines that have markers, every non-plain token must be marked. */
  strict?: boolean
  /**
   * Strip the first line if blank, the last line if blank and the common
   * indentation of the others (template literals indented in test code).
   * Default: only when the text starts with a blank line, so the output of
   * `describeTokens` is read verbatim (unless the source itself starts with
   * a blank line). Pass `false` for a snippet whose lines are all indented
   * on purpose (e.g. stack frames).
   */
  dedent?: boolean
  /** Tab width used to compare columns. Default 4. */
  tabSize?: number
}

export interface TokenText {
  text: string
  type: TokenType
}

const MARKER = /^([ \t]*)(\^+)[ \t]+(\S.*?)[ \t]*$/
const blank = (s: string) => !s.trim()
const pad = (s: string) => s.replace(/^/gm, '    ')
const fmt = (type: TokenType) => (type === null ? 'null' : `"${type}"`)

/** Tokenizes lines with the state carried over; adjacent tokens of a type are merged. */
function lex(language: Language, lines: readonly string[]): Token[][] {
  let state = language.initialState
  return lines.map((line) => {
    const res = language.tokenize(line, state)
    state = res.state
    const out: Token[] = []
    for (const t of res.tokens) {
      const last = out[out.length - 1]
      if (t.to <= t.from) continue
      if (last && last.type === t.type && last.to === t.from) last.to = t.to
      else out.push({ from: t.from, to: t.to, type: t.type })
    }
    return out
  })
}

/** Visual column of each char boundary (tabs jump to the next tab stop). */
function columns(line: string, tab: number): number[] {
  const out = [0]
  for (let i = 0, c = 0; i < line.length; i++) out.push((c = line[i] === '\t' ? c + tab - (c % tab) : c + 1))
  return out
}

/** The range of a token without its edge blanks (whole for a blank token). */
function trimmed(line: string, t: Token): [number, number] {
  const s = line.slice(t.from, t.to)
  if (blank(s)) return [t.from, t.to]
  return [t.from + s.length - s.trimStart().length, t.to - (s.length - s.trimEnd().length)]
}

function marker(line: string, cols: number[], from: number, to: number, type: TokenType): string {
  return line.slice(0, from).replace(/[^\t]/g, ' ') + '^'.repeat(Math.max(1, cols[to]! - cols[from]!)) + ' ' + (type ?? 'null')
}

const skipped = (line: string, t: Token) => t.type === null || blank(line.slice(t.from, t.to))

function describeLine(line: string, tokens: readonly Token[], all: boolean, tab: number): string {
  const cols = columns(line, tab)
  let out = line
  for (const t of tokens) if (all || !skipped(line, t)) out += '\n' + marker(line, cols, ...trimmed(line, t), t.type)
  return out
}

/**
 * Tokenizes `source` line by line (the state is carried across lines) and
 * returns the tokens of each line. Plain whitespace-only tokens are left out
 * unless `all` is set.
 */
export function tokenizeLines(language: Language, source: string, options: { all?: boolean } = {}): TokenText[][] {
  const lines = source.split(/\r?\n/)
  return lex(language, lines).map((tokens, i) =>
    tokens
      .map((t) => ({ text: lines[i]!.slice(t.from, t.to), type: t.type }))
      .filter((t) => options.all || t.type !== null || !blank(t.text)),
  )
}

/**
 * Returns `source` annotated with the tokens of each line in the caret
 * format, ready to read or to paste into a test for `expectTokens`.
 * Plain and whitespace-only tokens are skipped unless `options.all` is set.
 */
export function describeTokens(language: Language, source: string, options: DescribeOptions = {}): string {
  const lines = source.split(/\r?\n/)
  const tab = options.tabSize ?? 4
  return lex(language, lines).map((tokens, i) => describeLine(lines[i]!, tokens, !!options.all, tab)).join('\n')
}

interface Marker {
  /** Index of the code line it annotates. */
  line: number
  indent: string
  width: number
  type: TokenType
}

function parse(annotated: string, dedent: boolean | undefined): { code: string[]; markers: Marker[] } {
  let rows = annotated.split(/\r?\n/)
  if (dedent ?? (rows.length > 1 && blank(rows[0]!))) {
    if (rows.length && blank(rows[0]!)) rows.shift()
    if (rows.length && blank(rows[rows.length - 1]!)) rows.pop()
    let indent: string | undefined
    for (const row of rows) {
      if (blank(row)) continue
      const lead = /^[ \t]*/.exec(row)![0]
      let n = 0
      if (indent === undefined) n = lead.length
      else while (n < indent.length && indent[n] === lead[n]) n++
      indent = lead.slice(0, n)
    }
    rows = rows.map((row) => (blank(row) ? '' : row.slice(indent?.length ?? 0)))
  }
  const code: string[] = []
  const markers: Marker[] = []
  for (const row of rows) {
    const m = code.length ? MARKER.exec(row) : null
    if (!m) code.push(row)
    else markers.push({ line: code.length - 1, indent: m[1]!, width: m[2]!.length, type: m[3] === 'null' || m[3] === '-' ? null : m[3]! })
  }
  return { code, markers }
}

/**
 * Checks tokens against an annotated snippet in the caret format (see
 * `describeTokens`). For each marker, the text under the carets must be
 * exactly one token (its blank edges may be left out) of the given type;
 * with `partial`, the carets may cover part of it. `null` / `-` markers
 * only require the covered text to be plain. Lines without markers are
 * tokenized (for the state) but not checked, unless `strict` is set and
 * the line has markers.
 *
 * Throws an `Error` listing every mismatch, with the actual tokens of each
 * failing line in the caret format (copy them to fix the test).
 *
 * ```ts
 * expectTokens(javascript, `
 *   const answer = 42
 *   ^^^^^ keyword
 *                  ^^ number
 * `)
 * ```
 */
export function expectTokens(language: Language, annotated: string, options: ExpectOptions = {}): void {
  const tab = options.tabSize ?? 4
  const { code, markers } = parse(annotated, options.dedent)
  const lines = lex(language, code)
  const problems = new Map<number, string[]>()
  const marked = new Map<number, [number, number][]>()
  const report = (line: number, message: string) => {
    const list = problems.get(line)
    if (list) list.push(message)
    else problems.set(line, [message])
  }

  for (const m of markers) {
    const line = code[m.line]!
    const tokens = lines[m.line]!
    const cols = columns(line, tab)
    const start = columns(m.indent, tab)[m.indent.length]!
    const end = start + m.width
    const where = `line ${m.line + 1}`
    if (end > cols[line.length]!) {
      report(m.line, `${where}: the carets go past the end of the line (${fmt(m.type)})\n` + pad(`${line}\n${m.indent}${'^'.repeat(m.width)} ${m.type ?? 'null'}`))
      continue
    }
    let from = 0
    while (from < line.length && cols[from + 1]! <= start) from++
    let to = from
    while (to < line.length && cols[to]! < end) to++
    const ranges = marked.get(m.line)
    if (ranges) ranges.push([from, to])
    else marked.set(m.line, [[from, to]])

    const hit = tokens.filter((t) => t.to > from && t.from < to)
    let ok: boolean
    if (m.type === null) ok = hit.every((t) => t.type === null)
    else if (hit.length !== 1 || hit[0]!.type !== m.type) ok = false
    else {
      const t = hit[0]!
      const [a, b] = trimmed(line, t)
      ok = from >= t.from && to <= t.to && (!!options.partial || (from <= a && to >= b))
    }
    if (ok) continue
    const text = JSON.stringify(line.slice(from, to))
    const found = hit.length
      ? hit.map((t) => `${fmt(t.type)} ${JSON.stringify(line.slice(t.from, t.to))}`).join(', ')
      : 'no token'
    const sameType = hit.length === 1 && hit[0]!.type === m.type
    report(
      m.line,
      `${where}: expected ${fmt(m.type)} on ${text}, found ${found}` +
        (sameType ? ' (the carets must cover the whole token, or pass { partial: true })' : '') +
        '\n' +
        pad([line, marker(line, cols, from, to, m.type) + '   <- expected', ...hit.map((t) => marker(line, cols, ...trimmed(line, t), t.type) + '   <- actual')].join('\n')),
    )
  }

  if (options.strict) {
    for (const [i, ranges] of marked) {
      const line = code[i]!
      const cols = columns(line, tab)
      for (const t of lines[i]!) {
        if (skipped(line, t) || ranges.some(([a, b]) => b > t.from && a < t.to)) continue
        report(i, `line ${i + 1}: ${fmt(t.type)} ${JSON.stringify(line.slice(t.from, t.to))} is not marked (strict)\n` + pad(`${line}\n${marker(line, cols, ...trimmed(line, t), t.type)}`))
      }
    }
  }

  if (!problems.size) return
  let count = 0
  let message = ''
  for (const i of [...problems.keys()].sort((a, b) => a - b)) {
    const list = problems.get(i)!
    count += list.length
    message += `\n\n${list.join('\n')}\nactual tokens of line ${i + 1} (copy to fix):\n${pad(describeLine(code[i]!, lines[i]!, false, tab))}`
  }
  throw new Error(`expectTokens (${language.name}): ${count} mismatch${count > 1 ? 'es' : ''}${message}`)
}
