import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Highlighter } from '../src/language/highlighter.ts'
import { defineLanguage, words } from '../src/language/language.ts'
import { TextDocument } from '../src/state/text.ts'
import { tokenize } from './helpers.ts'

const lang = defineLanguage({
  name: 'mini',
  states: {
    root: [
      [/\s+/, null],
      [/#.*/, 'comment'],
      [/"/, 'string', '@string'],
      [/\/\*/, 'comment', '@block'],
      { match: /[a-z]+/, token: words({ keyword: ['if', 'else'] }, 'variable') },
      [/(\d+)(px)/, ['number', 'keyword']],
    ],
    string: [
      [/[^"\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
    block: [
      [/\*\//, 'comment', '@pop'],
      [/[^*]+|\*/, 'comment'],
    ],
  },
})

test('rules, tuples, keyword helper and groups', () => {
  assert.deepEqual(tokenize(lang, 'if x # hi'), [[['if', 'keyword'], ['x', 'variable'], ['# hi', 'comment']]])
  assert.deepEqual(tokenize(lang, '12px'), [[['12', 'number'], ['px', 'keyword']]])
})

test('states: push/pop and escapes', () => {
  assert.deepEqual(tokenize(lang, '"a\\"b" c'), [[['"a', 'string'], ['\\"', 'string.escape'], ['b"', 'string'], ['c', 'variable']]])
})

test('states carry over lines', () => {
  const lines = tokenize(lang, 'a /* one\ntwo\nthree */ b')
  assert.deepEqual(lines[1], [['two', 'comment']])
  assert.deepEqual(lines[2], [['three */', 'comment'], ['b', 'variable']])
})

test('states are interned', () => {
  const s = lang.initialState
  assert.equal(s.push('string'), s.push('string'))
  assert.equal(s.push('string').pop(), s)
  assert.deepEqual(s.push('block').stack, ['root', 'block'])
})

test('unknown states throw a helpful error', () => {
  assert.throws(() => defineLanguage({ name: 'bad', states: { root: [[/a/, null, '@nope']] } }), /unknown state "nope"/)
})

test('zero-length state changes do not loop forever', () => {
  const loop = defineLanguage({
    name: 'loop',
    states: { root: [[/(?=a)/, null, '@other']], other: [[/(?=a)/, null, '@root']] },
  })
  assert.ok(loop.tokenize('aaa', loop.initialState))
})

test('highlighter: incremental re-tokenization converges', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `x${i} # line`)
  const doc = new TextDocument(lines.join('\n'))
  const hl = new Highlighter(lang, doc)
  assert.ok(hl.ensure(999))
  assert.equal(hl.validUpTo, 999)

  // Opening a block comment changes the state of every following line…
  hl.applyChange(doc.replace({ line: 10, col: 0 }, { line: 10, col: 0 }, '/*'))
  assert.equal(hl.validUpTo, 10)
  hl.ensure(999)
  assert.equal(hl.stateAt(500).name, 'block')

  // …and closing it converges back quickly to the cached states.
  hl.applyChange(doc.replace({ line: 20, col: 0 }, { line: 20, col: 0 }, '*/'))
  hl.ensure(999)
  assert.equal(hl.stateAt(500).name, 'root')
  assert.equal(hl.stateAt(15).name, 'block')

  // Inserting lines keeps states aligned.
  hl.applyChange(doc.replace({ line: 5, col: 0 }, { line: 5, col: 0 }, 'a\nb\nc\n'))
  hl.ensure(1002)
  assert.equal(hl.stateAt(18).name, 'block')
  assert.equal(hl.stateAt(24).name, 'root')
})

test('highlighter: respects the deadline', () => {
  const doc = new TextDocument(Array.from({ length: 50_000 }, () => 'if a # b').join('\n'))
  const hl = new Highlighter(lang, doc)
  assert.equal(hl.ensure(49_999, performance.now() - 1), false)
  assert.ok(hl.validUpTo < 49_999)
  assert.ok(hl.ensure(49_999))
})
