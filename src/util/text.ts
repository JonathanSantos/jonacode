/** Low level text helpers shared by the document, the view and the commands. */

const SIMPLE_LINE = /^[\t\x20-\x7e]*$/

/** True when every char of the line is printable ASCII or a tab (fixed-width fast path). */
export function isSimpleLine(text: string): boolean {
  return SIMPLE_LINE.test(text)
}

/** Visual column of `col`, expanding tabs to the next tab stop. */
export function visualColumn(text: string, col: number, tabSize: number): number {
  if (text.indexOf('\t') < 0) return col
  let v = 0
  const end = Math.min(col, text.length)
  for (let i = 0; i < end; i++) {
    v = text.charCodeAt(i) === 9 ? v + tabSize - (v % tabSize) : v + 1
  }
  return v + Math.max(0, col - text.length)
}

/** Inverse of {@link visualColumn}: the closest char column to a (fractional) visual column. */
export function columnAtVisual(text: string, target: number, tabSize: number): number {
  if (text.indexOf('\t') < 0) return Math.max(0, Math.min(text.length, Math.round(target)))
  let v = 0
  for (let i = 0; i < text.length; i++) {
    const next = text.charCodeAt(i) === 9 ? v + tabSize - (v % tabSize) : v + 1
    if (target < (v + next) / 2) return i
    v = next
  }
  return text.length
}

/** Length of the leading whitespace of a line. */
export function indentLength(text: string): number {
  let i = 0
  while (i < text.length && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++
  return i
}

/** Width of an indentation string in columns. */
export function indentWidth(indent: string, tabSize: number): number {
  return visualColumn(indent, indent.length, tabSize)
}

/** Builds an indentation string `width` columns wide. */
export function makeIndent(width: number, tabSize: number, insertSpaces: boolean): string {
  if (width <= 0) return ''
  if (insertSpaces) return ' '.repeat(width)
  return '\t'.repeat(Math.floor(width / tabSize)) + ' '.repeat(width % tabSize)
}

// ---------------------------------------------------------------------------
// Character classes, used for word movement and double-click selection.

export const CHAR_SPACE = 0
export const CHAR_WORD = 1
export const CHAR_PUNCT = 2

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u

export function charCategory(ch: string, wordChars = ''): number {
  if (ch === ' ' || ch === '\t') return CHAR_SPACE
  if (WORD_CHAR.test(ch) || (wordChars && wordChars.includes(ch))) return CHAR_WORD
  return CHAR_PUNCT
}

/** Column of the next word boundary to the right (skipping whitespace first). */
export function wordEnd(text: string, col: number, wordChars = ''): number {
  let i = col
  while (i < text.length && charCategory(text[i]!, wordChars) === CHAR_SPACE) i++
  if (i >= text.length) return text.length
  const cat = charCategory(text[i]!, wordChars)
  while (i < text.length && charCategory(text[i]!, wordChars) === cat) i++
  return i
}

/** Column of the previous word boundary to the left (skipping whitespace first). */
export function wordStart(text: string, col: number, wordChars = ''): number {
  let i = col
  while (i > 0 && charCategory(text[i - 1]!, wordChars) === CHAR_SPACE) i--
  if (i <= 0) return 0
  const cat = charCategory(text[i - 1]!, wordChars)
  while (i > 0 && charCategory(text[i - 1]!, wordChars) === cat) i--
  return i
}

/** The run of same-category chars around `col` (used for double click). */
export function wordRangeAt(text: string, col: number, wordChars = ''): [number, number] {
  if (!text) return [0, 0]
  let at = Math.min(col, text.length - 1)
  // Prefer the word on the left when the cursor sits right after it.
  if (col > 0 && (col >= text.length || charCategory(text[col]!, wordChars) !== CHAR_WORD) &&
      charCategory(text[col - 1]!, wordChars) === CHAR_WORD) at = col - 1
  const cat = charCategory(text[at]!, wordChars)
  let from = at
  let to = at + 1
  if (cat === CHAR_PUNCT) return [from, to]
  while (from > 0 && charCategory(text[from - 1]!, wordChars) === cat) from--
  while (to < text.length && charCategory(text[to]!, wordChars) === cat) to++
  return [from, to]
}

// ---------------------------------------------------------------------------
// Grapheme-aware cursor steps (so the cursor never lands inside an emoji).

type Segmenter = { segment(input: string): Iterable<{ index: number; segment: string }> }
let segmenter: Segmenter | null | undefined

function getSegmenter(): Segmenter | null {
  if (segmenter === undefined) {
    const Intl_ = (globalThis as { Intl?: { Segmenter?: new (l?: string, o?: object) => Segmenter } }).Intl
    segmenter = Intl_?.Segmenter ? new Intl_.Segmenter(undefined, { granularity: 'grapheme' }) : null
  }
  return segmenter
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff

export function nextCharBoundary(text: string, col: number): number {
  if (col >= text.length) return text.length
  const code = text.charCodeAt(col)
  if (code < 0x300 && (col + 1 >= text.length || text.charCodeAt(col + 1) < 0x300)) return col + 1
  const seg = getSegmenter()
  if (seg) {
    for (const { index, segment } of seg.segment(text)) {
      if (index + segment.length > col) return index + segment.length
    }
    return text.length
  }
  return isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(col + 1)) ? col + 2 : col + 1
}

export function prevCharBoundary(text: string, col: number): number {
  if (col <= 0) return 0
  const code = text.charCodeAt(col - 1)
  if (code < 0x300 && (col < 2 || text.charCodeAt(col - 2) < 0x300)) return col - 1
  const seg = getSegmenter()
  if (seg) {
    let last = 0
    for (const { index } of seg.segment(text)) {
      if (index >= col) break
      last = index
    }
    return last
  }
  return isLowSurrogate(code) && col >= 2 && isHighSurrogate(text.charCodeAt(col - 2)) ? col - 2 : col - 1
}

/** The character (surrogate pair or grapheme cluster: emoji with modifiers, accents, flags) that `col` is strictly inside of. */
export function clusterAround(text: string, col: number): [number, number] | null {
  if (col <= 0 || col >= text.length || (text.charCodeAt(col) < 0x300 && text.charCodeAt(col - 1) < 0x300)) return null
  const end = nextCharBoundary(text, col)
  const start = prevCharBoundary(text, end)
  return start < col ? [start, end] : null
}

export function escapeHTML(text: string): string {
  let out = ''
  let last = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 38 || c === 60 || c === 62) {
      out += text.slice(last, i) + (c === 38 ? '&amp;' : c === 60 ? '&lt;' : '&gt;')
      last = i + 1
    }
  }
  return last === 0 ? text : out + text.slice(last)
}
