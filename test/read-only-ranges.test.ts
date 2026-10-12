import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEdits } from '../src/ai/edits.ts'
import { editorTools } from '../src/ai/tools.ts'
import { getDecorations } from '../src/decorations.ts'
import type { Editor, Extension } from '../src/editor.ts'
import { getReadOnlyRanges, lineRange, readOnlyRanges, setReadOnlyRanges } from '../src/extensions/read-only-ranges.ts'
import { fakeEditor, type FakeEditor } from './fake-editor.ts'

const p = (line: number, col: number) => ({ line, col })
/** Runs an extension on an editor, returning its cleanup. */
const use = (ext: Extension, ed: Editor) => (ext as (ed: Editor) => () => void)(ed)

/** Just enough of a DOM for `injectStyle` and decorations. */
function withDom<T extends Editor>(ed: T): T {
  const style = { setAttribute() {}, textContent: '' }
  const doc = { createElement: () => style, head: { appendChild() {} } }
  ;(ed as { dom: unknown }).dom = { getRootNode: () => doc, ownerDocument: doc }
  return ed
}

/** `one / PROTECTED / three` with line 2 protected; rejections are recorded. */
function setup(): { ed: FakeEditor; rejected: string[]; dispose: () => void } {
  const ed = fakeEditor('one\nPROTECTED\nthree')
  const rejected: string[] = []
  const dispose = use(readOnlyRanges([lineRange(ed, 2, 2)], { onReject: (_, origin) => rejected.push(origin) }), ed)
  return { ed, rejected, dispose }
}

test('read-only ranges: lineRange covers whole lines (1-based, inclusive)', () => {
  const ed = fakeEditor('a\nbb\nccc\nd')
  assert.deepEqual(lineRange(ed, 2, 3), { from: p(1, 0), to: p(2, 3) })
  assert.deepEqual(lineRange(ed, 0, 99), { from: p(0, 0), to: p(3, 1) })
})

test('read-only ranges: typing or deleting inside is blocked', () => {
  const { ed, rejected } = setup()
  ed.dispatch({ changes: { from: p(1, 3), insert: 'x' }, origin: 'input' })
  ed.dispatch({ changes: { from: p(1, 8), to: p(1, 9) }, origin: 'delete.backward' })
  ed.dispatch({ changes: { from: p(0, 2), to: p(1, 1) }, origin: 'delete.forward' })
  ed.dispatch({ changes: { from: p(0, 0), to: p(2, 5), insert: 'all new' }, origin: 'input.paste' })
  assert.equal(ed.getValue(), 'one\nPROTECTED\nthree')
  assert.equal(ed.version, 0)
  assert.deepEqual(rejected, ['input', 'delete.backward', 'delete.forward', 'input.paste'])
})

test('read-only ranges: insertions right before / after are allowed and stay outside', () => {
  const { ed, rejected } = setup()
  ed.dispatch({ changes: { from: p(1, 0), insert: '>> ' } })
  ed.dispatch({ changes: { from: p(1, 12), insert: ' <<' } })
  ed.dispatch({ changes: { from: p(1, 15), insert: '\nnew line' } })
  assert.equal(ed.getValue(), 'one\n>> PROTECTED <<\nnew line\nthree')
  assert.deepEqual(getReadOnlyRanges(ed), [{ from: p(1, 3), to: p(1, 12) }])
  assert.deepEqual(rejected, [])
  // Deleting what was typed next to it works too; the range doesn't grow or shrink.
  ed.dispatch({ changes: { from: p(1, 0), to: p(1, 3) } })
  assert.deepEqual(getReadOnlyRanges(ed), [{ from: p(1, 0), to: p(1, 9) }])
})

test('read-only ranges: follow edits above them', () => {
  const { ed } = setup()
  ed.dispatch({ changes: { from: p(0, 0), insert: 'a\nb\n' } })
  assert.deepEqual(getReadOnlyRanges(ed), [{ from: p(3, 0), to: p(3, 9) }])
  ed.dispatch({ changes: { from: p(3, 0), insert: 'x' } })   // at its start: allowed, outside
  ed.dispatch({ changes: { from: p(3, 5), insert: 'y' } })   // inside: blocked
  assert.equal(ed.getValue(), 'a\nb\none\nxPROTECTED\nthree')
  ed.dispatch({ changes: { from: p(0, 0), to: p(2, 0) } })
  assert.deepEqual(getReadOnlyRanges(ed), [{ from: p(1, 1), to: p(1, 10) }])
})

