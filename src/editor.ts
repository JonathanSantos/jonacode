import {
  defaultKeymap, deleteCharBackward, deleteCharForward, deleteLine, deleteWordBackward, deleteWordForward, insertNewline,
  redo, undo,
} from './commands.ts'
import { compileKeymap, eventKeyNames, isMac, runKeymap, type CompiledKeymap, type KeyBinding } from './keymap.ts'
import { matchBracket } from './language/brackets.ts'
import { Highlighter } from './language/highlighter.ts'
import { innerLanguage, plainText, type Language, type State, type Token } from './language/language.ts'
import { History, invertChanges, type HistoryEntry } from './state/history.ts'
import {
  cursor, eqSelections, isEmpty, mapRange, mapSelection, normalizeSelection, selFrom, selTo, toEditorSelection,
  type EditorSelection, type Selection, type SelectionInput,
} from './state/selection.ts'
import { changeEnd, cmpPos, spliceArray, splitLines, TextDocument, type Change, type ChangeSpec, type Pos } from './state/text.ts'
import { tokenClass, type Theme } from './theme/theme.ts'
import { oneDark } from './themes/one-dark.ts'
import {
  clusterAround, columnAtVisual, escapeHTML, indentLength, isSimpleLine, visualColumn, wordRangeAt,
} from './util/text.ts'
import { columnAtWidth, HeightMap, rowOfColumn, textWidth, wrapLine, type Advances } from './view/layout.ts'
import { BASE_CSS, injectStyle } from './view/style.ts'

// ---------------------------------------------------------------------------
// Public types

export interface EditorOptions {
  /** Initial content. */
  value?: string
  /** Language used for highlighting. Defaults to plain text. */
  language?: Language
  /** Theme. Defaults to One Dark. */
  theme?: Theme
  /** Extensions (line numbers, bracket matching…). See `basicSetup()`. */
  extensions?: Extension
  /** Width of a tab / indentation unit. Default 2. */
  tabSize?: number
  /** Indent with spaces (default) or tabs. */
  insertSpaces?: boolean
  readOnly?: boolean
  /** Wrap long lines at the editor width instead of scrolling horizontally. Default false. */
  lineWrapping?: boolean
  /** Text shown while the document is empty. */
  placeholder?: string
  /**
   * Minimum height, in lines. Without a fixed height on the parent the editor
   * grows with its content — and still only renders the lines on screen.
   */
  minLines?: number
  /** Maximum height, in lines: past it the editor scrolls instead of growing. */
  maxLines?: number
  /** Font size (number = px). */
  fontSize?: number | string
  fontFamily?: string
  /** Line height (number = multiplier of the font size, or a CSS length). Default 1.6. */
  lineHeight?: number | string
  autofocus?: boolean
  /** Extra class for the root element. */
  className?: string
  /** Accessible label of the editor. */
  ariaLabel?: string
  /** Translations of UI texts (touch toolbar, search panel…), e.g. `{ Copy: 'Copiar' }`. */
  phrases?: Record<string, string>
  /** Called after every document change with the new value. */
  onChange?: (value: string, event: ChangeEvent) => void
}

export interface ResolvedOptions {
  tabSize: number
  insertSpaces: boolean
  readOnly: boolean
  lineWrapping: boolean
  placeholder: string
  minLines: number
  maxLines: number
}

export interface Transaction {
  /** Changes applied in order; each position refers to the document after the previous change. */
  changes?: ChangeSpec | readonly ChangeSpec[]
  /** New selection: a range, a position or `{ ranges, main }`. When omitted the current one is mapped through the changes. */
  selection?: SelectionInput
  /** Label of the change, e.g. `input`, `delete.backward`, `input.paste`. Used for undo grouping. */
  origin?: string
  scrollIntoView?: boolean | 'center'
  /** Record in the undo history (default true). `false` clears the history. */
  history?: boolean
}

/** What `changeByRange` expects for each range. */
export interface RangeChange {
  /** Changes, in the coordinates of the document as the callback sees it. */
  changes?: ChangeSpec | readonly ChangeSpec[]
  /** The range after these changes. */
  range: Selection
}

export interface ChangeEvent {
  changes: readonly Change[]
  origin: string
}

export interface EditorEvents {
  change: (event: ChangeEvent, editor: Editor) => void
  /** Fired with the main range when the selection changes. */
  selection: (selection: Selection, editor: Editor) => void
  focus: (editor: Editor) => void
  blur: (editor: Editor) => void
  scroll: (editor: Editor) => void
  render: (editor: Editor) => void
  /** Folded (hidden) line ranges changed. */
  fold: (folds: readonly FoldRange[], editor: Editor) => void
  destroy: (editor: Editor) => void
}

/** Lines `from..to` (inclusive) are hidden under line `from - 1`. */
export interface FoldRange {
  from: number
  to: number
}

/** Empty space above and/or below a line: room for block widgets and zones. */
export interface LineGap {
  line: number
  /** Space above the line, in rows (line heights), or in px with `px`. */
  above?: number
  /** Space below the line, in rows (line heights), or in px with `px`. */
  below?: number
  /** `above` / `below` are px (rows follow the font size; px don't). */
  px?: boolean
}

/**
 * An extension is a function that receives the editor and uses its API
 * (`addKeymap`, `addLayer`, `addGutter`, `on`…). It may return a cleanup
 * function. Arrays of extensions are flattened.
 */
export type Extension = ((editor: Editor) => void | (() => void)) | readonly Extension[] | null | undefined | false

/** Handles typed text before the default insertion. Return true to stop it. */
export type InputHandler = (editor: Editor, text: string) => boolean

/**
 * Rewrites the tokens of a line before painting (split, retype, style…).
 * Must be a pure function of the text and tokens.
 */
export type TokenTransform = (text: string, tokens: Token[]) => Token[]

export type GutterCell = string | null | { text: string; className?: string }

export interface GutterSpec {
  className?: string
  /** CSS width of the gutter (re-read on every render). */
  width?: (editor: Editor) => string
  /** Content of the cell of a line. */
  cell: (line: number, editor: Editor) => GutterCell
  /** Mouse down on a cell. Return true to prevent the default (select the line). */
  onMouseDown?: (line: number, event: MouseEvent, editor: Editor) => boolean | void
}

export interface LayerSpec {
  className?: string
  /** Draw above the text (default: below). */
  above?: boolean
  /** Stacking order among layers of the same side. Selection is 0. */
  order?: number
  /**
   * Doesn't scroll sideways with the text (zones, banners): x = 0 is the left
   * edge of the editor's visible area (over the gutters, see `gutterWidth`),
   * and the layer is as wide as that area. Drawn above the text and gutters.
   */
  fixed?: boolean
  /** Called on every view update. Coordinates come from `editor.coordsAtPos` / `editor.rangeRects`. */
  render: (dom: HTMLElement, editor: Editor) => void
}

/**
 * Checks changes before they are committed (after they were computed, in
 * order: each one in the coordinates left by the previous). Return false to
 * reject the whole transaction — nothing is applied and no event fires.
 */
export type ChangeFilter = (changes: readonly Change[], origin: string, editor: Editor) => boolean

/** Takes over undo / redo (collaboration: undo only your own changes, through the shared document). */
export interface UndoProvider {
  undo(): boolean
  redo(): boolean
  canUndo?(): boolean
  canRedo?(): boolean
}

/** Runs before the default mouse handling; return true to skip it. */
export type MouseHandler = (event: MouseEvent, editor: Editor) => boolean

/** Mouse modifiers that create extra cursors (`add`) or a column selection (`rect`). */
export type CursorModifier = { kind: 'add' | 'rect'; test: (event: MouseEvent) => boolean }

export interface Coords {
  x: number
  top: number
  bottom: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// ---------------------------------------------------------------------------

const PAD_X = 12
const PAD_Y = 8
/**
 * Browsers cap element heights (Firefox at ~17.9M px, others at ~33.5M px).
 * Taller documents are drawn in "compressed" mode: the scrollable height is
 * capped and positions are mapped (see `offset`).
 */
const MAX_HEIGHT = 10_000_000
const PROBE_CHARS = 200
const HTML_CACHE_SIZE = 2500
const SENTINEL = '​'
/** Lines mirrored into the textarea for screen readers, and a cap for long lines. */
const MIRROR_PAGE = 10
const MIRROR_MAX = 4000

interface LineView {
  el: HTMLDivElement
  text: string
  stateId: number
  layout: number
  top: number
}
interface CellView { el: HTMLDivElement; text: string; cls: string; top: number }
interface GutterView { spec: GutterSpec; el: HTMLDivElement; cells: Map<number, CellView>; width: string }
interface LayerView { spec: LayerSpec; el: HTMLDivElement }
interface KeymapEntry { map: CompiledKeymap; prec: number }

type AnyListener = (...args: unknown[]) => void

function once(fn: () => void): () => void {
  let done = false
  return () => {
    if (!done) { done = true; fn() }
  }
}

/** Lengths of the common prefix and suffix of two strings (not overlapping). */
function affixes(a: string, b: string): [number, number] {
  const max = Math.min(a.length, b.length)
  let p = 0
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++
  let q = 0
  while (q < max - p && a.charCodeAt(a.length - 1 - q) === b.charCodeAt(b.length - 1 - q)) q++
  return [p, q]
}

function endOfInsert(from: Pos, text: string): Pos {
  const lines = splitLines(text)
  return lines.length === 1
    ? { line: from.line, col: from.col + lines[0]!.length }
    : { line: from.line + lines.length - 1, col: lines[lines.length - 1]!.length }
}

/**
 * X offset (px) of a column inside a rendered line, measured with a DOM Range.
 * `side` picks the end of the previous text node (-1) or the start of the next
 * one (1) at node boundaries, which matters at soft-wrap breaks.
 */
function measureX(lineEl: HTMLElement, col: number, side: -1 | 1 = 1): number {
  const doc = lineEl.ownerDocument
  const walker = doc.createTreeWalker(lineEl, 4 /* SHOW_TEXT */)
  let rest = col
  let node: Text | null
  let last: Text | null = null
  while ((node = walker.nextNode() as Text | null)) {
    const len = node.data.length
    if (side < 0 ? rest <= len : rest < len) break
    rest -= len
    last = node
  }
  if (!node) {
    if (!last) return 0
    node = last
    rest = last.data.length
  }
  const range = doc.createRange()
  range.setStart(node, rest)
  range.setEnd(node, rest)
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
  const line = lineEl.getBoundingClientRect()
  return (rect.left - line.left) / scaleOf(lineEl, line)
}

/** Horizontal scale applied by CSS transforms (1 when untransformed). */
/**
 * CSS scale of an element (a transformed ancestor). `offsetWidth` is rounded
 * while the rect isn't: differences under a pixel are rounding, not scale
 * (a fake 1.0008 used to push clicks deep in long documents off by lines).
 */
function scaleOf(el: HTMLElement, rect: DOMRect): number {
  const w = el.offsetWidth
  return w && Math.abs(rect.width - w) >= 1 ? rect.width / w : 1
}

export class Editor {
  /** Root element. */
  readonly dom: HTMLDivElement
  /** The scroll container. */
  readonly scrollDOM: HTMLDivElement
  /** Origin of the text coordinates (`coordsAtPos` is relative to it). */
  readonly contentDOM: HTMLDivElement
  /** Hidden textarea receiving keyboard / IME / clipboard input. */
  readonly inputDOM: HTMLTextAreaElement
  readonly doc: TextDocument
  readonly options: ResolvedOptions
  /** Incremented on every document change. */
  version = 0

  private sizer: HTMLDivElement
  private gutterBox: HTMLDivElement
  private content: HTMLDivElement
  private linesDOM: HTMLDivElement
  private layersBelow: HTMLDivElement
  private layersAbove: HTMLDivElement
  /** Container of the `fixed` layers (created on first use), and its width. */
  private fixedDOM: HTMLDivElement | null = null
  private fixedW = -1
  private probe: HTMLDivElement
  private cursorEls: HTMLDivElement[] = []
  private placeholderEl: HTMLDivElement | null = null

  private _sel: EditorSelection = { ranges: [cursor({ line: 0, col: 0 })], main: 0 }
  private _language: Language
  private _theme: Theme
  private hl: Highlighter
  private history = new History()
  private undoProvider: UndoProvider | null = null
  private onChangeOption: EditorOptions['onChange']
  private phrases: Record<string, string>

  private lh = 20
  /** Advance of `x`, and of a digit (px). */
  private cw = 0
  private dw = 0
  /**
   * Monospace font whose bold and italic are as wide: a column is `cw` px and
   * ASCII lines are placed by arithmetic. Otherwise (proportional fonts, or a
   * bold the browser synthesizes wider) rendered lines are measured.
   */
  private fixed = true
  /** Char widths in columns, for wrapping and widths (see `measure`). */
  private adv: Advances = { ascii: null, wide: 2, max: 2 }
  /** Width of the gutters (px), re-read when it may have changed. */
  private gutterW = 0
  private gutterDirty = true
  /** Bumped when the font metrics change. */
  private metricsVersion = 0
  private lineViews = new Map<number, LineView>()
  private gutters: GutterView[] = []
  private layers: LayerView[] = []
  private keymaps: KeymapEntry[] = []
  private inputHandlers: InputHandler[] = []
  private tokenTransforms: TokenTransform[] = []
  private cursorModifiers: CursorModifier[] = []
  private mouseHandlers: MouseHandler[] = []
  private changeFilters: ChangeFilter[] = []
  private listeners = new Map<string, Set<AnyListener>>()
  private extDisposers: (() => void)[] = []
  private collecting: (() => void)[] | null = null
  private disposers: (() => void)[] = []
  private resizeObserver: ResizeObserver | null = null

