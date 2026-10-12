/**
 * Diagnostics (lint): wavy underlines, a gutter marker per line, the messages
 * in a hover tooltip (with quick-fix buttons), optional inline messages at the
 * end of the line, and F8 / Shift-F8 to jump between them. Jonacode doesn't
 * ship a linter: `setDiagnostics()` takes whatever yours produces, and
 * `linter(source)` runs it after each edit.
 *
 * ```ts
 * linter((editor) => {
 *   try { JSON.parse(editor.getValue()); return [] }
 *   catch (e) { return [{ from: posFromError(e), severity: 'error', message: e.message }] }
 * })
 * ```
 */
import { decorationsAt, getDecorations, setDecorations, type Decoration } from '../decorations.ts'
import type { Editor, Extension } from '../editor.ts'
import type { Command, KeyBinding } from '../keymap.ts'
import { cmpPos, type Pos } from '../state/text.ts'
import { injectStyle } from '../view/style.ts'
import { hoverTooltip, showTooltip } from './tooltip.ts'

export type Severity = 'error' | 'warning' | 'info' | 'hint'

export interface DiagnosticAction {
  name: string
  apply: (editor: Editor, diagnostic: Diagnostic) => void
}

export interface Diagnostic {
  from: Pos
  /** End of the range. Without it (or when equal to `from`), the word at `from` is marked. */
  to?: Pos
  severity: Severity
  message: string
  /** Who reported it (`eslint`, `json`…), shown dim after the message. */
  source?: string
  /** Quick fixes, shown as buttons in the tooltip. */
  actions?: readonly DiagnosticAction[]
}

export interface DiagnosticsOptions {
  /** Markers in a gutter. Default true. */
  gutter?: boolean
  /** Messages in a tooltip on hover. Default true. */
  hover?: boolean
  /** The first message of each line, dimmed, after its end ("error lens"). Default false. */
  inline?: boolean
}

const SET = 'diagnostics'
const LENS = 'diagnostics-lens'
/** Decoration sets in use per editor: one per source (`setDiagnostics(ed, list, 'syntax')`). */
const sources = new WeakMap<Editor, Set<string>>()
const keyOf = (source: string) => (source === 'default' ? SET : SET + ':' + source)
const keysOf = (editor: Editor) => sources.get(editor) ?? new Set([SET])
const RANK: Record<Severity, number> = { error: 4, warning: 3, info: 2, hint: 1 }
const ICON: Record<Severity, string> = { error: '●', warning: '▲', info: 'ℹ', hint: '·' }

const inlineOn = new WeakSet<Editor>()

/** Marks a word (or one char) when a diagnostic has no range. */
function widen(editor: Editor, d: Diagnostic): { from: Pos; to: Pos } {
  const doc = editor.doc
  const from = doc.clamp(d.from)
  const to = d.to ? doc.clamp(d.to) : from
  if (cmpPos(from, to) < 0) return { from, to }
  const [a, b] = editor.wordRange(from)
  if (cmpPos(a, b) < 0) return { from: a, to: b }
  const line = doc.line(from.line)
  if (from.col < line.length) return { from, to: { line: from.line, col: from.col + 1 } }
  return from.col > 0 ? { from: { line: from.line, col: from.col - 1 }, to: from } : { from, to: { line: from.line, col: 0 } }
}

/**
 * Replaces the diagnostics of an editor (of one `source`: a linter, the
 * syntax checker… each source replaces only its own). Positions then follow
 * the edits until the next call.
 */
export function setDiagnostics(editor: Editor, diagnostics: readonly Diagnostic[], source = 'default'): void {
  const decos: Decoration[] = []
  for (const d of diagnostics) {
    const { from, to } = widen(editor, d)
    decos.push({ from, to, class: `jc-diag jc-diag-${d.severity}`, data: d })
  }
  const key = keyOf(source)
  let keys = sources.get(editor)
  if (!keys) sources.set(editor, (keys = new Set([SET])))
  keys.add(key)
  setDecorations(editor, key, decos)
  if (inlineOn.has(editor)) drawLens(editor)
}

/** The first message of the worst diagnostic of each line, after its end (all sources). */
function drawLens(editor: Editor): void {
  const worst = new Map<number, Diagnostic>()
  for (const d of getDiagnostics(editor)) {
    const w = worst.get(d.from.line)
    if (!w || RANK[d.severity] > RANK[w.severity]) worst.set(d.from.line, d)
  }
  const decos: Decoration[] = []
  for (const [line, d] of worst) {
    decos.push({
      from: { line, col: editor.doc.line(line).length },
      class: `jc-diag-lens jc-diag-${d.severity}`,
      data: d,
      widget: (ed) => {
        const el = ed.dom.ownerDocument.createElement('span')
        el.textContent = d.message.split('\n')[0]!
        return el
      },
    })
  }
  setDecorations(editor, LENS, decos)
}

