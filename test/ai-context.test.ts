import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeEditor, fimContext, numberLines, pathFor } from '../src/ai/context.ts'
import { clearAIMarks, getAIMarks, markAIEdits } from '../src/ai/marks.ts'
import type { Editor } from '../src/editor.ts'
import { setDiagnostics } from '../src/extensions/diagnostics.ts'
import { css } from '../src/languages/css.ts'
import { html } from '../src/languages/html.ts'
import { javascript } from '../src/languages/javascript.ts'
import { fakeEditor } from './fake-editor.ts'

const p = (line: number, col: number) => ({ line, col })

/** Just enough of a DOM for `injectStyle` and decorations, so DOM-only features can be checked headless. */
function withDom<T extends Editor>(ed: T): T {
  const style = { setAttribute() {}, textContent: '' }
  const doc = { createElement: () => style, head: { appendChild() {} } }
  ;(ed as { dom: unknown }).dom = { getRootNode: () => doc, ownerDocument: doc }
  return ed
}

const lines = (n: number, fn = (i: number) => `line ${i + 1}`) => Array.from({ length: n }, (_, i) => fn(i)).join('\n')

test('pathFor: a file name from the language', () => {
  assert.equal(pathFor(fakeEditor('')), 'file.txt')
  assert.equal(pathFor(fakeEditor('', { language: javascript })), 'main.js')
  assert.equal(pathFor(fakeEditor('', { language: html })), 'index.html')
  assert.equal(pathFor(fakeEditor('', { language: css })), 'style.css')
})

test('numberLines: cat -n rows, long lines cut, char budget', () => {
  const ed = fakeEditor(`a\n${'x'.repeat(2500)}\nc`)
  const [text, last] = numberLines(ed, 0, 2)
  assert.equal(last, 2)
  assert.match(text, /^     1\ta\n     2\tx{2000} … \[500 more chars\]\n     3\tc\n$/)
  const [some, shown] = numberLines(ed, 0, 2, 20)
  assert.equal(shown, 0)
  assert.equal(some, '     1\ta\n')
})

test('describeEditor: file, cursor, selection, numbered lines', () => {
  const ed = fakeEditor('const a = 1\nconst b = 2\nconsole.log(a + b)\n', { language: javascript })
  ed.setSelection(p(1, 6), p(1, 7))
  const out = describeEditor(ed)
  assert.match(out, /^File: main\.js \(javascript, 3 lines\)\n/)
  assert.match(out, /Cursor: line 2, col 8\n/)
  assert.match(out, /Selection: 2:7 to 2:8\nSelected text:\n```\nb\n```\n/)
  assert.match(out, /Lines 1-3:\n     1\tconst a = 1\n     2\tconst b = 2\n     3\tconsole\.log\(a \+ b\)\n$/)
  assert.doesNotMatch(out, /Problems/)
  assert.match(describeEditor(ed, { path: 'src/x.js' }), /^File: src\/x\.js /)
})

test('describeEditor: several cursors', () => {
  const ed = fakeEditor('abc\ndef\nghi')
  ed.dispatch({ selection: { ranges: [{ anchor: p(0, 1), head: p(0, 1) }, { anchor: p(2, 2), head: p(2, 2) }], main: 1 } })
  assert.match(describeEditor(ed), /Cursors \(line:col\): 1:2, 3:3 \(main\)\n/)
})

test('describeEditor: big files show only the lines around the cursor, within maxChars', () => {
  const ed = fakeEditor(lines(100_000))
  ed.setSelection(p(50_000, 2))
  const t = performance.now()
  const out = describeEditor(ed)
  assert.ok(performance.now() - t < 50, 'fast')
  assert.match(out, /100000 lines/)
  assert.match(out, /Lines 49961-50041:\n/)
  assert.match(out, / 50001\tline 50001\n/)
  assert.doesNotMatch(out, /\tline 1\n/)
  assert.ok(out.length <= 12000)
  // A tight budget shrinks the window around the cursor line.
  const small = describeEditor(ed, { maxChars: 600 })
  assert.ok(small.length <= 600, `${small.length}`)
  assert.match(small, / 50001\tline 50001\n/)
  const m = /Lines (\d+)-(\d+):/.exec(small)!
  assert.ok(+m[1]! > 49961 && +m[2]! < 50041 && +m[1]! <= 50001 && +m[2]! >= 50001)
})

