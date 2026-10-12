/**
 * Applies edits written by language models to the document, as ONE
 * transaction (one undo step, origin `ai`): SEARCH/REPLACE blocks, unified
 * diffs, whole files, or structured ops like the `str_replace` / `insert`
 * commands of text-editor tools. Search texts are matched exactly, then
 * ignoring trailing whitespace, then indentation, then approximately; each
 * failure comes back with a message written for the model, so it can fix the
 * edit on its next try. Only the text that really changed is replaced, so
 * cursors and decorations elsewhere stay put.
 *
 * ```ts
 * const result = applyEdits(editor, reply)            // or [{ old: 'a', new: 'b' }]
 * if (!result.ok) return result.summary                // → tool result for the model
 * setDecorations(editor, 'ai', result.ranges.map((r) => ({ ...r, class: 'ai-edit' })))
 * ```
 */
import type { Editor } from '../editor.ts'
import { diffLines, diffToChanges } from '../state/diff.ts'
import { cmpPos, spliceArray, type ChangeSpec, type Pos } from '../state/text.ts'

/** One edit, in the shapes models produce. */
export type EditOp =
  /** Search & replace. Also accepted: old_str/new_str, oldText/newText, search/replace, old_string/new_string. */
  | { type?: 'replace'; old: string; new: string; all?: boolean }
  /** Insert after 1-based line `line` (0 = top of file), like Claude's text editor tool. */
  | { type: 'insert'; line: number; text: string }
  /** The whole file (applied as a minimal diff). */
  | { type: 'write'; text: string }
  /** A unified diff. */
  | { type: 'patch'; diff: string }

/** A model's raw output (SEARCH/REPLACE blocks, a unified diff, or a whole file), or structured ops. */
export type EditInput = string | EditOp | readonly EditOp[]

export interface EditError {
  /** Which edit failed (0-based index among the parsed ops; -1 for the transaction as a whole). */
  index: number
  /** Written for the model: what went wrong and how to fix it. */
  message: string
  /** Most similar place found, when a search text wasn't found. `line` is 1-based. */
  hint?: { line: number; similarity: number; text: string }
}

export interface EditResult {
  ok: boolean
  /** Number of edits applied. */
  applied: number
  errors: EditError[]
  /** The dispatched (or, with dryRun, planned) changes. */
  changes: ChangeSpec[]
  /** Where the new text ended up, in the document after the edit: the changed lines (empty ranges for deletions). */
  ranges: { from: Pos; to: Pos }[]
  /** One line for a tool result, e.g. "Applied 2 edits (lines 12–18, 40)." or the errors. Written for the model. */
  summary: string
  /** The format detected for string input. */
  format: 'blocks' | 'diff' | 'whole' | 'ops'
}

export interface ApplyEditsOptions {
  /** All or nothing (default true): if one edit fails, none is applied. */
  atomic?: boolean
  /** Plan only; don't touch the document. */
  dryRun?: boolean
  /** Transaction origin (default 'ai'). */
  origin?: string
  /** Allow approximate matches of search texts (default true). A number sets the minimum similarity (default 0.9). */
  fuzzy?: boolean | number
  /** Move the cursor to (and scroll to) the first edit (default false). */
  select?: boolean
}

/** A planned edit: replace `from..to` of the original document with `lines`. */
interface Edit {
  from: Pos
  to: Pos
  lines: string[]
  i?: number
}
interface Err {
  message: string
  hint?: EditError['hint']
}
interface Hunk {
  line?: number
  count?: number
  old: string[]
  neu: string[]
  src: string[]
}
/** A match: `size` lines at `at`; `re`: re-indent the replacement. */
interface Hit {
  at: number
  size: number
  re?: boolean
}
interface Near extends Hit {
  sim: number
}
/** The document being planned on, with lazily computed views. */
interface Ctx {
  lines: readonly string[]
  norm: (readonly string[])[]
  text?: string
}

