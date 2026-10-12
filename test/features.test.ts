import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTokenRule } from '../src/extensions/token-rule.ts'
import { searchRegExp } from '../src/extensions/search.ts'
import { firstChars } from '../src/language/first-chars.ts'
import { defineLanguage, extendLanguage } from '../src/language/language.ts'
import { javascript } from '../src/languages/javascript.ts'
import { normalizeSelection } from '../src/state/selection.ts'
import { tokenClass, tokenSelector, tokenTypeOfClass } from '../src/theme/theme.ts'
import { HeightMap, rowOfColumn, wrapLine } from '../src/view/layout.ts'
import { tokenize, typeOf } from './helpers.ts'

const p = (line: number, col: number) => ({ line, col })

test('selection: ranges are sorted and overlapping ones merged', () => {
  const sel = normalizeSelection({
    ranges: [
      { anchor: p(2, 0), head: p(2, 4) },
      { anchor: p(0, 1), head: p(0, 1) },
      { anchor: p(2, 3), head: p(2, 8) },
      { anchor: p(0, 1), head: p(0, 1) },
    ],
    main: 0,
  })
  assert.equal(sel.ranges.length, 2)
  assert.deepEqual(sel.ranges[0], { anchor: p(0, 1), head: p(0, 1) })
  assert.deepEqual(sel.ranges[1], { anchor: p(2, 0), head: p(2, 8) })
  assert.equal(sel.main, 1)
})

test('wrap: breaks after spaces, hard-breaks long words, respects tabs and wide chars', () => {
  assert.equal(wrapLine('short line', 40, 2), null)
  assert.deepEqual(wrapLine('aaaa bbbb cccc', 10, 2), [10])
  assert.deepEqual(wrapLine('abcdefghijkl', 5, 2), [5, 10])
  assert.deepEqual(wrapLine('\t\tab', 4, 4), [1, 2])
  assert.deepEqual(wrapLine('世界世界世界', 4, 2), [2, 4])
  const text = 'const x = someFunction(argumentOne, argumentTwo, argumentThree) + 42'
  for (const cols of [8, 13, 20, 33]) {
    const breaks = wrapLine(text, cols, 2)!
    const starts = [0, ...breaks, text.length]
    for (let i = 0; i < starts.length - 1; i++) assert.ok(starts[i + 1]! - starts[i]! <= cols, `row fits ${cols}`)
  }
  assert.equal(rowOfColumn([10, 20], 9), 0)
  assert.equal(rowOfColumn([10, 20], 10), 1)
  assert.equal(rowOfColumn([10, 20], 25), 2)
})

test('height map: prefix sums, lookups and splices', () => {
  const h = new HeightMap()
  h.reset([1, 3, 1, 2])
  assert.equal(h.total, 7)
  assert.equal(h.before(2), 4)
  assert.equal(h.lineAtRow(0), 0)
  assert.equal(h.lineAtRow(3), 1)
  assert.equal(h.lineAtRow(4), 2)
  assert.equal(h.lineAtRow(99), 3)
  h.splice(1, 1, [2, 2])
  assert.equal(h.total, 8)
  assert.equal(h.before(3), 5)
  h.set(0, 4)
  assert.equal(h.before(1), 4)
})

test('first chars: static analysis of rule regexes', () => {
  const chars = (re: RegExp) => {
    const set = firstChars(re.source, re.flags)
    return set ? [...set].map((v, c) => (v ? String.fromCharCode(c) : '')).join('') : null
  }
  assert.equal(chars(/\/\/.*/), '/')
  assert.equal(chars(/"|'/), `"'`)
  assert.equal(chars(/(?:0x|\d)+/), '0123456789')
  assert.equal(chars(/[a-c]+/i), 'ABCabc')
  assert.equal(chars(/(?<=\s)\/x/), '/')
  assert.equal(chars(/a?b/), null)
  assert.equal(chars(/(?=x)/), null)
  assert.equal(chars(/$/), null)
})

test('first-char dispatch gives the same tokens as trying every rule', () => {
  const slow = defineLanguage(javascript.spec, { prefilter: false })
  const src = 'const re = /a[/]b/g; x = `t ${y /* c */} ${`n`}` // done\nlet a = 0x1F / 2 // "q" ✓ 👍🏽'
  assert.deepEqual(tokenize(javascript, src), tokenize(slow, src))
})

test('tokenRule: captures new token types inside existing ones', () => {
  const rule = createTokenRule({ match: /\b(TODO|FIXME)\b/, token: 'todo', inside: 'comment' })
  const text = 'x // TODO: fix TODO'
  const tokens = rule(text, javascript.tokenize(text, javascript.initialState).tokens)
  const todos = tokens.filter((t) => t.type === 'comment todo').map((t) => text.slice(t.from, t.to))
  assert.deepEqual(todos, ['TODO', 'TODO'])
  // Outside comments nothing changes.
  const code = 'let TODO = 1'
  const base = javascript.tokenize(code, javascript.initialState).tokens
  assert.equal(rule(code, base), base)
  // Tokens still cover the whole line.
  let pos = 0
  for (const t of tokens) {
    assert.equal(t.from, pos)
    pos = t.to
  }
  assert.equal(pos, text.length)
})

test('tokenRule: dynamic types and inline styles', () => {
  const rule = createTokenRule({ match: /#[\da-f]{6}\b/i, token: 'color', keepType: false, style: (m) => `--swatch:${m[0]}` })
  const text = `const c = '#ff0000'`
  const t = rule(text, javascript.tokenize(text, javascript.initialState).tokens).find((x) => x.type === 'color')!
  assert.equal(text.slice(t.from, t.to), '#ff0000')
  assert.equal(t.style, '--swatch:#ff0000')
})

test('token classes for combined types', () => {
  assert.equal(tokenClass('comment todo'), 'jc-t-comment jc-t-todo')
  assert.equal(tokenSelector('comment.doc todo'), '.jc-t-comment-doc.jc-t-todo')
  assert.equal(tokenTypeOfClass(tokenClass('string.escape')), 'string.escape')
})

test('extendLanguage: new rules win over the original grammar', () => {
  const js = extendLanguage(javascript, {
    name: 'js-plus',
    prepend: { root: [[/\bdebugger\b/, 'invalid'], [/\bsql(?=`)/, 'meta', '@next:root']] },
    states: { extra: [[/x/, 'number']] },
  })
  assert.equal(js.name, 'js-plus')
  assert.equal(typeOf(js, 'debugger;', 'debugger'), 'invalid')
  assert.equal(typeOf(javascript, 'debugger;', 'debugger'), 'keyword')
  assert.equal(typeOf(js, 'const a = 1', 'const'), 'keyword')
  assert.throws(() => extendLanguage(javascript, { prepend: { nope: [] } }), /unknown state/)
})

test('search: regex building', () => {
  const q = { search: 'a.b', replace: '', caseSensitive: false, wholeWord: false, regexp: false }
  assert.equal(searchRegExp(q)!.test('A.B'), true)
  assert.equal(searchRegExp({ ...q, caseSensitive: true })!.test('A.B'), false)
  assert.equal(searchRegExp({ ...q, search: 'id', wholeWord: true })!.test('userid'), false)
  assert.equal(searchRegExp({ ...q, search: 'id', wholeWord: true })!.test('user id'), true)
  assert.equal(searchRegExp({ ...q, search: '(', regexp: true }), null)
})
