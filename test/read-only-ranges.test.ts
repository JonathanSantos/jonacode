import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEdits } from '../src/ai/edits.ts'
import { editorTools } from '../src/ai/tools.ts'
import { getDecorations } from '../src/decorations.ts'
import type { Editor, Extension } from '../src/editor.ts'
import { blocksChange, getReadOnlyRanges, lineRange, readOnlyRanges, setReadOnlyRanges } from '../src/extensions/read-only-ranges.ts'
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

// ---------------------------------------------------------------------------
// Inclusive edges

/** `head / YOURS / tail`: only line 2 can be edited, the ends of the document included. */
function exercise(): { ed: FakeEditor; rejected: string[] } {
  const ed = fakeEditor('head\nYOURS\ntail')
  const rejected: string[] = []
  use(readOnlyRanges([], { onReject: (_, origin) => rejected.push(origin) }), ed)
  setReadOnlyRanges(ed, [lineRange(ed, 1, 1, { sticky: true }), lineRange(ed, 3, 3, { sticky: true })])
  return { ed, rejected }
}

test('read-only ranges: blocksChange at the edges follows the inclusive flags', () => {
  const insertAt = (line: number, col: number) => ({ from: p(line, col), to: p(line, col), inserted: ['x'], removed: [''] })
  const range = { from: p(1, 2), to: p(1, 6) }
  assert.equal(blocksChange(range, insertAt(1, 2)), false)
  assert.equal(blocksChange(range, insertAt(1, 6)), false)
  assert.equal(blocksChange(range, insertAt(1, 4)), true)
  assert.equal(blocksChange({ ...range, inclusiveStart: true }, insertAt(1, 2)), true)
  assert.equal(blocksChange({ ...range, inclusiveStart: true }, insertAt(1, 6)), false)
  assert.equal(blocksChange({ ...range, inclusiveEnd: true }, insertAt(1, 6)), true)
  assert.equal(blocksChange({ ...range, inclusiveEnd: true }, insertAt(1, 2)), false)
  // Never past the edges, whatever the flags.
  const both = { ...range, inclusiveStart: true, inclusiveEnd: true }
  assert.equal(blocksChange(both, insertAt(1, 1)), false)
  assert.equal(blocksChange(both, insertAt(1, 7)), false)
  // Deleting what is next to an inclusive edge is still fine.
  assert.equal(blocksChange(both, { from: p(1, 0), to: p(1, 2), inserted: [''], removed: ['ab'] }), false)
  assert.equal(blocksChange(both, { from: p(1, 6), to: p(1, 8), inserted: [''], removed: ['ab'] }), false)
})

test('read-only ranges: lineRange sticky makes the edges at the ends of the document inclusive', () => {
  const ed = fakeEditor('a\nbb\nccc')
  assert.deepEqual(lineRange(ed, 1, 2, { sticky: true }), { from: p(0, 0), to: p(1, 2), inclusiveStart: true })
  assert.deepEqual(lineRange(ed, 2, 3, { sticky: true }), { from: p(1, 0), to: p(2, 3), inclusiveEnd: true })
  assert.deepEqual(lineRange(ed, 1, Infinity, { sticky: true }), { from: p(0, 0), to: p(2, 3), inclusiveStart: true, inclusiveEnd: true })
  assert.deepEqual(lineRange(ed, 2, 2, { sticky: true }), { from: p(1, 0), to: p(1, 2) })
  assert.deepEqual(lineRange(ed, 1, 3), { from: p(0, 0), to: p(2, 3) })
})

