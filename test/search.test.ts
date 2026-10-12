import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  expandReplacement, isMultiline, joinLines, lowerBound, mapThrough, offsetToPos, posToOffset, replaceChanges, scanMatches, scanner,
  searchRegExp, type Replacement, type SearchQuery,
} from '../src/extensions/search.ts'
import { mapPos, TextDocument, type Change, type Pos } from '../src/state/text.ts'

const q = (search: string, more: Partial<SearchQuery> = {}): SearchQuery => ({
  search, replace: '', caseSensitive: false, wholeWord: false, regexp: false, ...more,
})
const p = (line: number, col: number): Pos => ({ line, col })

/** Every non-empty match of `re` in `text`: the reference for the windowed scan. */
function reference(re: RegExp, text: string): [number, number][] {
  const out: [number, number][] = []
  const r = new RegExp(re.source, re.flags)
  let m: RegExpExecArray | null
  while ((m = r.exec(text))) {
    if (m[0].length) out.push([m.index, m.index + m[0].length])
    else r.lastIndex = m.index + (r.unicode && text.codePointAt(m.index)! > 0xffff ? 2 : 1)
  }
  return out
}

/** Scans the whole document like the background count (resuming until done). */
function scanAll(text: string, re: RegExp, deadline = Infinity): [number, number][] {
  const t = joinLines(text.split('\n'))
  const sc = scanner(re)
  const out: [number, number][] = []
  let at = 0
  for (let guard = 0; at >= 0; guard++) {
    assert.ok(guard < 1e5, 'the scan must progress')
    at = scanMatches(t, sc, at, t.text.length, deadline, (s, e) => void out.push([s, e]))
  }
  return out
}

test('search: multi-line detection', () => {
  assert.equal(isMultiline(q('foo')), false)
  assert.equal(isMultiline(q('foo\nbar')), true)
  assert.equal(isMultiline(q('foo\r\nbar')), true)
  assert.equal(isMultiline(q('a\\nb')), false, 'literal backslash + n')
  assert.equal(isMultiline(q('a\\nb', { regexp: true })), true)
  assert.equal(isMultiline(q('\\r', { regexp: true })), true)
  assert.equal(isMultiline(q('[^\\n]', { regexp: true })), true)
  assert.equal(isMultiline(q('a\\\\nb', { regexp: true })), false, 'escaped backslash, then n')
  assert.equal(isMultiline(q('a\\\\\\nb', { regexp: true })), true)
  assert.equal(isMultiline(q('\\s+x', { regexp: true })), false, '\\s alone stays per line')
  assert.equal(isMultiline(q('a\nb', { regexp: true })), true, 'a typed newline')
})

test('search: single-line regexes are unchanged', () => {
  const re = searchRegExp(q('a.b'))!
  assert.equal(re.source, 'a\\.b')
  assert.equal(re.flags, 'giu')
  assert.equal(searchRegExp(q('^x$', { regexp: true, caseSensitive: true }))!.flags, 'gu')
  assert.equal(searchRegExp(q('\\-', { regexp: true }))!.flags, 'gi', 'falls back to non-unicode')
})

test('search: multi-line regexes', () => {
  const lit = searchRegExp(q('a.b\nc('))!
  assert.equal(lit.flags, 'gimu')
  assert.equal(lit.source, 'a\\.b\\nc\\(')
  assert.deepEqual(reference(lit, 'x a.b\nc( axb\nc('), [[2, 8]])
  // `\r\n` (pasted from Windows, or typed in a regex) means the joined '\n'.
  assert.deepEqual(reference(searchRegExp(q('b\r\nc'))!, 'ab\nc'), [[1, 4]])
  assert.deepEqual(reference(searchRegExp(q('b\\r\\nc', { regexp: true }))!, 'ab\nc'), [[1, 4]])
  assert.deepEqual(reference(searchRegExp(q('b\\r?\\nc', { regexp: true }))!, 'ab\nc'), [[1, 4]])
  assert.equal(searchRegExp(q('b\\\\r\\nc', { regexp: true }))!.source, 'b\\\\r\\nc', 'an escaped backslash stays')
  // `^` / `$` match at every line (m flag); `.` stays on its line.
  assert.deepEqual(reference(searchRegExp(q('^b$\\n', { regexp: true }))!, 'a\nb\nb\nc'), [[2, 4], [4, 6]])
  assert.deepEqual(reference(searchRegExp(q('a.\\n', { regexp: true }))!, 'a\n\nab\n'), [[3, 6]])
  // Case and whole word.
  assert.deepEqual(reference(searchRegExp(q('END\nfoo'))!, 'end\nFoo'), [[0, 7]])
  assert.deepEqual(reference(searchRegExp(q('END\nfoo', { caseSensitive: true }))!, 'end\nFoo'), [])
  assert.deepEqual(reference(searchRegExp(q('d\nf', { wholeWord: true }))!, 'end\nfoo d\nf'), [[8, 11]])
  assert.equal(searchRegExp(q('(\\n', { regexp: true })), null)
})

