import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChangeEvent } from '../src/editor.ts'
import {
  chunkDetail, chunkIndexAt, editedLines, lineHTML, revertChanges, updateChunks, type LineEdit,
} from '../src/extensions/diff-view.ts'
import { diffLines, type DiffChunk } from '../src/state/diff.ts'
import { TextDocument, splitLines, type ChangeSpec } from '../src/state/text.ts'
import { fakeEditor } from './fake-editor.ts'

/** Checks that `chunks` describe `a` → `b`: sorted, non-empty, separated, and the lines between them equal. */
function assertValid(a: readonly string[], b: readonly string[], chunks: readonly DiffChunk[]): void {
  let ia = 0
  let ib = 0
  for (const [i, c] of chunks.entries()) {
    assert.ok(c.toA > c.fromA || c.toB > c.fromB, `chunk ${i} is empty`)
    assert.ok(c.fromA >= ia && c.fromB >= ib, `chunk ${i} is out of order`)
    if (i) assert.ok(c.fromA > ia || c.fromB > ib, `chunk ${i} touches the previous one`)
    assert.equal(c.fromA - ia, c.fromB - ib, `unequal stretch before chunk ${i}`)
    for (let k = 0; k < c.fromA - ia; k++) assert.equal(a[ia + k], b[ib + k], `line ${ia + k} / ${ib + k} differs`)
    ia = c.toA
    ib = c.toB
  }
  assert.equal(a.length - ia, b.length - ib, 'unequal stretch at the end')
  for (let k = 0; k < a.length - ia; k++) assert.equal(a[ia + k], b[ib + k])
}

/** Replays a random edit session on B, updating the chunks incrementally after each transaction. */
function session(seed: number, steps: number, maxCost?: number): void {
  let r = seed
  const rnd = (n: number) => ((r = (r * 1103515245 + 12345) & 0x7fffffff), r % n)
  const words = ['foo', 'bar', 'x = 1', '', '}', 'return y', '  if (a) {', 'baz()']
  const original = Array.from({ length: 30 }, () => words[rnd(words.length)]!)
  const a = original.slice()
  const ed = fakeEditor(original.join('\n'))
  let chunks: DiffChunk[] = []
  ed.on('change', (e: ChangeEvent) => {
    const edit = editedLines(e.changes)
    if (edit) chunks = updateChunks(chunks, a, ed.doc.lines, edit, 'b', maxCost).chunks
  })
  for (let s = 0; s < steps; s++) {
    const n = ed.doc.lineCount
    const specs: ChangeSpec[] = []
    // One to three changes per transaction, each in the coordinates left by the previous.
    const count = 1 + rnd(3)
    for (let k = 0; k < count; k++) {
      const line = rnd(n + k * 2)
      const to = line + rnd(3)
      const kind = rnd(4)
      const insert = kind === 0 ? '' : kind === 1 ? words[rnd(words.length)]! : kind === 2 ? `${words[rnd(8)]}\n${words[rnd(8)]}` : '\n'
      specs.push({ from: { line, col: rnd(4) }, to: { line: to, col: rnd(6) }, insert })
    }
    ed.dispatch({ changes: specs })
    assertValid(a, ed.doc.lines, chunks)
  }
  // Undoing everything brings back the original. Region diffs stay valid but not always minimal
  // (the extension runs a full diff when idle for that).
  while (ed.undo()) assertValid(a, ed.doc.lines, chunks)
  assert.deepEqual(ed.doc.lines, original)
}

test('editedLines: one change', () => {
  const doc = new TextDocument('a\nb\nc\nd')
  const c = doc.replace({ line: 1, col: 0 }, { line: 2, col: 1 }, 'x\ny\nz')
  assert.deepEqual(editedLines([c]), { from: 1, to: 3, delta: 1 })
  assert.equal(editedLines([]), null)
})

test('editedLines: several changes, each in the coordinates of the previous', () => {
  const doc = new TextDocument('0\n1\n2\n3\n4\n5\n6\n7\n8\n9')
  const c1 = doc.replace({ line: 7, col: 0 }, { line: 7, col: 0 }, 'new\n') // line 7 → 2 lines
  const c2 = doc.replace({ line: 2, col: 0 }, { line: 4, col: 0 }, '') // lines 2..4 → 1 line
  const edit = editedLines([c1, c2])!
  assert.deepEqual(edit, { from: 2, to: 8, delta: -1 })
  // Everything outside the span is untouched, and after it shifted by delta.
  const old = '0\n1\n2\n3\n4\n5\n6\n7\n8\n9'.split('\n')
  assert.deepEqual(doc.lines.slice(0, edit.from), old.slice(0, edit.from))
  assert.deepEqual(doc.lines.slice(edit.to + edit.delta), old.slice(edit.to))
})

