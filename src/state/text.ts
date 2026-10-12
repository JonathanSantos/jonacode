/** A zero-based position in the document. `col` counts UTF-16 code units. */
export interface Pos {
  line: number
  col: number
}

/** Describes an edit: replace `from..to` with `insert`. `to` defaults to `from`. */
export interface ChangeSpec {
  from: Pos
  to?: Pos
  insert?: string | readonly string[]
}

/** An applied change, with enough information to invert it. */
export interface Change {
  /** Start of the replaced range. */
  from: Pos
  /** End of the replaced range, in the document *before* the change. */
  to: Pos
  /** Inserted text split in lines. */
  inserted: readonly string[]
  /** Removed text split in lines. */
  removed: readonly string[]
}

export const cmpPos = (a: Pos, b: Pos): number => a.line - b.line || a.col - b.col
export const eqPos = (a: Pos, b: Pos): boolean => a.line === b.line && a.col === b.col
export const minPos = (a: Pos, b: Pos): Pos => (cmpPos(a, b) <= 0 ? a : b)
export const maxPos = (a: Pos, b: Pos): Pos => (cmpPos(a, b) >= 0 ? a : b)

export function splitLines(text: string): string[] {
  return text.split(/\r\n?|\n/)
}

/** End position of the inserted text of a change, in the document *after* the change. */
export function changeEnd(change: Change): Pos {
  const ins = change.inserted
  const last = ins[ins.length - 1]!.length
  return ins.length === 1
    ? { line: change.from.line, col: change.from.col + last }
    : { line: change.from.line + ins.length - 1, col: last }
}

/**
 * Maps a position through a change. `assoc` decides on which side a position
 * that sits exactly at an insertion point ends up (-1 before, 1 after).
 */
export function mapPos(pos: Pos, change: Change, assoc: -1 | 1 = 1): Pos {
  const { from, to } = change
  const c = cmpPos(pos, from)
  if (c < 0 || (c === 0 && assoc < 0 && eqPos(from, to))) return pos
  if (cmpPos(pos, to) < 0) return assoc < 0 ? from : changeEnd(change)
  const end = changeEnd(change)
  if (pos.line === to.line) return { line: end.line, col: end.col + (pos.col - to.col) }
  return { line: pos.line + (end.line - to.line), col: pos.col }
}

/** Replaces `count` items at `start` without hitting argument-count limits. */
export function spliceArray<T>(arr: T[], start: number, count: number, items: readonly T[]): T[] {
  // At the end (appending to logs, streams): no copy of the whole array.
  if (start + count === arr.length) {
    arr.length = start
    for (let i = 0; i < items.length; i++) arr.push(items[i]!)
    return arr
  }
  if (items.length < 5000 && count < 5000) {
    arr.splice(start, count, ...items)
    return arr
  }
  return arr.slice(0, start).concat(items as T[], arr.slice(start + count))
}

/** The text model: a plain array of lines, which is fast and simple to virtualize. */
export class TextDocument {
  private _lines: string[]
  /** Line separator used by {@link TextDocument.toString}. Detected from the input. */
  eol = '\n'

  constructor(text = '') {
    this._lines = this.parse(text)
  }

  private parse(text: string): string[] {
    const m = /\r\n?|\n/.exec(text)
    this.eol = m ? m[0] : '\n'
    return splitLines(text)
  }

  get lines(): readonly string[] {
    return this._lines
  }

  get lineCount(): number {
    return this._lines.length
  }

  get end(): Pos {
    const last = this._lines.length - 1
    return { line: last, col: this._lines[last]!.length }
  }

  line(n: number): string {
    return this._lines[n] ?? ''
  }

  toString(): string {
    return this._lines.join(this.eol)
  }

  /** Replaces the whole content. Returns the previous lines. */
  setText(text: string): string[] {
    const old = this._lines
    this._lines = this.parse(text)
    return old
  }

  clamp(pos: Pos): Pos {
    const line = Math.max(0, Math.min(this._lines.length - 1, pos.line | 0))
    const col = Math.max(0, Math.min(this._lines[line]!.length, pos.col | 0))
    return line === pos.line && col === pos.col ? pos : { line, col }
  }

  sliceLines(from: Pos, to: Pos): string[] {
    const lines = this._lines
    if (from.line === to.line) return [lines[from.line]!.slice(from.col, to.col)]
    const out = [lines[from.line]!.slice(from.col)]
    for (let i = from.line + 1; i < to.line; i++) out.push(lines[i]!)
    out.push(lines[to.line]!.slice(0, to.col))
    return out
  }

  slice(from: Pos, to: Pos): string {
    return this.sliceLines(from, to).join(this.eol)
  }

  /** Applies a replacement. Positions must be valid and ordered (see {@link clamp}). */
  replace(from: Pos, to: Pos, insert: string | readonly string[]): Change {
    const inserted = typeof insert === 'string' ? splitLines(insert) : insert.length ? insert : ['']
    const lines = this._lines
    const removed = this.sliceLines(from, to)
    const before = lines[from.line]!.slice(0, from.col)
    const after = lines[to.line]!.slice(to.col)
    if (inserted.length === 1 && from.line === to.line) {
      lines[from.line] = before + inserted[0] + after
    } else {
      const out = inserted.slice()
      out[0] = before + out[0]
      out[out.length - 1] += after
      this._lines = spliceArray(lines, from.line, to.line - from.line + 1, out)
    }
    return { from, to, inserted, removed }
  }
}