test('read-only ranges: nothing is typed before a sticky first line or after a sticky last line', () => {
  const { ed, rejected } = exercise()
  ed.dispatch({ changes: { from: p(0, 0), insert: 'x' }, origin: 'input' })
  ed.dispatch({ changes: { from: p(0, 0), insert: 'new\n' }, origin: 'input.paste' })
  ed.dispatch({ changes: { from: p(2, 4), insert: 'x' }, origin: 'input' })
  ed.dispatch({ changes: { from: p(2, 4), insert: '\nnew' }, origin: 'input' })
  assert.equal(ed.getValue(), 'head\nYOURS\ntail')
  assert.deepEqual(rejected, ['input', 'input.paste', 'input', 'input'])
  // The edges that face the editable line stay open: text typed there is outside the ranges.
  ed.dispatch({ changes: { from: p(1, 0), insert: '> ' }, origin: 'input' })
  ed.dispatch({ changes: { from: p(1, 7), insert: '!' }, origin: 'input' })
  assert.equal(ed.getValue(), 'head\n> YOURS!\ntail')
  assert.equal(rejected.length, 4)
})

test('read-only ranges: the inclusive flags survive edits and a get → set round trip', () => {
  const { ed, rejected } = exercise()
  // An unrelated edit that moves the last range to another line (so it is rebuilt).
  ed.dispatch({ changes: { from: p(1, 5), insert: '\nmore\nlines' }, origin: 'input' })
  assert.deepEqual(getReadOnlyRanges(ed), [
    { from: p(0, 0), to: p(0, 4), inclusiveStart: true },
    { from: p(4, 0), to: p(4, 4), inclusiveEnd: true },
  ])
  ed.dispatch({ changes: { from: p(4, 4), insert: 'x' }, origin: 'input' })
  ed.dispatch({ changes: { from: p(0, 0), insert: 'x' }, origin: 'input' })
  assert.deepEqual(rejected, ['input', 'input'])
  // What an app does to keep the locks across something that resets them.
  setReadOnlyRanges(ed, getReadOnlyRanges(ed))
  ed.dispatch({ changes: { from: p(4, 4), insert: 'x' }, origin: 'input' })
  ed.dispatch({ changes: { from: p(0, 0), insert: 'x' }, origin: 'input' })
  assert.equal(ed.getValue(), 'head\nYOURS\nmore\nlines\ntail')
  assert.equal(rejected.length, 4)
  // Given backwards, the flags swap with the edges.
  setReadOnlyRanges(ed, [{ from: p(0, 4), to: p(0, 0), inclusiveEnd: true }])
  assert.deepEqual(getReadOnlyRanges(ed), [{ from: p(0, 0), to: p(0, 4), inclusiveStart: true }])
})

test('read-only ranges: at an inclusive edge, undo and remote edits insert and stay outside (a range never grows)', () => {
  const ed = fakeEditor('abcLOCKED')
  setReadOnlyRanges(ed, [{ from: p(0, 3), to: p(0, 9), inclusiveStart: true, inclusiveEnd: true }])
  ed.dispatch({ changes: { from: p(0, 0), to: p(0, 3) }, origin: 'delete' })
  assert.equal(ed.getValue(), 'LOCKED')
  assert.equal(ed.undo(), true)
  assert.equal(ed.getValue(), 'abcLOCKED')
  assert.deepEqual(getReadOnlyRanges(ed), [{ from: p(0, 3), to: p(0, 9), inclusiveStart: true, inclusiveEnd: true }])
  ed.dispatch({ changes: { from: p(0, 9), insert: '!' }, origin: 'remote' })
  assert.deepEqual(getReadOnlyRanges(ed), [{ from: p(0, 3), to: p(0, 9), inclusiveStart: true, inclusiveEnd: true }])
  // The remote text is outside, so it can be edited.
  ed.dispatch({ changes: { from: p(0, 9), to: p(0, 10) }, origin: 'delete' })
  assert.equal(ed.getValue(), 'abcLOCKED')
})

test('read-only ranges: setReadOnlyRanges called from another extension outlives that extension', () => {
  const ed = fakeEditor('one\ntwo')
  // The fake has no extension scopes: what matters is that the protection is installed untracked.
  let untracked = 0
  const original = ed.untracked
  ;(ed as { untracked: Editor['untracked'] }).untracked = (fn) => (untracked++, original(fn))
  setReadOnlyRanges(ed, [lineRange(ed, 1, 1)])
  assert.equal(untracked, 1)
  ed.dispatch({ changes: { from: p(0, 1), insert: 'x' } })
  assert.equal(ed.getValue(), 'one\ntwo')
})
