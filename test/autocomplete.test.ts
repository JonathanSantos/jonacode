import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completeFromList, filterCompletions, fuzzyMatch, scanWords, type Completion, type CompletionContext } from '../src/extensions/autocomplete.ts'
import { css } from '../src/languages/css.ts'
import { html } from '../src/languages/html.ts'
import { javascript } from '../src/languages/javascript.ts'
import { shell } from '../src/languages/shell.ts'
import { sql } from '../src/languages/sql.ts'
import { typescript } from '../src/languages/typescript.ts'

const labels = (list: readonly (string | Completion)[], query: string, max?: number) =>
  filterCompletions(list.map((c) => (typeof c === 'string' ? { label: c } : c)), query, max).map((r) => r.completion.label)

test('fuzzyMatch: match kinds, in order of quality', () => {
  assert.deepEqual(fuzzyMatch('const', 'const'), { score: 1000, ranges: [0, 5] })
  assert.deepEqual(fuzzyMatch('console', 'con'), { score: 800, ranges: [0, 3] })
  assert.deepEqual(fuzzyMatch('Console', 'con'), { score: 600, ranges: [0, 3] })
  assert.deepEqual(fuzzyMatch('getElementById', 'gEBI'), { score: 400, ranges: [0, 1, 3, 4, 10, 11, 12, 13] })
  assert.deepEqual(fuzzyMatch('getElementById', 'gebi'), { score: 400, ranges: [0, 1, 3, 4, 10, 11, 12, 13] })
  assert.deepEqual(fuzzyMatch('getElementById', 'getElBy'), { score: 400, ranges: [0, 5, 10, 12] })
  assert.deepEqual(fuzzyMatch('get_value', 'gv'), { score: 400, ranges: [0, 1, 4, 5] })
  assert.deepEqual(fuzzyMatch('max-width', 'mw'), { score: 400, ranges: [0, 1, 4, 5] })
  assert.deepEqual(fuzzyMatch('getElementById', 'ment'), { score: 200, ranges: [6, 10] })
  assert.deepEqual(fuzzyMatch('getElementById', 'gtlm'), { score: 0, ranges: [0, 1, 2, 3, 4, 5, 6, 7] })
  // Empty query: everything, as a prefix.
  assert.deepEqual(fuzzyMatch('anything', ''), { score: 800, ranges: [] })
})

test('fuzzyMatch: rejects', () => {
  assert.equal(fuzzyMatch('console', 'x'), null)
  assert.equal(fuzzyMatch('console', 'noc'), null)
  // One char only matches at a word start (no mid-word noise)…
  assert.equal(fuzzyMatch('console', 'n'), null)
  assert.ok(fuzzyMatch('toString', 's'))
  // …and subsequences must start at one.
  assert.equal(fuzzyMatch('console', 'nl'), null)
  assert.equal(fuzzyMatch('console', 'ns')!.score, 200) // a substring is fine
  assert.equal(fuzzyMatch('abc', 'abcd'), null)
})

test('filterCompletions: ranking by kind, boost, length, then source order', () => {
  assert.deepEqual(labels(['getElementById', 'get', 'Get', 'target', 'gadget', 'getter'], 'get'), ['get', 'getter', 'getElementById', 'Get', 'target', 'gadget'])
  // Boost reorders within a kind, never across kinds.
  assert.deepEqual(labels([{ label: 'getter' }, { label: 'getAll', boost: 5 }, { label: 'target', boost: 99 }], 'get'), ['getAll', 'getter', 'target'])
  // Same kind and length: source order.
  assert.deepEqual(labels(['forB', 'forA'], 'for'), ['forB', 'forA'])
  // Empty query (Ctrl-Space on nothing): source order, no length sorting.
  assert.deepEqual(labels(['longest', 'a', 'mid'], ''), ['longest', 'a', 'mid'])
  assert.deepEqual(labels(['a1', 'a2', 'a3', 'a4'], 'a', 2), ['a1', 'a2'])
})

test('filterCompletions: equal labels are merged, keeping the richest', () => {
  const out = filterCompletions([
    { label: 'fetch', type: 'text' },
    { label: 'fetch', type: 'function', detail: '(url) => Promise' },
    { label: 'fetch', type: 'keyword' },
  ], 'fe')
  assert.equal(out.length, 1)
  assert.equal(out[0]!.completion.detail, '(url) => Promise')
})