test('search: offsets <-> positions', () => {
  const lines = ['', 'ab', '', 'cde', '']
  const t = joinLines(lines)
  assert.equal(t.text, '\nab\n\ncde\n')
  assert.deepEqual([...t.starts], [0, 1, 4, 5, 9])
  for (let line = 0; line < lines.length; line++) {
    for (let col = 0; col <= lines[line]!.length; col++) {
      const off = posToOffset(t, p(line, col))
      assert.deepEqual(offsetToPos(t, off), p(line, col))
    }
  }
  assert.deepEqual(offsetToPos(t, 0), p(0, 0), 'document start')
  assert.deepEqual(offsetToPos(t, t.text.length), p(4, 0), 'document end')
  assert.deepEqual(offsetToPos(t, 3), p(1, 2), 'end of a line (before its newline)')
  // A slice of the lines keeps document line numbers.
  const part = joinLines(lines, 1, 4)
  assert.equal(part.text, 'ab\n\ncde')
  assert.deepEqual(offsetToPos(part, 4), p(3, 0))
  assert.equal(posToOffset(part, p(3, 2)), 6)
  assert.equal(lowerBound(new Uint32Array([1, 3, 3, 7]), 4, 3), 1)
  assert.equal(lowerBound(new Uint32Array([1, 3, 3, 7]), 4, 8), 4)
})

test('search: windowed scan finds what a whole-text regex finds', () => {
  const lines: string[] = []
  for (let i = 0; i < 30000; i++) lines.push(i % 7 === 3 ? '' : `line ${i} ${'x'.repeat(i % 50)}${i % 11 === 0 ? ' end' : ''}`)
  const text = lines.join('\n')
  for (const src of ['end\\nline', '\\n\\n', '^$\\n', 'x+\\n(?:line \\d+ )?', '(\\d)\\n.*\\1', 'end$\\n^line']) {
    const re = searchRegExp(q(src, { regexp: true }))!
    assert.deepEqual(scanAll(text, re), reference(re, text), src)
  }
  // Paused at every window (deadline in the past), resumed: same result.
  const re = searchRegExp(q('end\nline'))!
  assert.deepEqual(scanAll(text, re, 0), reference(re, text))
})

test('search: zero-length matches never loop', () => {
  const text = 'a\n\n😀b\n\n'
  for (const src of ['^\\n*', '(?=\\n)', 'x*\\n?', '\\n?']) {
    const re = searchRegExp(q(src, { regexp: true }))!
    assert.deepEqual(scanAll(text, re), reference(re, text), src)
  }
  assert.deepEqual(scanAll(text, searchRegExp(q('^\\n*', { regexp: true }))!), [[2, 3], [7, 8]])
  assert.deepEqual(scanAll('😀\n', searchRegExp(q('x*\\n?', { regexp: true }))!), [[2, 3]])
})

test('search: matches at the document start and end, stopping and resuming', () => {
  const text = 'ab\ncd\nab\ncd'
  const re = searchRegExp(q('ab\ncd'))!
  assert.deepEqual(scanAll(text, re), [[0, 5], [6, 11]])
  const t = joinLines(text.split('\n'))
  const seen: number[] = []
  const at = scanMatches(t, scanner(re), 0, t.text.length, Infinity, (s) => (seen.push(s), false))
  assert.deepEqual(seen, [0])
  assert.equal(at, 5, 'resumes after the match')
  assert.equal(scanMatches(t, scanner(re), 1, 6, Infinity, () => assert.fail('no match starts in 1…6')), -1)
})

