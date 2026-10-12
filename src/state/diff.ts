/**
 * Diffs between two versions of a text: Myers' O(ND) algorithm with common
 * prefix/suffix trimming and a work limit (past it, the rest is reported as
 * one coarse chunk, so huge unrelated inputs stay fast), on lines or on
 * characters. `diffToChanges` turns two versions of a document into changes
 * that leave the unchanged text — and the cursors and decorations on it — alone.
 *
 * ```ts
 * editor.dispatch({ changes: diffToChanges(editor.doc.lines, splitLines(newText)) })
 * ```
 */
import type { ChangeSpec, Pos } from './text.ts'

/** A changed region: `a[fromA..toA)` became `b[fromB..toB)` (lines for diffLines, UTF-16 offsets for diffChars). */
export interface DiffChunk {
  fromA: number
  toA: number
  fromB: number
  toB: number
}

export interface DiffOptions {
  /** Work limit; past it the rest is reported as one coarse chunk. Default 1e6 (about 1400 inserted + deleted items). */
  maxCost?: number
}

/**
 * Myers' diff of two sequences compared with `===`. Chunks are sorted, maximal
 * and separated by at least one equal item. Memory and time grow with the
 * square of the number of differences, which `maxCost` caps.
 */
function myers(a: ArrayLike<unknown>, b: ArrayLike<unknown>, maxCost = 1e6): DiffChunk[] {
  let n = a.length
  let m = b.length
  let s = 0
  while (s < n && s < m && a[s] === b[s]) s++
  while (n > s && m > s && a[n - 1] === b[m - 1]) n--, m--
  const N = n - s
  const M = m - s
  const out: DiffChunk[] = []
  if (!N || !M) {
    if (N || M) out.push({ fromA: s, toA: n, fromB: s, toB: m })
    return out
  }
  // v[off + k]: furthest x reached on diagonal k (x - y = k). Row d of the trace keeps it for diagonals -d..d.
  const off = N + M + 1
  const v = new Int32Array(2 * off + 1)
  const trace: Int32Array[] = []
  let x = 0
  let y = 0
  for (let d = 0, cost = 0, best = -1; best < N + M && cost <= maxCost; d++, cost += d) {
    const row = new Int32Array(d + 1)
    best = -1
    for (let k = -d; k <= d; k += 2) {
      let px = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1
      let py = px - k
      while (px < N && py < M && a[s + px] === b[s + py]) px++, py++
      v[off + k] = row[(k + d) >> 1] = px
      if (px <= N && py <= M && px + py > best) (best = px + py), (x = px), (y = py)
    }
    trace.push(row)
  }
  // Out of budget: what is left after the furthest point reached is one chunk.
  if (x < N || y < M) out.push({ fromA: s + x, toA: n, fromB: s + y, toB: m })
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]!
    const at = (k: number) => prev[(k + d - 1) >> 1]!
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const pk = down ? k + 1 : k - 1
    const px = at(pk)
    const py = px - pk
    // One insertion (down) or deletion (right) from (px, py) to (ex, ey), then equal items up to (x, y).
    const ex = down ? px : px + 1
    const ey = ex - k
    const last = out[out.length - 1]
    if (last && last.fromA === s + ex && last.fromB === s + ey) (last.fromA = s + px), (last.fromB = s + py)
    else out.push({ fromA: s + px, toA: s + ex, fromB: s + py, toB: s + ey })
    x = px
    y = py
  }
  return out.reverse()
}

/** Line diff. Lines between the common prefix and suffix are interned to numbers, so comparisons are cheap. */
export function diffLines(a: readonly string[], b: readonly string[], options: DiffOptions = {}): DiffChunk[] {
  let s = 0
  let n = a.length
  let m = b.length
  while (s < n && s < m && a[s] === b[s]) s++
  while (n > s && m > s && a[n - 1] === b[m - 1]) n--, m--
  const ids = new Map<string, number>()
  const id = (line: string) => {
    let i = ids.get(line)
    if (i === undefined) ids.set(line, (i = ids.size))
    return i
  }
  const out = myers(a.slice(s, n).map(id), b.slice(s, m).map(id), options.maxCost)
  for (const c of out) (c.fromA += s), (c.toA += s), (c.fromB += s), (c.toB += s)
  return out
}

const size = (c: DiffChunk) => Math.max(c.toA - c.fromA, c.toB - c.fromB)
const isLow = (s: string, i: number) => (s.charCodeAt(i) & 0xfc00) === 0xdc00

/**
 * Character diff, for highlighting inside changed lines. Equal runs shorter
 * than the edits on both sides are absorbed (like diff-match-patch's semantic
 * cleanup), so a rewritten word is one chunk rather than scattered letters,
 * and surrogate pairs are never split.
 */
export function diffChars(a: string, b: string, options: DiffOptions = {}): DiffChunk[] {
  const out: DiffChunk[] = []
  for (let c of myers(a, b, options.maxCost)) {
    if (c.fromA && (isLow(a, c.fromA) || isLow(b, c.fromB))) c.fromA--, c.fromB--
    if (isLow(a, c.toA)) c.toA++, c.toB++
    let last: DiffChunk | undefined
    while ((last = out[out.length - 1]) && c.fromA - last.toA <= Math.min(size(last), size(c))) {
      out.pop()
      c = { fromA: last.fromA, toA: c.toA, fromB: last.fromB, toB: c.toB }
    }
    out.push(c)
  }
  return out
}

/**
 * ChangeSpecs that turn a document whose lines are `a` into `b`: line diff,
 * refined to characters inside changed lines. Returned in DESCENDING position
 * order so they can be dispatched in one transaction (each change leaves
 * earlier positions valid).
 */
export function diffToChanges(a: readonly string[], b: readonly string[], chunks: readonly DiffChunk[] = diffLines(a, b)): ChangeSpec[] {
  const out: ChangeSpec[] = []
  const bol = (line: number): Pos => ({ line, col: 0 })
  const eol = (line: number): Pos => ({ line, col: a[line]!.length })
  for (let i = chunks.length; i--; ) {
    const { fromA, toA, fromB, toB } = chunks[i]!
    const ins = b.slice(fromB, toB)
    if (fromA === toA) {
      out.push(fromA < a.length ? { from: bol(fromA), insert: [...ins, ''] } : { from: eol(fromA - 1), insert: ['', ...ins] })
    } else if (fromB === toB) {
      out.push(toA < a.length ? { from: bol(fromA), to: bol(toA) } : { from: fromA ? eol(fromA - 1) : bol(0), to: eol(toA - 1) })
    } else {
      const text = ins.join('\n')
      let line = fromA
      let start = 0
      // Offsets in the changed lines → positions; called with increasing offsets.
      const pos = (o: number): Pos => {
        while (o > start + a[line]!.length) start += a[line++]!.length + 1
        return { line, col: o - start }
      }
      const specs = diffChars(a.slice(fromA, toA).join('\n'), text).map((c) => ({ from: pos(c.fromA), to: pos(c.toA), insert: text.slice(c.fromB, c.toB) }))
      for (let j = specs.length; j--; ) out.push(specs[j]!)
    }
  }
  return out
}
