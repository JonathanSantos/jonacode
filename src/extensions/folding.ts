/**
 * Code folding. A line can be folded when it ends with an opening bracket
 * (up to its match, keeping the closing line visible), when the lines below
 * it are more indented (Python, YAML…), or when it's a Markdown heading (up
 * to the next heading of the same level). Fold markers live in a gutter, a
 * `⋯` placeholder after the folded line unfolds it, and the editor core hides
 * the lines (arrow keys skip over folds; search or "go to line" open them).
 *
 * Keys: Ctrl-Shift-[ / Ctrl-Shift-] (Cmd-Alt-[ / Cmd-Alt-] on macOS) fold and
 * unfold at the cursor, Ctrl-Alt-[ / Ctrl-Alt-] fold and unfold everything.
 */
import type { Editor, Extension, FoldRange } from '../editor.ts'
import type { Command, KeyBinding } from '../keymap.ts'
import { matchBracket } from '../language/brackets.ts'
import { injectStyle } from '../view/style.ts'

const SKIPPED = /^(string|comment|regexp)/
const indentOf = (text: string) => /^[ \t]*/.exec(text)![0].replace(/\t/g, '    ').length
const blank = (text: string) => !text.trim()

/** The last significant char of a line if it's an opening bracket (outside strings and comments). */
function openingBracketAt(editor: Editor, line: number): number {
  const text = editor.doc.line(line)
  const tokens = editor.getTokens(line)
  for (let t = tokens.length - 1; t >= 0; t--) {
    const tok = tokens[t]!
    const s = text.slice(tok.from, tok.to)
    if (!s.trim() || (tok.type && tok.type.startsWith('comment'))) continue
    if (tok.type && SKIPPED.test(tok.type)) return -1
    const col = tok.from + s.trimEnd().length - 1
    const lang = editor.languageAt({ line, col })
    return lang.brackets.some(([open]) => open === text[col]) ? col : -1
  }
  return -1
}

