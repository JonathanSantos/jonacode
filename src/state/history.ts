import type { EditorSelection } from './selection.ts'
import { changeEnd, eqPos, type Change, type ChangeSpec } from './text.ts'

export interface HistoryEntry {
  changes: Change[]
  before: EditorSelection
  after: EditorSelection
  origin: string
  time: number
}

/** Origins that are merged into a single undo step when typed in quick succession. */
const MERGEABLE = new Set(['input', 'delete.backward', 'delete.forward'])

/** Changes that undo `changes`, in the order they must be applied. */
export function invertChanges(changes: readonly Change[]): ChangeSpec[] {
  const out: ChangeSpec[] = []
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i]!
    out.push({ from: c.from, to: changeEnd(c), insert: c.removed })
  }
  return out
}

function sameCursors(a: EditorSelection, b: EditorSelection): boolean {
  if (a.ranges.length !== b.ranges.length) return false
  return a.ranges.every((r, i) => eqPos(r.head, b.ranges[i]!.head))
}

export class History {
  done: HistoryEntry[] = []
  undone: HistoryEntry[] = []
  /** Max number of undo steps kept. */
  limit = 500
  /** Typing within this interval (ms) is merged in the same undo step. */
  groupDelay = 600

  record(changes: Change[], before: EditorSelection, after: EditorSelection, origin: string, time = Date.now()): void {
    const last = this.done[this.done.length - 1]
    this.undone.length = 0
    if (last && MERGEABLE.has(origin) && last.origin === origin && time - last.time < this.groupDelay &&
        sameCursors(last.after, before)) {
      last.changes.push(...changes)
      last.after = after
      last.time = time
      return
    }
    this.done.push({ changes, before, after, origin, time })
    if (this.done.length > this.limit) this.done.shift()
  }

  /** Stops the current entry from absorbing further typing. */
  breakGroup(): void {
    const last = this.done[this.done.length - 1]
    if (last) last.time = 0
  }

  clear(): void {
    this.done.length = 0
    this.undone.length = 0
  }
}
