/**
 * Undo that only touches the local user's changes, for backends that don't
 * keep a history of their own (Yjs does: its adapter uses it instead).
 *
 * Each step holds the replacements that undo it, in the text as it will be
 * when that step's turn comes (after the steps above it are undone). Someone
 * else's edit moves every step: it's carried down the stack through the
 * steps above, like a rebase. When it lands on text a step would restore,
 * undoing that step would destroy the other person's work, so that step and
 * the older ones are dropped instead.
 */
import type { ChangeEvent, Editor, UndoProvider } from '../editor.ts'
import { changeEnd, cmpPos, mapPos, type Change, type Pos } from '../state/text.ts'

interface Spec {
  from: Pos
  to: Pos
  insert: string
}

interface Step {
  specs: Spec[]
  origin: string
  time: number
}

/** Typing and deleting in a row become one step (like the editor's own history). */
const MERGEABLE = new Set(['input', 'delete.backward', 'delete.forward'])
const GROUP_DELAY = 600
const LIMIT = 300

const eq = (a: Pos, b: Pos) => cmpPos(a, b) === 0
const isEmpty = (c: Change) => c.inserted.length === 1 && !c.inserted[0]
const lines = (text: string) => text.split('\n')

/** What undoes `changes`: replacements in the text right after them (the changes of one transaction don't overlap). */
export function inverseOf(changes: readonly Change[]): Spec[] {
  return changes.map((c, k) => {
    let from = c.from
    let to = changeEnd(c)
    for (const later of changes.slice(k + 1)) {
      from = mapPos(from, later, isEmpty(c) ? -1 : 1)
      to = mapPos(to, later, -1)
    }
    return { from, to, insert: c.removed.join('\n') }
  })
}

/** Whether `c` touches what `s` would restore. */
function conflicts(s: Spec, c: Change): boolean {
  if (eq(s.from, s.to)) return cmpPos(c.from, s.from) < 0 && cmpPos(c.to, s.from) > 0
  return (cmpPos(c.from, s.to) < 0 && cmpPos(c.to, s.from) > 0) || (cmpPos(c.from, s.from) > 0 && cmpPos(c.from, s.to) < 0)
}

function mapSpec(s: Spec, c: Change): Spec {
  const point = eq(s.from, s.to)
  return { from: mapPos(s.from, c, point ? -1 : 1), to: mapPos(s.to, c, -1), insert: s.insert }
}

/** `c` as it would be after the specs are applied (the frame of the next step down). */
function through(c: Change, specs: readonly Spec[]): Change {
  let from = c.from
  let to = c.to
  for (const s of [...specs].sort((a, b) => cmpPos(b.from, a.from))) {
    const change: Change = { from: s.from, to: s.to, inserted: lines(s.insert), removed: [] }
    from = mapPos(from, change, 1)
    to = mapPos(to, change, -1)
  }
  return { from, to: cmpPos(to, from) < 0 ? from : to, inserted: c.inserted, removed: c.removed }
}

export class OwnHistory implements UndoProvider {
  private done: Step[] = []
  private undone: Step[] = []
  private editor: Editor

  constructor(editor: Editor) {
    this.editor = editor
  }

  /** Follows a change of the editor: someone else's moves the steps, the local user's are recorded. */
  track(event: ChangeEvent, remote: boolean): void {
    const { changes, origin } = event
    if (remote) {
      for (const c of changes) {
        this.rebase(this.done, c)
        this.rebase(this.undone, c)
      }
      return
    }
    const step: Step = { specs: inverseOf(changes), origin, time: Date.now() }
    if (origin === 'undo') return void this.undone.push(step)
    if (origin === 'redo') return void this.done.push(step)
    this.undone.length = 0
    if (!this.merge(step, changes)) {
      this.done.push(step)
      if (this.done.length > LIMIT) this.done.shift()
    }
  }

  /** Carries someone else's change down a stack, top first. */
  private rebase(stack: Step[], change: Change): void {
    let c = change
    for (let i = stack.length - 1; i >= 0; i--) {
      const step = stack[i]!
      if (step.specs.some((s) => conflicts(s, c))) {
        stack.splice(0, i + 1)
        return
      }
      const before = step.specs
      step.specs = before.map((s) => mapSpec(s, c))
      c = through(c, before)
    }
  }

  /** Typing right after the last step, or deleting right before it, extends it. */
  private merge(step: Step, changes: readonly Change[]): boolean {
    const last = this.done[this.done.length - 1]
    if (!last || last.origin !== step.origin || !MERGEABLE.has(step.origin) || step.time - last.time > GROUP_DELAY) return false
    if (changes.length !== 1 || last.specs.length !== 1) return false
    const c = changes[0]!
    const prev = last.specs[0]!
    if (isEmpty(c)) {
      // Deleting: the text to put back grows (backspace before it, delete after it).
      if (!eq(prev.from, prev.to)) return false
      if (eq(c.to, prev.from)) prev.insert = c.removed.join('\n') + prev.insert
      else if (eq(c.from, prev.from)) prev.insert += c.removed.join('\n')
      else return false
      prev.from = prev.to = c.from
    } else {
      // Typing: the range to remove grows when the new text comes right after it.
      if (!eq(c.from, c.to) || prev.insert || !eq(c.from, prev.to)) return false
      prev.to = changeEnd(c)
    }
    last.time = step.time
    return true
  }

  private apply(from: Step[], origin: 'undo' | 'redo'): boolean {
    const step = from.pop()
    if (!step) return false
    const specs = [...step.specs].sort((a, b) => cmpPos(b.from, a.from))
    // The first spec in the document is applied last, so nothing moves it: the cursor goes after it.
    const first = specs[specs.length - 1]!
    const ins = lines(first.insert)
    const end = ins.length > 1 ? { line: first.from.line + ins.length - 1, col: ins[ins.length - 1]!.length } : { line: first.from.line, col: first.from.col + first.insert.length }
    this.editor.dispatch({ changes: specs, selection: { anchor: end, head: end }, origin, scrollIntoView: true })
    return true
  }

  undo(): boolean {
    return this.apply(this.done, 'undo')
  }

  redo(): boolean {
    return this.apply(this.undone, 'redo')
  }

  canUndo(): boolean {
    return this.done.length > 0
  }

  canRedo(): boolean {
    return this.undone.length > 0
  }
}