test('filterCompletions: 5k candidates filter in well under 5 ms', () => {
  const words: Completion[] = []
  const parts = ['get', 'set', 'element', 'by', 'id', 'value', 'item', 'list', 'count', 'node', 'child', 'parent']
  for (let i = 0; i < 5000; i++) {
    const a = parts[i % parts.length]!
    const b = parts[(i * 7) % parts.length]!
    words.push({ label: `${a}${b[0]!.toUpperCase()}${b.slice(1)}${i}` })
  }
  filterCompletions(words, 'gEl') // warm up
  let best = Infinity
  for (const q of ['g', 'gE', 'gEl', 'item', 'xyz', 'cNd']) {
    const t = performance.now()
    filterCompletions(words, q)
    best = Math.min(best, performance.now() - t)
  }
  const t = performance.now()
  for (const q of ['g', 'ge', 'get', 'getE', 'getEl', 'getEle']) filterCompletions(words, q)
  const avg = (performance.now() - t) / 6
  assert.ok(avg < 5, `average ${avg.toFixed(2)} ms per keystroke`)
})

test('completeFromList: strings become completions', async () => {
  const source = completeFromList(['alpha', { label: 'beta', type: 'function', detail: '()' }])
  const result = await source({} as CompletionContext)
  assert.deepEqual(result, [{ label: 'alpha' }, { label: 'beta', type: 'function', detail: '()' }])
})

test('scanWords: closest lines first, without the word at the cursor', () => {
  const lines = [
    'const farAway = 1',
    'let alpha = beta + gamma',
    'alpha.delta(ep)', // cursor after `ep`
    'function zeta(x) { return x }',
    '// 42 __ -- $dollar',
  ]
  const words = scanWords(lines, { line: 2, col: 14 }, '$')
  assert.deepEqual(words.slice(0, 2), ['alpha', 'delta'])
  assert.ok(!words.includes('ep'), 'the word being typed is excluded')
  assert.ok(!words.includes('x'), 'single chars are skipped')
  assert.ok(!words.includes('__'), 'words need a letter')
  assert.ok(words.includes('$dollar'), 'language word chars count')
  // Line 1 and 3 (distance 1) come before line 0 and 4 (distance 2).
  assert.ok(words.indexOf('zeta') < words.indexOf('farAway'))
  assert.ok(words.indexOf('gamma') < words.indexOf('farAway'))
  // The same word elsewhere still counts.
  assert.ok(scanWords(['ep', 'ep'], { line: 1, col: 2 }).includes('ep'))
  // `-` as a word char (CSS): `max-width` is one word, `--` isn't one.
  assert.deepEqual(scanWords(['a { max-width: 0 } -- --x'], { line: 0, col: 0 }, '-'), ['max-width', '--x'])
  // Not the tails of numbers.
  assert.deepEqual(scanWords(['0x1f 10px #fff é_ok'], { line: 0, col: 0 }), ['fff', 'é_ok'])
})

test('scanWords: only a window of a 100k-line document, and at most 5000 words', () => {
  const lines = Array.from({ length: 100_000 }, (_, i) => `const value${i} = compute(item${i}, other${i % 50})`)
  const near = scanWords(lines, { line: 50_000, col: 0 }, '$', 500)
  assert.ok(near.includes('value50499') && near.includes('value49501'))
  assert.ok(!near.includes('value50502') && !near.includes('value1'))
  const t = performance.now()
  const words = scanWords(lines, { line: 50_000, col: 0 }, '$')
  const ms = performance.now() - t
  assert.equal(words.length, 5000)
  assert.ok(words.includes('value50001') && !words.includes('value48000'), 'closest first')
  assert.ok(ms < 100, `${ms.toFixed(1)} ms`)
})

test('languages: completion word lists', () => {
  for (const [lang, some] of [
    [javascript, ['const', 'console', 'document', 'Promise', 'fetch', 'setTimeout', 'undefined', 'this']],
    [typescript, ['const', 'interface', 'readonly', 'string', 'satisfies', 'Record']],
    [sql, ['SELECT', 'VARCHAR', 'COUNT', 'COALESCE']],
    [shell, ['echo', 'export', 'if', 'grep']],
    [css, ['display', 'grid-template-columns', 'media', 'keyframes']],
    [html, ['div', 'button', 'script']],
  ] as const) {
    for (const w of some) assert.ok(lang.completions.includes(w), `${lang.name}: ${w}`)
    assert.equal(new Set(lang.completions).size, lang.completions.length, `${lang.name}: no duplicates`)
    assert.ok(lang.completions.every((w) => /^[\p{L}_$][\p{L}\p{N}_$-]*$/u.test(w)), `${lang.name}: only words`)
  }
  assert.ok(!shell.completions.includes('.'))
})