/** The current diagnostics (of every source, or one), with their positions mapped through the edits since they were set. */
export function getDiagnostics(editor: Editor, source?: string): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const key of source ? [keyOf(source)] : keysOf(editor)) {
    for (const d of getDecorations(editor, key)) out.push({ ...(d.data as Diagnostic), from: d.from, to: d.to })
  }
  return out
}

/** Worst severity per line, cached per version of the decoration list (it's replaced on every edit). */
const byLine = new WeakMap<readonly Decoration[], Map<number, Severity>>()
function severityAt(editor: Editor, line: number): Severity | null {
  let worst: Severity | null = null
  for (const key of keysOf(editor)) {
    const list = getDecorations(editor, key)
    let map = byLine.get(list)
    if (!map) {
      map = new Map()
      for (const d of list) {
        const s = (d.data as Diagnostic).severity
        const cur = map.get(d.from.line)
        if (!cur || RANK[s] > RANK[cur]) map.set(d.from.line, s)
      }
      byLine.set(list, map)
    }
    const s = map.get(line)
    if (s && (!worst || RANK[s] > RANK[worst])) worst = s
  }
  return worst
}

/** The tooltip body for some diagnostics. */
function describe(editor: Editor, list: Diagnostic[]): HTMLElement {
  const doc = editor.dom.ownerDocument
  const box = doc.createElement('div')
  box.className = 'jc-diag-list'
  for (const d of list) {
    const row = doc.createElement('div')
    row.className = `jc-diag-item jc-diag-${d.severity}`
    const icon = doc.createElement('span')
    icon.className = 'jc-diag-icon'
    icon.textContent = ICON[d.severity]
    const msg = doc.createElement('span')
    msg.className = 'jc-diag-message'
    msg.textContent = d.message
    row.append(icon, msg)
    if (d.source) {
      const src = doc.createElement('span')
      src.className = 'jc-diag-source'
      src.textContent = d.source
      row.appendChild(src)
    }
    if (d.actions?.length) {
      const actions = doc.createElement('div')
      actions.className = 'jc-diag-actions'
      for (const a of d.actions) {
        const b = doc.createElement('button')
        b.type = 'button'
        b.textContent = a.name
        b.addEventListener('mousedown', (e) => e.preventDefault())
        b.addEventListener('click', () => {
          a.apply(editor, d)
          editor.focus()
        })
        actions.appendChild(b)
      }
      row.appendChild(actions)
    }
    box.appendChild(row)
  }
  return box
}

const sorted = (editor: Editor) => getDiagnostics(editor).sort((a, b) => cmpPos(a.from, b.from))

function jump(editor: Editor, dir: 1 | -1): boolean {
  const list = sorted(editor)
  if (!list.length) return false
  const head = editor.selection.head
  const next = dir > 0
    ? (list.find((d) => cmpPos(d.from, head) > 0) ?? list[0]!)
    : ([...list].reverse().find((d) => cmpPos(d.from, head) < 0) ?? list[list.length - 1]!)
  editor.dispatch({ selection: { anchor: next.from, head: next.from }, scrollIntoView: 'center', origin: 'select.diagnostic' })
  editor.flush()
  const here = list.filter((d) => cmpPos(d.from, next.from) === 0)
  showTooltip(editor, next.from, describe(editor, here))
  return true
}

export const nextDiagnostic: Command = (ed) => jump(ed, 1)
export const previousDiagnostic: Command = (ed) => jump(ed, -1)

export const diagnosticsKeymap: readonly KeyBinding[] = [{ key: 'F8', run: nextDiagnostic, shift: previousDiagnostic }]

/** Editors where `diagnostics()` is installed (it's shared: linters and the syntax checker all include it). */
const installed = new WeakMap<Editor, number>()

/** Gutter markers, hover messages and F8 navigation for the diagnostics set with `setDiagnostics`. */
export function diagnostics(options: DiagnosticsOptions = {}): Extension {
  return (editor) => {
    if (options.inline) inlineOn.add(editor)
    const count = installed.get(editor) ?? 0
    installed.set(editor, count + 1)
    const release = () => installed.set(editor, (installed.get(editor) ?? 1) - 1)
    // Already there (another linter brought it): share it.
    if (count) return release
    injectStyle(editor.dom, 'diagnostics', diagnosticsCSS())
    const disposers: (() => void)[] = [release]
    if (options.gutter !== false) {
      disposers.push(editor.addGutter({
        className: 'jc-gutter-diag',
        width: () => '14px',
        cell: (line, ed) => {
          const s = severityAt(ed, line)
          return s ? { text: ICON[s], className: `jc-diag-marker jc-diag-${s}` } : null
        },
        onMouseDown: (line, _e, ed) => {
          const here = getDiagnostics(ed).filter((d) => d.from.line === line)
          if (!here.length) return false
          showTooltip(ed, here[0]!.from, describe(ed, here))
          return true
        },
      }))
    }
    if (options.hover !== false) {
      const hover = hoverTooltip((pos, ed) => {
        const keys = keysOf(ed)
        const here = decorationsAt(ed, pos).filter((d) => keys.has(d.set)).map((d) => d.data as Diagnostic)
        return here.length ? describe(ed, here) : null
      }) as (editor: Editor) => (() => void) | void
      const off = hover(editor)
      if (off) disposers.push(off)
    }
    disposers.push(editor.addKeymap(diagnosticsKeymap))
    return () => {
      for (const d of disposers) d()
      inlineOn.delete(editor)
      for (const key of keysOf(editor)) setDecorations(editor, key, [])
      setDecorations(editor, LENS, [])
    }
  }
}

