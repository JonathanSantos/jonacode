import assert from 'node:assert/strict'
import { test } from 'node:test'
import { json } from '../src/languages/json.ts'
import { tokenize, typeOf } from './helpers.ts'

const t = (src: string, text: string) => typeOf(json, src, text)

test('keys vs string values', () => {
  assert.deepEqual(tokenize(json, '{"name": "jonacode", "n" : 1}')[0], [
    ['{', 'punctuation.bracket'], ['"name"', 'property'], [': ', 'punctuation'], ['"jonacode"', 'string'],
    [', ', 'punctuation'], ['"n"', 'property'], [': ', 'punctuation'], ['1', 'number'], ['}', 'punctuation.bracket'],
  ])
  assert.equal(t('["a", "b"]', '"a"'), 'string')
})

test('escapes in values and keys', () => {
  assert.deepEqual(tokenize(json, '"a\\n\\u00e9b"')[0], [
    ['"a', 'string'], ['\\n\\u00e9', 'string.escape'], ['b"', 'string'],
  ])
  assert.equal(t('{"we\\"ird": 1}', '"we\\"ird"'), 'property')
  // An unterminated string stops at the end of the line.
  assert.equal(tokenize(json, '"open\n1')[1]![0]![1], 'number')
})

test('numbers and literals', () => {
  assert.equal(t('[-1.5e+10]', '-1.5e+10'), 'number')
  assert.equal(t('[0]', '0'), 'number')
  assert.equal(t('{"a": true}', 'true'), 'constant.language')
  assert.equal(t('[false]', 'false'), 'constant.language')
  assert.equal(t('[null]', 'null'), 'constant.language')
  assert.equal(t('[nul]', 'nul'), null)
})

test('comments (JSONC)', () => {
  const lines = tokenize(json, '{\n  // line\n  /* block\n still */ "k": 1 /* x */\n}')
  assert.deepEqual(lines[1], [['// line', 'comment']])
  assert.deepEqual(lines[2], [['/* block', 'comment']])
  assert.deepEqual(lines[3], [[' still */', 'comment'], ['"k"', 'property'], [': ', 'punctuation'], ['1', 'number'], ['/* x */', 'comment']])
  assert.equal(t('{"url": "http://x"}', '"http://x"'), 'string')
})

test('language metadata', () => {
  assert.equal(json.name, 'json')
  assert.ok(json.aliases.includes('jsonc'))
  assert.ok(json.extensions.includes('.webmanifest'))
  assert.ok(json.indent.increase!.test('  "a": {'))
})

test('tokenizes a large file quickly', () => {
  const src = Array.from({ length: 20_000 }, (_, i) =>
    `  {"id": ${i}, "name": "item \\"${i}\\"", "tags": ["a", "b"], "ok": ${i % 2 === 0}, "ratio": ${i / 7}, "x": null},`,
  ).join('\n')
  const lines = src.split('\n')
  const start = performance.now()
  let state = json.initialState
  for (const line of lines) state = json.endState(line, state)
  let tokens = 0
  for (const line of lines) tokens += json.tokenize(line, state).tokens.length
  const ms = performance.now() - start
  assert.ok(tokens > 20_000 * 20)
  assert.ok(ms < 1500, `took ${ms}ms`)
})