  // Wrapping: break offsets per line and the resulting row heights.
  private breaks: (number[] | null)[] = []
  private heights = new HeightMap()
  private wrapCols = 0
  /** Bumped whenever the painted output of a line may change without its text changing. */
  private layoutVersion = 0
  private htmlCache = new Map<string, string>()

  private viewFrom = 0
  private viewTo = -1
  private rafId = 0
  /** Pending background highlighting (idle callback or timeout id). */
  private hlTask: (() => void) | null = null
  private widthTimer: ReturnType<typeof setTimeout> | null = null
  /** Pending scroll; `page`: may scroll the page too (explicit requests, or edits while focused). */
  private scrollTarget: { pos: Pos | null; center: boolean; page: boolean } | null = null
  private focused = false
  private composing = false
  private userEvent = false
  private touchInput = false
  private maxCols = 0
  private lastHeight = -1
  /** Uncompressed content height (px). */
  private realHeight = 0
  /** Compressed mode: the content is taller than `MAX_HEIGHT`. */
  private big = false
  /** Compressed mode: the real y shown at the top of the visible slice… */
  private bigTop = 0
  /** …and the DOM y (scroll position) it was derived from. */
  private bigSeen = -1
  /** DOM y = real y + `offset` for the lines rendered now (0 unless compressed). */
  private offset = 0
  private lastWidth = -1
  private lastSelectionHTML = ''
  private activeLinesCache: { sel: EditorSelection; lines: Set<number> } | null = null
  private dragCleanup: (() => void) | null = null
  private destroyed = false
  private lastLimits = '/'
  /** Hidden line ranges, sorted and disjoint. */
  private _folds: FoldRange[] = []
  /** Row counts must be rebuilt (folds removed by an edit or a cursor). */
  private heightsDirty = false
  /** Named sets of line gaps, and their sum per line (px). */
  private gapSets = new Map<string, LineGap[]>()
  private gaps = new Map<number, { above: number; below: number }>()
  /** What the textarea holds (outside touch mode): the doc text from `from`, and the selection in it. */
  private mirror = { text: '', from: { line: 0, col: 0 } as Pos, start: 0, end: 0 }
  private compositionEl: HTMLDivElement | null = null
  private mirrorDesc = ''
  /** The whole field was selected from outside: the next native edit replaces the whole document. */
  private fieldAll = false
  /** Escape was just pressed: the next Tab moves the focus instead of indenting. */
  private tabEscape = false
  /** True while the editor is taller than the window and virtualizes against it. */
  private pageVirtual = false
  private clipParents: Element[] | null = null
  private pageScroll: ScrollLogicalPosition | null = null

  constructor(parent: HTMLElement, options: EditorOptions = {}) {
    const doc = parent.ownerDocument
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, into?: HTMLElement) => {
      const e = doc.createElement(tag)
      e.className = cls
      into?.appendChild(e)
      return e
    }

    this.doc = new TextDocument(options.value ?? '')
    this._language = options.language ?? plainText
    this._theme = options.theme ?? oneDark
    this.options = {
      tabSize: options.tabSize ?? 2,
      insertSpaces: options.insertSpaces ?? true,
      readOnly: options.readOnly ?? false,
      lineWrapping: options.lineWrapping ?? false,
      placeholder: options.placeholder ?? '',
      minLines: options.minLines ?? 0,
      maxLines: options.maxLines ?? 0,
    }
    this.onChangeOption = options.onChange
    this.phrases = options.phrases ?? {}
    this.hl = new Highlighter(this._language, this.doc)

    this.dom = el('div', 'jc-editor')
    this.scrollDOM = el('div', 'jc-scroller', this.dom)
    this.sizer = el('div', 'jc-sizer', this.scrollDOM)
    this.gutterBox = el('div', 'jc-gutters', this.sizer)
    this.gutterBox.style.display = 'none'
    // Screen readers get the text from the textarea; line numbers are decoration.
    this.gutterBox.setAttribute('aria-hidden', 'true')
    this.content = el('div', 'jc-content', this.sizer)
    this.contentDOM = el('div', 'jc-view', this.content)
    this.layersBelow = el('div', 'jc-layer jc-layer-below', this.contentDOM)
    this.linesDOM = el('div', 'jc-lines', this.contentDOM)
    this.layersAbove = el('div', 'jc-layer jc-layer-above', this.contentDOM)
    // Measures the font where the lines are (same inherited styles), in a clipped box so it adds no scrollable overflow.
    this.probe = el('div', 'jc-probe', el('div', 'jc-probe-box', this.linesDOM))
    const x = 'x'.repeat(PROBE_CHARS)
    // x, a mix (monospace?), bold and italic (as wide?), digits (line numbers); then wide chars, on a row of their own.
    this.probe.innerHTML = `<div><span>${x}</span><span>${'iW.m'.repeat(PROBE_CHARS / 4)}</span><b>${x}</b><i>${x}</i><span>${'0'.repeat(PROBE_CHARS)}</span></div>` +
      `<div><span>${'漢'.repeat(20)}</span><span>${'😀'.repeat(20)}</span></div>`
    this.probe.parentElement!.setAttribute('aria-hidden', 'true')
    this.inputDOM = el('textarea', 'jc-input', this.contentDOM)
    for (const [k, v] of [['autocapitalize', 'off'], ['autocomplete', 'off'], ['autocorrect', 'off'],
      ['spellcheck', 'false'], ['wrap', 'off'], ['enterkeyhint', 'enter'], ['aria-multiline', 'true'],
      ['aria-roledescription', 'code editor']]) {
      this.inputDOM.setAttribute(k!, v!)
    }
    this.inputDOM.setAttribute('aria-label', options.ariaLabel ?? 'Code editor')

    const style = this.dom.style
    style.setProperty('--jc-pad-x', PAD_X + 'px')
    style.setProperty('--jc-lh', this.lh + 'px')
    style.setProperty('--jc-tab-size', String(this.options.tabSize))
    this.applyFont(options)
    this.dom.classList.add(this._theme.className)
    if (options.className) this.dom.classList.add(...options.className.split(/\s+/).filter(Boolean))
    this.dom.classList.toggle('jc-wrap', this.options.lineWrapping)
    this.setReadOnlyState(this.options.readOnly)

    parent.appendChild(this.dom)
    injectStyle(this.dom, 'base', BASE_CSS)
    injectStyle(this.dom, this._theme.className, this._theme.css)

    this.keymaps.push({ map: compileKeymap(defaultKeymap), prec: -1 })
    this.addLayer({ className: 'jc-selection-layer', order: 0, render: (dom) => this.drawSelection(dom) })
    this.bindEvents()
    this.installExtensions(options.extensions)
    this.maxCols = this.computeMaxCols()
    this.measure()
    this.render()
    if (options.autofocus) this.focus()
  }

  // -------------------------------------------------------------------------
  // State accessors

  /** The main selection range. */
  get selection(): Selection {
    return this._sel.ranges[this._sel.main]!
  }

  /** All selection ranges (one per cursor), sorted by position. */
  get ranges(): readonly Selection[] {
    return this._sel.ranges
  }

  /** Index of the main range in `ranges`. */
  get mainIndex(): number {
    return this._sel.main
  }

  /** The whole selection state `{ ranges, main }`. */
  get editorSelection(): EditorSelection {
    return this._sel
  }

  get language(): Language {
    return this._language
  }

  get theme(): Theme {
    return this._theme
  }

  get lineHeight(): number {
    return this.lh
  }

  /** Advance of `x` (px): the width of a column in monospace fonts. */
  get charWidth(): number {
    return this.cw || 8
  }

  /** Advance of a digit (px), e.g. for line numbers. Equal to `charWidth` in monospace fonts. */
  get digitWidth(): number {
    return this.dw || this.charWidth
  }

  /** Whether every column is `charWidth` px wide (a monospace font, with bold and italic as wide). */
  get monospace(): boolean {
    return this.fixed
  }

  /** Width of the gutters (line numbers, folding…) in px; 0 without gutters. */
  get gutterWidth(): number {
    return this.gutterW
  }

  get hasFocus(): boolean {
    return this.focused || (this.inputDOM.getRootNode() as unknown as DocumentOrShadowRoot).activeElement === this.inputDOM
  }

  /** Range of lines currently rendered (visible lines plus a margin). */
  get visibleRange(): { from: number; to: number } {
    return { from: this.viewFrom, to: this.viewTo }
  }

  /** The indentation unit: `tabSize` spaces, or a tab. */
  get indentUnit(): string {
    return this.options.insertSpaces ? ' '.repeat(this.options.tabSize) : '\t'
  }

  /** Translated UI text (see the `phrases` option). */
  phrase(text: string): string {
    return this.phrases[text] ?? text
  }

  /** Lines that contain a cursor. */
  get activeLines(): ReadonlySet<number> {
    if (this.activeLinesCache?.sel !== this._sel) {
      this.activeLinesCache = { sel: this._sel, lines: new Set(this._sel.ranges.map((r) => r.head.line)) }
    }
    return this.activeLinesCache.lines
  }

  getValue(): string {
    return this.doc.toString()
  }

  /** Replaces the whole document (resets the undo history, keeps the cursor when possible). */
  setValue(value: string): void {
    const oldEnd = this.doc.end
    const removed = this.doc.setText(value)
    this.hl.reset()
    this.history.clear()
    this.version++
    this.maxCols = this.computeMaxCols()
    const hadFolds = this._folds.length > 0
    this._folds = []
    this.resetWrap()
    if (hadFolds) this.emit('fold', this._folds, this)
    const doc = this.doc
    this._sel = normalizeSelection({
      ranges: this._sel.ranges.map((r) => ({ anchor: doc.clamp(r.anchor), head: doc.clamp(r.head) })),
      main: this._sel.main,
    })
    this.requestRender()
    const event: ChangeEvent = {
      changes: [{ from: { line: 0, col: 0 }, to: oldEnd, inserted: this.doc.lines.slice(), removed }],
      origin: 'setValue',
    }
    this.emit('change', event, this)
    this.onChangeOption?.(value, event)
  }

  /** Selected text of the main range (`all` joins every range with newlines). */
  getSelectedText(all = false): string {
    const ranges = all ? this._sel.ranges : [this.selection]
    return ranges.map((r) => this.doc.slice(selFrom(r), selTo(r))).join(this.doc.eol)
  }

  /** Sets a single range. */
  setSelection(anchor: Pos, head: Pos = anchor, scrollIntoView = true): void {
    this.dispatch({ selection: { anchor, head }, scrollIntoView, origin: 'select' })
  }

  /** Sets several ranges (multiple cursors). `main` defaults to the last one. */
  setSelections(ranges: readonly Selection[], main = ranges.length - 1, scrollIntoView = true): void {
    this.dispatch({ selection: { ranges, main }, scrollIntoView, origin: 'select' })
  }

  /** Replaces every range with `text` (cursors after it, or the text selected when `select`). */
  replaceSelection(text: string, origin = 'input', select = false): void {
    this.changeByRange((range) => {
      const from = selFrom(range)
      const end = endOfInsert(from, text)
      return { changes: { from, to: selTo(range), insert: text }, range: select ? { anchor: from, head: end } : cursor(end) }
    }, { origin, scrollIntoView: true })
  }

  /**
   * Appends text at the end of the document (logs, streams…), outside the
   * undo history by default. When the end was on screen, the view keeps
   * following it, like `tail -f` (`follow` forces either way).
   */
  append(text: string, options: { follow?: boolean; history?: boolean } = {}): void {
    if (!text) return
    const follow = options.follow ?? this.viewTo >= this.doc.lineCount - 1
    this.dispatch({ changes: { from: this.doc.end, insert: text }, origin: 'append', history: options.history ?? false })
    // The start of the last line: following a log shouldn't scroll sideways to its end. The page
    // only follows when the editor grows with it (then the end was on screen, or we wouldn't follow).
    if (follow) {
      this.scrollTarget = { pos: { line: this.doc.lineCount - 1, col: 0 }, center: false, page: this.pageVirtual }
      this.requestRender()
    }
  }

  /** Inserts text as if typed: runs input handlers (auto-close brackets…) and auto-outdent. */
  typeText(text: string): void {
    if (this.options.readOnly) return
    for (const handler of this.inputHandlers) if (handler(this, text)) return
    this.replaceSelection(text, 'input')
    this.autoOutdent(text)
  }

  /**
   * The language in effect at `pos`: the editor's language, or the one it
   * embeds there (JavaScript inside an HTML `<script>`, a Markdown fence…).
   * Commands use it for comments, indentation and auto-closed pairs.
   */
  languageAt(pos: Pos): Language {
    const lang = this._language
    if (!lang.nested) return lang
    const p = this.doc.clamp(pos)
    this.hl.ensure(p.line)
    return innerLanguage(lang, lang.stateAtColumn(this.doc.line(p.line), this.hl.stateAt(p.line), p.col))
  }

  /** Tokens of a line (highlighted with the current language, after token transforms). */
  getTokens(line: number): Token[] {
    this.hl.ensure(line)
    return this.lineTokens(this.doc.line(line), this.hl.stateAt(line))
  }

