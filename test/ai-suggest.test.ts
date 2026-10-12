import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanResult, editRange, stripFence, surroundings, wholeLines } from '../src/ai/inline-edit.ts'
import { nextWord, suggestsAfter, trimSuggestion, typeThrough } from '../src/ai/suggest.ts'
import { TextDocument } from '../src/state/text.ts'

test('trimSuggestion: drops a tail that repeats the text after the cursor', () => {
  // Closing punctuation repeated by FIM models.
  assert.equal(trimSuggestion("'hi')", ')'), "'hi'")
  assert.equal(trimSuggestion('a, b);', ');\n}'), 'a, b')
  assert.equal(trimSuggestion('\n  return 1\n}', '\n}'), '\n  return 1')
  assert.equal(trimSuggestion('foo()\n  }', '\n  }\n}'), 'foo()')
  // The whole rest of the line repeated.
  assert.equal(trimSuggestion('a) {', ') {\nbody'), 'a')
  assert.equal(trimSuggestion('y = x', 'x'), 'y = ')
  // Only what's before the cursor's closing bracket: the `)` of an inner call stays.
  assert.equal(trimSuggestion('f(x)', ''), 'f(x)')
  // A coincidental overlap in the middle of a line is kept.
  assert.equal(trimSuggestion('foo(b', 'b + c;'), 'foo(b')
  assert.equal(trimSuggestion('a + b', 'b + c'), 'a + b')
  // An auto-closed `}` on its own: the suggestion keeps its line break before it.
  assert.equal(trimSuggestion('\n  x()\n}', '}\n'), '\n  x()\n')
})

test('trimSuggestion: whitespace', () => {
  assert.equal(trimSuggestion('foo  \n\n', ''), 'foo')
  assert.equal(trimSuggestion('   \n\t', ''), '')
  assert.equal(trimSuggestion('', ')'), '')
  assert.equal(trimSuggestion(')', ')'), '')
  assert.equal(trimSuggestion('  x', ''), '  x')
})

test('typeThrough: the rest of the suggestion, or null', () => {
  assert.equal(typeThrough('console.log(x)', 'cons'), 'ole.log(x)')
  assert.equal(typeThrough('console.log(x)', 'console.log(x)'), '')
  assert.equal(typeThrough('\n  return 1', '\n  '), 'return 1')
  assert.equal(typeThrough('console', 'x'), null)
  assert.equal(typeThrough('ab', 'abc'), null)
})

test('nextWord: up to the end of the next word', () => {
  assert.equal(nextWord('const total = 1'), 'const')
  assert.equal(nextWord(' total = 1'), ' total')
  assert.equal(nextWord(' = 1'), ' =')
  assert.equal(nextWord('();\n  next'), '();')
  assert.equal(nextWord('\n  return x'), '\n  return')
  assert.equal(nextWord('my-var rest', '-'), 'my-var')
  assert.equal(nextWord('   '), '   ')
  assert.equal(nextWord(''), '')
})

test('suggestsAfter: automatic requests only before closing chars', () => {
  for (const rest of ['', '   ', ')', ');', '})', "')", '"]', '`', ' }', ','])
    assert.equal(suggestsAfter(rest), true, JSON.stringify(rest))
  for (const rest of ['foo', ') + x', 'bar()', '(', '{'])
    assert.equal(suggestsAfter(rest), false, JSON.stringify(rest))
})

test('stripFence: a fence wrapping the whole answer', () => {
  assert.equal(stripFence('```js\nconst a = 1\n```'), 'const a = 1')
  assert.equal(stripFence('```\na\nb\n```\n'), 'a\nb')
  assert.equal(stripFence('  ```typescript\nx\n```  '), 'x')
  assert.equal(stripFence('const a = 1'), 'const a = 1')
  // Inner fences (Markdown) stay.
  assert.equal(stripFence('```md\n# T\n```js\nx\n```\n```'), '# T\n```js\nx\n```')
  // Backticks in code aren't fences.
  assert.equal(stripFence('const s = `x`'), 'const s = `x`')
  assert.equal(stripFence('`foo'), '`foo')
})

test('stripFence: while streaming', () => {
  assert.equal(stripFence('`'), '')
  assert.equal(stripFence('``'), '')
  assert.equal(stripFence('```'), '')
  assert.equal(stripFence('```ts'), '')
  assert.equal(stripFence('```ts\n'), '')
  assert.equal(stripFence('```ts\nconst a'), 'const a')
  assert.equal(stripFence('```ts\nconst a = 1\n`'), 'const a = 1')
  assert.equal(stripFence('```ts\nconst a = 1\n``'), 'const a = 1')
})

test('cleanResult: fits the answer to the replaced text', () => {
  assert.equal(cleanResult('```js\nfoo()\n```\n', 'bar()'), 'foo()')
  assert.equal(cleanResult('foo()\n', 'bar()'), 'foo()')
  assert.equal(cleanResult('foo()\n\n', 'bar()'), 'foo()\n')
  // Editing a Markdown fence: the answer's fence is the content.
  assert.equal(cleanResult('```js\nx\n```', '```js\ny\n```'), '```js\nx\n```')
  assert.equal(cleanResult('', 'x'), '')
})

test('editRange: whole lines of a selection', () => {
  const doc = new TextDocument('zero\none\ntwo\nthree')
  assert.deepEqual(editRange(doc, { line: 1, col: 2 }, { line: 2, col: 1 }), { from: { line: 1, col: 0 }, to: { line: 2, col: 3 } })
  // Ending at column 0 leaves that line out (full-line selections).
  assert.deepEqual(editRange(doc, { line: 1, col: 0 }, { line: 3, col: 0 }), { from: { line: 1, col: 0 }, to: { line: 2, col: 3 } })
  // An empty selection: the cursor's line.
  assert.deepEqual(editRange(doc, { line: 3, col: 0 }, { line: 3, col: 0 }), { from: { line: 3, col: 0 }, to: { line: 3, col: 5 } })
  assert.deepEqual(wholeLines(doc, 0, 0), { from: { line: 0, col: 0 }, to: { line: 0, col: 4 } })
})

test('surroundings: whole lines around a range, within limits', () => {
  const lines = ['a'.repeat(5), 'b'.repeat(5), 'TARGET', 'c'.repeat(5), 'd'.repeat(5)]
  const from = { line: 2, col: 0 }
  const to = { line: 2, col: 6 }
  const all = surroundings(lines, from, to)
  assert.equal(all.before + 'TARGET' + all.after, lines.join('\n'))
  assert.deepEqual(surroundings(lines, from, to, [8, 8]), { before: 'bbbbb\n', after: '\nccccc' })
  assert.deepEqual(surroundings(lines, from, to, [0, 0]), { before: '', after: '' })
  assert.deepEqual(surroundings(['only'], { line: 0, col: 0 }, { line: 0, col: 4 }), { before: '', after: '' })
})
