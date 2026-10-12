import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffChars, diffLines, diffToChanges, type DiffChunk } from '../src/state/diff.ts'
import { TextDocument, type ChangeSpec } from '../src/state/text.ts'
import { fakeEditor } from './fake-editor.ts'

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Applies chunks to `a`, checking that they are sorted, maximal, non-empty and that the parts between them are equal. */
function applyChunks<T>(a: ArrayLike<T>, b: ArrayLike<T>, chunks: readonly DiffChunk[]): T[] {
  const out: T[] = []
  let pa = 0
  let pb = 0
  for (const c of chunks) {
    assert.ok(c.fromA <= c.toA && c.fromB <= c.toB, 'ordered bounds')
    assert.ok(c.toA > c.fromA || c.toB > c.fromB, 'non-empty chunk')
    assert.ok(c.fromA >= pa && c.fromB >= pb, 'sorted, non-overlapping')
    if (out.length || pa || pb) assert.ok(c.fromA > pa, 'maximal: chunks are separated by equal items')
    assert.equal(c.fromA - pa, c.fromB - pb, 'equal parts have the same length')
    for (let i = pa; i < c.fromA; i++) {
      assert.equal(a[i], b[pb + i - pa])
      out.push(a[i]!)
    }
    for (let i = c.fromB; i < c.toB; i++) out.push(b[i]!)
    pa = c.toA
    pb = c.toB
  }
  assert.equal(a.length - pa, b.length - pb)
  for (let i = pa; i < a.length; i++) out.push(a[i]!)
  return out
}

/** Applies ChangeSpecs one after the other, like one `dispatch`. */
function applySpecs(lines: readonly string[], specs: readonly ChangeSpec[]): string[] {
  const doc = new TextDocument(lines.join('\n'))
  for (const s of specs) doc.replace(doc.clamp(s.from), doc.clamp(s.to ?? s.from), s.insert ?? '')
  return doc.lines.slice()
}

/** Random edits of `a`: replace, insert and delete lines, sometimes a fully random `b`. */
function mutate<T>(rnd: () => number, a: readonly T[], item: () => T): T[] {
  if (rnd() < 0.1) return Array.from({ length: Math.floor(rnd() * 10) }, item)
  const b = a.slice()
  for (let k = Math.floor(rnd() * 5); k >= 0; k--) {
    const p = Math.floor(rnd() * (b.length + 1))
    const r = rnd()
    if (r < 0.35) b.splice(p, 0, ...Array.from({ length: 1 + Math.floor(rnd() * 3) }, item))
    else if (r < 0.7) b.splice(p, 1 + Math.floor(rnd() * 2))
    else if (p < b.length) b[p] = item()
  }
  return b
}

test('diffLines: identical inputs have no chunks', () => {
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']), [])
  assert.deepEqual(diffLines([], []), [])
})

test('diffLines: insertions, deletions and replacements', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'x', 'b', 'c']), [{ fromA: 1, toA: 1, fromB: 1, toB: 2 }])
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'c']), [{ fromA: 1, toA: 2, fromB: 1, toB: 1 }])
  assert.deepEqual(diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']), [
    { fromA: 1, toA: 2, fromB: 1, toB: 2 },
    { fromA: 4, toA: 4, fromB: 4, toB: 5 },
  ])
  assert.deepEqual(diffLines([], ['a']), [{ fromA: 0, toA: 0, fromB: 0, toB: 1 }])
})

test('diffLines: adjacent edits are merged into one chunk', () => {
  // Myers yields a deletion and an insertion here; they touch, so they form one chunk.
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'x', 'y', 'c']), [{ fromA: 1, toA: 2, fromB: 1, toB: 3 }])
})

test('diffLines: past maxCost the rest is one coarse chunk, still correct', () => {
  const a = Array.from({ length: 200 }, (_, i) => 'a' + i)
  const b = Array.from({ length: 200 }, (_, i) => (i % 3 ? 'a' + i : 'b' + i))
  const fine = diffLines(a, b)
  const coarse = diffLines(a, b, { maxCost: 50 })
  assert.equal(fine.length, 67)
  assert.ok(coarse.length < fine.length)
  assert.deepEqual(applyChunks(a, b, coarse), b)
})

test('diffChars: a changed word is one chunk; equal runs shorter than the edits are absorbed', () => {
  assert.deepEqual(diffChars('hello world', 'hello there'), [{ fromA: 6, toA: 11, fromB: 6, toB: 11 }])
  assert.deepEqual(diffChars('abcd', 'xbxd'), [{ fromA: 0, toA: 3, fromB: 0, toB: 3 }])
  // Long equal runs are kept.
  assert.deepEqual(diffChars('const a = 1, b = 2', 'const a = 5, b = 6'), [
    { fromA: 10, toA: 11, fromB: 10, toB: 11 },
    { fromA: 17, toA: 18, fromB: 17, toB: 18 },
  ])
})

test('diffChars: surrogate pairs are never split', () => {
  assert.deepEqual(diffChars('a😀b', 'a😁b'), [{ fromA: 1, toA: 3, fromB: 1, toB: 3 }])
  assert.deepEqual(diffChars('😀x', '😀y'), [{ fromA: 2, toA: 3, fromB: 2, toB: 3 }])
})

