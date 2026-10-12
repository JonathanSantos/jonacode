/**
 * Elements injected into the editor, like Monaco's view zones, content
 * widgets and overlay widgets:
 *
 * - `addZone`: an element between two lines that takes room of its own (the
 *   lines below move down) without being part of the text: an action bar
 *   above a function, a message, a comment thread, a rendered preview…
 * - `addWidget`: an element floating next to a position (above or below its
 *   line), taking no room: a hint, a small toolbar at the cursor.
 * - `addOverlay`: an element fixed in a corner of the editor.
 *
 * All of them follow edits, and return a handle to change or remove them.
 * Zones size themselves to their content (and follow it as it changes),
 * stay in view when the text scrolls sideways and work with folding,
 * wrapping and any font size.
 *
 * ```ts
 * addZone(editor, { line: 4, content: 'Um texto acima da linha 5' })
 * addZone(editor, { line: 9, actions: [{ label: '▶ Executar', run: () => rodar() }, { label: 'Depurar', run: depurar }] })
 * addZone(editor, { line: 20, side: 'below', content: () => comentario(), gutter: '💬' })
 * addWidget(editor, { pos: editor.selection.head, content: botao, place: 'above' })
 * addOverlay(editor, { content: selo, position: 'bottom-right' })
 * ```
 */
import type { Editor } from './editor.ts'
import { mapPos, type Pos } from './state/text.ts'
import { indentLength } from './util/text.ts'
import { injectStyle } from './view/style.ts'

/** What to show: an element, text, or a function that builds the element. */
export type WidgetContent = HTMLElement | string | ((editor: Editor) => HTMLElement)

export interface ZoneAction {
  label: string
  /** Tooltip. */
  title?: string
  run: (editor: Editor, zone: Zone) => void
}

export interface ZoneSpec {
  /** The line the zone belongs to; it moves with that line as text is edited. */
  line: number
  /** Above the line (default) or below it. */
  side?: 'above' | 'below'
  content?: WidgetContent
  /** A bar of clickable actions (like VS Code's CodeLens), aligned with the line's code. */
  actions?: readonly ZoneAction[]
  /** Height in px, or `'auto'` (default): the content's height, followed as it changes. */
  height?: number | 'auto'
  /** Height in lines (follows the font size); wins over `height`. */
  lines?: number
  /** Something to show in the gutters next to the zone (like Monaco's margin node). */
  gutter?: WidgetContent
  /** Start where the line's code starts (after its indentation). Default: true with `actions`, false otherwise. */
  indent?: boolean
  /** Span the gutters too. */
  cover?: boolean
  /** Scroll sideways with the text, like code does (default: stays in view). */
  scroll?: boolean
  /** Extra class(es) of the zone element. */
  class?: string
  /** Order among the zones on the same side of a line (lower first). Default 0. */
  order?: number
  /** Called when the zone's height changes (px). */
  onHeight?: (height: number, zone: Zone) => void
}

export interface Zone {
  /** The zone element (content goes inside it). */
  readonly dom: HTMLElement
  /** The line it belongs to now. */
  readonly line: number
  readonly side: 'above' | 'below'
  /** Current height (px). */
  readonly height: number
  /** Changes the zone: line, content, height… (content and actions are rebuilt when given). */
  update(spec: Partial<ZoneSpec>): void
  remove(): void
}

export interface WidgetSpec {
  /** Where: a document position (it follows edits). */
  pos: Pos
  content: WidgetContent
  /** Above (default) or below the line of `pos`; flips when there's no room on screen. */
  place?: 'above' | 'below'
  class?: string
}

export interface Widget {
  readonly dom: HTMLElement
  readonly pos: Pos
  update(spec: Partial<WidgetSpec>): void
  remove(): void
}

export type OverlayPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'top' | 'bottom'

export interface OverlaySpec {
  content: WidgetContent
  /** Corner (or edge) of the visible area; default `'top-right'`. */
  position?: OverlayPosition
  class?: string
}

export interface Overlay {
  readonly dom: HTMLElement
  update(spec: Partial<OverlaySpec>): void
  remove(): void
}

// ---------------------------------------------------------------------------

function build(editor: Editor, content: WidgetContent | undefined, textClass: string): HTMLElement | null {
  if (content == null) return null
  if (typeof content === 'function') return content(editor)
  if (typeof content !== 'string') return content
  const el = editor.dom.ownerDocument.createElement('div')
  el.className = textClass
  el.textContent = content
  return el
}

const classes = (el: HTMLElement, base: string, extra?: string) => {
  el.className = base + (extra ? ' ' + extra : '')
}

