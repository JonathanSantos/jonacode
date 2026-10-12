/**
 * Decorations: ranges, lines and widgets drawn on top of (or behind) the text,
 * in named sets. Marks, lines and inline widgets never change the text
 * layout; block widgets get rows of their own between lines (inline diffs,
 * suggestions, comments) and virtualization keeps accounting for them. All
 * follow edits (positions are mapped through every change). Diagnostics and
 * folding placeholders are built on the same API.
 *
 * ```ts
 * setDecorations(editor, 'review', [
 *   { from: { line: 3, col: 4 }, to: { line: 3, col: 12 }, class: 'destaque' },   // a mark
 *   { from: { line: 7, col: 0 }, line: true, class: 'linha-alterada' },            // a whole line
 *   { from: { line: 7, col: 40 }, widget: () => badge('revisar') },               // a widget
 *   { from: { line: 9, col: 0 }, block: 'above', lines: 2, widget: () => comment() }, // a block
 * ])
 * ```
 */
import type { Editor } from './editor.ts'
import { cmpPos, mapPos, type Pos } from './state/text.ts'
import { injectStyle } from './view/style.ts'

export interface Decoration {
  /** Start of a mark, the line of a line decoration, or where a widget goes. */
  from: Pos
  /** End of a mark (exclusive). */
  to?: Pos
  /** Class of the mark, line or widget. */
  class?: string
  /** A whole-line decoration (background of the line of `from`). */
  line?: boolean
  /** A widget drawn at `from`. It floats over the text and takes no space (unless it's a `block`). */
  widget?: HTMLElement | ((editor: Editor) => HTMLElement)
  /** Makes the widget a block on rows of its own, above or below the line of `from`. */
  block?: 'above' | 'below'
  /** Height of a block, in lines (default 1). */
  lines?: number
  /** Draw marks above the text instead of behind it. */
  above?: boolean
  /** Anything you want back from `decorationsAt()` (a diagnostic, a message…). */
  data?: unknown
}

export interface DecorationHit extends Decoration {
  /** Name of the set it belongs to. */
  set: string
}

interface Sets {
  sets: Map<string, Decoration[]>
  /** Number of block widgets (their rows are reserved in the editor). */
  blocks: number
  /** Lines spanned by the longest mark of each set (to find marks that start above the view). */
  span: Map<string, number>
  /** Document version each set's positions refer to. */
  version: Map<string, number>
  widgets: WeakMap<Decoration, HTMLElement>
}

const registry = new WeakMap<Editor, Sets>()

const byStart = (a: Decoration, b: Decoration) => cmpPos(a.from, b.from)

/** Installs the machinery on first use (rendering layers and position mapping), for the editor's lifetime. */
function install(editor: Editor): Sets {
  return registry.get(editor) ?? editor.untracked(() => setup(editor))
}

function setup(editor: Editor): Sets {
  const sets: Sets = { sets: new Map(), blocks: 0, span: new Map(), version: new Map(), widgets: new WeakMap() }
  registry.set(editor, sets)
  injectStyle(editor.dom, 'decorations', DECORATIONS_CSS)

  editor.on('change', (event) => {
    for (const [key, list] of sets.sets) {
      // Set by another `change` listener that ran first: already in the new coordinates.
      if (sets.version.get(key) === editor.version) continue
      sets.version.set(key, editor.version)
      const out: Decoration[] = []
      for (const d of list) {
        let from = d.from
        let to = d.to
        for (const c of event.changes) {
          from = mapPos(from, c, d.line ? -1 : 1)
          if (to) to = mapPos(to, c, -1)
        }
        // Marks whose text was deleted disappear.
        if (to && cmpPos(from, to) >= 0 && cmpPos(d.from, d.to!) < 0) continue
        const moved = from === d.from && to === d.to ? d : { ...d, from, to }
        if (moved !== d) {
          const w = sets.widgets.get(d)
          if (w) sets.widgets.set(moved, w)
        }
        out.push(moved)
      }
      sets.sets.set(key, out)
    }
    if (sets.blocks) syncGaps(editor, sets)
  })

  const draw = (dom: HTMLElement, ed: Editor, above: boolean) => {
    const { from, to } = ed.visibleRange
    let html = ''
    const widgets: HTMLElement[] = []
    const stacked = new Map<string, number>()
    for (const [key, list] of sets.sets) {
      // Binary search the first decoration that may reach the view.
      const first = Math.max(0, from - (sets.span.get(key) ?? 0))
      let lo = 0
      let hi = list.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (list[mid]!.from.line < first) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < list.length; i++) {
        const d = list[i]!
        if (d.from.line > to) break
        if (d.widget) {
          if (!above || ed.isLineHidden?.(d.from.line)) continue
          let el = sets.widgets.get(d)
          if (!el) {
            el = typeof d.widget === 'function' ? d.widget(ed) : d.widget
            el.classList.add('jc-widget')
            if (d.block) el.classList.add('jc-block')
            if (d.class) el.classList.add(...d.class.split(/\s+/).filter(Boolean))
            sets.widgets.set(d, el)
          }
          if (d.block) {
            // Blocks on the same side of a line stack in order inside its gap.
            const slot = d.from.line + d.block
            const used = stacked.get(slot) ?? 0
            const rows = d.lines ?? 1
            stacked.set(slot, used + rows)
            const top = ed.gapBlock(d.from.line, d.block).top + used * ed.lineHeight
            el.style.transform = `translateY(${top}px)`
            el.style.height = rows * ed.lineHeight + 'px'
          } else {
            const c = ed.coordsAtPos(d.from)
            el.style.transform = `translate(${c.x}px,${c.top}px)`
          }
          widgets.push(el)
        } else if (d.line) {
          if (above || ed.isLineHidden?.(d.from.line)) continue
          const b = ed.lineBlock(d.from.line)
          html += `<div class="jc-line-deco ${d.class ?? ''}" style="top:${b.top}px;height:${b.height}px"></div>`
        } else if (d.to && !!d.above === above) {
          if (d.to.line < from) continue
          for (const r of ed.rangeRects(d.from, d.to)) {
            html += `<div class="jc-mark ${d.class ?? ''}" style="left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px"></div>`
          }
        }
      }
    }
    // Marks are plain HTML (cheap to redo); widgets are kept and only moved.
    let marks = dom.querySelector<HTMLElement>(':scope > .jc-marks')
    if (!marks) {
      marks = ed.dom.ownerDocument.createElement('div')
      marks.className = 'jc-marks'
      dom.appendChild(marks)
    }
    if (marks.innerHTML !== html) marks.innerHTML = html
    for (const el of [...dom.children]) if (el !== marks && !widgets.includes(el as HTMLElement)) el.remove()
    for (const el of widgets) if (el.parentNode !== dom) dom.appendChild(el)
  }
  editor.addLayer({ className: 'jc-deco-below', order: -0.8, render: (dom, ed) => draw(dom, ed, false) })
  editor.addLayer({ className: 'jc-deco-above', above: true, order: 4, render: (dom, ed) => draw(dom, ed, true) })
  return sets
}

