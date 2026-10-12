import assert from 'node:assert/strict'
import { test } from 'node:test'
import { columnAtWidth, textWidth, wrapLine, type Advances } from '../src/view/layout.ts'

/** A proportional font: `i` is half a column, `W` two, a space 0.6, everything else 1; wide chars 2.4. */
function proportional(): Advances {
  const ascii = new Float64Array(128).fill(1)
  ascii['i'.charCodeAt(0)] = 0.5
  ascii['W'.charCodeAt(0)] = 2
  ascii[32] = 0.6
  return { ascii, wide: 2.4, max: 2.4 }
}

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`)

test('text width: monospace columns by default, measured advances when given', () => {
  assert.equal(textWidth('abc', 4), 3)
  assert.equal(textWidth('a\tb', 4), 5)
  assert.equal(textWidth('世界', 4), 4)
  assert.equal(textWidth('😀x', 4), 3)
  const adv = proportional()
  assert.equal(textWidth('iiW', 4, adv), 3)
  assert.equal(textWidth('世', 4, adv), 2.4)
  assert.equal(textWidth('abcdef', 4, adv, 2), 2)
})

test('tabs go to the next stop (every tabSize spaces); one closer than half a space is skipped, like CSS', () => {
  const adv = proportional() // stops every 4 × 0.6 = 2.4 columns
  near(textWidth('\t', 4, adv), 2.4)
  near(textWidth('ab\t', 4, adv), 2.4)
  near(textWidth('Wi\t', 4, adv), 4.8)
  near(textWidth('WWii\t', 4, adv), 7.2)
  // After 2.2 columns the next stop is 0.2 away, under half a space (0.3): the one after it.
  near(textWidth('  a\t', 4, adv), 4.8)
  // Monospace: plain tab stops.
  assert.equal(textWidth('abc\t', 4), 4)
  assert.equal(textWidth('abcd\t', 4), 8)
})

test('column at a width: the nearest boundary, never inside a surrogate pair', () => {
  const adv = proportional()
  assert.equal(columnAtWidth('iiW', 0.2, 4, adv), 0)
  assert.equal(columnAtWidth('iiW', 0.3, 4, adv), 1)
  assert.equal(columnAtWidth('iiW', 1.8, 4, adv), 2)
  assert.equal(columnAtWidth('iiW', 2.1, 4, adv), 3)
  assert.equal(columnAtWidth('iiW', 99, 4, adv), 3)
  assert.equal(columnAtWidth('a😀b', 1.9, 4), 1)
  assert.equal(columnAtWidth('a😀b', 2.1, 4), 3)
  for (let x = 0; x < 5; x += 0.1) assert.notEqual(columnAtWidth('a😀b', x, 4), 2)
})

test('wrap with measured advances: every row fits, narrow chars fill more, wide ones take what they measure', () => {
  const adv = proportional()
  const text = 'WWW iii WWW iii ' + 'Wide words iiii '.repeat(6)
  for (const cols of [6, 9.5, 14, 23]) {
    const breaks = wrapLine(text, cols, 4, adv)!
    assert.ok(breaks, `wraps at ${cols}`)
    const starts = [0, ...breaks, text.length]
    for (let i = 0; i < starts.length - 1; i++) {
      const row = text.slice(starts[i], starts[i + 1])
      assert.ok(textWidth(row, 4, adv) <= cols + 1e-9, `row ${i} fits ${cols}: ${JSON.stringify(row)}`)
    }
  }
  assert.deepEqual(wrapLine('i'.repeat(30), 20, 4), [20])
  assert.equal(wrapLine('i'.repeat(30), 20, 4, adv), null)
  assert.deepEqual(wrapLine('世界世界', 5, 4), [2])
  assert.deepEqual(wrapLine('世界世界', 5, 4, adv), [2])
  assert.deepEqual(wrapLine('世界世界', 4.7, 4, adv), [1, 2, 3])
})