/** The machinery of one editor, installed on first use for the editor's lifetime. */
interface State {
  zones: ZoneImpl[]
  widgets: WidgetImpl[]
  /** The layers: zones that stay in view, zones that scroll with the text, widgets. */
  fixed: HTMLElement
  scroll: HTMLElement
  floating: HTMLElement
  resize: ResizeObserver | null
  seq: number
}

const states = new WeakMap<Editor, State>()

function state(editor: Editor): State {
  return states.get(editor) ?? editor.untracked(() => setup(editor))
}

function setup(editor: Editor): State {
  injectStyle(editor.dom, 'widgets', WIDGETS_CSS)
  editor.addLayer({ className: 'jc-zones-scroll', above: true, order: 3, render: () => {} })
  editor.addLayer({ className: 'jc-zones', fixed: true, order: 5, render: () => drawZones(editor, st) })
  editor.addLayer({ className: 'jc-widgets', above: true, order: 6, render: () => drawWidgets(editor, st) })
  // The layers' elements exist right away: zones and widgets are in the page (and placed) as soon as they're added.
  const layer = (cls: string) => editor.dom.querySelector<HTMLElement>(`.jc-layer.${cls}`)!
  const st: State = { zones: [], widgets: [], fixed: layer('jc-zones'), scroll: layer('jc-zones-scroll'), floating: layer('jc-widgets'), resize: null, seq: 0 }
  states.set(editor, st)
  if (typeof ResizeObserver !== 'undefined') {
    // Auto-sized zones: their height is their content's, reserved as soon as it's laid out (before the paint).
    st.resize = new ResizeObserver((entries) => {
      let changed = false
      for (const e of entries) {
        const z = st.zones.find((z) => z.dom === e.target)
        if (!z || z.hiddenNow || !z.auto) continue
        const h = Math.ceil((e.target as HTMLElement).offsetHeight)
        if (h === z.measured) continue
        z.measured = h
        changed = true
        z.spec.onHeight?.(h, z)
      }
      if (changed) {
        syncGaps(editor, st)
        editor.flush()
      }
    })
  }
  editor.on('change', (event) => {
    for (const z of st.zones) {
      // Added by another listener of this change: already in the new coordinates.
      if (z.version === editor.version) continue
      z.version = editor.version
      for (const c of event.changes) z.anchor = mapPos(z.anchor, c, z.side === 'above' ? 1 : -1)
      z.anchor = z.anchorAt(z.anchor.line)
    }
    for (const w of st.widgets) {
      if (w.version === editor.version) continue
      w.version = editor.version
      for (const c of event.changes) w.at = mapPos(w.at, c)
    }
    // The editor moved the gaps along already; this only settles edge cases (nothing happens when they agree).
    if (st.zones.length) syncGaps(editor, st)
  })
  editor.on('destroy', () => st.resize?.disconnect())
  return st
}

/** Reserves each zone's room: one gap per zone, in px (or rows for `lines`, which follow the font). */
function syncGaps(editor: Editor, st: State): void {
  editor.setLineGaps('zones', st.zones.map((z) => z.spec.lines != null
    ? { line: z.anchor.line, [z.side]: z.spec.lines }
    : { line: z.anchor.line, [z.side]: z.pxHeight(), px: true }))
}

class ZoneImpl implements Zone {
  readonly dom: HTMLElement
  editor: Editor
  st: State
  spec: ZoneSpec
  anchor: Pos
  version: number
  seq: number
  margin: HTMLElement | null = null
  /** Measured height of an auto-sized zone (-1: not yet). */
  measured = -1
  /** Hidden by the last draw (folded, or far from the view once measured). */
  hiddenNow = false
  last = { top: NaN, left: '', pad: '', height: '', display: '', visibility: '' }

  constructor(editor: Editor, st: State, spec: ZoneSpec) {
    this.editor = editor
    this.st = st
    this.spec = { ...spec }
    this.seq = st.seq++
    this.version = editor.version
    this.dom = editor.dom.ownerDocument.createElement('div')
    this.anchor = this.anchorAt(spec.line)
    this.fill(true)
  }

  get line(): number {
    return this.anchor.line
  }

  get side(): 'above' | 'below' {
    return this.spec.side ?? 'above'
  }

  get auto(): boolean {
    return this.spec.lines == null && (this.spec.height ?? 'auto') === 'auto'
  }

  get height(): number {
    return this.spec.lines != null ? this.spec.lines * this.editor.lineHeight : this.pxHeight()
  }

  pxHeight(): number {
    const h = this.spec.height
    return typeof h === 'number' ? Math.max(0, Math.round(h)) : Math.max(0, this.measured)
  }