  private lineTokens(text: string, state: State): Token[] {
    let tokens = this._language.tokenize(text, state).tokens
    for (const transform of this.tokenTransforms) tokens = transform(text, tokens)
    return tokens
  }

  // -------------------------------------------------------------------------
  // Transactions

  dispatch(tr: Transaction): void {
    this.apply(tr, true)
  }

  /**
   * Runs `fn` for every range (in document order) and applies the changes it
   * returns. Each call sees the document with the previous ranges' changes
   * already applied, so commands can be written for a single cursor.
   */
  changeByRange(
    fn: (range: Selection, index: number) => RangeChange | null | undefined,
    opts: { origin?: string; scrollIntoView?: boolean | 'center'; history?: boolean } = {},
  ): void {
    if (this.destroyed) return
    const before = this._sel
    const applied: Change[] = []
    const results: { range: Selection; mark: number }[] = []
    let blocked = false
    before.ranges.forEach((original, i) => {
      if (blocked) return
      const range = mapRange(original, applied)
      const out = fn(range, i)
      if (out?.changes) {
        const specs = Array.isArray(out.changes) ? out.changes : [out.changes as ChangeSpec]
        if (specs.length && this.options.readOnly && this.userEvent) {
          blocked = true
          return
        }
        for (const spec of specs) {
          const c = this.applySpec(spec)
          if (c) applied.push(c)
        }
      }
      results.push({ range: out ? out.range : range, mark: applied.length })
    })
    if (blocked || !this.allowed(applied, opts.origin)) {
      this.rollback(applied)
      return
    }
    const ranges = results.map(({ range, mark }) => mapRange(range, applied.slice(mark), -1))
    this.commit(applied, before, { ranges, main: before.main }, opts, true)
  }

  private applySpec(spec: ChangeSpec): Change | null {
    let from = this.doc.clamp(spec.from)
    let to = spec.to ? this.doc.clamp(spec.to) : from
    if (cmpPos(from, to) > 0) [from, to] = [to, from]
    const insert = spec.insert ?? ''
    if (cmpPos(from, to) === 0 && (insert.length === 0 || (typeof insert !== 'string' && insert.length === 1 && !insert[0]))) {
      return null
    }
    const shrinks = this.touchesLongest(from.line, to.line)
    const change = this.doc.replace(from, to, insert)
    this.hl.applyChange(change)
    this.growWidth(change, shrinks)
    this.mapFolds(change)
    if (this.gapSets.size) this.mapGaps(change)
    this.updateWrap(change)
    return change
  }

  private allowed(applied: Change[], origin = 'api'): boolean {
    return !applied.length || this.changeFilters.every((f) => f(applied, origin, this))
  }

  /** Undoes changes applied by an aborted transaction (no events, no history). */
  private rollback(applied: Change[]): void {
    for (const spec of invertChanges(applied)) this.applySpec(spec)
  }

  private apply(tr: Transaction, record: boolean): Change[] {
    if (this.destroyed) return []
    const specs = tr.changes ? (Array.isArray(tr.changes) ? tr.changes : [tr.changes as ChangeSpec]) : []
    if (specs.length && this.options.readOnly && this.userEvent) return []
    const before = this._sel
    const applied: Change[] = []
    for (const spec of specs) {
      const c = this.applySpec(spec)
      if (c) applied.push(c)
    }
    if (!this.allowed(applied, tr.origin)) {
      this.rollback(applied)
      return []
    }
    const sel = tr.selection ? toEditorSelection(tr.selection) : mapSelection(before, applied)
    this.commit(applied, before, sel, tr, record)
    return applied
  }

  private commit(
    applied: Change[], before: EditorSelection, selection: EditorSelection,
    opts: { origin?: string; scrollIntoView?: boolean | 'center'; history?: boolean }, record: boolean,
  ): void {
    const doc = this.doc
    let sel = normalizeSelection({
      ranges: selection.ranges.map((r) => {
        const anchor = doc.clamp(r.anchor)
        const head = doc.clamp(r.head)
        return anchor === r.anchor && head === r.head ? r : { anchor, head, goalX: r.goalX }
      }),
      main: selection.main,
    })
    if (this._folds.length) sel = this.skipFolds(sel, before)
    const selChanged = !eqSelections(sel, before)
    this._sel = sel
    const origin = opts.origin ?? 'api'
    if (applied.length) {
      this.version++
      if (record && !this.undoProvider) {
        if (opts.history === false) this.history.clear()
        else this.history.record(applied, before, sel, origin)
      }
    }
    // Edits only pull the page towards the cursor while the editor has focus (like a textarea):
    // a demo typing into an unfocused editor must not fight the user's scrolling.
    if (opts.scrollIntoView) this.scrollTarget = { pos: null, center: opts.scrollIntoView === 'center', page: this.hasFocus }
    if (applied.length || selChanged) {
      for (const c of this.cursorEls) c.classList.toggle('jc-blink-alt')
      this.requestRender()
    }
    if (applied.length) {
      const event: ChangeEvent = { changes: applied, origin }
      this.emit('change', event, this)
      this.onChangeOption?.(this.getValue(), event)
    }
    if (selChanged) this.emit('selection', this.selection, this)
  }

  undo(): boolean {
    if (this.options.readOnly && this.userEvent) return false
    return this.undoProvider ? this.undoProvider.undo() : this.applyHistory(this.history.done, this.history.undone, 'undo')
  }

  redo(): boolean {
    if (this.options.readOnly && this.userEvent) return false
    return this.undoProvider ? this.undoProvider.redo() : this.applyHistory(this.history.undone, this.history.done, 'redo')
  }

  get canUndo(): boolean {
    return this.undoProvider ? (this.undoProvider.canUndo?.() ?? true) : this.history.done.length > 0
  }

  get canRedo(): boolean {
    return this.undoProvider ? (this.undoProvider.canRedo?.() ?? true) : this.history.undone.length > 0
  }

  /** Hands undo / redo to another history (null gives it back); the editor's own history stops recording. */
  setUndoProvider(provider: UndoProvider | null): void {
    this.undoProvider = provider
    this.history.clear()
  }

  private applyHistory(from: HistoryEntry[], to: HistoryEntry[], origin: string): boolean {
    const entry = from.pop()
    if (!entry) return false
    const applied = this.apply({ changes: invertChanges(entry.changes), selection: entry.before, origin, scrollIntoView: true }, false)
    if (!applied.length && entry.changes.length) {
      // Vetoed by a change filter: the step stays where it was.
      from.push(entry)
      return false
    }
    to.push({ changes: applied, before: entry.after, after: entry.before, origin, time: 0 })
    return true
  }

  // -------------------------------------------------------------------------
  // Options

  setOptions(opts: Partial<EditorOptions>): void {
    if ('language' in opts && (opts.language ?? plainText) !== this._language) {
      this._language = opts.language ?? plainText
      this.hl.reset(this._language)
      this.invalidateLines()
    }
    if (opts.theme && opts.theme !== this._theme) {
      this.dom.classList.remove(this._theme.className)
      this._theme = opts.theme
      injectStyle(this.dom, opts.theme.className, opts.theme.css)
      this.dom.classList.add(opts.theme.className)
      this.gutterDirty = true
    }
    if (opts.tabSize != null && opts.tabSize !== this.options.tabSize) {
      this.options.tabSize = opts.tabSize
      this.dom.style.setProperty('--jc-tab-size', String(opts.tabSize))
      this.maxCols = this.computeMaxCols()
      this.resetWrap()
    }
    if (opts.lineWrapping != null && opts.lineWrapping !== this.options.lineWrapping) {
      this.options.lineWrapping = opts.lineWrapping
      this.dom.classList.toggle('jc-wrap', opts.lineWrapping)
      this.wrapCols = 0
      this.resetWrap()
      this.lastWidth = -1
      this.invalidateLines()
    }
    if (opts.insertSpaces != null) this.options.insertSpaces = opts.insertSpaces
    if (opts.readOnly != null) this.setReadOnlyState(opts.readOnly)
    if (opts.placeholder != null) this.options.placeholder = opts.placeholder
    if (opts.minLines != null) this.options.minLines = opts.minLines
    if (opts.maxLines != null) this.options.maxLines = opts.maxLines
    if (opts.ariaLabel) this.inputDOM.setAttribute('aria-label', opts.ariaLabel)
    if ('onChange' in opts) this.onChangeOption = opts.onChange
    if (opts.phrases) this.phrases = opts.phrases
    if (opts.fontSize != null || opts.fontFamily != null || opts.lineHeight != null) {
      this.applyFont(opts)
      this.measure()
    }
    if ('extensions' in opts) this.setExtensions(opts.extensions)
    if (opts.value != null && opts.value !== this.getValue()) this.setValue(opts.value)
    this.requestRender()
  }

  private setReadOnlyState(readOnly: boolean): void {
    this.options.readOnly = readOnly
    this.inputDOM.readOnly = readOnly
    this.dom.classList.toggle('jc-readonly', readOnly)
  }

  private applyFont(opts: Partial<EditorOptions>): void {
    const s = this.dom.style
    if (opts.fontSize != null) s.setProperty('--jc-font-size', typeof opts.fontSize === 'number' ? opts.fontSize + 'px' : opts.fontSize)
    if (opts.fontFamily != null) s.setProperty('--jc-font-family', opts.fontFamily)
    if (opts.lineHeight != null) s.setProperty('--jc-line-height', String(opts.lineHeight))
  }

  // -------------------------------------------------------------------------
  // Extension API

  /** Replaces all extensions (their registrations are disposed first). */
  setExtensions(extensions: Extension): void {
    for (const dispose of this.extDisposers.splice(0).reverse()) dispose()
    this.installExtensions(extensions)
    this.requestRender()
  }

  private installExtensions(extensions: Extension): void {
    const collected: (() => void)[] = []
    this.collecting = collected
    const visit = (ext: Extension) => {
      if (!ext) return
      if (Array.isArray(ext)) (ext as readonly Extension[]).forEach(visit)
      else {
        const cleanup = (ext as (e: Editor) => void | (() => void))(this)
        if (typeof cleanup === 'function') collected.push(once(cleanup))
      }
    }
    try {
      visit(extensions)
    } finally {
      this.collecting = null
    }
    this.extDisposers = collected
  }

  /**
   * Runs `fn` without tying what it registers to the extension being
   * installed: for shared machinery installed lazily on first use
   * (decorations, tooltips), which must outlive that extension.
   */
  untracked<T>(fn: () => T): T {
    const collecting = this.collecting
    this.collecting = null
    try {
      return fn()
    } finally {
      this.collecting = collecting
    }
  }

  /** Registrations made while installing extensions are disposed with them. */
  private track(dispose: () => void): () => void {
    const d = once(dispose)
    this.collecting?.push(d)
    return d
  }

  private register<T>(list: T[], item: T, after?: () => void): () => void {
    list.push(item)
    after?.()
    return this.track(() => {
      const i = list.indexOf(item)
      if (i >= 0) list.splice(i, 1)
      after?.()
    })
  }