test('search: replacement expansion', () => {
  const m = /(?<k>\w+)=(\w+)\n/.exec('key=value\n')!
  assert.equal(expandReplacement('$2 <- $<k>;$&$$', m, true), 'value <- key;key=value\n$')
  assert.equal(expandReplacement('$1\\n$2\\t\\\\', m, true), 'key\nvalue\t\\')
  assert.equal(expandReplacement('$9', m, true), '$9', 'unknown groups stay')
  assert.equal(expandReplacement('$1\\n', m, false), '$1\\n', 'literal mode is literal')
  assert.equal(expandReplacement('$1\\n$$', null, true), '$1\n$', 'groups unknown')
})

/** Applies ChangeSpecs like the editor (each one on the result of the previous one). */
function apply(text: string, reps: Replacement[]): { doc: TextDocument; changes: Change[]; specs: number } {
  const doc = new TextDocument(text)
  const specs = replaceChanges(doc.lines, reps)
  const changes = specs.map((s) => doc.replace(s.from, s.to ?? s.from, s.insert ?? ''))
  return { doc, changes, specs: specs.length }
}

/** Replaces the matches of `re` in the joined text directly. */
function expected(text: string, re: RegExp, insert: (m: string) => string): string {
  return text.replace(new RegExp(re.source, re.flags), insert)
}

function reps(text: string, re: RegExp, insert: (m: string) => string): Replacement[] {
  const t = joinLines(text.split('\n'))
  return reference(re, text).map(([s, e]) => ({ from: offsetToPos(t, s), to: offsetToPos(t, e), insert: insert(t.text.slice(s, e)) }))
}

test('search: replace all, one change per match or merged', () => {
  const text = 'a {\n  x\n}\nb {\n}\n\nc {\n  y\n}'
  const re = searchRegExp(q('\\{\\n\\s*(\\w)?', { regexp: true }))!
  const ins = (m: string) => `{ ${m.trim().slice(1).trim()}|\n`
  const small = apply(text, reps(text, re, ins))
  assert.equal(small.specs, 3, 'short documents: one change per match, last first')
  assert.equal(small.doc.toString(), expected(text, re, ins))
  // Many line-changing matches in a long document: a single change.
  const long = Array.from({ length: 300000 }, (_, i) => (i % 3 === 2 ? '}' : i % 3 === 0 ? `f${i} {` : `  s${i}`)).join('\n')
  const bigReps = reps(long, re, ins)
  const big = apply(long, bigReps)
  assert.equal(big.specs, 1)
  assert.equal(big.doc.toString(), expected(long, re, ins))
  // The cursor lands where the separate changes would have put it.
  const perMatch = new TextDocument(long)
  const changes = bigReps.slice().reverse().map((r) => perMatch.replace(r.from, r.to, r.insert))
  for (const pos of [p(0, 0), p(1, 3), p(4, 1), p(150000, 2), p(299999, 1), p(299998, 0)]) {
    const want = changes.reduce((acc, c) => mapPos(acc, c), pos)
    assert.deepEqual(mapThrough(pos, bigReps), want, JSON.stringify(pos))
  }
})

test('search: mapThrough on the same line', () => {
  // "aXbXc" -> replace both X by "--": positions after them move right.
  const r: Replacement[] = [
    { from: p(0, 1), to: p(0, 2), insert: '--' },
    { from: p(0, 3), to: p(0, 4), insert: 'Y\nZ' },
  ]
  assert.deepEqual(mapThrough(p(0, 1), r), p(0, 1), 'at a match start: stays before it')
  assert.deepEqual(mapThrough(p(0, 2), r), p(0, 3))
  assert.deepEqual(mapThrough(p(0, 3), r), p(0, 4))
  assert.deepEqual(mapThrough(p(0, 5), r), p(1, 2))
})