const START = /^\s*<{5,9}\s*(?:SEARCH|ORIGINAL)\b/i
const MID = /^\s*={5,9}\s*$/
const END = /^\s*>{5,9}\s*(?:REPLACE|UPDATED)?\s*$/i
const FENCE = /^\s*(?:`{3,}|~{3,})[\w+#.-]*\s*$/
const HUNK = /^@@+\s*(?:-(\d+)(?:,(\d+))?)?/
/** Placeholder lines that stand for code the model didn't write out. */
const ELIDED =
  /^\s*(?:(?:\.\.\.|…)\s*$|(?:\/\/+|#+|--|\/\*+|\{\s*\/\*+|<!--)\s*(?:\.\.\.|…|.*\b(?:existing code|rest of (?:the )?(?:code|file|function|class|method|component)|(?:remains?|stays?) (?:the )?(?:same|unchanged)|unchanged code|code omitted|for brevity)\b))/i
const NORMS = [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()]
const SEARCH = 'the search text'
const EMPTY = 'the search text is empty; use an insert edit, or include the lines around the new code in the search text'
const BLOCK = 'malformed SEARCH/REPLACE block; write "<<<<<<< SEARCH", the exact current lines, "=======", the new lines, then ">>>>>>> REPLACE"'
const NOT_WHOLE = 'the text has no line in common with the file, so it was not taken as the new file; send SEARCH/REPLACE blocks, a unified diff or the complete file'
const NO_HUNKS = 'the diff has no hunks (starting with "@@ -12,3 +12,4 @@")'

const split = (s: string) => s.replace(/\r\n?/g, '\n').split('\n')
const lead = (s = '') => /^\s*/.exec(s)![0]
const firstText = (lines: readonly string[]) => lines.find((l) => l.trim())
const quote = (s = '') => JSON.stringify((s = s.trim()).length > 70 ? s.slice(0, 70) + '…' : s)
const lineList = (ls: readonly (number | string)[]) => ls.slice(0, 6).join(', ') + (ls.length > 6 ? ', …' : '')

/** Splits a model's raw output into edit ops, detecting its format. */
export function parseEdits(text: string): { ops: EditOp[]; format: 'blocks' | 'diff' | 'whole' } {
  const { ops, format } = parse(text)
  return { ops: ops.filter((o): o is EditOp => typeof o !== 'string'), format }
}

/** Like parseEdits, with malformed parts kept as error messages (strings) at their index. */
function parse(text: string): { ops: (EditOp | string)[]; format: 'blocks' | 'diff' | 'whole' } {
  const lines = split(text)
  if (lines.some((l) => START.test(l))) return { ops: blocks(lines), format: 'blocks' }
  if (lines.some((l, i) => HUNK.test(l) || (/^--- /.test(l) && /^\+\+\+ /.test(lines[i + 1] ?? '')))) {
    const hs = hunks(lines)
    return { ops: hs.length ? hs.map((h) => ({ type: 'patch', diff: h.src.join('\n') })) : [NO_HUNKS], format: 'diff' }
  }
  if (!text.trim()) return { ops: ['no edit found: the text is empty'], format: 'whole' }
  // A file wrapped in a code fence, maybe with a line or two of prose around it.
  const f = lines.flatMap((l, i) => (FENCE.test(l) ? [i] : []))
  const body = f.length === 2 && lines.filter((l, i) => (i < f[0]! || i > f[1]!) && l.trim()).length < 5 ? lines.slice(f[0]! + 1, f[1]) : lines
  return { ops: [{ type: 'write', text: body.join('\n') }], format: 'whole' }
}

/** SEARCH/REPLACE blocks; anything outside them (prose, fences, file names) is ignored. */
function blocks(lines: string[]): (EditOp | string)[] {
  const ops: (EditOp | string)[] = []
  let part: string[][] | undefined
  // An unterminated block may have been cut off: don't guess where it ends.
  const close = (ok: boolean) => {
    if (part) ops.push(ok && part[1] ? { old: part[0]!.join('\n'), new: part[1].join('\n') } : BLOCK)
    part = undefined
  }
  for (const l of lines) {
    if (START.test(l)) close(false), (part = [[]])
    else if (!part) continue
    else if (part.length === 1 && MID.test(l)) part.push([])
    else if (END.test(l)) close(true)
    else part[part.length - 1]!.push(l)
  }
  close(false)
  return ops
}

/** Hunks of a unified diff. Tolerates missing numbers and blank context lines without their space. */
function hunks(lines: string[]): Hunk[] {
  const out: Hunk[] = []
  let h: Hunk | undefined
  let header = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const m = HUNK.exec(l)
    if (m) {
      out.push((h = { line: m[1] ? +m[1] : undefined, count: m[2] ? +m[2] : undefined, old: [], neu: [], src: [l] }))
      continue
    }
    // `--- a/file` + `+++ b/file`, unless it is a removed "-- " line inside a hunk that isn't complete yet.
    if (/^--- /.test(l) && /^\+\+\+ /.test(lines[i + 1] ?? '') && !(h && (h.count ?? 0) > h.old.length)) {
      h = undefined
      header = true
      i++
      continue
    }
    const c = l[0]
    if (!h && header && c && ' +-'.includes(c)) out.push((h = { old: [], neu: [], src: ['@@ @@'] }))
    if (!h) continue
    if (!l || c === ' ' || c === '-' || c === '+') {
      if (c !== '+') h.old.push(l.slice(1))
      if (c !== '-') h.neu.push(l.slice(1))
    } else if (c !== '\\') {
      h = undefined
      continue
    }
    h.src.push(l)
    header = false
  }
  for (const h of out) while (h.src[h.src.length - 1] === '') h.src.pop(), h.old.pop(), h.neu.pop()
  return out
}

/** Pure planning on a list of lines (no editor needed). */
export function planEdits(lines: readonly string[], input: EditInput, options: ApplyEditsOptions = {}): EditResult {
  const { atomic = true, fuzzy = true } = options
  const min = fuzzy === true ? 0.9 : fuzzy || 2
  let { ops, format } = typeof input === 'string' ? parse(input) : { ops: (Array.isArray(input) ? input : [input]) as (EditOp | string)[], format: 'ops' as const }
  if (format === 'whole' && typeof ops[0] !== 'string') {
    // A reply that is only prose must not replace the file.
    const next = new Set(split((ops[0] as { text: string }).text).map(NORMS[2]!))
    const doc = lines.map(NORMS[2]!).filter((l) => l)
    if (doc.length > 2 && !doc.some((l) => next.has(l))) ops = [NOT_WHOLE]
  }
  let { edits, errors } = planOps(lines, ops, min)
  let next = errors.length && atomic ? lines : applyTo(lines, edits)
  if (errors.length && ops.length > 1) {
    // Models used to applying blocks one after the other: search each one in the result of the previous ones.
    let cur = lines
    let k = 0
    // (Exact matches only: an approximate one could land on the wrong place.)
    for (let r; k < ops.length && !(r = planOps(cur, [ops[k]!], 2)).errors.length; k++) cur = applyTo(cur, r.edits)
    if (k === ops.length) (next = cur), (errors = [])
  }
  const chunks = diffLines(lines, next)
  const eol = (line: number): Pos => ({ line, col: next[line]!.length })
  const ranges = chunks.map(({ fromB, toB }) => {
    const from = toB > fromB || fromB < next.length ? { line: fromB, col: 0 } : eol(fromB - 1)
    return { from, to: toB > fromB ? eol(toB - 1) : from }
  })
  const applied = errors.length && atomic ? 0 : ops.length - new Set(errors.map((e) => e.index)).size
  return {
    ok: !errors.length,
    applied,
    errors,
    changes: diffToChanges(lines, next, chunks),
    ranges,
    summary: summarize(ops.length, applied, errors, ranges, options.dryRun ? 'Would apply' : 'Applied'),
    format,
  }
}

/**
 * Applies a model's edits to the editor as one transaction (one undo step).
 * On failure nothing changes (unless `atomic: false`) and `summary` tells the
 * model what to fix.
 */
export function applyEdits(editor: Editor, input: EditInput, options: ApplyEditsOptions = {}): EditResult {
  const r = planEdits(editor.doc.lines, input, options)
  if (options.dryRun || !r.changes.length) return r
  const version = editor.version
  const select = options.select ? r.ranges[0]!.from : undefined
  editor.dispatch({ changes: r.changes, origin: options.origin ?? 'ai', selection: select, scrollIntoView: select && true })
  if (editor.version !== version) return r
  // A change filter vetoed the transaction.
  const error = { index: -1, message: 'the edit touches a protected (read-only) part of the file and was rejected; change only the editable parts' }
  const errors = [...r.errors, error]
  return { ...r, ok: false, applied: 0, errors, changes: [], ranges: [], summary: summarize(errors.length, 0, errors, [], '') }
}

function summarize(n: number, applied: number, errors: EditError[], ranges: EditResult['ranges'], verb: string): string {
  const ls = ranges.map(({ from, to }) => (from.line === to.line ? `${from.line + 1}` : `${from.line + 1}–${to.line + 1}`))
  const what = ls.length ? ` (line${ls.length > 1 || ls[0]!.includes('–') ? 's' : ''} ${lineList(ls)})` : ' (no change)'
  return (
    (errors.length && !applied ? 'No edits applied' : `${verb} ${applied}${errors.length ? ` of ${n}` : ''} edit${(errors.length ? n : applied) === 1 ? '' : 's'}${what}`) +
    '.' +
    errors.map((e) => ` ${n > 1 && e.index >= 0 ? `Edit ${e.index + 1}: ` : ''}${e.message[0]!.toUpperCase()}${e.message.slice(1)}.`).join('')
  )
}

/** Plans every op against `lines`; overlapping edits are errors. */
function planOps(lines: readonly string[], ops: readonly (EditOp | string)[], min: number): { edits: Edit[]; errors: EditError[] } {
  const c: Ctx = { lines, norm: [] }
  const errors: EditError[] = []
  const edits: Edit[] = []
  ops.forEach((op, i) => {
    const r = typeof op === 'string' ? { message: op } : planOp(c, op, min)
    if (Array.isArray(r)) for (const e of r) edits.push({ ...e, i })
    else errors.push({ index: i, ...r })
  })
  edits.sort((a, b) => cmpPos(a.from, b.from) || cmpPos(a.to, b.to) || a.i! - b.i!)
  let last: Edit | undefined
  for (const e of edits) {
    if (last && cmpPos(last.to, e.from) > 0) {
      const [x, y] = [last.i!, e.i!].sort((a, b) => a - b)
      if (!errors.some((er) => er.index === y)) {
        errors.push({ index: y!, message: `edits ${x! + 1} and ${y! + 1} overlap (line ${e.from.line + 1}); merge them into one edit` })
      }
      if (y === last.i) last = e
    } else last = e
  }
  const failed = new Set(errors.map((e) => e.index))
  return { edits: edits.filter((e) => !failed.has(e.i!)), errors: errors.sort((a, b) => a.index - b.index) }
}

/** Applies planned edits (sorted, non-overlapping, in original coordinates) to a copy of `lines`. */
function applyTo(lines: readonly string[], edits: readonly Edit[]): string[] {
  let out = lines.slice()
  for (let j = edits.length; j--; ) {
    const { from, to, lines: ins } = edits[j]!
    const mid = ins.slice()
    mid[0] = out[from.line]!.slice(0, from.col) + mid[0]
    mid[mid.length - 1] += out[to.line]!.slice(to.col)
    out = spliceArray(out, from.line, to.line - from.line + 1, mid)
  }
  return out
}

function planOp(c: Ctx, op: EditOp, min: number): Edit[] | Err {
  const o = op as unknown as Record<string, unknown>
  // Field names vary between tools: old / old_str / oldText / old_string / search, new_str / newText / replace, file_text…
  const get = (re: RegExp) => Object.keys(o).map((k) => re.test(k) && o[k]).find((v): v is string => typeof v === 'string')
  const old = get(/^(old|search)/i)
  const neu = get(/^(new|replace$)/i)
  const text = get(/^(text|content|\w+_text)$/) ?? neu
  const diff = get(/^(diff|patch)$/)
  const line = o.line ?? o.insert_line
  const type = String(o.type ?? o.command ?? (old != null ? 'replace' : diff != null ? 'patch' : line != null ? 'insert' : 'write'))
  const missing = (what: string) => ({ message: `the ${what} is missing` })
  if (/replace/.test(type)) {
    if (old == null || neu == null) return missing(old == null ? 'search text ("old")' : 'new text ("new")')
    return planReplace(c, old, neu, !!(o.all ?? o.replace_all ?? o.replaceAll), min)
  }
  if (text == null && /insert|write|create/.test(type)) return missing('text')
  if (type === 'insert') {
    const nl = split(text!)
    if (nl.length > 1 && !nl[nl.length - 1]) nl.pop()
    return insertAt(c.lines, Number(line), nl)
  }
  if (/write|create/.test(type)) return writeAll(c.lines, text!)
  if (/patch|diff/.test(type)) {
    const hs = hunks(split(diff ?? ''))
    if (!hs.length) return { message: NO_HUNKS }
    const out: Edit[] = []
    for (const h of hs) {
      const r = planHunk(c, h, min)
      if (!Array.isArray(r)) return r
      out.push(...r)
    }
    return out
  }
  return { message: `unknown edit type "${type}"; use replace {old, new}, insert {line, text}, write {text} or patch {diff}` }
}

function planReplace(c: Ctx, old: string, neu: string, all: boolean, min: number): Edit[] | Err {
  const { lines } = c
  old = old.replace(/\r\n?/g, '\n')
  const ol = split(old)
  const nl = split(neu)
  if (!old.trim()) return lines.length > 1 || lines[0] ? { message: EMPTY } : [{ from: { line: 0, col: 0 }, to: { line: 0, col: 0 }, lines: nl }]
  const bad = elided(ol, nl)
  if (bad) return bad
  // 1. Exact.
  const text = (c.text ??= lines.join('\n'))
  const at: number[] = []
  for (let p = text.indexOf(old); p >= 0; p = text.indexOf(old, p + (all ? old.length : 1))) at.push(p)
  let line = 0
  let start = 0
  // Offset → position, for increasing offsets.
  const pos = (o: number): Pos => {
    for (let i; (i = text.indexOf('\n', start)) >= 0 && i < o; start = i + 1) line++
    return { line, col: o - start }
  }
  if (at.length > 1 && !all) return ambiguous(SEARCH, at.map((p) => pos(p).line))
  if (at.length) return at.map((p) => ({ from: pos(p), to: pos(p + old.length), lines: nl }))
  // 2–4. Whole lines, ignoring trailing whitespace, then indentation, then approximately.
  if (ol.length > 1 && !ol[ol.length - 1]) {
    ol.pop()
    if (!nl[nl.length - 1]) nl.pop()
  }
  const hits = locate(c, ol, SEARCH, min, undefined, all)
  return Array.isArray(hits) ? hits.map((h) => lineEdit(lines, h, nl, ol)) : hits
}

function planHunk(c: Ctx, h: Hunk, min: number): Edit[] | Err {
  if (!h.old.length) {
    if (!h.neu.length) return []
    return h.line == null ? { message: 'the hunk has no context lines nor line number; include a few unchanged lines around the change' } : insertAt(c.lines, h.line, h.neu)
  }
  const bad = elided(h.old, h.neu)
  if (bad) return bad
  const hits = locate(c, h.old, 'the hunk (its context and "-" lines)', min, h.line == null ? undefined : h.line - 1)
  return Array.isArray(hits) ? [lineEdit(c.lines, hits[0]!, h.neu, h.old)] : hits
}

/** Inserts lines after 1-based line `line` (0: at the top). */
function insertAt(lines: readonly string[], line: number, nl: string[]): Edit[] | Err {
  const n = lines.length
  // A final newline doesn't make one more line for the model.
  const m = lines[n - 1] ? n : n - 1
  if (!(line >= 0 && line <= m && line % 1 === 0)) return { message: `line ${line} is out of range: the file has ${m} line${m === 1 ? '' : 's'}, so line must be 0–${m} (0 inserts at the top)` }
  const p = line < n ? { line, col: 0 } : { line: n - 1, col: lines[n - 1]!.length }
  return [{ from: p, to: p, lines: line < n ? [...nl, ''] : ['', ...nl] }]
}

/** The whole file; keeps the document's final newline (or its absence). */
function writeAll(lines: readonly string[], text: string): Edit[] | Err {
  const n = lines.length
  const nl = split(text)
  const had = n > 1 && !lines[n - 1]
  if (n > 1 || lines[0]) {
    if (had && nl[nl.length - 1]) nl.push('')
    else if (!had && nl.length > 1 && !nl[nl.length - 1]) nl.pop()
  }
  return elided(lines, nl) ?? [{ from: { line: 0, col: 0 }, to: { line: n - 1, col: lines[n - 1]!.length }, lines: nl }]
}

/** Replaces whole lines `h.at..h.at + h.size` with `nl` (re-indented when matched ignoring indentation). */
function lineEdit(lines: readonly string[], h: Hit, nl: string[], ol: readonly string[]): Edit {
  const end = h.at + h.size
  const eol = (line: number): Pos => ({ line, col: lines[line]!.length })
  if (h.re) {
    // Each new line takes the indentation change between its old line and the matching line of the file.
    const doc = lines.slice(h.at, end)
    const od = align(doc, ol)
    const no = align(ol, nl)
    nl = nl.map((l, i) => {
      let j = no[i]!
      while (j && !ol[j]!.trim()) j--
      const from = lead(ol[j])
      const to = lead(doc[od[j]!])
      const d = to.length - from.length
      return !l.trim() || from === to ? l : l.startsWith(from) ? to + l.slice(from.length) : d > 0 ? to.slice(0, d) + l : l.slice(Math.min(-d, lead(l).length))
    })
  }
  if (!nl.length) {
    // Delete the lines with their line break.
    if (end < lines.length) return { from: { line: h.at, col: 0 }, to: { line: end, col: 0 }, lines: [''] }
    if (h.at) return { from: eol(h.at - 1), to: eol(end - 1), lines: [''] }
  }
  return { from: { line: h.at, col: 0 }, to: eol(end - 1), lines: nl.length ? nl : [''] }
}

/** For each line of `b`, the line of `a` it corresponds to (by a diff of the trimmed lines). */
function align(a: readonly string[], b: readonly string[]): number[] {
  const out: number[] = []
  let pa = 0
  for (const c of [...diffLines(a.map(NORMS[2]!), b.map(NORMS[2]!)), { fromA: a.length, toA: a.length, fromB: b.length, toB: b.length }]) {
    while (out.length < c.fromB) out.push(pa++)
    while (out.length < c.toB) out.push(Math.max(0, Math.min(c.fromA + out.length - c.fromB, c.toA - 1, a.length - 1)))
    pa = c.toA
  }
  return out
}

/** Finds whole lines: exact, then ignoring trailing whitespace, then indentation, then approximately. */
function locate(c: Ctx, ol: readonly string[], what: string, min: number, near?: number, all?: boolean): Hit[] | Err {
  for (let t = 0; t < 3; t++) {
    const d = (c.norm[t] ??= t ? c.lines.map(NORMS[t]!) : c.lines)
    const o = ol.map(NORMS[t]!)
    let at: number[] = []
    for (let i = 0, j = 0; i + o.length <= d.length; i++, j = 0) {
      while (j < o.length && d[i + j] === o[j]) j++
      if (j === o.length) at.push(i)
    }
    if (!at.length) continue
    let end = -1
    if (all) at = at.filter((p) => p >= end && (end = p + o.length))
    else if (at.length > 1) {
      if (near == null) return ambiguous(what, at)
      at = [at.reduce((a, b) => (Math.abs(b - near) < Math.abs(a - near) ? b : a))]
    }
    return at.map((p) => ({ at: p, size: o.length, re: t > 1 }))
  }
  const found = nearest(c, ol)
  const best = found[0]
  if (best && best.sim >= min) {
    const second = found.find((o) => o.at >= best.at + best.size || o.at + o.size <= best.at)
    if (near != null || !second || second.sim < best.sim - 0.05) return [{ ...best, re: true }]
    return { message: `${what} was not found exactly and several places are similar (lines ${best.at + 1}, ${second.at + 1}); include more surrounding lines` }
  }
  const hint = best && best.sim >= 0.4 ? { line: best.at + 1, similarity: Math.round(best.sim * 100) / 100, text: c.lines.slice(best.at, best.at + best.size).join('\n') } : undefined
  return {
    message: `${what} was not found${hint ? `; the most similar text is at line ${hint.line} (${Math.round(best!.sim * 100)}% similar): ${quote(firstText(hint.text.split('\n')))}` : ''}. It must match the file exactly (re-read it if unsure)`,
    ...(hint && { hint }),
  }
}

/** The windows of lines most similar to `ol` (ignoring indentation), best first. */
function nearest(c: Ctx, ol: readonly string[]): Near[] {
  const tt = (c.norm[2] ??= c.lines.map(NORMS[2]!))
  const text = ol.map(NORMS[2]!).join('\n')
  const ot = tokens(text)
  const k = ol.length
  const n = tt.length
  // Lines score the share of their trigrams found in the search text; the best windows are candidates.
  const grams = (s: string, f: (g: number) => unknown) => {
    for (let i = 2; i < s.length; i++) f((s.charCodeAt(i - 2) << 20) ^ (s.charCodeAt(i - 1) << 10) ^ s.charCodeAt(i))
  }
  const set = new Set<number>()
  grams(text, (g) => set.add(g))
  const sum = [0]
  tt.forEach((l, p) => {
    let h = 0
    grams(l, (g) => (h += +set.has(g)))
    sum.push(sum[p]! + h / Math.max(l.length - 2, 1))
  })
  const out: Near[] = []
  for (let r = 0; r < 3; r++) {
    let best = -1
    let s = -1
    for (let a = 0; a <= n - k || !a; a++) {
      const v = sum[Math.min(a + k, n)]! - sum[a]!
      if (v > best && !out.some((o) => Math.abs(o.at - a) < k)) (best = v), (s = a)
    }
    if (s < 0) break
    for (let a = s - 1; a <= s + 1; a++) {
      for (let z = k - 1; z <= k + 1; z++) {
        const lo = Math.max(0, a)
        const hi = Math.min(n, a + z)
        if (hi > lo && !out.some((o) => o.at === lo && o.size === hi - lo)) out.push({ at: lo, size: hi - lo, sim: ratio(ot, tokens(tt.slice(lo, hi).join(' '))) })
      }
    }
  }
  // Blank lines have no tokens: on ties, prefer the window as long as the search text.
  return out.sort((x, y) => y.sim - x.sim || Math.abs(x.size - k) - Math.abs(y.size - k))
}

const tokens = (s: string) => s.match(/\w+|\S/g) ?? []

/**
 * Similarity of two token lists, 0..1: 2 × matched tokens / total. Tokens
 * (words and symbols) make a renamed identifier count as much as a changed
 * operator, and ignore whitespace.
 */
function ratio(a: readonly string[], b: readonly string[]): number {
  let same = a.length
  for (const c of diffLines(a, b, { maxCost: 1e5 })) same -= c.toA - c.fromA
  return (2 * same) / (a.length + b.length || 1)
}

/** An error when the new text has a placeholder like `// ... existing code ...` that would delete code. */
function elided(old: readonly string[], neu: readonly string[]): Err | undefined {
  const olds = new Set(old.map((l) => l.trim()))
  const news = new Set(neu.map((l) => l.trim()))
  const bad = neu.find((l) => ELIDED.test(l) && !olds.has(l.trim()))
  if (bad != null && [...olds].some((l) => l && !news.has(l))) {
    return { message: `the new text has the placeholder ${quote(bad)}, which would delete the code it stands for; write the full text (an edit only needs the lines it changes)` }
  }
}

function ambiguous(what: string, at: number[]): Err {
  return { message: `${what} matches ${at.length} places (lines ${lineList(at.map((l) => l + 1))}); include more surrounding lines so it is unique` }
}