test('read-only ranges: each change of a transaction is checked where it lands', () => {
  const { ed, rejected } = setup()
  // After the first change, line 2 is `one`: inserting there is fine.
  ed.dispatch({ changes: [{ from: p(0, 0), insert: 'zero\n' }, { from: p(1, 3), insert: '!' }] })
  assert.equal(ed.getValue(), 'zero\none!\nPROTECTED\nthree')
  // After the first change, the protected line is line 3: the second change hits it.
  ed.dispatch({ changes: [{ from: p(0, 0), insert: 'z\n' }, { from: p(3, 4), insert: '?' }], origin: 'multi' })
  assert.equal(ed.getValue(), 'zero\none!\nPROTECTED\nthree')
  assert.deepEqual(rejected, ['multi'])
  // The first change deletes the line above, so the protected line moves up before the second one.
  ed.dispatch({ changes: [{ from: p(0, 0), to: p(1, 0) }, { from: p(1, 2), insert: '#' }] })
  assert.equal(ed.getValue(), 'zero\none!\nPROTECTED\nthree')
  assert.deepEqual(getReadOnlyRanges(ed), [{ from: p(2, 0), to: p(2, 9) }])
})

test('read-only ranges: undo and redo are allowed', () => {
  const ed = fakeEditor('one\ntwo\nthree')
  ed.dispatch({ changes: { from: p(1, 1), insert: 'XX' }, origin: 'input' })
  setReadOnlyRanges(ed, [lineRange(ed, 2, 2)])
  assert.equal(ed.undo(), true)
  assert.equal(ed.getValue(), 'one\ntwo\nthree')
  assert.deepEqual(getReadOnlyRanges(ed), [{ from: p(1, 0), to: p(1, 3) }])
  assert.equal(ed.redo(), true)
  assert.equal(ed.getValue(), 'one\ntXXwo\nthree')
})

test('read-only ranges: setReadOnlyRanges normalizes and replaces; disposing lifts the protection', () => {
  const { ed, dispose } = setup()
  setReadOnlyRanges(ed, [{ from: p(2, 5), to: p(2, 1) }, { from: p(0, 1), to: p(0, 1) }, { from: p(0, 0), to: p(0, 99) }])
  assert.deepEqual(getReadOnlyRanges(ed), [{ from: p(0, 0), to: p(0, 3) }, { from: p(2, 1), to: p(2, 5) }])
  ed.dispatch({ changes: { from: p(1, 2), insert: '-' } })   // line 2 isn't protected anymore
  ed.dispatch({ changes: { from: p(2, 2), insert: '-' } })
  assert.equal(ed.getValue(), 'one\nPR-OTECTED\nthree')
  dispose()
  assert.deepEqual(getReadOnlyRanges(ed), [])
  ed.dispatch({ changes: { from: p(2, 2), insert: '-' } })
  assert.equal(ed.getValue(), 'one\nPR-OTECTED\nth-ree')
})

test('read-only ranges: shown with a decoration set when there is a DOM', async () => {
  const ed = withDom(fakeEditor('a\nb\nc\nd'))
  use(readOnlyRanges([lineRange(ed, 2, 3)], { className: 'locked' }), ed)
  const classes = () => getDecorations(ed, 'readonly').map((d) => `${d.class}@${d.from.line}`)
  // Whole protected lines get a full-width line decoration with both classes.
  assert.deepEqual(classes(), ['locked-line locked@1', 'locked-line locked@2'])
  // A new line above the block: the line decorations are redrawn on the lines that moved.
  ed.dispatch({ changes: { from: p(1, 0), insert: 'new\n' } })
  await Promise.resolve()
  assert.deepEqual(classes(), ['locked-line locked@2', 'locked-line locked@3'])
})

test('read-only ranges: AI edits touching them fail, with a message for the model', async () => {
  const { ed, rejected } = setup()
  const r = applyEdits(ed, { old: 'PROTECTED', new: 'changed' })
  assert.equal(r.ok, false)
  assert.equal(ed.getValue(), 'one\nPROTECTED\nthree')
  assert.deepEqual(rejected, ['ai'])
  assert.equal(applyEdits(ed, { old: 'three', new: '3' }).ok, true)
  assert.equal(ed.getValue(), 'one\nPROTECTED\n3')
  const tools = editorTools(ed, { settle: 0 })
  const res = await tools.run('write_file', { content: 'all\nnew\n3' })
  assert.equal(res.isError, true)
  assert.match(res.content, /protected \(read-only\)/)
  assert.equal(ed.getValue(), 'one\nPROTECTED\n3')
  assert.equal((await tools.run('insert_lines', { line: 1, text: 'between' })).isError, undefined)
  assert.equal(ed.getValue(), 'one\nbetween\nPROTECTED\n3')
})
