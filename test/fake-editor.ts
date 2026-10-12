/**
 * A DOM-less stand-in for `Editor` in unit tests: a real `TextDocument`,
 * highlighter and selection, with the transaction semantics of the editor
 * (changes applied in order, change filters, one undo step per transaction,
 * `change` events). Rendering calls are no-ops.
 */
import type { ChangeEvent, ChangeFilter, Editor, Transaction } from '../src/editor.ts'
import { Highlighter } from '../src/language/highlighter.ts'
import { plainText, type Language } from '../src/language/language.ts'
import { invertChanges } from '../src/state/history.ts'
import {
  cursor, mapSelection, normalizeSelection, toEditorSelection, type EditorSelection, type Selection,
} from '../src/state/selection.ts'
import { cmpPos, TextDocument, type Change, type ChangeSpec, type Pos } from '../src/state/text.ts'

export interface FakeEditor extends Editor {
  /** Origins of the transactions dispatched so far. */
  readonly origins: string[]
}

export function fakeEditor(text = '', options: { language?: Language; readOnly?: boolean; tabSize?: number } = {}): FakeEditor {
  const doc = new TextDocument(text)
  const language = options.language ?? plainText
  const hl = new Highlighter(language, doc)
  let sel: EditorSelection = { ranges: [cursor({ line: 0, col: 0 })], main: 0 }
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const filters: ChangeFilter[] = []
  const done: { changes: Change[]; before: EditorSelection; after: EditorSelection }[] = []
  const undone: typeof done = []
  const origins: string[] = []

  const emit = (type: string, ...args: unknown[]) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(...args)
  }
  const applySpec = (spec: ChangeSpec): Change | null => {
    let from = doc.clamp(spec.from)
    let to = spec.to ? doc.clamp(spec.to) : from
    if (cmpPos(from, to) > 0) [from, to] = [to, from]
    const insert = spec.insert ?? ''
    if (cmpPos(from, to) === 0 && !insert.length) return null
    const change = doc.replace(from, to, insert)
    hl.applyChange(change)
    return change
  }

  const ed = {
    doc,
    version: 0,
    origins,
    options: { tabSize: options.tabSize ?? 2, insertSpaces: true, readOnly: options.readOnly ?? false, lineWrapping: false, placeholder: '', minLines: 0, maxLines: 0 },
    get selection(): Selection {
      return sel.ranges[sel.main]!
    },
    get ranges() {
      return sel.ranges
    },
    get editorSelection() {
      return sel
    },
    language,
    languageAt: () => language,
    getTokens: (line: number) => hl.tokens(line),
    getValue: () => doc.toString(),
    get hasFocus() {
      return false
    },
    get visibleRange() {
      return { from: 0, to: Math.min(doc.lineCount - 1, 40) }
    },
    get indentUnit() {
      return ' '.repeat(ed.options.tabSize)
    },
    phrase: (s: string) => s,
    folds: [],
    isLineHidden: () => false,
    dispatch(tr: Transaction): void {
      const specs = tr.changes ? (Array.isArray(tr.changes) ? tr.changes : [tr.changes as ChangeSpec]) : []
      const before = sel
      const applied: Change[] = []
      for (const spec of specs) {
        const c = applySpec(spec)
        if (c) applied.push(c)
      }
      const origin = tr.origin ?? 'api'
      if (applied.length && !filters.every((f) => f(applied, origin, ed as unknown as Editor))) {
        for (const spec of invertChanges(applied)) applySpec(spec)
        return
      }
      const next = tr.selection ? toEditorSelection(tr.selection) : mapSelection(before, applied)
      sel = normalizeSelection({ ranges: next.ranges.map((r) => ({ anchor: doc.clamp(r.anchor), head: doc.clamp(r.head) })), main: next.main })
      if (!applied.length) return
      ed.version++
      origins.push(origin)
      if (tr.history === false) {
        done.length = 0
        undone.length = 0
      } else if (origin !== 'undo' && origin !== 'redo' && !ed.undoProvider) {
        done.push({ changes: applied, before, after: sel })
        undone.length = 0
      }
      const event: ChangeEvent = { changes: applied, origin }
      emit('change', event, ed)
    },
    undoProvider: null as import('../src/editor.ts').UndoProvider | null,
    setUndoProvider(p: import('../src/editor.ts').UndoProvider | null) {
      ed.undoProvider = p
    },
    undo(): boolean {
      if (ed.undoProvider) return ed.undoProvider.undo()
      const entry = done.pop()
      if (!entry) return false
      const v = ed.version
      ed.dispatch({ changes: invertChanges(entry.changes), selection: entry.before, origin: 'undo' })
      if (ed.version === v) {
        done.push(entry)
        return false
      }
      undone.push(entry)
      return true
    },
    redo(): boolean {
      if (ed.undoProvider) return ed.undoProvider.redo()
      const entry = undone.pop()
      if (!entry) return false
      ed.dispatch({ changes: entry.changes.map((c) => ({ from: c.from, to: c.to, insert: c.inserted })), selection: entry.after, origin: 'redo' })
      done.push(entry)
      return true
    },
    get canUndo() {
      return done.length > 0
    },
    get canRedo() {
      return undone.length > 0
    },
    setValue(value: string): void {
      const end = doc.end
      ed.dispatch({ changes: { from: { line: 0, col: 0 }, to: end, insert: value }, history: false, origin: 'setValue' })
    },
    setSelection(anchor: Pos, head: Pos = anchor): void {
      ed.dispatch({ selection: { anchor, head }, origin: 'select' })
    },
    replaceSelection(text: string, origin = 'input'): void {
      const r = ed.selection
      const from = cmpPos(r.anchor, r.head) <= 0 ? r.anchor : r.head
      const to = cmpPos(r.anchor, r.head) <= 0 ? r.head : r.anchor
      ed.dispatch({ changes: { from, to, insert: text }, origin })
    },
    wordRange(p: Pos): [Pos, Pos] {
      const line = doc.line(p.line)
      let a = p.col
      let b = p.col
      while (a > 0 && /\w/.test(line[a - 1]!)) a--
      while (b < line.length && /\w/.test(line[b]!)) b++
      return [{ line: p.line, col: a }, { line: p.line, col: b }]
    },
    on(type: string, fn: (...args: unknown[]) => void) {
      let set = listeners.get(type)
      if (!set) listeners.set(type, (set = new Set()))
      set.add(fn)
      return () => set!.delete(fn)
    },
    addChangeFilter(f: ChangeFilter) {
      filters.push(f)
      return () => filters.splice(filters.indexOf(f), 1)
    },
    addKeymap: () => () => {},
    addLayer: () => () => {},
    addGutter: () => () => {},
    untracked: <T>(fn: () => T): T => fn(),
    setLineGaps() {},
    scrollIntoView() {},
    requestRender() {},
    flush() {},
    focus() {},
  }
  return ed as unknown as FakeEditor
}
