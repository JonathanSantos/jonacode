/**
 * Soft wrapping, computed in JS (not by the browser) so row positions are
 * deterministic: the editor knows where every visual row starts without
 * measuring, which keeps virtualization and cursor math exact.
 */
import { spliceArray } from '../state/text.ts'

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

/**
 * Char widths in columns (the advance of `x`), measured by the editor for
 * fonts where columns aren't all equal (proportional fonts, a synthesized
 * bold that is wider) and for wide chars (CJK, emoji), whose fallback fonts
 * may be wider than two columns.
 */
export interface Advances {
  /** Columns of each ASCII char (by code), or null when they are all 1 (monospace). */
  ascii: Float64Array | null
  /** Columns of a wide char (CJK, emoji): at least 2. */
  wide: number
  /** The widest char, in columns. */
  max: number
}

/** Columns taken by the code unit at `i` (0 for the low half of a surrogate pair). */
function charCols(text: string, i: number, adv?: Advances | null): number {
  const c = text.charCodeAt(i)
  if (c < 128 && adv?.ascii) return adv.ascii[c]!
  if (c < 0x300) return 1
  if (c >= 0xdc00 && c <= 0xdfff) return 0 // second half of an emoji / astral char
  if (c >= 0xd800 && c <= 0xdbff) return adv ? adv.wide : 2 // emoji and other astral chars
  if ((c >= 0x300 && c <= 0x36f) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) return 0 // combining, ZWJ, variation
  return WIDE.test(text[i]!) ? (adv ? adv.wide : 2) : 1
}

/** Columns from `width` to the next tab stop (stops every `tabSize` spaces; one closer than half a space is skipped, like CSS). */
function tabCols(width: number, tabSize: number, adv?: Advances | null): number {
  const space = adv?.ascii ? adv.ascii[32]! : 1
  const stop = tabSize * space
  const w = stop - (width % stop)
  return w < space / 2 ? w + stop : w
}

/** Width of `text.slice(0, end)` in columns (tabs to their stops, wide chars, measured advances). */
export function textWidth(text: string, tabSize: number, adv?: Advances | null, end = text.length): number {
  let w = 0
  for (let i = 0; i < end && i < text.length; i++) w += text.charCodeAt(i) === 9 ? tabCols(w, tabSize, adv) : charCols(text, i, adv)
  return w
}

/** The column closest to `target` columns from the start of `text` (never inside a surrogate pair). */
export function columnAtWidth(text: string, target: number, tabSize: number, adv?: Advances | null): number {
  let w = 0
  for (let i = 0; i < text.length; i++) {
    const next = w + (text.charCodeAt(i) === 9 ? tabCols(w, tabSize, adv) : charCols(text, i, adv))
    if (next === w) continue
    if (target < (w + next) / 2) return i
    w = next
  }
  return text.length
}

/**
 * Offsets where each wrapped row after the first starts, or null when the
 * line fits in `cols` columns. Breaks after whitespace when possible, and
 * mid-word otherwise. Tab stops are relative to the start of each row.
 */
export function wrapLine(text: string, cols: number, tabSize: number, adv?: Advances | null): number[] | null {
  const len = text.length
  // Fast path: even if every char were as wide as the widest it would fit.
  if (len * Math.max(adv ? adv.max : 2, text.indexOf('\t') < 0 ? 0 : tabSize * (adv?.ascii ? adv.ascii[32]! : 1) + 1) <= cols) return null
  const breaks: number[] = []
  let rowStart = 0
  let width = 0
  let lastSpaceEnd = -1 // offset right after the last whitespace in this row
  for (let i = 0; i < len; i++) {
    const ch = text.charCodeAt(i)
    const w = ch === 9 ? tabCols(width, tabSize, adv) : charCols(text, i, adv)
    if (width + w > cols && i > rowStart && w > 0) {
      const at = lastSpaceEnd > rowStart && lastSpaceEnd <= i ? lastSpaceEnd : i
      breaks.push(at)
      rowStart = at
      lastSpaceEnd = -1
      // Re-measure the chars carried over to the new row.
      width = 0
      for (let j = at; j < i; j++) width += text.charCodeAt(j) === 9 ? tabCols(width, tabSize, adv) : charCols(text, j, adv)
      i--
      continue
    }
    width += w
    if (ch === 32 || ch === 9) lastSpaceEnd = i + 1
  }
  return breaks.length ? breaks : null
}

/** Index of the row containing `col` (a position at a break belongs to the next row). */
export function rowOfColumn(breaks: readonly number[] | null, col: number): number {
  if (!breaks) return 0
  let lo = 0
  let hi = breaks.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (breaks[mid]! <= col) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Heights of the lines (the editor uses px: wrapped rows, gaps) with lazily
 * updated prefix sums, so that "top of line N" and "line at y" are O(1) /
 * O(log n) even for huge documents.
 */
export class HeightMap {
  private rows: number[] = []
  private prefix = new Float64Array(1)
  /** `prefix[0..valid]` are correct. */
  private valid = 0

  reset(rows: number[]): void {
    this.rows = rows
    this.prefix = new Float64Array(rows.length + 1)
    this.valid = 0
  }

  get lineCount(): number {
    return this.rows.length
  }

  rowsOf(line: number): number {
    return this.rows[line] ?? 1
  }

  set(line: number, rows: number): void {
    if (this.rows[line] !== rows) {
      this.rows[line] = rows
      if (line < this.valid) this.valid = line
    }
  }

  splice(start: number, removed: number, inserted: number[]): void {
    this.rows = spliceArray(this.rows, start, removed, inserted)
    if (start < this.valid) this.valid = start
  }

  private ensure(line: number): void {
    const n = this.rows.length
    if (this.prefix.length !== n + 1) {
      const next = new Float64Array(n + 1)
      const keep = Math.min(this.valid, n) + 1
      next.set(this.prefix.subarray(0, Math.min(keep, this.prefix.length)))
      this.prefix = next
      this.valid = Math.min(this.valid, n)
    }
    const prefix = this.prefix
    const rows = this.rows
    for (let i = this.valid; i < line; i++) prefix[i + 1] = prefix[i]! + rows[i]!
    if (line > this.valid) this.valid = line
  }

  /** Sum of the heights above `line`. */
  before(line: number): number {
    this.ensure(line)
    return this.prefix[line]!
  }

  get total(): number {
    return this.before(this.rows.length)
  }

  /** The line containing `row` (a position in the same unit as the heights, clamped). */
  lineAtRow(row: number): number {
    const n = this.rows.length
    this.ensure(n)
    const prefix = this.prefix
    if (row <= 0) return 0
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (prefix[mid]! <= row) lo = mid
      else hi = mid - 1
    }
    return lo
  }
}