test('diffToChanges: refined to characters, in descending order', () => {
  const a = ['const x = 1', 'keep', 'let y = 2']
  const b = ['const x = 10', 'keep', 'let z = 2']
  const specs = diffToChanges(a, b)
  assert.deepEqual(specs, [
    { from: { line: 2, col: 4 }, to: { line: 2, col: 5 }, insert: 'z' },
    { from: { line: 0, col: 11 }, to: { line: 0, col: 11 }, insert: '0' },
  ])
  assert.deepEqual(applySpecs(a, specs), b)
})

test('diffToChanges: whole lines inserted or deleted, at the start, middle and end', () => {
  const cases: [string[], string[]][] = [
    [['a', 'b'], ['x', 'a', 'b']],
    [['a', 'b'], ['a', 'b', 'x', 'y']],
    [['a', 'b', 'c'], ['a', 'c']],
    [['a', 'b', 'c'], ['a']],
    [['a', 'b', 'c'], ['c']],
    [['a', 'b'], ['']],
    [[''], ['a', 'b', '']],
  ]
  for (const [a, b] of cases) assert.deepEqual(applySpecs(a, diffToChanges(a, b)), b, JSON.stringify([a, b]))
  // Pure line insertions keep the neighbouring lines untouched.
  assert.deepEqual(diffToChanges(['a', 'b'], ['a', 'x', 'b']), [{ from: { line: 1, col: 0 }, insert: ['x', ''] }])
})

test('property: chunks rebuild b, and diffToChanges in one dispatch yields b (then undo yields a)', () => {
  const rnd = prng(42)
  const alphabet = ['', '}', 'a', 'bb', 'return x', 'if (y) {', 'ccc', '  z']
  const item = () => alphabet[Math.floor(rnd() * alphabet.length)]!
  for (let n = 0; n < 1500; n++) {
    const a = Array.from({ length: 1 + Math.floor(rnd() * 15) }, item)
    const b = mutate(rnd, a, item)
    if (!b.length) b.push('')
    const maxCost = rnd() < 0.25 ? Math.floor(rnd() * 20) : undefined
    assert.deepEqual(applyChunks(a, b, diffLines(a, b, { maxCost })), b)
    const specs = diffToChanges(a, b)
    assert.deepEqual(applySpecs(a, specs), b)
    if (n % 5 === 0) {
      const ed = fakeEditor(a.join('\n'))
      ed.dispatch({ changes: specs })
      assert.equal(ed.getValue(), b.join('\n'))
      if (specs.length) {
        ed.undo()
        assert.equal(ed.getValue(), a.join('\n'))
      }
    }
  }
})

test('property: diffChars chunks rebuild b and keep surrogate pairs whole', () => {
  const rnd = prng(7)
  const chars = ['a', 'b', 'c', ' ', '\n', '😀', '😁', 'é']
  const item = () => chars[Math.floor(rnd() * chars.length)]!
  for (let n = 0; n < 2000; n++) {
    const a = Array.from({ length: Math.floor(rnd() * 20) }, item).join('')
    const b = mutate(rnd, [...a], item).join('')
    const maxCost = rnd() < 0.25 ? Math.floor(rnd() * 20) : undefined
    const chunks = diffChars(a, b, { maxCost })
    assert.equal(applyChunks(a, b, chunks).join(''), b)
    const low = (s: string, i: number) => (s.charCodeAt(i) & 0xfc00) === 0xdc00
    for (const c of chunks) assert.ok(!low(a, c.fromA) && !low(a, c.toA) && !low(b, c.fromB) && !low(b, c.toB), JSON.stringify([a, b, c]))
  }
})

test('performance: bounded worst case and fast scattered edits', (t) => {
  const rnd = prng(3)
  const line = () => `  const v${Math.floor(rnd() * 1e9)} = compute(${Math.floor(rnd() * 1e6)})`
  const time = (f: () => unknown) => {
    const start = performance.now()
    f()
    return performance.now() - start
  }
  // Two totally different 20k-line inputs: capped by maxCost.
  const a = Array.from({ length: 20000 }, line)
  const b = Array.from({ length: 20000 }, line)
  let chunks: DiffChunk[] = []
  const different = time(() => (chunks = diffLines(a, b)))
  assert.deepEqual(chunks, [{ fromA: 0, toA: 20000, fromB: 0, toB: 20000 }])
  // A 100k-line file (with blank lines and braces, as in code) with ~100 scattered one-line edits.
  const big = Array.from({ length: 100000 }, (_, i) => (i % 7 === 0 ? '' : i % 11 === 0 ? '}' : line()))
  const edited = big.slice()
  for (let k = 0; k < 100; k++) {
    const p = Math.floor(rnd() * edited.length)
    const r = rnd()
    if (r < 0.4) edited[p] = line()
    else if (r < 0.7) edited.splice(p, 0, line())
    else edited.splice(p, 1)
  }
  const scattered = time(() => (chunks = diffLines(big, edited)))
  assert.deepEqual(applyChunks(big, edited, chunks), edited)
  const changes = time(() => diffToChanges(big, edited))
  t.diagnostic(`20k different lines: ${different.toFixed(1)} ms; 100k lines, 100 edits: ${scattered.toFixed(1)} ms (diffToChanges ${changes.toFixed(1)} ms)`)
  // Targets are 150 ms and 50 ms (see the diagnostic above). The asserts only catch algorithmic
  // blowups (seconds), with a 10× margin: tests run in parallel and machines are noisy.
  assert.ok(different < 1500, `20k different lines took ${different} ms`)
  assert.ok(scattered < 500, `100k scattered took ${scattered} ms`)
})