export interface LinterOptions extends DiagnosticsOptions {
  /** Wait this long (ms) after the last edit before linting. Default 500. */
  delay?: number
}

/**
 * Runs `source` when the editor starts and after edits (debounced) and shows
 * what it returns. Late results of an outdated document are dropped.
 */
export function linter(source: (editor: Editor) => readonly Diagnostic[] | Promise<readonly Diagnostic[]>, options: LinterOptions = {}): Extension {
  return [
    diagnostics(options),
    (editor) => {
      let version = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const run = async () => {
        const v = version
        try {
          const list = await source(editor)
          if (v === version && !editor.isDestroyed) setDiagnostics(editor, list)
        } catch (err) {
          console.error('[jonacode] linter failed', err)
        }
      }
      const off = editor.on('change', () => {
        version++
        clearTimeout(timer)
        timer = setTimeout(run, options.delay ?? 500)
      })
      void run()
      return () => {
        clearTimeout(timer)
        off()
      }
    },
  ]
}

// A wave drawn with a mask, so it takes the color of the severity (and themes can change it).
const WAVE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='M0 2.2Q1.5-.2 3 2.2T6 2.2' fill='none' stroke='%23000' stroke-width='1.1'/%3E%3C/svg%3E")`
/** A function, so the CSS is dropped by tree-shaking when only `getDiagnostics` & co. are used. */
const diagnosticsCSS = () => `
.jc-editor{--jc-error:#e06c75;--jc-warning:#e5c07b;--jc-info:#61afef;--jc-hint:#7f848e}
.jc-diag{border-radius:0;-webkit-mask:${WAVE} repeat-x left bottom/6px 3px;mask:${WAVE} repeat-x left bottom/6px 3px}
.jc-diag.jc-diag-error{background:var(--jc-error)}
.jc-diag.jc-diag-warning{background:var(--jc-warning)}
.jc-diag.jc-diag-info{background:var(--jc-info)}
.jc-diag.jc-diag-hint{background:var(--jc-hint);opacity:.7}
.jc-gutter-diag .jc-gutter-cell{text-align:center;padding:0;font-size:.7em;cursor:pointer}
.jc-diag-marker.jc-diag-error,.jc-diag-item.jc-diag-error .jc-diag-icon,.jc-diag-lens.jc-diag-error{color:var(--jc-error)}
.jc-diag-marker.jc-diag-warning,.jc-diag-item.jc-diag-warning .jc-diag-icon,.jc-diag-lens.jc-diag-warning{color:var(--jc-warning)}
.jc-diag-marker.jc-diag-info,.jc-diag-item.jc-diag-info .jc-diag-icon,.jc-diag-lens.jc-diag-info{color:var(--jc-info)}
.jc-diag-marker.jc-diag-hint,.jc-diag-item.jc-diag-hint .jc-diag-icon,.jc-diag-lens.jc-diag-hint{color:var(--jc-hint)}
.jc-diag-list{display:grid;gap:6px;max-width:480px}
.jc-diag-item{display:grid;grid-template-columns:auto 1fr auto;gap:2px 8px;align-items:baseline}
.jc-diag-icon{font-size:.85em}
.jc-diag-message{white-space:pre-wrap;overflow-wrap:anywhere}
.jc-diag-source{font-size:.85em;opacity:.6}
.jc-diag-actions{grid-column:2/-1;display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.jc-diag-actions button{font:inherit;font-size:.9em;color:inherit;background:color-mix(in srgb,var(--jc-caret) 22%,transparent);border:1px solid color-mix(in srgb,var(--jc-caret) 50%,transparent);border-radius:5px;padding:2px 8px;cursor:pointer}
.jc-diag-actions button:hover{background:color-mix(in srgb,var(--jc-caret) 40%,transparent)}
.jc-diag-lens{margin-left:2.5ch;font-style:italic;opacity:.75;pointer-events:none}
`