/** Reserves the rows of every block widget (summed per line and side). */
function syncGaps(editor: Editor, sets: Sets): void {
  const gaps = new Map<number, { line: number; above: number; below: number }>()
  let blocks = 0
  for (const list of sets.sets.values()) {
    for (const d of list) {
      if (!d.block || !d.widget) continue
      blocks++
      const line = d.from.line
      const g = gaps.get(line) ?? { line, above: 0, below: 0 }
      g[d.block] += d.lines ?? 1
      gaps.set(line, g)
    }
  }
  sets.blocks = blocks
  editor.setLineGaps('decorations', [...gaps.values()])
}

/** Replaces the decorations of a named set (other sets are untouched). */
export function setDecorations(editor: Editor, key: string, decorations: readonly Decoration[]): void {
  const sets = install(editor)
  const list = decorations.filter((d) => d.line || d.widget || (d.to && cmpPos(d.from, d.to) < 0)).sort(byStart)
  let span = 0
  for (const d of list) if (d.to) span = Math.max(span, d.to.line - d.from.line)
  const hadBlocks = (sets.sets.get(key) ?? []).some((d) => d.block)
  sets.sets.set(key, list)
  sets.span.set(key, span)
  sets.version.set(key, editor.version)
  if (hadBlocks || list.some((d) => d.block)) syncGaps(editor, sets)
  editor.requestRender()
}

/** The decorations of a set, with their positions mapped through the edits since they were set. */
export function getDecorations(editor: Editor, key: string): readonly Decoration[] {
  return registry.get(editor)?.sets.get(key) ?? []
}

/** Marks covering `pos`, line decorations of its line and widgets on it — optionally of one set only. */
export function decorationsAt(editor: Editor, pos: Pos, key?: string): DecorationHit[] {
  const out: DecorationHit[] = []
  const state = registry.get(editor)
  if (!state) return out
  for (const [set, list] of state.sets) {
    if (key && set !== key) continue
    for (const d of list) {
      if (d.from.line > pos.line) break
      const hit = d.line || d.widget ? d.from.line === pos.line : cmpPos(d.from, pos) <= 0 && cmpPos(pos, d.to!) <= 0
      if (hit) out.push({ ...d, set })
    }
  }
  return out
}

const DECORATIONS_CSS = `
.jc-marks{position:absolute;inset:0}
.jc-mark{position:absolute;border-radius:2px}
.jc-widget{position:absolute;left:0;top:0;height:var(--jc-lh);line-height:var(--jc-lh);white-space:nowrap;pointer-events:auto}
.jc-deco-below .jc-line-deco{position:absolute;left:calc(-1 * var(--jc-pad-x));right:0}
.jc-block{left:calc(-1 * var(--jc-pad-x));right:0;white-space:normal;overflow:hidden;cursor:auto;user-select:text;-webkit-user-select:text}
`