  /** Above a line: its start. Below: its end (typing at the end of the line keeps the zone under it). */
  anchorAt(line: number): Pos {
    const doc = this.editor.doc
    const l = Math.max(0, Math.min(doc.lineCount - 1, line))
    return { line: l, col: this.side === 'above' ? 0 : doc.line(l).length }
  }

  /** (Re)builds the content, the actions and the gutter element. */
  fill(content: boolean): void {
    const { editor, spec, dom } = this
    dom.style.cssText = ''
    classes(dom, 'jc-zone jc-ui' + (spec.scroll ? ' jc-zone-scroll' : '') + (spec.cover ? ' jc-zone-cover' : ''), spec.class)
    if (content) {
      dom.replaceChildren()
      const el = build(editor, spec.content, 'jc-zone-text')
      if (el) dom.appendChild(el)
      if (spec.actions?.length) dom.appendChild(actionsBar(editor, spec.actions, this))
    }
    this.margin?.remove()
    this.margin = null
    const gutter = spec.cover ? null : build(editor, spec.gutter, 'jc-zone-gutter-text')
    if (gutter) {
      this.margin = editor.dom.ownerDocument.createElement('div')
      this.margin.className = 'jc-zone-gutter jc-ui'
      this.margin.appendChild(gutter)
    }
    this.last = { top: NaN, left: '', pad: '', height: '', display: '', visibility: '' }
  }

  update(patch: Partial<ZoneSpec>): void {
    if (!this.st.zones.includes(this)) return
    const side = this.side
    this.spec = { ...this.spec, ...patch }
    if ('line' in patch || this.side !== side) {
      this.anchor = this.anchorAt(patch.line ?? this.anchor.line)
      this.version = this.editor.version
    }
    if ('height' in patch || 'lines' in patch) this.measured = -1
    this.fill('content' in patch || 'actions' in patch)
    if (this.auto) this.st.resize?.observe(this.dom)
    else this.st.resize?.unobserve(this.dom)
    syncGaps(this.editor, this.st)
    drawZones(this.editor, this.st)
    this.editor.requestRender()
  }

  remove(): void {
    const list = this.st.zones
    const i = list.indexOf(this)
    if (i < 0) return
    list.splice(i, 1)
    this.st.resize?.unobserve(this.dom)
    this.dom.remove()
    this.margin?.remove()
    syncGaps(this.editor, this.st)
    this.editor.requestRender()
  }
}

function actionsBar(editor: Editor, actions: readonly ZoneAction[], zone: Zone): HTMLElement {
  const doc = editor.dom.ownerDocument
  const bar = doc.createElement('div')
  bar.className = 'jc-zone-actions'
  actions.forEach((a, i) => {
    if (i) {
      const sep = doc.createElement('span')
      sep.className = 'jc-zone-sep'
      sep.setAttribute('aria-hidden', 'true')
      sep.textContent = '|'
      bar.appendChild(sep)
    }
    const b = doc.createElement('button')
    b.type = 'button'
    b.className = 'jc-zone-action'
    b.textContent = a.label
    if (a.title) b.title = a.title
    // A click runs the action without taking the focus from the editor.
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', () => a.run(editor, zone))
    bar.appendChild(b)
  })
  return bar
}

const set = (el: HTMLElement, last: Record<string, unknown>, key: string, prop: string, value: string) => {
  if (last[key] === value) return
  last[key] = value
  el.style.setProperty(prop, value)
}

function drawZones(editor: Editor, st: State): void {
  const layer = st.fixed
  const { from, to } = editor.visibleRange
  const gw = editor.gutterWidth
  const lh = editor.lineHeight
  // Zones on the same side of a line stack in order inside its gap.
  const sorted = [...st.zones].sort((a, b) => a.line - b.line || (a.spec.order ?? 0) - (b.spec.order ?? 0) || a.seq - b.seq)
  const used = new Map<string, number>()
  for (const z of sorted) {
    const { dom, spec, last } = z
    const line = z.line
    const slot = line + z.side
    const height = z.height
    const offset = used.get(slot) ?? 0
    used.set(slot, offset + height)
    const parent = spec.scroll ? st.scroll : layer
    if (dom.parentNode !== parent) parent.appendChild(dom)
    if (z.margin && z.margin.parentNode !== layer) layer.appendChild(z.margin)
    // Far from the view (and measured), or folded: out of the layout. Not measured yet: laid out unseen, to get its height.
    const folded = editor.isLineHidden(line)
    const away = line < from || line > to
    const hide = folded || (away && (!z.auto || z.measured >= 0))
    z.hiddenNow = hide
    set(dom, last, 'display', 'display', hide ? 'none' : '')
    if (z.margin) z.margin.style.display = hide || away ? 'none' : ''
    if (hide) continue
    set(dom, last, 'visibility', 'visibility', away ? 'hidden' : '')
    const top = away ? 0 : editor.gapBlock(line, z.side).top + offset
    if (last.top !== top) {
      last.top = top
      dom.style.transform = `translateY(${top}px)`
    }
    set(dom, last, 'height', 'height', z.auto ? '' : height + 'px')
    if (!spec.scroll) set(dom, last, 'left', 'left', (spec.cover ? 0 : gw) + 'px')
    const indent = spec.indent ?? !!spec.actions?.length
    let pad = ''
    if (indent) {
      const text = editor.doc.line(line)
      pad = `calc(var(--jc-pad-x) + ${editor.coordsAtPos({ line, col: indentLength(text) }).x}px)`
    }
    set(dom, last, 'pad', 'padding-left', pad)
    if (z.margin && !away) {
      const m = z.margin.style
      m.transform = `translateY(${top}px)`
      m.width = gw + 'px'
      m.height = height + 'px'
      m.lineHeight = Math.min(height, lh) + 'px'
    }
  }
}

