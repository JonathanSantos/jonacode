/**
 * Hover tooltips. Each `hoverTooltip(source)` adds a source; when the mouse
 * rests over text, every source is asked about that position (sync or async)
 * and the answers are shown together in one box, anchored above the text.
 * The box stays while the pointer moves into it (so it can hold buttons) and
 * closes on typing, clicking, scrolling or leaving. `showHover` opens it at
 * the cursor from the keyboard; `showTooltip` shows any content anywhere.
 *
 * ```ts
 * hoverTooltip((pos, editor) => {
 *   const [from, to] = editor.wordRange(pos)
 *   const word = editor.doc.slice(from, to)
 *   return docs[word] ?? null            // string, HTMLElement, or a Promise of either
 * })
 * ```
 */
import type { Editor, Extension } from '../editor.ts'
import type { Command } from '../keymap.ts'
import type { Pos } from '../state/text.ts'
import { createFloating, type Floating } from '../view/floating.ts'
import { injectStyle } from '../view/style.ts'

export type TooltipContent = string | HTMLElement | null | undefined | false
export type HoverSource = (pos: Pos, editor: Editor) => TooltipContent | Promise<TooltipContent>

export interface HoverOptions {
  /** Time (ms) the pointer must rest before asking the sources. Default 300. */
  delay?: number
}

interface Hover {
  sources: { fn: HoverSource; delay: number }[]
  floating: Floating
  /** Where the current tooltip points (null: hidden). */
  at: Pos | null
  gen: number
  timer: ReturnType<typeof setTimeout> | undefined
  hideTimer: ReturnType<typeof setTimeout> | undefined
}

const hovers = new WeakMap<Editor, Hover>()

const toNode = (doc: Document, c: TooltipContent): Node | null => {
  if (!c) return null
  if (typeof c !== 'string') return c
  const div = doc.createElement('div')
  div.className = 'jc-tooltip-text'
  div.textContent = c
  return div
}

function fill(editor: Editor, h: Hover, contents: TooltipContent[]): boolean {
  const doc = editor.dom.ownerDocument
  const nodes = contents.map((c) => toNode(doc, c)).filter((n): n is Node => !!n)
  if (!nodes.length) return false
  const el = h.floating.el
  el.replaceChildren()
  for (const n of nodes) {
    const section = doc.createElement('div')
    section.className = 'jc-tooltip-section'
    section.appendChild(n)
    el.appendChild(section)
  }
  return true
}

function hide(h: Hover): void {
  clearTimeout(h.timer)
  clearTimeout(h.hideTimer)
  h.gen++
  h.at = null
  h.floating.hide()
}

/** Asks every source about `pos` and shows what comes back (the latest request wins). */
async function query(editor: Editor, h: Hover, pos: Pos): Promise<void> {
  const gen = ++h.gen
  const results = await Promise.all(h.sources.map(({ fn }) => Promise.resolve().then(() => fn(pos, editor)).catch(() => null)))
  if (gen !== h.gen) return
  if (!fill(editor, h, results)) return hide(h)
  h.at = pos
  h.floating.show(pos, 'above')
}

function install(editor: Editor): Hover {
  return hovers.get(editor) ?? editor.untracked(() => setup(editor))
}