const HEADING = /^(#{1,6})\s/

/** The lines `line` would hide if folded, or null. */
export function foldableRange(editor: Editor, line: number): FoldRange | null {
  const doc = editor.doc
  const text = doc.line(line)
  if (blank(text)) return null
  const last = doc.lineCount - 1
  // Markdown headings: up to the next heading of the same or a higher level.
  const heading = HEADING.exec(text)
  if (heading && editor.language.name === 'markdown') {
    let end = line
    for (let l = line + 1; l <= last; l++) {
      const h = HEADING.exec(doc.line(l))
      if (h && h[1]!.length <= heading[1]!.length) break
      end = l
    }
    while (end > line && blank(doc.line(end))) end--
    return end > line ? { from: line + 1, to: end } : null
  }
  // Brackets: `{` … `}` (the closing line stays visible).
  const col = openingBracketAt(editor, line)
  if (col >= 0) {
    const m = matchBracket(editor, { line, col: col + 1 }, 100000)
    if (m?.to && m.to.line > line + 1) return { from: line + 1, to: m.to.line - 1 }
    if (m?.to) return null
  }
  // Indentation: the following more indented block.
  const indent = indentOf(text)
  let end = line
  for (let l = line + 1; l <= last && l - line < 100000; l++) {
    const t = doc.line(l)
    if (blank(t)) continue
    if (indentOf(t) <= indent) break
    end = l
  }
  return end > line ? { from: line + 1, to: end } : null
}

/** Cheap check for the gutter: could this line start a fold? */
function looksFoldable(editor: Editor, line: number): boolean {
  const doc = editor.doc
  const text = doc.line(line)
  if (blank(text)) return false
  if (editor.language.name === 'markdown' && HEADING.test(text)) return true
  if (openingBracketAt(editor, line) >= 0) return true
  const indent = indentOf(text)
  for (let l = line + 1; l < doc.lineCount && l - line < 50; l++) {
    const t = doc.line(l)
    if (!blank(t)) return indentOf(t) > indent
  }
  return false
}

/** The fold that the cursor's line opens, or the innermost foldable block around it. */
function rangeAtCursor(editor: Editor): FoldRange | null {
  const line = editor.selection.head.line
  for (let l = line, n = 0; l >= 0 && n < 2000; l--, n++) {
    const r = foldableRange(editor, l)
    if (r && (l === line || (line >= r.from && line <= r.to + 1))) return r
  }
  return null
}

export const foldCode: Command = (ed) => {
  const r = rangeAtCursor(ed)
  if (!r) return false
  ed.setFolds([...ed.folds, r])
  return true
}

export const unfoldCode: Command = (ed) => {
  const line = ed.selection.head.line
  const folds = ed.folds.filter((f) => f.from - 1 !== line && !(line >= f.from - 1 && line <= f.to + 1))
  if (folds.length === ed.folds.length) return false
  ed.setFolds(folds)
  return true
}

export const toggleFold: Command = (ed) => unfoldCode(ed) || foldCode(ed)

/** Folds every outermost block (nested ones end up inside them). */
export const foldAll: Command = (ed) => {
  const ranges: FoldRange[] = []
  const n = ed.doc.lineCount
  for (let l = 0; l < n; l++) {
    const r = foldableRange(ed, l)
    if (r) {
      ranges.push(r)
      l = r.to
    }
  }
  ed.setFolds(ranges)
  return true
}

export const unfoldAll: Command = (ed) => {
  if (!ed.folds.length) return false
  ed.setFolds([])
  return true
}

export const foldKeymap: readonly KeyBinding[] = [
  { key: 'Ctrl-Shift-[', mac: 'Mod-Alt-[', run: foldCode },
  { key: 'Ctrl-Shift-]', mac: 'Mod-Alt-]', run: unfoldCode },
  { key: 'Ctrl-Alt-[', run: foldAll },
  { key: 'Ctrl-Alt-]', run: unfoldAll },
]

export interface FoldingOptions {
  /** Show the fold markers gutter. Default true. */
  gutter?: boolean
}

export function folding(options: FoldingOptions = {}): Extension {
  return (editor) => {
    injectStyle(editor.dom, 'folding', FOLDING_CSS)
    const toggleAt = (line: number) => {
      const open = editor.folds.find((f) => f.from - 1 === line)
      if (open) editor.setFolds(editor.folds.filter((f) => f !== open))
      else {
        const r = foldableRange(editor, line)
        if (r) editor.setFolds([...editor.folds, r])
      }
    }
    const disposers: (() => void)[] = []
    if (options.gutter !== false) {
      disposers.push(editor.addGutter({
        className: 'jc-gutter-fold',
        width: () => '14px',
        cell: (line, ed) => {
          if (ed.folds.some((f) => f.from - 1 === line)) return { text: '›', className: 'jc-fold-closed' }
          return looksFoldable(ed, line) ? { text: '›', className: 'jc-fold-open' } : null
        },
        onMouseDown: (line) => {
          toggleAt(line)
          return true
        },
      }))
    }
    // The ⋯ placeholder after each folded line.
    const layer = editor.addLayer({
      className: 'jc-fold-layer',
      above: true,
      order: 6,
      render(dom, ed) {
        const { from, to } = ed.visibleRange
        let html = ''
        for (const f of ed.folds) {
          const header = f.from - 1
          if (header < from || header > to) continue
          const c = ed.coordsAtPos({ line: header, col: ed.doc.line(header).length })
          const n = f.to - f.from + 1
          html += `<button type="button" class="jc-fold-placeholder" data-line="${header}" style="transform:translate(${c.x}px,${c.top}px)" title="${ed.phrase('Unfold')} (${n})" aria-label="${ed.phrase('Unfold')} (${n})">⋯</button>`
        }
        if (dom.innerHTML !== html) dom.innerHTML = html
      },
    })
    const onDown = (e: MouseEvent) => {
      const btn = (e.target as Element).closest?.('.jc-fold-placeholder') as HTMLElement | null
      if (!btn) return
      e.preventDefault()
      e.stopPropagation()
      toggleAt(Number(btn.dataset.line))
      editor.focus()
    }
    editor.dom.addEventListener('mousedown', onDown, true)
    disposers.push(editor.addKeymap(foldKeymap), layer, () => editor.dom.removeEventListener('mousedown', onDown, true))
    return () => {
      for (const d of disposers) d()
    }
  }
}

const FOLDING_CSS = `
.jc-gutter-fold .jc-gutter-cell{text-align:center;padding:0;cursor:pointer;color:var(--jc-gutter-foreground);font-size:.95em;opacity:0;transition:opacity .15s}
.jc-gutters:hover .jc-gutter-fold .jc-gutter-cell,.jc-gutter-fold .jc-fold-closed{opacity:1}
.jc-fold-open{transform:rotate(90deg)}
.jc-fold-closed{color:var(--jc-caret)}
.jc-fold-placeholder{position:absolute;left:0;top:0;margin:calc((var(--jc-lh) - 1.25em) / 2) 0 0 6px;height:1.25em;padding:0 6px;border:0;border-radius:4px;
font:inherit;font-size:.85em;line-height:1.25em;cursor:pointer;pointer-events:auto;color:var(--jc-fg);background:color-mix(in srgb,var(--jc-fg) 14%,transparent)}
.jc-fold-placeholder:hover{background:color-mix(in srgb,var(--jc-caret) 35%,transparent)}
`