/**
 * Adds an element between lines (above or below `line`) that takes room of
 * its own: the lines below move down. See {@link ZoneSpec}.
 */
export function addZone(editor: Editor, spec: ZoneSpec): Zone {
  const st = state(editor)
  const z = new ZoneImpl(editor, st, spec)
  st.zones.push(z)
  if (z.auto) st.resize?.observe(z.dom)
  syncGaps(editor, st)
  drawZones(editor, st)
  editor.requestRender()
  return z
}

/** The zones of an editor, in the order they were added. */
export function getZones(editor: Editor): readonly Zone[] {
  return states.get(editor)?.zones ?? []
}

// ---------------------------------------------------------------------------

class WidgetImpl implements Widget {
  readonly dom: HTMLElement
  editor: Editor
  st: State
  spec: WidgetSpec
  at: Pos
  version: number

  constructor(editor: Editor, st: State, spec: WidgetSpec) {
    this.editor = editor
    this.st = st
    this.spec = { ...spec }
    this.at = editor.doc.clamp(spec.pos)
    this.version = editor.version
    this.dom = editor.dom.ownerDocument.createElement('div')
    this.fill()
  }

  get pos(): Pos {
    return this.at
  }

  fill(): void {
    classes(this.dom, 'jc-content-widget jc-ui', this.spec.class)
    this.dom.replaceChildren()
    const el = build(this.editor, this.spec.content, 'jc-widget-text')
    if (el) this.dom.appendChild(el)
  }

  update(patch: Partial<WidgetSpec>): void {
    if (!this.st.widgets.includes(this)) return
    this.spec = { ...this.spec, ...patch }
    if (patch.pos) {
      this.at = this.editor.doc.clamp(patch.pos)
      this.version = this.editor.version
    }
    if ('content' in patch || 'class' in patch) this.fill()
    drawWidgets(this.editor, this.st)
    this.editor.requestRender()
  }

  remove(): void {
    const i = this.st.widgets.indexOf(this)
    if (i < 0) return
    this.st.widgets.splice(i, 1)
    this.dom.remove()
    this.editor.requestRender()
  }
}

function drawWidgets(editor: Editor, st: State): void {
  const layer = st.floating
  const { from, to } = editor.visibleRange
  const sc = editor.scrollDOM.getBoundingClientRect()
  for (const w of st.widgets) {
    const { dom, at } = w
    if (dom.parentNode !== layer) layer.appendChild(dom)
    const hide = at.line < from || at.line > to || editor.isLineHidden(at.line)
    dom.style.display = hide ? 'none' : ''
    if (hide) continue
    const c = editor.coordsAtPos(at)
    const h = dom.offsetHeight
    let above = (w.spec.place ?? 'above') === 'above'
    // No room on screen on the preferred side: the other one.
    if (above && editor.contentToClient(c.x, c.top - h).y < sc.top) above = false
    else if (!above && editor.contentToClient(c.x, c.bottom + h).y > sc.bottom && editor.contentToClient(c.x, c.top - h).y >= sc.top) above = true
    dom.classList.toggle('jc-widget-below', !above)
    dom.style.transform = `translate(${c.x}px,${above ? c.top - h : c.bottom}px)`
  }
}

/** Adds an element floating next to a position (above or below its line), taking no room. See {@link WidgetSpec}. */
export function addWidget(editor: Editor, spec: WidgetSpec): Widget {
  const st = state(editor)
  const w = new WidgetImpl(editor, st, spec)
  st.widgets.push(w)
  drawWidgets(editor, st)
  editor.requestRender()
  return w
}