  on<K extends keyof EditorEvents>(type: K, listener: EditorEvents[K]): () => void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(listener as AnyListener)
    return this.track(() => set!.delete(listener as AnyListener))
  }

  private emit<K extends keyof EditorEvents>(type: K, ...args: Parameters<EditorEvents[K]>): void {
    const set = this.listeners.get(type)
    if (set) for (const fn of [...set]) fn(...args)
  }

  /** Adds key bindings, checked before the default ones (`high` goes before other extensions). */
  addKeymap(bindings: readonly KeyBinding[], precedence: 'default' | 'high' = 'default'): () => void {
    const entry: KeymapEntry = { map: compileKeymap(bindings), prec: precedence === 'high' ? 2 : 1 }
    return this.register(this.keymaps, entry, () => this.keymaps.sort((a, b) => b.prec - a.prec))
  }

  addInputHandler(handler: InputHandler): () => void {
    return this.register(this.inputHandlers, handler)
  }

  /** Adds a token transform (see `tokenRule`). Visible lines are repainted. */
  addTokenTransform(transform: TokenTransform): () => void {
    return this.register(this.tokenTransforms, transform, () => this.invalidateLines())
  }

  /** Handles mouse down before the editor (return true to skip the default behavior). */
  addMouseHandler(handler: MouseHandler): () => void {
    return this.register(this.mouseHandlers, handler)
  }

  /** Lets an extension veto changes (read-only ranges, limits…). See {@link ChangeFilter}. */
  addChangeFilter(filter: ChangeFilter): () => void {
    return this.register(this.changeFilters, filter)
  }

  /** Makes a mouse modifier add cursors (`add`) or select columns (`rect`). */
  addCursorModifier(modifier: CursorModifier): () => void {
    return this.register(this.cursorModifiers, modifier)
  }

  addGutter(spec: GutterSpec): () => void {
    const el = this.dom.ownerDocument.createElement('div')
    el.className = 'jc-gutter' + (spec.className ? ' ' + spec.className : '')
    const view: GutterView = { spec, el, cells: new Map(), width: '' }
    this.gutters.push(view)
    this.gutterBox.appendChild(el)
    this.gutterBox.style.display = ''
    this.gutterDirty = true
    this.requestRender()
    return this.track(() => {
      el.remove()
      this.gutters.splice(this.gutters.indexOf(view), 1)
      if (!this.gutters.length) this.gutterBox.style.display = 'none'
      this.gutterDirty = true
      this.requestRender()
    })
  }

  addLayer(spec: LayerSpec): () => void {
    const el = this.dom.ownerDocument.createElement('div')
    el.className = 'jc-layer' + (spec.className ? ' ' + spec.className : '')
    const view: LayerView = { spec, el }
    const parent = spec.fixed ? this.fixedLayers() : spec.above ? this.layersAbove : this.layersBelow
    const order = spec.order ?? 1
    const after = this.layers.find((l) => l.el.parentNode === parent && (l.spec.order ?? 1) > order)
    parent.insertBefore(el, after ? after.el : null)
    this.layers.push(view)
    this.layers.sort((a, b) => (a.spec.order ?? 1) - (b.spec.order ?? 1))
    this.requestRender()
    return this.track(() => {
      el.remove()
      this.layers.splice(this.layers.indexOf(view), 1)
    })
  }

  /**
   * The container of the `fixed` layers: sticky at the left of the scroller,
   * as wide as its visible area, and taking no room in the flow (a negative
   * margin), so it stays in view when the text scrolls sideways.
   */
  private fixedLayers(): HTMLDivElement {
    if (!this.fixedDOM) {
      this.fixedDOM = this.dom.ownerDocument.createElement('div')
      this.fixedDOM.className = 'jc-fixed'
      this.sizer.insertBefore(this.fixedDOM, this.gutterBox)
      this.fixedW = -1
    }
    return this.fixedDOM
  }

  /** Forces visible lines to be repainted (e.g. after changing a token transform's config). */
  invalidateLines(): void {
    this.layoutVersion++
    this.htmlCache.clear()
    this.requestRender()
  }

  // -------------------------------------------------------------------------
  // Geometry

  private get wrapping(): boolean {
    return this.options.lineWrapping && this.wrapCols > 0
  }

  /** Lines have different heights (wrapped rows, folded lines, gaps): positions come from the height map. */
  private get tall(): boolean {
    return this.wrapping || this._folds.length > 0 || this.gaps.size > 0
  }

  private breaksOf(line: number): readonly number[] | null {
    return this.wrapping ? (this.breaks[line] ?? null) : null
  }

  /** Top of a line's text (below its gap), relative to `contentDOM`. */
  private lineTop(line: number): number {
    const y = this.tall ? this.heights.before(line) + (this.gaps.get(line)?.above ?? 0) : this.lh * line
    return PAD_Y + y + this.offset
  }

  private lineAtY(y: number): number {
    const at = y - this.offset - PAD_Y
    const line = this.tall ? this.heights.lineAtRow(at) : Math.floor(at / this.lh)
    return Math.max(0, Math.min(this.doc.lineCount - 1, line))
  }

  /** Rows of text of a line: wrapped rows, 0 when folded. */
  private textRows(line: number): number {
    if (this._folds.length && this.isLineHidden(line)) return 0
    const b = this.breaksOf(line)
    return b ? b.length + 1 : 1
  }

  /** Height of a line in the height map (px): its text rows plus its gaps. */
  private heightOf(line: number): number {
    const rows = this.textRows(line)
    const g = rows ? this.gaps.get(line) : undefined
    return rows * this.lh + (g ? g.above + g.below : 0)
  }

  /** Vertical extent of a line's text (several rows when wrapped). */
  lineBlock(line: number): { top: number; height: number } {
    const l = Math.max(0, Math.min(this.doc.lineCount - 1, line))
    return { top: this.lineTop(l), height: this.lh * this.textRows(l) }
  }

  /** The gap (in px, relative to `contentDOM`) above or below a line; height 0 when there is none. */
  gapBlock(line: number, side: 'above' | 'below'): { top: number; height: number } {
    const { top, height } = this.lineBlock(line)
    const g = height ? this.gaps.get(line) : undefined
    const h = g ? g[side] : 0
    return { top: side === 'above' ? top - h : top + height, height: h }
  }

  /**
   * Reserves empty space above/below lines, where block widgets (inline
   * diffs, suggestions, comments…) and zones are drawn — see block
   * decorations and `addZone`. Each named set replaces its previous gaps;
   * gaps move with their lines as text is edited.
   */
  setLineGaps(key: string, gaps: readonly LineGap[]): void {
    const before = this.gaps
    const list = gaps.filter((g) => (g.above ?? 0) > 0 || (g.below ?? 0) > 0)
    if (list.length) this.gapSets.set(key, list)
    else if (!this.gapSets.delete(key)) return
    const wasTall = this.tall
    this.mergeGaps()
    const after = this.gaps
    const same = (a?: { above: number; below: number }, b?: { above: number; below: number }) => a?.above === b?.above && a?.below === b?.below
    const lines = new Set([...before.keys(), ...after.keys()])
    const changed = [...lines].filter((l) => !same(before.get(l), after.get(l)))
    if (!changed.length) return
    if (!wasTall) this.rebuildHeights()
    else if (this.tall) for (const l of changed) if (l < this.doc.lineCount) this.heights.set(l, this.heightOf(l))
    this.lastHeight = -1
    this.requestRender()
  }

  /** Sums the gap sets per line, in px. */
  private mergeGaps(): void {
    const merged = new Map<number, { above: number; below: number }>()
    const last = this.doc.lineCount - 1
    for (const list of this.gapSets.values()) {
      for (const g of list) {
        const line = Math.max(0, Math.min(last, g.line))
        const unit = g.px ? 1 : this.lh
        const m = merged.get(line) ?? { above: 0, below: 0 }
        m.above += (g.above ?? 0) * unit
        m.below += (g.below ?? 0) * unit
        merged.set(line, m)
      }
    }
    this.gaps = merged
  }

  /**
   * Keeps gaps with their lines when lines are inserted or removed (their
   * owners usually re-set them after): a gap above a line follows its start,
   * one below follows its end — Enter at the start of a line pushes the line
   * and the gap above it down, Enter at its end leaves the gap below it.
   */
  private mapGaps(change: Change): void {
    const start = change.from.line
    const end = change.to.line
    const lastNew = start + change.inserted.length - 1
    const delta = lastNew - end
    // Edits inside a line (typing) move nothing.
    if (!delta && start === end) return
    const insertion = cmpPos(change.from, change.to) === 0
    const above = (l: number) => (l < start || (l === start && change.from.col > 0) ? l : l > end ? l + delta : lastNew)
    // Typing at the very end of a line keeps what's below it there.
    const atEnd = insertion && this.doc.line(lastNew).length === changeEnd(change).col
    const below = (l: number) => (l < start ? l : l > end ? l + delta : l < end ? start : atEnd ? l : lastNew)
    let moved = false
    for (const [key, list] of this.gapSets) {
      const out: LineGap[] = []
      for (const g of list) {
        const a = g.above ? above(g.line) : g.line
        const b = g.below ? below(g.line) : g.line
        if (a === g.line && b === g.line) out.push(g)
        else if (a === b) out.push({ ...g, line: a })
        else out.push({ line: a, above: g.above, px: g.px }, { line: b, below: g.below, px: g.px })
        if (a !== g.line || b !== g.line) moved = true
      }
      if (moved) this.gapSets.set(key, out)
    }
    if (moved) this.mergeGaps()
  }

  /** Coordinates of a position, relative to `contentDOM`. */
  coordsAtPos(pos: Pos): Coords {
    const line = Math.max(0, Math.min(this.doc.lineCount - 1, pos.line))
    const breaks = this.breaksOf(line)
    const row = rowOfColumn(breaks, pos.col)
    const top = this.lineTop(line) + row * this.lh
    return { x: this.xAt(line, pos.col, row ? breaks![row - 1]! : 0), top, bottom: top + this.lh }
  }

  /** Document position closest to a point relative to `contentDOM`. */
  posAtCoords(x: number, y: number): Pos {
    const doc = this.doc
    const lastTop = this.lineBlock(doc.lineCount - 1)
    if (y >= lastTop.top + lastTop.height) return doc.end
    const line = this.lineAtY(y)
    const text = doc.line(line)
    if (!text) return { line, col: 0 }
    const breaks = this.breaksOf(line)
    let rowStart = 0
    let rowEnd = text.length
    if (breaks) {
      const row = Math.max(0, Math.min(breaks.length, Math.floor((y - this.lineTop(line)) / this.lh)))
      rowStart = row ? breaks[row - 1]! : 0
      rowEnd = row < breaks.length ? breaks[row]! : text.length
    }
    const lastRow = rowEnd === text.length
    let col: number
    if (x <= 0) col = rowStart
    else {
      const view = this.lineViews.get(line)
      const row = text.slice(rowStart, rowEnd)
      if (this.fixed && isSimpleLine(text)) col = rowStart + columnAtVisual(row, x / this.charWidth, this.options.tabSize)
      else if (!view || view.text !== text || !view.el.isConnected) {
        // Not rendered: estimated from the char widths.
        col = rowStart + columnAtWidth(row, x / this.charWidth, this.options.tabSize, this.adv)
      } else {
        let lo = rowStart
        let hi = rowEnd
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (measureX(view.el, mid) < x) lo = mid + 1
          else hi = mid
        }
        if (lo > rowStart && x - measureX(view.el, lo - 1) < measureX(view.el, lo, lo === rowEnd ? -1 : 1) - x) lo--
        col = lo
      }
    }
    // Past the end of a wrapped row: stay on that row.
    if (!lastRow && col >= rowEnd) col = rowEnd - 1
    // Never inside a character (emoji with modifiers, accents, flags): its nearer edge.
    const c = clusterAround(text, col)
    if (c) col = x - this.xAt(line, c[0], rowStart) <= this.xAt(line, c[1], rowStart) - x ? c[0] : c[1]
    return { line, col }
  }

  /** Document position under a viewport (client) point. */
  posAtClient(clientX: number, clientY: number): Pos {
    const { x, y } = this.clientToContent(clientX, clientY)
    return this.posAtCoords(x, y)
  }

  /** Converts viewport coordinates to `contentDOM` coordinates. */
  clientToContent(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.contentDOM.getBoundingClientRect()
    const scale = scaleOf(this.contentDOM, r)
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale }
  }

  /** Converts `contentDOM` coordinates to viewport (client) coordinates (scaled when an ancestor is). */
  contentToClient(x: number, y: number): { x: number; y: number } {
    const r = this.contentDOM.getBoundingClientRect()
    const scale = scaleOf(this.contentDOM, r)
    return { x: r.left + x * scale, y: r.top + y * scale }
  }

  /** X of `col` inside its visual row (which starts at `rowStart`). */
  private xAt(line: number, col: number, rowStart = 0, side: -1 | 1 = 1): number {
    if (col <= rowStart) return 0
    const text = this.doc.line(line)
    const row = rowStart ? text.slice(rowStart) : text
    if (this.fixed && isSimpleLine(text)) return visualColumn(row, col - rowStart, this.options.tabSize) * this.charWidth
    const view = this.lineViews.get(line)
    if (view && view.text === text && view.el.isConnected) return measureX(view.el, col, side)
    // Not rendered: estimated from the char widths.
    return textWidth(row, this.options.tabSize, this.adv, col - rowStart) * this.charWidth
  }

  /**
   * Rectangles (relative to `contentDOM`) covering `from..to`, one per visual
   * row, limited to the rendered lines. Used for selections and highlights.
   */
  rangeRects(from: Pos, to: Pos, extendEol = false): Rect[] {
    const out: Rect[] = []
    if (cmpPos(from, to) > 0) [from, to] = [to, from]
    const a = Math.max(from.line, this.viewFrom)
    const b = Math.min(to.line, this.viewTo)
    const lh = this.lh
    for (let line = a; line <= b; line++) {
      if (this._folds.length && this.isLineHidden(line)) continue
      const text = this.doc.line(line)
      const s = line === from.line ? from.col : 0
      const e = line === to.line ? to.col : text.length
      const eol = line !== to.line || extendEol
      const breaks = this.breaksOf(line) ?? []
      const top = this.lineTop(line)
      for (let r = 0; r <= breaks.length; r++) {
        const rs = r ? breaks[r - 1]! : 0
        const re = r < breaks.length ? breaks[r]! : text.length
        const last = r === breaks.length
        const lo = Math.max(s, rs)
        const hi = Math.min(e, re)
        if (lo > hi || (lo === hi && !(last && eol && lo === text.length) && !(lo === rs && hi === re))) continue
        const x1 = this.xAt(line, lo, rs)
        let x2 = hi === re && !last ? this.xAt(line, re, rs, -1) : this.xAt(line, hi, rs)
        if (last && eol && e === text.length) x2 += this.charWidth * 0.6
        if (x2 > x1) out.push({ x: x1, y: top + r * lh, width: x2 - x1, height: lh })
      }
    }
    return out
  }

  /** Scrolls so that `pos` (default: the main cursor) is visible. */
  scrollIntoView(pos?: Pos, center = false): void {
    this.scrollTarget = { pos: pos ?? null, center, page: true }
    this.requestRender()
  }

  // -------------------------------------------------------------------------
  // Focus & lifecycle

  focus(): void {
    this.inputDOM.focus({ preventScroll: true })
  }

  blur(): void {
    this.inputDOM.blur()
  }

  /** Schedules a render on the next animation frame. */
  requestRender(): void {
    if (!this.rafId && !this.destroyed) this.rafId = requestAnimationFrame(() => this.render())
  }

  /** Renders now if a render is pending. */
  flush(): void {
    if (this.rafId) this.render()
  }

  destroy(): void {
    if (this.destroyed) return
    this.emit('destroy', this)
    for (const dispose of this.extDisposers.splice(0).reverse()) dispose()
    for (const dispose of this.disposers.splice(0)) dispose()
    this.dragCleanup?.()
    this.resizeObserver?.disconnect()
    this.scrollDOM.removeEventListener('wheel', this.onWheel)
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.hlTask?.()
    if (this.widthTimer) clearTimeout(this.widthTimer)
    this.listeners.clear()
    this.dom.remove()
    this.destroyed = true
  }

  get isDestroyed(): boolean {
    return this.destroyed
  }

  // -------------------------------------------------------------------------
  // Events

  private bindEvents(): void {
    const on = <E extends Event>(target: EventTarget, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts)
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts))
    }
    const input = this.inputDOM
    on(this.scrollDOM, 'scroll', () => {
      this.render()
      this.emit('scroll', this)
    }, { passive: true })
    // Any scroll or resize around a page-tall editor changes what's on screen.
    const onPage = () => this.pageVirtual && this.requestRender()
    const win = this.dom.ownerDocument.defaultView
    on(this.dom.ownerDocument, 'scroll', onPage, { capture: true, passive: true })
    if (win) on(win, 'resize', onPage)
    on<MouseEvent>(this.scrollDOM, 'mousedown', (e) => this.onMouseDown(e))
    on<KeyboardEvent>(input, 'keydown', (e) => this.onKeyDown(e))
    on<InputEvent>(input, 'beforeinput', (e) => this.onBeforeInput(e))
    on<InputEvent>(input, 'input', (e) => this.onInput(e))
    on(input, 'compositionstart', () => {
      if (this.adoptFieldSelection()) this.fieldAll = true
      this.composing = true
      this.dom.classList.add('jc-composing')
    })
    on<CompositionEvent>(input, 'compositionupdate', (e) => this.showComposition(e.data))
    on<CompositionEvent>(input, 'compositionend', (e) => {
      this.composing = false
      this.dom.classList.remove('jc-composing')
      this.showComposition('')
      const text = (this.touchInput ? e.data || input.value : e.data).replaceAll(SENTINEL, '')
      if (this.touchInput) this.resetInput()
      // Outside touch mode the textarea already holds the composed text where the doc will have it.
      if (this.fieldAll) {
        this.fieldAll = false
        this.replaceDocument(text)
      } else if (text) this.userInput(() => this.handleTextInput(text))
      else this.resetInput()
    })
    on<ClipboardEvent>(input, 'copy', (e) => this.onCopy(e, false))
    on<ClipboardEvent>(input, 'cut', (e) => this.onCopy(e, true))
    on<ClipboardEvent>(input, 'paste', (e) => {
      e.preventDefault()
      const text = e.clipboardData?.getData('text/plain')
      if (text) this.userInput(() => {
        this.adoptFieldSelection()
        this.fieldAll = false
        this.paste(text.replace(/\r\n?/g, '\n'))
      })
    })
    on(input, 'focus', () => this.setFocused(true))
    on(input, 'blur', () => this.setFocused(false))

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        this.clipParents = null
        // The probe resizes when the font does (CSS, a font loading, zoom): re-measure, and redraw before the paint.
        const metrics = this.metricsVersion
        if (!this.cw || entries.some((e) => e.target === this.probe)) this.measure()
        if (metrics !== this.metricsVersion) this.render()
        else this.requestRender()
      })
      this.resizeObserver.observe(this.scrollDOM)
      this.resizeObserver.observe(this.probe)
    }
    const fonts = this.dom.ownerDocument.fonts
    if (fonts) {
      on(fonts, 'loadingdone', () => {
        this.measure()
        this.requestRender()
      })
    }
  }

  /** Runs a handler flagged as user input (blocked in read-only mode), then renders. */
  private userInput(fn: () => void): void {
    this.userEvent = true
    try {
      fn()
    } finally {
      this.userEvent = false
    }
    this.flush()
  }

  private setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    this.dom.classList.toggle('jc-focused', focused)
    if (!focused) this.resetContextInput()
    else this.syncInput()
    for (const c of this.cursorEls) c.classList.toggle('jc-blink-alt')
    this.emit(focused ? 'focus' : 'blur', this)
  }

  /**
   * Adapts the hidden textarea to virtual keyboards (called by the `touch()`
   * extension on the first touch): keeps a sentinel char in it so Backspace
   * is reported even when there is nothing typed.
   */
  enableTouchInput(): void {
    if (this.touchInput) return
    this.touchInput = true
    this.dom.classList.add('jc-touch')
    this.resetInput()
  }

  private resetInput(): void {
    const input = this.inputDOM
    if (!this.touchInput) return this.syncInput(true)
    input.value = SENTINEL
    input.setSelectionRange(1, 1)
  }

  /**
   * Screen reader support: the textarea mirrors the text around the main
   * cursor (a page of 10 lines) with the same selection, so screen readers
   * read lines, words and selections as in a native text field. Typing is
   * then read back from the textarea by comparing it with the mirror.
   */
  private syncInput(force = false): void {
    const input = this.inputDOM
    if (this.touchInput || this.composing || input.classList.contains('jc-context')) return
    const doc = this.doc
    const { anchor, head } = this.selection
    let from: Pos = { line: head.line - (head.line % MIRROR_PAGE), col: 0 }
    const last = Math.min(doc.lineCount - 1, from.line + MIRROR_PAGE - 1)
    let to: Pos = { line: last, col: doc.line(last).length }
    let text = doc.slice(from, to)
    if (text.length > MIRROR_MAX) {
      // Very long lines: only the part of the cursor's line around it.
      const line = doc.line(head.line)
      from = { line: head.line, col: Math.max(0, head.col - MIRROR_MAX / 2) }
      to = { line: head.line, col: Math.min(line.length, head.col + MIRROR_MAX / 2) }
      text = line.slice(from.col, to.col)
    }
    const offset = (p: Pos) => {
      if (cmpPos(p, from) <= 0) return 0
      if (cmpPos(p, to) >= 0) return text.length
      let off = p.col - (p.line === from.line ? from.col : 0)
      for (let l = from.line; l < p.line; l++) off += doc.line(l).length + 1 - (l === from.line ? from.col : 0)
      return off
    }
    const a = offset(anchor)
    const h = offset(head)
    const start = Math.min(a, h)
    const end = Math.max(a, h)
    // Tells screen readers (and browser agents reading the accessibility tree) that this is a page of a longer file.
    const total = doc.lineCount
    const desc = to.line - from.line + 1 < total
      ? this.phrase('Lines {from}–{to} of {total}').replace('{from}', String(from.line + 1)).replace('{to}', String(to.line + 1)).replace('{total}', String(total))
      : ''
    if (desc !== this.mirrorDesc) {
      this.mirrorDesc = desc
      if (desc) input.setAttribute('aria-description', desc)
      else input.removeAttribute('aria-description')
    }
    const m = this.mirror
    if (force || input.value !== text) input.value = text
    else if (m.start === start && m.end === end && input.selectionStart === start && input.selectionEnd === end) return
    this.mirror = { text, from, start, end }
    input.setSelectionRange(start, end, a > h ? 'backward' : 'forward')
  }

  /** Document position of an offset in the mirrored text. */
  private mirrorPos(off: number): Pos {
    const { text, from } = this.mirror
    let line = from.line
    let lineStart = 0
    for (let i = text.indexOf('\n'); i >= 0 && i < off; i = text.indexOf('\n', i + 1)) {
      line++
      lineStart = i + 1
    }
    return { line, col: off - lineStart + (line === from.line ? from.col : 0) }
  }

  /** Shows the text being composed by an IME at the cursor. */
  private showComposition(text: string): void {
    let el = this.compositionEl
    if (!text) {
      if (el) el.style.display = 'none'
      return
    }
    if (!el) {
      el = this.compositionEl = this.dom.ownerDocument.createElement('div')
      el.className = 'jc-composition'
      el.setAttribute('aria-hidden', 'true')
      this.layersAbove.appendChild(el)
    }
    const c = this.coordsAtPos(selFrom(this.selection))
    el.textContent = text
    el.style.transform = `translate(${c.x}px,${c.top}px)`
    el.style.display = ''
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.composing || e.isComposing || e.keyCode === 229) return
    this.resetContextInput()
    // Let Tab move the focus away from read-only editors, or after Escape (no keyboard trap).
    const escaped = this.tabEscape
    // Modifier keys alone (the Shift of Shift+Tab) don't break the Escape-then-Tab sequence.
    if (!/^(Shift|Control|Alt|Meta)$/.test(e.key)) this.tabEscape = false
    if ((this.options.readOnly || escaped) && e.key === 'Tab') return
    const whole = this.adoptFieldSelection()
    const names = eventKeyNames(e)
    let handled = false
    this.userInput(() => {
      for (const km of this.keymaps) {
        if (runKeymap(km.map, names, this)) {
          handled = true
          break
        }
      }
    })
    if (handled) e.preventDefault()
    // A key the editor doesn't handle lands in the field (natively), replacing it all.
    else this.fieldAll = whole
    // Only an Escape that didn't close anything (a suggestion, a list, a panel) arms the Tab escape.
    if (e.key === 'Escape' && !handled) this.tabEscape = true
  }

  /**
   * The whole field was selected from outside the editor (a script or an
   * automation tool "filling" it): that stands for the whole document, not
   * just the mirrored page. Selects it all in the editor, without touching the
   * field: a native edit about to land (WebKit drops it if the field changes).
   */
  private adoptFieldSelection(): boolean {
    const input = this.inputDOM
    const m = this.mirror
    if (this.touchInput || !input.value || input.selectionStart !== 0 || input.selectionEnd !== input.value.length) return false
    if (m.start === 0 && m.end === m.text.length) return false
    this.dispatch({ selection: { anchor: { line: 0, col: 0 }, head: this.doc.end }, origin: 'select' })
    return true
  }

  /** Editing commands coming from virtual keyboards (which often skip keydown). */
  private onBeforeInput(e: InputEvent): void {
    if (this.composing || e.isComposing) return
    const whole = this.adoptFieldSelection()
    const cmd = COMMANDS_BY_INPUT_TYPE[e.inputType]
    if (!cmd) {
      // The native edit replaces the whole field: the `input` handler replaces the whole document.
      if (whole) this.fieldAll = true
      return
    }
    e.preventDefault()
    this.userInput(() => {
      // Virtual keyboards send Enter without a keydown: give Enter bindings (accept a completion…) a chance first.
      if ((e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') && this.keymaps.some((km) => runKeymap(km.map, ['Enter'], this))) return
      cmd(this)
    })
  }

  private onInput(e: InputEvent): void {
    if (this.composing) return
    const raw = this.inputDOM.value
    if (!this.touchInput) {
      if (this.fieldAll) {
        this.fieldAll = false
        return this.replaceDocument(raw)
      }
      return e.isTrusted ? this.readMirror(raw) : this.readScriptValue(raw)
    }
    if (raw === '') {
      // The keyboard deleted our sentinel: that's a Backspace.
      this.resetInput()
      this.userInput(() => deleteCharBackward(this))
      return
    }
    const text = raw.replaceAll(SENTINEL, '')
    if (raw === (this.touchInput ? SENTINEL : '')) return
    this.resetInput()
    if (!text) return
    this.userInput(() => this.handleTextInput(text))
  }

  /** Applies what changed in the textarea since the last `syncInput`. */
  private readMirror(raw: string): void {
    const { text, start, end } = this.mirror
    if (raw === text) return
    const tail = text.length - end
    if (raw.length >= start + tail && raw.startsWith(text.slice(0, start)) && raw.endsWith(text.slice(end))) {
      // The usual case: something typed over the selection.
      const typed = raw.slice(start, raw.length - tail)
      this.userInput(() => (typed ? this.handleTextInput(typed) : this.replaceSelection('', 'delete')))
      return
    }
    // Anything else (a native edit elsewhere): apply the difference as is.
    const [p, q] = affixes(raw, text)
    const from = this.mirrorPos(p)
    const to = this.mirrorPos(text.length - q)
    const insert = raw.slice(p, raw.length - q)
    this.userInput(() => this.dispatch({ changes: { from, to, insert }, selection: cursor(endOfInsert(from, insert)), origin: 'input', scrollIntoView: true }))
  }

  /**
   * A script set the field's value (automation tools, tests, browser agents):
   * it's either an edit of the mirrored page or a whole new document. Takes
   * the reading that changes less, unless the value keeps little of the page.
   */
  private readScriptValue(raw: string): void {
    const text = this.mirror.text
    const [pm, qm] = affixes(raw, text)
    const full = this.doc.toString()
    const [pf, qf] = affixes(raw, full)
    const pageCost = text.length + raw.length - 2 * (pm + qm)
    const docCost = full.length + raw.length - 2 * (pf + qf)
    if (raw === text || (pageCost < docCost && pm + qm >= text.length / 2 && text.length > 0)) return this.readMirror(raw)
    this.replaceDocument(raw, full, pf, qf)
  }

  /** The document becomes `raw`, changing only what differs (one undo step). */
  private replaceDocument(raw: string, full = this.doc.toString(), pf = -1, qf = 0): void {
    if (pf < 0) [pf, qf] = affixes(raw, full)
    // Offsets in the joined document → positions.
    const eol = this.doc.eol.length
    const posAt = (off: number): Pos => {
      let line = 0
      for (const l of this.doc.lines) {
        if (off <= l.length) break
        off -= l.length + eol
        line++
      }
      return { line, col: off }
    }
    const from = posAt(pf)
    const insert = raw.slice(pf, raw.length - qf).replace(/\r\n?/g, '\n')
    this.userInput(() => this.dispatch({
      changes: { from, to: posAt(full.length - qf), insert },
      selection: cursor(endOfInsert(from, insert)), origin: 'input.replace', scrollIntoView: true,
    }))
  }

  private handleTextInput(raw: string): void {
    const text = raw.replace(/\r\n?/g, '\n')
    if (text === '\n') insertNewline(this)
    else this.typeText(text)
  }

  /** Paste: one line per cursor when the counts match (like VS Code). */
  private paste(text: string): void {
    const ranges = this._sel.ranges
    const lines = splitLines(text)
    if (ranges.length > 1 && lines.length === ranges.length) {
      this.changeByRange((range, i) => {
        const from = selFrom(range)
        return { changes: { from, to: selTo(range), insert: lines[i]! }, range: cursor(endOfInsert(from, lines[i]!)) }
      }, { origin: 'input.paste', scrollIntoView: true })
    } else {
      this.replaceSelection(text, 'input.paste')
    }
  }

  private autoOutdent(typed: string): void {
    const lang = this.languageAt(this.selection.head)
    if (typed.length !== 1 || !lang.indent.decrease || !lang.brackets.some(([, close]) => close === typed)) return
    this.changeByRange((range) => {
      const { head } = range
      if (!isEmpty(range)) return null
      const line = this.doc.line(head.line)
      const indent = line.slice(0, head.col - 1)
      if (!/^\s*$/.test(indent) || line[head.col - 1] !== typed) return null
      const match = matchBracket(this, head)
      if (!match?.to) return null
      const target = this.doc.line(match.to.line)
      const wanted = target.slice(0, indentLength(target))
      if (wanted === indent) return null
      return {
        changes: { from: { line: head.line, col: 0 }, to: { line: head.line, col: indent.length }, insert: wanted },
        range: cursor({ line: head.line, col: wanted.length + 1 }),
      }
    }, { origin: 'input' })
  }

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    const ranges = this._sel.ranges
    const lineMode = ranges.every(isEmpty)
    const text = lineMode
      ? [...new Set(ranges.map((r) => r.head.line))].map((l) => this.doc.line(l) + '\n').join('')
      : ranges.filter((r) => !isEmpty(r)).map((r) => this.doc.slice(selFrom(r), selTo(r))).join('\n')
    e.clipboardData?.setData('text/plain', text)
    e.preventDefault()
    if (!cut || this.options.readOnly) return
    this.userInput(() => (lineMode ? deleteLine(this) : this.replaceSelection('', 'delete.cut')))
  }

  private onMouseDown(e: MouseEvent): void {
    // The scrollbar, and widgets that handle their own clicks, inputs, selection (blocks, zones, anything marked `.jc-ui`).
    if (e.target === this.scrollDOM || (e.target as Element).closest?.('.jc-block,.jc-ui')) return
    for (const handler of this.mouseHandlers) {
      if (handler(e, this)) {
        e.preventDefault()
        return
      }
    }
    if (e.button === 2 || (isMac && e.ctrlKey && e.button === 0)) {
      this.prepareContextInput(e)
      // Keep the focus in the textarea, so the native menu gets Cut / Copy / Paste for the selection.
      e.preventDefault()
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    this.resetContextInput()
    this.focus()
    const pos = this.posAtClient(e.clientX, e.clientY)
    const target = e.target as Element
    const gutterEl = target.closest?.('.jc-gutter')
    if (gutterEl) {
      const gutter = this.gutters.find((g) => g.el === gutterEl)
      if (gutter?.spec.onMouseDown?.(pos.line, e, this)) return
    }
    const mode = this.cursorModifiers.find((m) => m.test(e))?.kind
    this.history.breakGroup()
    if (mode === 'rect') return this.startRectSelection(e)

    const clicks = this.gutterBox.contains(target) ? 3 : ((Math.max(1, e.detail) - 1) % 3) + 1
    const unit = (p: Pos): [Pos, Pos] => (clicks === 1 ? [p, p] : clicks === 2 ? this.wordRange(p) : this.lineRange(p))
    let others = mode === 'add' ? this._sel.ranges.slice() : []
    if (mode === 'add' && clicks === 1 && others.length > 1) {
      // Alt+click on an existing cursor removes it.
      const hit = others.findIndex((r) => isEmpty(r) && cmpPos(r.head, pos) === 0)
      if (hit >= 0) {
        others.splice(hit, 1)
        this.dispatch({ selection: { ranges: others, main: others.length - 1 }, origin: 'select.pointer' })
        return
      }
    }
    const anchor = this.selection.anchor
    const base: [Pos, Pos] = e.shiftKey && clicks === 1 && !mode ? [anchor, anchor] : unit(pos)
    const update = (p: Pos) => {
      const r = unit(p)
      const range = cmpPos(r[0], base[0]) < 0 ? { anchor: base[1], head: r[0] } : { anchor: base[0], head: r[1] }
      if (!mode && e.shiftKey && clicks === 1) {
        // Shift-click keeps the other cursors' ranges out: extend the main one.
        this.dispatch({ selection: range, origin: 'select.pointer' })
      } else {
        this.dispatch({ selection: { ranges: [...others, range], main: others.length }, origin: 'select.pointer' })
      }
    }
    update(pos)
    this.flush()
    this.startDrag((p) => update(p))
  }

  /** Alt+Shift+drag (with `multiCursor()`): one range per line between the anchor and the pointer. */
  private startRectSelection(e: MouseEvent): void {
    const start = this.clientToContent(e.clientX, e.clientY)
    const startPos = this.posAtCoords(start.x, start.y)
    const update = (_p: Pos, x: number, y: number) => {
      const endPos = this.posAtCoords(x, y)
      const [a, b] = startPos.line <= endPos.line ? [startPos.line, endPos.line] : [endPos.line, startPos.line]
      const ranges: Selection[] = []
      for (let line = a; line <= b; line++) {
        const top = this.lineTop(line) + 1
        const from = this.posAtCoords(start.x, top)
        const to = this.posAtCoords(x, top)
        if (from.line !== line || to.line !== line) continue
        ranges.push({ anchor: from, head: to })
      }
      if (ranges.length) this.dispatch({ selection: { ranges, main: ranges.length - 1 }, origin: 'select.pointer' })
    }
    update(startPos, start.x, start.y)
    this.flush()
    this.startDrag(update)
  }

  /** The word (or run of same-class chars) around a position. */
  wordRange(p: Pos): [Pos, Pos] {
    const [from, to] = wordRangeAt(this.doc.line(p.line), p.col, this._language.wordChars)
    return [{ line: p.line, col: from }, { line: p.line, col: to }]
  }

  private lineRange(p: Pos): [Pos, Pos] {
    const end = p.line + 1 < this.doc.lineCount ? { line: p.line + 1, col: 0 } : { line: p.line, col: this.doc.line(p.line).length }
    return [{ line: p.line, col: 0 }, end]
  }

  private startDrag(update: (p: Pos, x: number, y: number) => void): void {
    this.dragCleanup?.()
    const win = this.dom.ownerDocument.defaultView ?? window
    let x = 0
    let y = 0
    let raf = 0
    const tick = () => {
      raf = 0
      const sc = this.scrollDOM
      const r = sc.getBoundingClientRect()
      const left = r.left + this.gutterBox.offsetWidth
      const right = r.left + sc.clientWidth
      const bottom = r.top + sc.clientHeight
      const speed = (d: number) => Math.sign(d) * Math.min(Math.abs(d) * 0.6, this.lh * 3)
      const dy = y < r.top ? y - r.top : y > bottom ? y - bottom : 0
      const dx = x < left ? x - left : x > right ? x - right : 0
      if (dy) this.scrollBy(speed(dy))
      if (dx) sc.scrollLeft += speed(dx)
      const c = this.clientToContent(Math.min(Math.max(x, left), right - 1), Math.min(Math.max(y, r.top), bottom - 1))
      update(this.posAtCoords(c.x, c.y), c.x, c.y)
      this.flush()
      if (dy || dx) raf = requestAnimationFrame(tick)
    }
    const move = (e: MouseEvent) => {
      x = e.clientX
      y = e.clientY
      if (!raf) tick()
    }
    const up = () => this.dragCleanup?.()
    win.addEventListener('mousemove', move)
    win.addEventListener('mouseup', up)
    this.dragCleanup = () => {
      win.removeEventListener('mousemove', move)
      win.removeEventListener('mouseup', up)
      if (raf) cancelAnimationFrame(raf)
      this.dragCleanup = null
    }
  }

  /** Puts the textarea under the pointer so the native context menu offers cut/copy/paste. */
  private prepareContextInput(e: MouseEvent): void {
    const pos = this.posAtClient(e.clientX, e.clientY)
    const inside = this._sel.ranges.some((r) => !isEmpty(r) && cmpPos(pos, selFrom(r)) >= 0 && cmpPos(pos, selTo(r)) <= 0)
    if (!inside) {
      this.dispatch({ selection: cursor(pos), origin: 'select.pointer' })
      this.flush()
    }
    const { x, y } = this.clientToContent(e.clientX, e.clientY)
    const input = this.inputDOM
    input.classList.add('jc-context')
    input.style.transform = `translate(${x}px,${y}px)`
    input.value = this.getSelectedText(true)
    input.select()
    this.focus()
  }

  private resetContextInput(): void {
    if (!this.inputDOM.classList.contains('jc-context')) return
    this.inputDOM.classList.remove('jc-context')
    this.resetInput()
    this.positionCursors()
  }

  // -------------------------------------------------------------------------
  // Measuring & layout

  /**
   * Measures the font (again after a font loads, a size changes through CSS,
   * a zoom…: the probe is observed). Sub-pixel sizes, corrected for CSS
   * transforms on ancestors: a rounded `offsetWidth` drifted by a pixel
   * every few hundred columns.
   */
  private measure(): boolean {
    const row = this.probe.firstElementChild as HTMLElement
    const rect = row.getBoundingClientRect()
    if (!rect.width || !rect.height) return false
    const scale = scaleOf(row, rect)
    const width = (el: Element) => el.getBoundingClientRect().width / scale
    const [x, mix, bold, italic, digits] = [...row.children].map(width) as [number, number, number, number, number]
    const cw = x / PROBE_CHARS
    const lh = Math.max(1, Math.round(rect.height / scale))
    const fixed = Math.abs(mix - x) < 1 && Math.abs(bold - x) < 1 && Math.abs(italic - x) < 1
    const wideRow = (this.probe.lastElementChild as HTMLElement).children
    const wide = Math.max(2, width(wideRow[0]!) / 20 / cw, width(wideRow[1]!) / 20 / cw)
    const ascii = fixed ? null : this.measureAscii(scale, cw)
    const old = this.adv.ascii
    const sameAscii = old === ascii || (!!old && !!ascii && old.every((v, i) => v === ascii[i]))
    const widths = fixed !== this.fixed || wide !== this.adv.wide || !sameAscii
    if (!widths && cw === this.cw && lh === this.lh) return true
    this.cw = cw
    this.dw = digits / PROBE_CHARS
    this.fixed = fixed
    this.adv = { ascii, wide, max: Math.max(wide, ascii ? Math.max(...ascii) : 1) }
    if (lh !== this.lh) {
      this.lh = lh
      this.dom.style.setProperty('--jc-lh', lh + 'px')
      // Heights are in px: gaps given in rows, wrapped rows… all change.
      this.mergeGaps()
      this.heightsDirty = true
    }
    if (widths) this.maxCols = this.computeMaxCols()
    this.lastHeight = this.lastWidth = -1
    this.wrapCols = 0
    this.gutterDirty = true
    this.invalidateLines()
    this.metricsVersion++
    return true
  }

  /** Widths of the ASCII chars in columns (the wider of regular and bold), when the font isn't fixed. */
  private measureAscii(scale: number, cw: number): Float64Array {
    const box = this.dom.ownerDocument.createElement('div')
    let html = ''
    for (let c = 32; c < 127; c++) {
      const s = escapeHTML(String.fromCharCode(c).repeat(10))
      html += `<span>${s}</span><b>${s}</b>`
    }
    box.innerHTML = html
    this.probe.appendChild(box)
    const out = new Float64Array(128).fill(1)
    const kids = box.children
    for (let c = 32; c < 127; c++) {
      const i = (c - 32) * 2
      out[c] = Math.max(kids[i]!.getBoundingClientRect().width, kids[i + 1]!.getBoundingClientRect().width) / scale / 10 / cw
    }
    box.remove()
    return out
  }

  /** Width of a line in columns (a lower bound for wide chars in monospace fonts: rendered lines widen the scroll area themselves). */
  private lineCols(text: string): number {
    if (this.fixed) return text.indexOf('\t') < 0 ? text.length : visualColumn(text, text.length, this.options.tabSize)
    return textWidth(text, this.options.tabSize, this.adv)
  }

  private computeMaxCols(): number {
    let max = 0
    const unit = this.fixed ? 1 : this.adv.max
    for (const line of this.doc.lines) {
      if (line.length * unit > max || line.indexOf('\t') >= 0) max = Math.max(max, this.lineCols(line))
    }
    return max
  }

  /** Whether one of the lines about to change is (one of) the longest. */
  private touchesLongest(from: number, to: number): boolean {
    for (let l = from; l <= to && l - from < 10000; l++) if (this.lineCols(this.doc.line(l)) >= this.maxCols) return true
    return false
  }

  private growWidth(change: Change, shrinks: boolean): void {
    const start = change.from.line
    const end = start + change.inserted.length - 1
    for (let l = start; l <= end; l++) this.maxCols = Math.max(this.maxCols, this.lineCols(this.doc.line(l)))
    // The longest line may have shrunk: recompute lazily, it's not urgent.
    if (shrinks && !this.widthTimer) {
      this.widthTimer = setTimeout(() => {
        this.widthTimer = null
        this.maxCols = this.computeMaxCols()
        this.requestRender()
      }, 250)
    }
  }

  /** Recomputes every soft-wrap break (width, font or tab size changed). */
  private resetWrap(): void {
    if (!this.options.lineWrapping || !this.wrapCols) {
      this.breaks = []
      if (this._folds.length) this.rebuildHeights()
      return
    }
    const { tabSize } = this.options
    const cols = this.wrapCols
    const lines = this.doc.lines
    const breaks = new Array<number[] | null>(lines.length)
    const rows = new Array<number>(lines.length)
    for (let i = 0; i < lines.length; i++) {
      const b = wrapLine(lines[i]!, cols, tabSize, this.adv)
      breaks[i] = b
      rows[i] = b ? b.length + 1 : 1
    }
    this.breaks = breaks
    this.finishRows(rows)
    this.layoutVersion++
  }

  private updateWrap(change: Change): void {
    if (!this.tall) return
    const start = change.from.line
    const removed = change.to.line - start + 1
    const count = change.inserted.length
    const { tabSize } = this.options
    const wrapping = this.wrapping
    const breaks: (number[] | null)[] = []
    const rows: number[] = []
    for (let l = start; l < start + count; l++) breaks.push(wrapping ? wrapLine(this.doc.line(l), this.wrapCols, tabSize, this.adv) : null)
    if (wrapping) this.breaks = spliceArray(this.breaks, start, removed, breaks)
    for (let l = start; l < start + count; l++) rows.push(this.heightOf(l))
    this.heights.splice(start, removed, rows)
  }

  /** Heights of every line: wrapped rows, 0 for folded lines, plus gaps. */
  private rebuildHeights(): void {
    const n = this.doc.lineCount
    const rows = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      const b = this.breaksOf(i)
      rows[i] = b ? b.length + 1 : 1
    }
    this.finishRows(rows)
  }

  /** Row counts to heights (px), with folds and gaps. */
  private finishRows(rows: number[]): void {
    const lh = this.lh
    for (let i = 0; i < rows.length; i++) rows[i]! *= lh
    for (const f of this._folds) for (let l = f.from; l <= f.to; l++) rows[l] = 0
    for (const [l, g] of this.gaps) if (rows[l]) rows[l] += g.above + g.below
    this.heights.reset(rows)
  }

  // -------------------------------------------------------------------------
  // Folding (the mechanism: which lines are hidden; `folding()` adds the UI)

  /** Hidden line ranges. */
  get folds(): readonly FoldRange[] {
    return this._folds
  }

  /** Hides line ranges (each under the line before it). Overlapping ranges are merged. */
  setFolds(ranges: readonly FoldRange[]): void {
    const last = this.doc.lineCount - 1
    const sorted = ranges
      .map((r) => ({ from: Math.max(1, r.from), to: Math.min(last, r.to) }))
      .filter((r) => r.from <= r.to)
      .sort((a, b) => a.from - b.from)
    const merged: FoldRange[] = []
    for (const r of sorted) {
      const prev = merged[merged.length - 1]
      if (prev && r.from <= prev.to + 1) prev.to = Math.max(prev.to, r.to)
      else merged.push({ ...r })
    }
    if (merged.length === this._folds.length && merged.every((r, i) => r.from === this._folds[i]!.from && r.to === this._folds[i]!.to)) return
    this._folds = merged
    this.rebuildHeights()
    this.lastHeight = -1
    // Cursors inside a fold move out of it.
    const sel = this._sel
    if (sel.ranges.some((r) => this.isLineHidden(r.head.line))) {
      this._sel = normalizeSelection({
        ranges: sel.ranges.map((r) => {
          const f = this.foldAt(r.head.line)
          if (!f) return r
          const head = { line: f.from - 1, col: this.doc.line(f.from - 1).length }
          return { anchor: this.isLineHidden(r.anchor.line) ? head : r.anchor, head }
        }),
        main: sel.main,
      })
    }
    this.requestRender()
    this.emit('fold', this._folds, this)
  }

  /** The fold hiding `line`, if any. */
  foldAt(line: number): FoldRange | undefined {
    const folds = this._folds
    let lo = 0
    let hi = folds.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const f = folds[mid]!
      if (line < f.from) hi = mid - 1
      else if (line > f.to) lo = mid + 1
      else return f
    }
    return undefined
  }

  isLineHidden(line: number): boolean {
    return this._folds.length > 0 && !!this.foldAt(line)
  }

  /** Follows an edit: folds before/after move, edits inside keep them, edits across a border unfold. */
  private mapFolds(change: Change): void {
    if (!this._folds.length) return
    const start = change.from.line
    const end = change.to.line
    const delta = change.inserted.length - 1 - (end - start)
    const kept: FoldRange[] = []
    let dropped = false
    for (const f of this._folds) {
      if (f.to < start) kept.push(f)
      else if (f.from - 1 > end || (f.from - 1 === end && start === end && !delta && change.from.col > 0)) {
        kept.push(delta ? { from: f.from + delta, to: f.to + delta } : f)
      } else if (start >= f.from && end <= f.to) kept.push({ from: f.from, to: f.to + delta })
      else if (start === end && end === f.from - 1 && !delta) kept.push(f) // typing on the header line
      else dropped = true
    }
    this._folds = kept
    if (dropped) {
      // Lines that were hidden show again: row counts are rebuilt on the next render.
      this.heightsDirty = true
      this.emit('fold', this._folds, this)
    }
  }

  /**
   * Arrow keys don't enter a fold: moving forward from its header jumps past
   * it, moving back from the line after it lands on the header. Any other way
   * of putting the cursor inside (search, go to line…) unfolds it.
   */
  private skipFolds(sel: EditorSelection, before: EditorSelection): EditorSelection {
    const unfold = new Set<FoldRange>()
    let changed = false
    const ranges = sel.ranges.map((r, i) => {
      const f = this.foldAt(r.head.line)
      if (!f) return r
      const prev = before.ranges[Math.min(i, before.ranges.length - 1)]!.head
      let head: Pos | null = null
      // Only a step over the border (arrow keys, word moves): a jump deeper in opens the fold.
      if (prev.line === f.from - 1 && r.head.line === f.from) head = { line: Math.min(f.to + 1, this.doc.lineCount - 1), col: 0 }
      else if (prev.line === f.to + 1 && r.head.line === f.to) head = { line: f.from - 1, col: this.doc.line(f.from - 1).length }
      if (!head || this.isLineHidden(head.line)) {
        unfold.add(f)
        return r
      }
      changed = true
      return { anchor: cmpPos(r.anchor, r.head) === 0 ? head : r.anchor, head }
    })
    if (unfold.size) {
      this._folds = this._folds.filter((f) => !unfold.has(f))
      this.heightsDirty = true
      this.emit('fold', this._folds, this)
    }
    return changed ? normalizeSelection({ ranges, main: sel.main }) : sel
  }

  /** Columns available per row when wrapping. */
  private computeWrapCols(): number {
    const width = this.scrollDOM.clientWidth - this.gutterW - PAD_X * 2 - this.charWidth
    return width > 0 ? Math.max(8, Math.floor(width / this.charWidth)) : 0
  }

  // -------------------------------------------------------------------------
  // Rendering

  private render(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
    if (this.destroyed) return
    if (!this.cw) this.measure()
    const lh = this.lh
    const doc = this.doc
    const sc = this.scrollDOM
    const count = doc.lineCount

    for (const g of this.gutters) {
      const w = g.spec.width?.(this) ?? ''
      if (w !== g.width) {
        g.el.style.width = g.width = w
        this.gutterDirty = true
      }
    }
    if (this.gutterDirty) {
      this.gutterDirty = false
      this.gutterW = this.gutters.length ? this.gutterBox.offsetWidth : 0
    }
    if (this.options.lineWrapping) {
      const cols = this.computeWrapCols()
      if (cols !== this.wrapCols) {
        this.wrapCols = cols
        this.resetWrap()
      }
    }
    const wrapping = this.wrapping
    if (this.heightsDirty) {
      this.heightsDirty = false
      if (this.tall) this.rebuildHeights()
      this.lastHeight = -1
    }
    this.realHeight = PAD_Y * 2 + (this.tall ? this.heights.total : lh * count)
    const big = this.realHeight > MAX_HEIGHT
    if (big !== this.big) {
      this.big = big
      this.bigSeen = -1
      this.dom.classList.toggle('jc-compressed', big)
      // A non-passive wheel listener makes the browser wait for JS on every scroll: only when needed.
      if (big) sc.addEventListener('wheel', this.onWheel, { passive: false })
      else sc.removeEventListener('wheel', this.onWheel)
    }
    const height = big ? MAX_HEIGHT : this.realHeight
    if (height !== this.lastHeight) {
      this.sizer.style.height = height + 'px'
      this.lastHeight = height
    }
    const width = wrapping ? 0 : Math.ceil((this.maxCols + 2) * this.charWidth) + PAD_X * 2
    if (width !== this.lastWidth) {
      this.content.style.minWidth = width ? width + 'px' : ''
      this.lastWidth = width
    }
    if (this.fixedDOM) {
      const w = sc.clientWidth
      if (w !== this.fixedW) {
        this.fixedW = w
        this.fixedDOM.style.width = w + 'px'
        this.fixedDOM.style.marginRight = -w + 'px'
      }
    }
    this.applyHeightLimits()
    if (this.scrollTarget) this.applyScroll()

    const { top, height: viewHeight } = this.visibleSlice()
    if (big) {
      // Scrollbar moves (and page scrolls) map linearly; wheel scrolling moves 1:1 (see onWheel).
      if (top !== this.bigSeen) {
        this.bigTop = top * this.bigRatio(viewHeight)
        this.bigSeen = top
      }
      this.offset = top - this.bigTop
    } else this.offset = 0
    const overscan = Math.max(4 * lh, viewHeight / 3)
    const from = this.lineAtY(top - overscan)
    const to = this.lineAtY(top + viewHeight + overscan)
    this.viewFrom = from
    this.viewTo = to
    // Catch up synchronously only when it's close; after a long jump, paint with the
    // best-known states right away and let the background finish (~500k lines/s).
    if (to - this.hl.validUpTo > 6000 || !this.hl.ensure(to, performance.now() + 15)) this.scheduleHighlight()

    this.renderLines(from, to)
    this.renderGutters(from, to)
    for (const layer of this.layers) layer.spec.render(layer.el, this)
    this.renderPlaceholder()
    this.positionCursors()
    if (this.hasFocus) this.syncInput()
    if (this.pageScroll) {
      // The editor grows with the page: let the page scroll to the cursor.
      this.inputDOM.scrollIntoView({ block: this.pageScroll, inline: 'nearest' })
      this.pageScroll = null
    }
    this.emit('render', this)
  }

  /** Real px per scroll px in compressed mode. */
  private bigRatio(viewHeight: number): number {
    return Math.max(1, (this.realHeight - viewHeight) / Math.max(1, this.lastHeight - viewHeight))
  }

  /** Compressed mode: shows real y at the top and keeps the scrollbar roughly in sync. */
  private scrollToReal(y: number): void {
    const sc = this.scrollDOM
    const view = sc.clientHeight
    this.bigTop = Math.max(0, Math.min(this.realHeight - view, y))
    sc.scrollTop = this.bigTop / this.bigRatio(view)
    this.bigSeen = sc.scrollTop
  }

  /**
   * Scrolls by `dy` px of content (Page Up/Down, drag autoscroll): 1:1 even
   * when the document is compressed.
   */
  scrollBy(dy: number): void {
    if (this.big && !this.pageVirtual) {
      this.scrollToReal(this.bigTop + dy)
      this.render()
    } else this.scrollDOM.scrollTop += dy
  }

  /** Compressed mode: wheel scrolling moves the content 1:1 instead of by the scrollbar ratio. */
  private onWheel = (e: WheelEvent): void => {
    if (!this.big || this.pageVirtual || e.ctrlKey || !e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
    e.preventDefault()
    const unit = e.deltaMode === 1 ? this.lh : e.deltaMode === 2 ? this.scrollDOM.clientHeight : 1
    this.scrollBy(e.deltaY * unit)
  }

  /** `minLines` / `maxLines` as CSS limits on the scroller. */
  private applyHeightLimits(): void {
    const { minLines, maxLines } = this.options
    const sc = this.scrollDOM
    // Room for a horizontal scrollbar, so the last line isn't hidden under it.
    const bar = maxLines ? sc.offsetHeight - sc.clientHeight : 0
    const limits = (minLines ? PAD_Y * 2 + this.lh * minLines + 'px' : '') + '/' + (maxLines ? PAD_Y * 2 + this.lh * maxLines + bar + 'px' : '')
    if (limits === this.lastLimits) return
    this.lastLimits = limits
    const [min, max] = limits.split('/')
    sc.style.minHeight = min!
    sc.style.maxHeight = max!
  }

  /**
   * The part of the content that can be seen, in content coordinates. Usually
   * the scroller's viewport; when the editor grows taller than the window
   * (no fixed height), only the slice that is inside the window.
   */
  private visibleSlice(): { top: number; height: number } {
    const sc = this.scrollDOM
    const height = sc.clientHeight || 600
    const win = this.dom.ownerDocument.defaultView
    const winHeight = win?.visualViewport?.height ?? win?.innerHeight ?? 0
    this.pageVirtual = winHeight > 0 && height > winHeight * 1.5
    if (!this.pageVirtual) return { top: sc.scrollTop, height }
    const rect = sc.getBoundingClientRect()
    const scale = rect.height / (sc.offsetHeight || rect.height) || 1
    // Clip by the window and by every scrolling ancestor (docs layouts often scroll a <main>).
    let top = 0
    let bottom = winHeight
    for (const p of (this.clipParents ??= this.findClipParents())) {
      const r = p.getBoundingClientRect()
      top = Math.max(top, r.top)
      bottom = Math.min(bottom, r.bottom)
    }
    const from = Math.min(Math.max(0, (top - rect.top) / scale), height)
    const to = Math.min(Math.max(from, (bottom - rect.top) / scale), height)
    return { top: sc.scrollTop + from, height: to - from }
  }

  private findClipParents(): Element[] {
    const out: Element[] = []
    const doc = this.dom.ownerDocument
    for (let n: Node | null = this.dom.parentNode; n && n !== doc.body && n !== doc.documentElement; n = n.parentNode ?? (n as ShadowRoot).host ?? null) {
      if (n.nodeType === 1 && (doc.defaultView ?? window).getComputedStyle(n as Element).overflowY !== 'visible') out.push(n as Element)
    }
    return out
  }

  /** Height (px) of the visible part of the editor — what Page Up / Page Down move by. */
  get viewportHeight(): number {
    return this.visibleSlice().height
  }

  private applyScroll(): void {
    const target = this.scrollTarget!
    this.scrollTarget = null
    const sc = this.scrollDOM
    const pos = this.doc.clamp(target.pos ?? this.selection.head)
    const lh = this.lh
    const coords = this.coordsAtPos(pos)
    const viewHeight = sc.clientHeight
    if (target.page && (this.pageVirtual || viewHeight >= this.lastHeight)) this.pageScroll = target.center ? 'center' : 'nearest'
    if (this.big && !this.pageVirtual && viewHeight > 0) {
      // Work in real coordinates, then map back to a scroll position.
      const top = coords.top - this.offset
      const bottom = coords.bottom - this.offset
      let y = this.bigTop
      if (target.center) y = top - (viewHeight - lh) / 2
      else if (top < y) y = top - (pos.line ? 0 : PAD_Y)
      else if (bottom > y + viewHeight) y = bottom - viewHeight + (pos.line === this.doc.lineCount - 1 ? PAD_Y : 0)
      this.scrollToReal(y)
    } else if (viewHeight > 0 && viewHeight < this.lastHeight) {
      // The first row of the document: all the way up (a zone above line 1 shows too).
      const upper = pos.line === 0 && coords.top === this.lineTop(0) ? 0 : coords.top
      const lower = coords.bottom + (pos.line === this.doc.lineCount - 1 ? PAD_Y : 0)
      if (target.center) sc.scrollTop = coords.top - (viewHeight - lh) / 2
      else if (upper < sc.scrollTop) sc.scrollTop = upper
      else if (lower > sc.scrollTop + viewHeight) sc.scrollTop = lower - viewHeight
    }
    const viewWidth = sc.clientWidth - this.gutterW
    if (viewWidth > 0 && !this.wrapping) {
      const x = PAD_X + coords.x
      const margin = this.charWidth * 2
      if (x - margin < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - margin * 2)
      else if (x + margin > sc.scrollLeft + viewWidth) sc.scrollLeft = x + margin - viewWidth
    }
  }

  /**
   * Tokenizes the rest in the background, in idle time: slices never delay a
   * frame (a 12 ms slice right after a long jump used to push the next paint).
   */
  private scheduleHighlight(): void {
    if (this.hlTask) return
    const win = this.dom.ownerDocument.defaultView ?? window
    const run = (deadline?: IdleDeadline) => {
      this.hlTask = null
      if (this.destroyed) return
      const budget = deadline ? Math.max(1, Math.min(deadline.timeRemaining(), 12)) : 5
      if (this.hl.ensure(this.viewTo, performance.now() + budget)) this.requestRender()
      else this.scheduleHighlight()
    }
    if (win.requestIdleCallback) {
      const id = win.requestIdleCallback(run, { timeout: 200 })
      this.hlTask = () => win.cancelIdleCallback(id)
    } else {
      const id = setTimeout(run, 0)
      this.hlTask = () => clearTimeout(id)
    }
  }


  /** Line HTML, from a small LRU cache (scrolling back and forth re-uses it). */
  private lineHTML(text: string, state: State, breaks: readonly number[] | null): string {
    if (!text) return ''
    const cacheable = text.length < 2000
    const key = cacheable ? `${state.id}\u0001${this.layoutVersion}\u0001${text}` : ''
    if (cacheable) {
      const hit = this.htmlCache.get(key)
      if (hit !== undefined) {
        this.htmlCache.delete(key)
        this.htmlCache.set(key, hit)
        return hit
      }
    }
    const tokens = this.lineTokens(text, state)
    let html = ''
    let b = 0
    let nextBreak = breaks ? breaks[0]! : Infinity
    for (const t of tokens) {
      let from = t.from
      while (from < t.to) {
        const end = Math.min(t.to, nextBreak)
        if (end > from) {
          const s = escapeHTML(text.slice(from, end))
          html += t.type || t.style
            ? `<span${t.type ? ` class="${tokenClass(t.type)}"` : ''}${t.style ? ` style="${escapeHTML(t.style).replace(/"/g, '&quot;')}"` : ''}>${s}</span>`
            : s
        }
        from = end
        if (from === nextBreak) {
          html += '<br>'
          nextBreak = breaks![++b] ?? Infinity
        }
      }
    }
    if (cacheable) {
      this.htmlCache.set(key, html)
      if (this.htmlCache.size > HTML_CACHE_SIZE) this.htmlCache.delete(this.htmlCache.keys().next().value!)
    }
    return html
  }

  /**
   * Virtualized rendering: only lines in `from..to` exist in the DOM. A line
   * element is reused as long as its (start state, text, layout) is the same,
   * so scrolling or editing only rebuilds lines whose output actually changed.
   */
  private renderLines(from: number, to: number): void {
    const old = this.lineViews
    const next = new Map<number, LineView>()
    const lines = this.doc.lines
    const hl = this.hl
    const layout = this.layoutVersion
    let missing: number[] | null = null
    const folded = this._folds.length > 0
    for (let i = from; i <= to; i++) {
      if (folded && this.isLineHidden(i)) continue
      const view = old.get(i)
      if (view && view.text === lines[i] && view.stateId === hl.stateAt(i).id && view.layout === layout) {
        next.set(i, view)
        old.delete(i)
      } else (missing ??= []).push(i)
    }
    if (missing) {
      // Lines that moved (after inserting / deleting lines) keep their element.
      const byText = new Map<string, LineView[]>()
      for (const view of old.values()) {
        if (view.layout !== layout) continue
        const list = byText.get(view.text)
        if (list) list.push(view)
        else byText.set(view.text, [view])
      }
      const rebuild: number[] = []
      const moved = new Set<LineView>()
      for (const i of missing) {
        const list = byText.get(lines[i]!)
        const id = hl.stateAt(i).id
        const at = list ? list.findIndex((v) => v.stateId === id) : -1
        if (at >= 0) {
          const view = list!.splice(at, 1)[0]!
          moved.add(view)
          next.set(i, view)
        } else rebuild.push(i)
      }
      const free = [...old.values()].filter((v) => !moved.has(v))
      for (const i of rebuild) {
        let view = free.pop()
        if (!view) {
          const el = this.dom.ownerDocument.createElement('div')
          el.className = 'jc-line'
          this.linesDOM.appendChild(el)
          view = { el, text: '', stateId: -1, layout: -1, top: -1 }
        }
        const state = hl.stateAt(i)
        const breaks = this.breaksOf(i)
        view.text = lines[i]!
        view.stateId = state.id
        view.layout = layout
        view.el.innerHTML = this.lineHTML(view.text, state, breaks)
        view.el.style.height = breaks ? (breaks.length + 1) * this.lh + 'px' : ''
        next.set(i, view)
      }
      for (const view of free) view.el.remove()
    } else {
      for (const view of old.values()) view.el.remove()
    }
    for (const [i, view] of next) {
      const top = this.lineTop(i)
      if (view.top !== top) {
        view.el.style.top = top + 'px'
        view.top = top
      }
    }
    this.lineViews = next
  }

  private renderGutters(from: number, to: number): void {
    for (const g of this.gutters) {
      const old = g.cells
      const next = new Map<number, CellView>()
      const free: CellView[] = []
      const folded = this._folds.length > 0
      for (const [i, cell] of old) if (i < from || i > to || (folded && this.isLineHidden(i))) free.push(cell)
      for (let i = from; i <= to; i++) {
        if (folded && this.isLineHidden(i)) continue
        let cell = old.get(i) ?? free.pop()
        if (!cell) {
          const el = this.dom.ownerDocument.createElement('div')
          el.className = 'jc-gutter-cell'
          g.el.appendChild(el)
          cell = { el, text: '', cls: '', top: -1 }
        }
        const out = g.spec.cell(i, this)
        const text = out == null ? '' : typeof out === 'string' ? out : out.text
        const cls = out && typeof out === 'object' ? (out.className ?? '') : ''
        if (cell.text !== text) cell.el.textContent = cell.text = text
        if (cell.cls !== cls) {
          cell.el.className = 'jc-gutter-cell' + (cls ? ' ' + cls : '')
          cell.cls = cls
        }
        const top = this.lineTop(i)
        if (cell.top !== top) {
          cell.el.style.top = top + 'px'
          cell.top = top
        }
        next.set(i, cell)
      }
      for (const cell of free) cell.el.remove()
      g.cells = next
    }
  }

  private drawSelection(dom: HTMLElement): void {
    let html = ''
    for (const range of this._sel.ranges) {
      if (isEmpty(range)) continue
      const from = selFrom(range)
      const to = selTo(range)
      if (to.line < this.viewFrom || from.line > this.viewTo) continue
      for (const r of this.rangeRects(from, to)) {
        html += `<div class="jc-selection-rect" style="left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px"></div>`
      }
    }
    if (html !== this.lastSelectionHTML) dom.innerHTML = this.lastSelectionHTML = html
  }

  private renderPlaceholder(): void {
    const show = !!this.options.placeholder && this.doc.lineCount === 1 && !this.doc.line(0)
    if (show && !this.placeholderEl) {
      this.placeholderEl = this.dom.ownerDocument.createElement('div')
      this.placeholderEl.className = 'jc-placeholder'
      this.placeholderEl.style.top = PAD_Y + 'px'
      this.layersBelow.appendChild(this.placeholderEl)
    }
    if (this.placeholderEl) {
      this.placeholderEl.style.display = show ? '' : 'none'
      if (show && this.placeholderEl.textContent !== this.options.placeholder) this.placeholderEl.textContent = this.options.placeholder
    }
  }

  /** One caret per range (only the visible ones); the textarea follows the main one. */
  private positionCursors(): void {
    const ranges = this._sel.ranges
    let n = 0
    for (let i = 0; i < ranges.length; i++) {
      const head = ranges[i]!.head
      if (i !== this._sel.main && (head.line < this.viewFrom || head.line > this.viewTo || this.isLineHidden(head.line))) continue
      let el = this.cursorEls[n]
      if (!el) {
        el = this.dom.ownerDocument.createElement('div')
        el.className = 'jc-cursor' + (this.cursorEls[0]?.classList.contains('jc-blink-alt') ? ' jc-blink-alt' : '')
        this.layersAbove.appendChild(el)
        this.cursorEls.push(el)
      }
      const c = this.coordsAtPos(head)
      el.style.transform = `translate(${c.x}px,${c.top}px)`
      el.style.display = ''
      el.classList.toggle('jc-cursor-secondary', i !== this._sel.main)
      if (i === this._sel.main && !this.inputDOM.classList.contains('jc-context')) this.inputDOM.style.transform = el.style.transform
      n++
    }
    for (let i = n; i < this.cursorEls.length; i++) this.cursorEls[i]!.style.display = 'none'
  }
}

/** Edits that virtual keyboards report through `beforeinput` (often without a keydown). */
const COMMANDS_BY_INPUT_TYPE: Record<string, (editor: Editor) => boolean> = {
  deleteContentBackward: deleteCharBackward,
  deleteContentForward: deleteCharForward,
  deleteWordBackward,
  deleteWordForward,
  insertLineBreak: insertNewline,
  insertParagraph: insertNewline,
  historyUndo: undo,
  historyRedo: redo,
}

/**
 * Creates an editor inside `parent`.
 *
 * ```ts
 * const editor = createEditor(document.querySelector('#app'), {
 *   value: 'console.log("hi")',
 *   language: javascript,
 *   extensions: basicSetup(),
 * })
 * ```
 */
export function createEditor(parent: HTMLElement, options?: EditorOptions): Editor {
  return new Editor(parent, options)
}