test('updateChunks: typing in an unchanged line only diffs that line', () => {
  const a = ['one', 'two', 'three', 'four', 'five']
  const b0 = ['one', 'TWO', 'three', 'four', 'five']
  const chunks = diffLines(a, b0)
  assert.deepEqual(chunks, [{ fromA: 1, toA: 2, fromB: 1, toB: 2 }])
  const b1 = ['one', 'TWO', 'three', 'four', 'FIVE']
  const u = updateChunks(chunks, a, b1, { from: 4, to: 5, delta: 0 })
  assert.deepEqual(u.chunks, [{ fromA: 1, toA: 2, fromB: 1, toB: 2 }, { fromA: 4, toA: 5, fromB: 4, toB: 5 }])
  assert.equal(u.chunks[0], chunks[0], 'the chunk before is the same object')
  assert.deepEqual([u.to, u.oldTo], [2, 1])
})

test('updateChunks: inserting lines shifts the chunks after the edit', () => {
  const a = ['a', 'b', 'c', 'd', 'e', 'f']
  const b0 = ['a', 'b', 'c', 'd', 'E', 'f']
  const chunks = diffLines(a, b0)
  const b1 = ['new', 'new2', 'a', 'b', 'c', 'd', 'E', 'f']
  const u = updateChunks(chunks, a, b1, { from: 0, to: 1, delta: 2 })
  assert.deepEqual(u.chunks, [{ fromA: 0, toA: 0, fromB: 0, toB: 2 }, { fromA: 4, toA: 5, fromB: 6, toB: 7 }])
  assert.deepEqual([u.to, u.oldTo], [1, 0])
})

test('updateChunks: an edit that restores the original removes the chunk', () => {
  const a = ['a', 'b', 'c']
  const chunks = diffLines(a, ['a', 'B', 'c'])
  const u = updateChunks(chunks, a, ['a', 'b', 'c'], { from: 1, to: 2, delta: 0 })
  assert.deepEqual(u.chunks, [])
})

test('updateChunks: edits on side A', () => {
  const b = ['a', 'b', 'c', 'd']
  const chunks = diffLines(['a', 'b', 'c', 'd'], b)
  const a1 = ['a', 'b', 'x', 'y', 'c', 'd']
  const u = updateChunks(chunks, a1, b, { from: 2, to: 3, delta: 2 }, 'a')
  assert.deepEqual(u.chunks, [{ fromA: 2, toA: 4, fromB: 2, toB: 2 }])
})

test('updateChunks: past the work limit, a region is one coarse chunk', () => {
  const a = Array.from({ length: 100 }, (_, i) => 'line ' + i)
  const b = a.map((l, i) => (i >= 10 && i < 60 && i % 2 ? l + '!' : l))
  assert.equal(updateChunks([], a, b, { from: 0, to: 100, delta: 0 }).chunks.length, 25)
  const coarse = updateChunks([], a, b, { from: 0, to: 100, delta: 0 }, 'b', 10).chunks
  assert.ok(coarse.length < 5)
  assert.deepEqual(coarse.at(-1), { fromA: 15, toA: 60, fromB: 15, toB: 60 })
})

test('updateChunks: random sessions stay valid', () => {
  for (let seed = 1; seed <= 60; seed++) session(seed, 40)
})

test('updateChunks: random sessions with coarse chunks stay valid', () => {
  for (let seed = 100; seed <= 120; seed++) session(seed, 30, 3)
})

test('updateChunks: an edit and its undo leave no chunk', () => {
  const a = splitLines('a\nb\nc\nd\ne')
  const ed = fakeEditor(a.join('\n'))
  let chunks: DiffChunk[] = []
  ed.on('change', (e: ChangeEvent) => {
    chunks = updateChunks(chunks, a, ed.doc.lines, editedLines(e.changes)!).chunks
  })
  ed.dispatch({ changes: [{ from: { line: 1, col: 0 }, to: { line: 3, col: 1 }, insert: 'x\ny' }, { from: { line: 0, col: 0 }, insert: 'top\n' }] })
  assert.deepEqual(chunks, diffLines(a, ed.doc.lines))
  ed.undo()
  assert.deepEqual(chunks, [])
})

test('incremental chunks equal a full diff for simple edits', () => {
  const a = splitLines('function f() {\n  return 1\n}\n\nconst x = f()\nconsole.log(x)')
  const ed = fakeEditor(a.join('\n'))
  let chunks: DiffChunk[] = []
  ed.on('change', (e: ChangeEvent) => {
    chunks = updateChunks(chunks, a, ed.doc.lines, editedLines(e.changes)!).chunks
  })
  ed.dispatch({ changes: { from: { line: 1, col: 9 }, to: { line: 1, col: 10 }, insert: '2' } })
  ed.dispatch({ changes: { from: { line: 5, col: 0 }, insert: '// done\n' } })
  ed.dispatch({ changes: { from: { line: 3, col: 0 }, to: { line: 4, col: 0 } } })
  assert.deepEqual(chunks, diffLines(a, ed.doc.lines))
})