// ---------------------------------------------------------------------------

const overlayBoxes = new WeakMap<Editor, HTMLElement>()

/** The container of the overlays: the visible area of the text (between the gutters and the scrollbars). */
function overlayBox(editor: Editor): HTMLElement {
  let box = overlayBoxes.get(editor)
  if (box) return box
  box = editor.dom.ownerDocument.createElement('div')
  box.className = 'jc-overlays'
  editor.dom.appendChild(box)
  overlayBoxes.set(editor, box)
  injectStyle(editor.dom, 'widgets', WIDGETS_CSS)
  const b = box
  const place = () => {
    const sc = editor.scrollDOM
    b.style.top = sc.offsetTop + 'px'
    b.style.left = sc.offsetLeft + editor.gutterWidth + 'px'
    b.style.width = Math.max(0, sc.clientWidth - editor.gutterWidth) + 'px'
    b.style.height = sc.clientHeight + 'px'
  }
  editor.untracked(() => {
    // Sizes change with the scroller (its scrollbars) and the gutters (line numbers get a digit).
    let gutter = -1
    editor.on('render', () => {
      if (editor.gutterWidth !== gutter) {
        gutter = editor.gutterWidth
        place()
      }
    })
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(place)
      ro.observe(editor.scrollDOM)
      editor.on('destroy', () => ro.disconnect())
    }
  })
  place()
  return box
}

/** Adds an element fixed in a corner (or edge) of the editor's visible area. See {@link OverlaySpec}. */
export function addOverlay(editor: Editor, spec: OverlaySpec): Overlay {
  const box = overlayBox(editor)
  let current = { ...spec }
  const dom = editor.dom.ownerDocument.createElement('div')
  const fill = () => {
    classes(dom, 'jc-overlay jc-ui', current.class)
    dom.dataset.position = current.position ?? 'top-right'
    dom.replaceChildren()
    const el = build(editor, current.content, 'jc-overlay-text')
    if (el) dom.appendChild(el)
  }
  fill()
  box.appendChild(dom)
  return {
    dom,
    update(patch) {
      current = { ...current, ...patch }
      fill()
    },
    remove() {
      dom.remove()
    },
  }
}

const WIDGETS_CSS = `
.jc-zone{position:absolute;top:0;left:0;right:0;padding:0 var(--jc-pad-x);overflow:hidden;pointer-events:auto;cursor:auto;
user-select:text;-webkit-user-select:text;white-space:normal}
.jc-zone-scroll{left:calc(-1 * var(--jc-pad-x))}
.jc-zone-text{white-space:pre-wrap;line-height:var(--jc-lh)}
.jc-zone-gutter{position:absolute;top:0;left:0;overflow:hidden;pointer-events:auto;text-align:right;padding-right:10px;color:var(--jc-gutter-foreground)}
.jc-zone-actions{display:flex;flex-wrap:wrap;align-items:center;min-height:var(--jc-lh);font-family:var(--jc-ui-font,system-ui,-apple-system,'Segoe UI',sans-serif);
font-size:.82em;line-height:1.5;color:color-mix(in srgb,var(--jc-fg) 55%,transparent)}
.jc-zone-action{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;border-radius:3px}
.jc-zone-action:hover,.jc-zone-action:focus-visible{color:var(--jc-caret);text-decoration:underline;outline:none}
.jc-zone-sep{padding:0 .5em;opacity:.45}
.jc-content-widget{position:absolute;top:0;left:0;pointer-events:auto;cursor:auto;white-space:nowrap}
.jc-widget-text,.jc-overlay-text{padding:2px 8px;border-radius:6px;font:12px/1.5 var(--jc-ui-font,system-ui,-apple-system,sans-serif);
color:var(--jc-fg);background:color-mix(in srgb,var(--jc-bg) 88%,var(--jc-fg));border:1px solid color-mix(in srgb,var(--jc-fg) 16%,transparent)}
.jc-overlays{position:absolute;pointer-events:none;z-index:9}
.jc-overlay{position:absolute;margin:8px;pointer-events:auto}
.jc-overlay[data-position=top-right]{top:0;right:0}
.jc-overlay[data-position=top-left]{top:0;left:0}
.jc-overlay[data-position=bottom-right]{bottom:0;right:0}
.jc-overlay[data-position=bottom-left]{bottom:0;left:0}
.jc-overlay[data-position=top]{top:0;left:50%;transform:translateX(-50%)}
.jc-overlay[data-position=bottom]{bottom:0;left:50%;transform:translateX(-50%)}
`
