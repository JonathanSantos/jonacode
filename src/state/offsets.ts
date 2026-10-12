/**
 * Offsets of the document as one string (lines joined by `\n`, in UTF-16
 * units), kept in sync with the editor's changes without joining the text:
 * tree-sitter edits and collaboration adapters speak in offsets.
 */
import { changeEnd, spliceArray, type Change, type Pos } from './text.ts'

/** A change in offsets (and row/column points), as tree-sitter's `edit()` takes it. */
export interface OffsetEdit {
  startIndex: number
  oldEndIndex: number
  newEndIndex: number
  startPosition: { row: number; column: number }
  oldEndPosition: { row: number; column: number }
  newEndPosition: { row: number; column: number }
}

export class LineOffsets {
  private lens: number[]
  /** Offset of the start of each line; `starts[0..valid]` are correct. */
  private starts = new Float64Array(1)
  private valid = 0

  constructor(lines: readonly string[]) {
    this.lens = lines.map((l) => l.length)
  }

  private ensure(line: number): void {
    const n = this.lens.length
    if (this.starts.length < n + 1) {
      const next = new Float64Array(Math.max(n + 1, this.starts.length * 2))
      next.set(this.starts.subarray(0, this.valid + 1))
      this.starts = next
    }
    for (let i = this.valid; i < line; i++) this.starts[i + 1] = this.starts[i]! + this.lens[i]! + 1
    if (line > this.valid) this.valid = line
  }

  offset(pos: Pos): number {
    this.ensure(pos.line)
    return this.starts[pos.line]! + pos.col
  }

  /** The position of an offset (clamped to the document). */
  pos(offset: number): Pos {
    const last = this.lens.length - 1
    this.ensure(last)
    let lo = 0
    let hi = last
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.starts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo, col: Math.max(0, Math.min(this.lens[lo]!, offset - this.starts[lo]!)) }
  }

  /** Length of the whole text. */
  get length(): number {
    const last = this.lens.length - 1
    this.ensure(last)
    return this.starts[last]! + this.lens[last]!
  }

  /** Follows one change (in the order the editor applied them); returns it in offsets. */
  apply(change: Change): OffsetEdit {
    const { from, to, inserted, removed } = change
    const startIndex = this.offset(from)
    const size = (lines: readonly string[]) => lines.reduce((n, l) => n + l.length, 0) + lines.length - 1
    const end = changeEnd(change)
    const edit: OffsetEdit = {
      startIndex,
      oldEndIndex: startIndex + size(removed),
      newEndIndex: startIndex + size(inserted),
      startPosition: { row: from.line, column: from.col },
      oldEndPosition: { row: to.line, column: to.col },
      newEndPosition: { row: end.line, column: end.col },
    }
    const after = (this.lens[to.line] ?? 0) - to.col
    const lens = inserted.map((l) => l.length)
    lens[0] += from.col
    lens[lens.length - 1] += after
    this.lens = spliceArray(this.lens, from.line, to.line - from.line + 1, lens)
    if (from.line < this.valid) this.valid = from.line
    return edit
  }
}