test('describeEditor: huge selections are capped', () => {
  const ed = fakeEditor(lines(5000))
  ed.setSelection(p(0, 0), p(4999, 4))
  const out = describeEditor(ed, { maxChars: 4000 })
  assert.ok(out.length <= 4000)
  assert.match(out, /more chars\]/)
})

test('describeEditor: lists the problems (1-based)', () => {
  const ed = withDom(fakeEditor('let x = \nfoo()'))
  setDiagnostics(ed, [
    { from: p(1, 0), severity: 'warning', message: 'foo is not defined', source: 'lint' },
    { from: p(0, 4), severity: 'error', message: 'Expression expected' },
  ])
  assert.match(describeEditor(ed), /Problems \(line:col\):\n- 1:5 error: Expression expected\n- 2:1 warning: foo is not defined \[lint\]\n/)
})

test('fimContext: text around the cursor, cut at line boundaries', () => {
  const ed = fakeEditor('function add(a, b) {\n  return \n}\n', { language: javascript })
  ed.setSelection(p(1, 9))
  assert.deepEqual(fimContext(ed), { prefix: 'function add(a, b) {\n  return ', suffix: '\n}\n', language: 'javascript', line: 1, col: 9 })

  const big = fakeEditor(lines(1000, (i) => `row ${String(i).padStart(4, '0')}`))   // 8 chars per line
  big.setSelection(p(500, 4))
  const { prefix, suffix } = fimContext(big, { before: 100, after: 50 })
  assert.ok(prefix.length <= 100 && prefix.length > 80)
  assert.ok(prefix.startsWith('row '), 'starts at a line')
  assert.ok(prefix.endsWith('row 0499\nrow '))
  assert.ok(suffix.length <= 50 && suffix.length > 35)
  assert.ok(suffix.startsWith('0500\nrow 0501'))
  assert.ok(/\d{4}$/.test(suffix), 'ends at a line end')
})

test('fimContext: a selection is left out; a very long line is cut mid-line', () => {
  const ed = fakeEditor('abc SELECTED def')
  ed.setSelection(p(0, 12), p(0, 4))
  const f = fimContext(ed)
  assert.equal(f.prefix, 'abc ')
  assert.equal(f.suffix, ' def')
  assert.equal(f.col, 4)
  const long = fakeEditor('x'.repeat(10_000))
  long.setSelection(p(0, 5000))
  const g = fimContext(long, { before: 100, after: 100 })
  assert.equal(g.prefix.length, 100)
  assert.equal(g.suffix.length, 100)
})

test('marks: AI edits are merged, follow edits, and can be cleared; no-op without DOM', async () => {
  const headless = fakeEditor('abc')
  markAIEdits(headless, [{ from: p(0, 0), to: p(0, 2) }])
  assert.deepEqual(getAIMarks(headless), [])

  const ed = withDom(fakeEditor('one\ntwo\nthree'))
  markAIEdits(ed, [{ from: p(0, 0), to: p(0, 3) }, { from: p(2, 1), to: p(2, 1) }])
  markAIEdits(ed, [{ from: p(0, 2), to: p(1, 1) }, { from: p(2, 0), to: p(2, 5) }])
  assert.deepEqual(getAIMarks(ed), [{ from: p(0, 0), to: p(1, 1) }, { from: p(2, 0), to: p(2, 5) }])
  ed.dispatch({ changes: { from: p(0, 0), insert: 'zero\n' } })
  assert.deepEqual(getAIMarks(ed), [{ from: p(1, 0), to: p(2, 1) }, { from: p(3, 0), to: p(3, 5) }])
  clearAIMarks(ed)
  assert.deepEqual(getAIMarks(ed), [])
})
