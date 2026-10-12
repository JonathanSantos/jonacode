import { cmpPos, eqPos, mapPos, type Change, type Pos } from './text.ts'

/** A selection range. `head` is where the cursor is, `anchor` is where it started. */
export interface Selection {
  anchor: Pos
  head: Pos
  /** Preferred x (px) for vertical movement. Set by the movement commands. */
  goalX?: number
}

/** All the ranges of the editor (one per cursor), sorted and non-overlapping. */
export interface EditorSelection {
  ranges: readonly Selection[]
  /** Index of the main range (the one the textarea / scrolling follow). */
  main: number
}

export type SelectionInput = Selection | Pos | EditorSelection

export const cursor = (pos: Pos): Selection => ({ anchor: pos, head: pos })
export const selFrom = (sel: Selection): Pos => (cmpPos(sel.anchor, sel.head) <= 0 ? sel.anchor : sel.head)
export const selTo = (sel: Selection): Pos => (cmpPos(sel.anchor, sel.head) <= 0 ? sel.head : sel.anchor)
export const isEmpty = (sel: Selection): boolean => eqPos(sel.anchor, sel.head)
export const eqSel = (a: Selection, b: Selection): boolean => eqPos(a.anchor, b.anchor) && eqPos(a.head, b.head)

export function eqSelections(a: EditorSelection, b: EditorSelection): boolean {
  if (a.main !== b.main || a.ranges.length !== b.ranges.length) return false
  for (let i = 0; i < a.ranges.length; i++) if (!eqSel(a.ranges[i]!, b.ranges[i]!)) return false
  return true
}

export function mapRange(range: Selection, changes: readonly Change[], assoc: -1 | 1 = 1): Selection {
  if (!changes.length) return range
  let { anchor, head } = range
  for (const c of changes) {
    anchor = mapPos(anchor, c, assoc)
    head = mapPos(head, c, assoc)
  }
  return { anchor, head }
}

export function mapSelection(sel: EditorSelection, changes: readonly Change[]): EditorSelection {
  if (!changes.length) return sel
  return { ranges: sel.ranges.map((r) => mapRange(r, changes)), main: sel.main }
}

export function toEditorSelection(input: SelectionInput): EditorSelection {
  if ('ranges' in input) return input
  if ('anchor' in input) return { ranges: [input], main: 0 }
  return { ranges: [cursor(input)], main: 0 }
}

/**
 * Sorts ranges and merges the ones that overlap (or cursors at the same
 * spot). The main index follows its range.
 */
export function normalizeSelection(sel: EditorSelection): EditorSelection {
  const { ranges } = sel
  if (ranges.length === 1) return sel
  if (!ranges.length) return { ranges: [cursor({ line: 0, col: 0 })], main: 0 }
  const mainRange = ranges[Math.min(sel.main, ranges.length - 1)]!
  const sorted = ranges.slice().sort((a, b) => cmpPos(selFrom(a), selFrom(b)))
  const out: Selection[] = []
  let main = 0
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last) {
      const c = cmpPos(selFrom(r), selTo(last))
      if (c < 0 || (c === 0 && (isEmpty(r) || isEmpty(last)))) {
        const from = selFrom(last)
        const to = cmpPos(selTo(r), selTo(last)) > 0 ? selTo(r) : selTo(last)
        const forward = cmpPos(last.anchor, last.head) <= 0
        out[out.length - 1] = forward ? { anchor: from, head: to } : { anchor: to, head: from }
        if (r === mainRange) main = out.length - 1
        continue
      }
    }
    if (r === mainRange) main = out.length
    out.push(r)
  }
  return { ranges: out, main }
}