test('revertChanges: rejecting chunks brings the original text back', () => {
  const original = 'a\nb\nc\nd\ne\nf\ng'
  const edited = 'a\nB\nc\ne\nnew\nf\ng\nend'
  const a = splitLines(original)
  const doc = new TextDocument(edited)
  const chunks = diffLines(a, doc.lines)
  assert.equal(chunks.length, 4)
  // One chunk: only its lines change.
  const one = new TextDocument(edited)
  for (const s of revertChanges([chunks[1]!], a, one.lines)) one.replace(s.from, s.to ?? s.from, s.insert ?? '')
  assert.equal(one.toString(), 'a\nB\nc\nd\ne\nnew\nf\ng\nend')
  // All of them, in one list (descending order).
  for (const s of revertChanges(chunks, a, doc.lines)) doc.replace(s.from, s.to ?? s.from, s.insert ?? '')
  assert.equal(doc.toString(), original)
})

test('revertChanges: chunks at the start and the end of the document', () => {
  for (const [original, edited] of [['x\ny', 'x'], ['x', 'x\ny'], ['x\ny', 'y'], ['y', 'x\ny'], ['', 'a\nb'], ['a\nb', '']]) {
    const a = splitLines(original!)
    const doc = new TextDocument(edited)
    for (const s of revertChanges(diffLines(a, doc.lines), a, doc.lines)) doc.replace(s.from, s.to ?? s.from, s.insert ?? '')
    assert.equal(doc.toString(), original, `${JSON.stringify(original)} ← ${JSON.stringify(edited)}`)
  }
})

test('chunkDetail: changed characters per line', () => {
  const d = chunkDetail(['const a = 1', 'let b = 2'], ['const a = 42', 'let b = 2', 'x()'])!
  assert.deepEqual(d.a, [[0, 10, 11]])
  // The inserted line break at the end of line 1 is empty there: only line 2 is marked.
  assert.deepEqual(d.b, [[0, 10, 12], [2, 0, 3]])
})

test('chunkDetail: line by line when both sides have as many lines', () => {
  const d = chunkDetail(['a = 1', 'rewritten entirely', 'c(x)'], ['a = 2', 'nothing in common!', 'c(x, y)'])!
  assert.deepEqual(d.a, [[0, 4, 5]])
  assert.deepEqual(d.b, [[0, 4, 5], [2, 3, 6]])
})

test('chunkDetail: nothing for one-sided chunks, huge chunks or rewritten lines', () => {
  assert.equal(chunkDetail([], ['a']), null)
  assert.equal(chunkDetail(['x'.repeat(100)], ['y'.repeat(100)], 150), null)
  assert.equal(chunkDetail(['alpha beta'], ['gamma delta']), null)
})

test('chunkIndexAt: first chunk that reaches a line', () => {
  const chunks: DiffChunk[] = [
    { fromA: 1, toA: 2, fromB: 1, toB: 3 },
    { fromA: 5, toA: 7, fromB: 6, toB: 6 }, // deleted lines above line 6
    { fromA: 9, toA: 9, fromB: 8, toB: 10 },
  ]
  assert.deepEqual([0, 1, 2, 3, 5, 6, 7, 8, 9, 10].map((l) => chunkIndexAt(chunks, l)), [0, 0, 0, 1, 1, 1, 2, 2, 2, 3])
  assert.deepEqual([0, 1, 2, 5, 6, 7, 9].map((l) => chunkIndexAt(chunks, l, 'a')), [0, 0, 1, 1, 1, 2, 2])
})

test('lineHTML: tokens and marks are combined', () => {
  const tokens = [{ from: 0, to: 5, type: 'keyword' }, { from: 5, to: 6, type: null }, { from: 6, to: 7, type: 'variable' }]
  const html = lineHTML('const a < 1', tokens as never, [[4, 7]], 'm')
  assert.equal(html, '<span class="jc-t-keyword">cons</span><span class="jc-t-keyword m">t</span><span class="m"> </span><span class="jc-t-variable m">a</span> &lt; 1')
})

test('editedLines + updateChunks over a large document stay cheap', () => {
  const a = Array.from({ length: 100000 }, (_, i) => `const v${i} = ${i}`)
  const b = a.slice()
  b[500] = 'changed'
  b.splice(70000, 0, 'inserted')
  let chunks = diffLines(a, b)
  const t0 = performance.now()
  for (let i = 0; i < 200; i++) {
    b[40000] = 'typing ' + i
    const edit: LineEdit = { from: 40000, to: 40001, delta: 0 }
    chunks = updateChunks(chunks, a, b, edit).chunks
  }
  const per = (performance.now() - t0) / 200
  assert.equal(chunks.length, 3)
  assert.ok(per < 2, `${per.toFixed(3)} ms per update`)
})
