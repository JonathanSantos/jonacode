import { spliceArray, type Change, type TextDocument } from '../state/text.ts'
import type { Language, State, Token } from './language.ts'

/**
 * Keeps the tokenizer state at the start of every line and updates it
 * incrementally: after an edit only the lines after it are re-tokenized, and
 * only until the state "converges" back to what it was before the edit.
 * Work is lazy — states are only computed up to what the view needs.
 */
export class Highlighter {
  language: Language
  private doc: TextDocument
  /** `states[i]` is the state at the start of line `i`. */
  private states: (State | undefined)[] = []
  /** `states[0..valid]` are known to be correct. */
  private valid = 0
  /** `states[valid+1..computed]` are old values, candidates for convergence. */
  private computed = 0
  /** Last line whose content changed since `valid` (-1: none). */
  private dirtyTo = -1

  constructor(language: Language, doc: TextDocument) {
    this.language = language
    this.doc = doc
    this.reset()
  }

  reset(language?: Language): void {
    if (language) this.language = language
    this.states = new Array(this.doc.lineCount)
    this.states[0] = this.language.initialState
    this.valid = 0
    this.computed = 0
    this.dirtyTo = -1
  }

  /** Index of the last line whose start state is known to be correct. */
  get validUpTo(): number {
    return this.valid
  }

  /**
   * Makes sure the states are correct up to `line`. Returns false when the
   * deadline (from `performance.now()`) was hit before getting there.
   */
  ensure(line: number, deadline = Infinity): boolean {
    const lines = this.doc.lines
    const target = Math.min(line, lines.length - 1)
    const lang = this.language
    const states = this.states
    let i = this.valid
    let n = 0
    while (i < target) {
      if ((++n & 127) === 0 && performance.now() > deadline) {
        this.valid = i
        return false
      }
      const next = lang.endState(lines[i]!, states[i]!)
      const j = i + 1
      if (j > this.dirtyTo && j <= this.computed && states[j] === next) {
        // Converged: everything after this point is still correct.
        i = this.computed
        this.dirtyTo = -1
        continue
      }
      states[j] = next
      i = j
      if (i > this.computed) this.computed = i
    }
    if (i > this.valid) this.valid = i
    return true
  }

  /** The state at the start of `line`: exact if it was computed, a best guess otherwise. */
  stateAt(line: number): State {
    return this.states[line] ?? this.language.initialState
  }

  isValid(line: number): boolean {
    return line <= this.valid
  }

  tokens(line: number): Token[] {
    this.ensure(line)
    return this.language.tokenize(this.doc.line(line), this.stateAt(line)).tokens
  }

  /** Must be called after every document change. */
  applyChange(change: Change): void {
    const fromLine = change.from.line
    const oldTo = change.to.line
    const newTo = fromLine + change.inserted.length - 1
    const removed = oldTo - fromLine
    const added = newTo - fromLine
    if (removed || added) {
      this.states = spliceArray(this.states, fromLine + 1, removed, new Array<State | undefined>(added))
    }
    const delta = added - removed
    this.computed = this.computed > oldTo ? this.computed + delta : Math.min(this.computed, fromLine)
    if (this.dirtyTo > oldTo) this.dirtyTo += delta
    else if (this.dirtyTo > fromLine) this.dirtyTo = fromLine
    this.dirtyTo = Math.max(this.dirtyTo, newTo)
    if (this.valid > fromLine) this.valid = fromLine
  }
}
