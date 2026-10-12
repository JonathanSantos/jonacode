import assert from 'node:assert/strict'
import { test } from 'node:test'
import { History, invertChanges } from '../src/state/history.ts'
import { mapPos, TextDocument } from '../src/state/text.ts'
import { columnAtVisual, nextCharBoundary, prevCharBoundary, visualColumn, wordEnd, wordRangeAt, wordStart } from '../src/util/text.ts'

test('document: replace inside a line', () => {
  const doc = new TextDocument('hello world')
  const c = doc.replace({ line: 0, col: 6 }, { line: 0, col: 11 }, 'there')
  assert.equal(doc.toString(), 'hello there')
  assert.deepEqual(c.removed, ['world'])
})

test('document: multi-line insert and delete', () => {
  const doc = new TextDocument('a\nb\nc')
  doc.replace({ line: 1, col: 0 }, { line: 1, col: 1 }, 'x\ny\nz')
  assert.deepEqual(doc.lines, ['a', 'x', 'y', 'z', 'c'])
  const c = doc.replace({ line: 0, col: 1 }, { line: 3, col: 1 }, '')
  assert.deepEqual(doc.lines, ['a', 'c'])
  assert.deepEqual(c.removed, ['', 'x', 'y', 'z'])
})

test('document: keeps CRLF line endings', () => {
  const doc = new TextDocument('a\r\nb')
  assert.deepEqual(doc.lines, ['a', 'b'])
  assert.equal(doc.toString(), 'a\r\nb')
})

test('document: huge inserts do not overflow the stack', () => {
  const doc = new TextDocument('start\nend')
  const big = Array.from({ length: 200_000 }, (_, i) => 'line ' + i)
  doc.replace({ line: 1, col: 0 }, { line: 1, col: 0 }, big)
  assert.equal(doc.lineCount, 200_001)
  assert.equal(doc.line(200_000), 'line 199999end')
})

test('mapPos: positions after a change shift', () => {
  const doc = new TextDocument('abc\ndef')
  const c = doc.replace({ line: 0, col: 1 }, { line: 0, col: 1 }, 'X\nY')
  assert.deepEqual(mapPos({ line: 0, col: 2 }, c), { line: 1, col: 2 })
  assert.deepEqual(mapPos({ line: 1, col: 1 }, c), { line: 2, col: 1 })
  assert.deepEqual(mapPos({ line: 0, col: 0 }, c), { line: 0, col: 0 })
  assert.deepEqual(mapPos({ line: 0, col: 1 }, c, -1), { line: 0, col: 1 })
  assert.deepEqual(mapPos({ line: 0, col: 1 }, c, 1), { line: 1, col: 1 })
})

test('history: inverting changes restores the document', () => {
  const doc = new TextDocument('one\ntwo\nthree')
  const changes = [
    doc.replace({ line: 1, col: 0 }, { line: 2, col: 2 }, 'TWO\nTH'),
    doc.replace({ line: 0, col: 3 }, { line: 0, col: 3 }, '!'),
  ]
  for (const spec of invertChanges(changes)) doc.replace(spec.from, spec.to!, spec.insert!)
  assert.equal(doc.toString(), 'one\ntwo\nthree')
})

test('history: typing is grouped', () => {
  const h = new History()
  const doc = new TextDocument('')
  const sel = (col: number) => ({ ranges: [{ anchor: { line: 0, col }, head: { line: 0, col } }], main: 0 })
  h.record([doc.replace({ line: 0, col: 0 }, { line: 0, col: 0 }, 'a')], sel(0), sel(1), 'input', 1000)
  h.record([doc.replace({ line: 0, col: 1 }, { line: 0, col: 1 }, 'b')], sel(1), sel(2), 'input', 1100)
  h.record([doc.replace({ line: 0, col: 2 }, { line: 0, col: 2 }, 'c')], sel(2), sel(3), 'input', 5000)
  assert.equal(h.done.length, 2)
})

test('text utils: tabs and visual columns', () => {
  assert.equal(visualColumn('\tab', 1, 4), 4)
  assert.equal(visualColumn('a\tb', 2, 4), 4)
  assert.equal(columnAtVisual('\tab', 4, 4), 1)
  assert.equal(columnAtVisual('\tab', 1.9, 4), 0)
  assert.equal(columnAtVisual('abc', 1.6, 4), 2)
})

test('text utils: word boundaries', () => {
  const text = 'const fooBar = obj.value;'
  assert.equal(wordEnd(text, 0), 5)
  assert.equal(wordEnd(text, 5), 12)
  assert.equal(wordStart(text, 12), 6)
  assert.deepEqual(wordRangeAt(text, 8), [6, 12])
  assert.deepEqual(wordRangeAt('$el.x', 1, '$'), [0, 3])
})

test('text utils: grapheme boundaries', () => {
  const text = 'a👍🏽b'
  assert.equal(nextCharBoundary(text, 1), 5)
  assert.equal(prevCharBoundary(text, 5), 1)
  assert.equal(nextCharBoundary('abc', 1), 2)
})