function setup(editor: Editor): Hover {
  injectStyle(editor.dom, 'tooltip', TOOLTIP_CSS)
  const floating = createFloating(editor, 'jc-tooltip')
  floating.el.setAttribute('role', 'tooltip')
  const hover: Hover = { sources: [], floating, at: null, gen: 0, timer: undefined, hideTimer: undefined }
  hovers.set(editor, hover)

  const sc = editor.scrollDOM
  /** The position under the pointer, if the pointer is really over text (not past the end of a line). */
  const textPosAt = (x: number, y: number): Pos | null => {
    const pos = editor.posAtClient(x, y)
    const c = editor.coordsAtPos(pos)
    const a = editor.contentToClient(c.x, c.top)
    const b = editor.contentToClient(c.x + editor.charWidth, c.bottom)
    const cx = a.x
    if (Math.abs(x - cx) > (b.x - a.x) * 1.2 || y < a.y || y > b.y) return null
    // Snap to the char under the pointer (a position is between two chars).
    return x < cx && pos.col > 0 ? { line: pos.line, col: pos.col - 1 } : pos
  }
  const near = (a: Pos, b: Pos) => a.line === b.line && Math.abs(a.col - b.col) <= 1
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.buttons) return
    const overGutter = !!(e.target as Element).closest?.('.jc-gutters')
    const pos = overGutter ? null : textPosAt(e.clientX, e.clientY)
    if (hover.at && pos && near(pos, hover.at)) {
      clearTimeout(hover.hideTimer)
      return
    }
    clearTimeout(hover.timer)
    if (hover.at) {
      // Grace period: the pointer may be on its way into the tooltip.
      clearTimeout(hover.hideTimer)
      hover.hideTimer = setTimeout(() => hide(hover), 250)
    }
    if (!pos) return
    const delay = Math.min(...hover.sources.map((s) => s.delay))
    hover.timer = setTimeout(() => void query(editor, hover, pos), delay)
  }
  const onLeave = () => {
    clearTimeout(hover.timer)
    if (hover.at) hover.hideTimer = setTimeout(() => hide(hover), 250)
  }
  const onFloatEnter = () => clearTimeout(hover.hideTimer)
  const onFloatLeave = () => {
    hover.hideTimer = setTimeout(() => hide(hover), 250)
  }
  const close = () => hide(hover)
  sc.addEventListener('pointermove', onMove)
  sc.addEventListener('pointerleave', onLeave)
  sc.addEventListener('pointerdown', close)
  sc.addEventListener('scroll', close, { passive: true })
  // Capture: runs before the editor's key bindings, so a key that opens a tooltip (F8…) doesn't close it right away.
  editor.inputDOM.addEventListener('keydown', close, true)
  floating.el.addEventListener('pointerenter', onFloatEnter)
  floating.el.addEventListener('pointerleave', onFloatLeave)
  editor.on('destroy', () => {
    hide(hover)
    floating.destroy()
  })
  return hover
}

/** Adds a hover source. Several sources share one tooltip, in the order they were added. */
export function hoverTooltip(source: HoverSource, options: HoverOptions = {}): Extension {
  return (editor) => {
    const h = install(editor)
    const entry = { fn: source, delay: options.delay ?? 300 }
    h.sources.push(entry)
    return () => {
      h.sources = h.sources.filter((s) => s !== entry)
      hide(h)
    }
  }
}

/** Shows `content` at `pos` right away (keyboard access, "go to next error"…). Returns a function that closes it. */
export function showTooltip(editor: Editor, pos: Pos, content: TooltipContent | TooltipContent[]): () => void {
  const h = install(editor)
  clearTimeout(h.timer)
  h.gen++
  if (!fill(editor, h, Array.isArray(content) ? content : [content])) return () => {}
  h.at = pos
  h.floating.show(pos, 'above')
  const gen = h.gen
  return () => {
    if (h.gen === gen) hide(h)
  }
}

/** Opens the hover tooltip at the cursor (for keyboard users). */
export const showHover: Command = (editor) => {
  const h = hovers.get(editor)
  if (!h?.sources.length) return false
  void query(editor, h, editor.selection.head)
  return true
}

const TOOLTIP_CSS = `
.jc-tooltip{max-height:40vh;pointer-events:auto}
.jc-tooltip-section{padding:6px 10px}
.jc-tooltip-section+.jc-tooltip-section{border-top:1px solid color-mix(in srgb,var(--jc-fg) 14%,transparent)}
.jc-tooltip-text{white-space:pre-wrap;overflow-wrap:anywhere}
`
