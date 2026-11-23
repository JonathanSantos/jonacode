import { defineLanguage, type LanguageSpec, type TokenContext, type TokenType } from '../language/language.ts'

const set = (s: string) => new Set(s.split(' '))

const KEYWORDS = set(
  'break case chan const continue default defer else fallthrough for func go goto if import interface map package range ' +
  'return select struct switch type var',
)
const CONSTANTS = set('true false nil iota')
const TYPES = set(
  'any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 ' +
  'uint16 uint32 uint64 uintptr',
)
const BUILTINS = set('append cap clear close complex copy delete imag len make max min new panic print println real recover')

const isSpace = (c: string | undefined) => c === ' ' || c === '\t'

function prevChar(line: string, from: number): string {
  let i = from - 1
  while (i >= 0 && isSpace(line[i])) i--
  return line[i] ?? ''
}

function nextChar(line: string, to: number): string {
  let i = to
  while (i < line.length && isSpace(line[i])) i++
  return line[i] ?? ''
}

/** The word right before `from` (skipping blanks), or `''`. */
function prevWord(line: string, from: number): string {
  let i = from
  while (i > 0 && isSpace(line[i - 1])) i--
  let j = i
  while (j > 0 && /[\p{L}\p{N}_]/u.test(line[j - 1]!)) j--
  return line.slice(j, i)
}

/** Classifies an identifier by the words and chars around it (Go has no sigils: context is all there is). */
function identifier(word: string, { line, from, to }: TokenContext): TokenType {
  const prev = prevChar(line, from)
  const next = nextChar(line, to)
  const call = next === '('
  // `fmt.Println(…)`, `p.name`.
  if (prev === '.' && line[from - 2] !== '.') return call ? 'function.method' : 'property'
  if (KEYWORDS.has(word)) return 'keyword'
  if (CONSTANTS.has(word)) return 'constant.language'
  const before = prevWord(line, from)
  // Declarations name things: `type Point struct`, `func main()`, `package main`.
  if (before === 'type') return 'type'
  if (before === 'func') return 'function'
  if (before === 'package' || before === 'import') return null
  if (TYPES.has(word)) return 'type.builtin'
  if (call) return BUILTINS.has(word) ? 'function.builtin' : 'function'
  // Exported names where a type goes. (Lower case ones can't be told from variables without a parser.)
  if (/^\p{Lu}/u.test(word)) {
    const glued = line[from - 1]
    if (
      // `Point{X: 1}`, `&Point{}`: a composite literal (`if ok {` is lower case by convention).
      next === '{' ||
      // `p Point`, `var origin Point`, `chan Point`: a name, then its type. Keywords come before values (`return Max`).
      (isSpace(glued) && before !== '' && (before === 'chan' || !KEYWORDS.has(before))) ||
      // `[]Point`, `map[string]Point`.
      glued === ']' ||
      // `*Point`, but not the product `2*Pi` or `a*B`.
      (glued === '*' && !/[\p{L}\p{N}_)\]]/u.test(line[from - 2] ?? ''))
    ) return 'type'
  }
  // `X: 1` inside a composite literal.
  if (next === ':' && line[line.indexOf(':', to) + 1] !== '=' && (prev === '{' || prev === ',' || prev === '')) return 'property'
  return 'variable'
}

/** Go. */
export const goSpec: LanguageSpec = {
  name: 'go',
  aliases: ['golang'],
  extensions: ['.go'],
  comments: { line: '//', block: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  closePairs: [['{', '}'], ['[', ']'], ['(', ')'], ['"', '"'], ["'", "'"], ['`', '`']],
  indent: {
    // After an opening bracket, and after `case x:` / `default:` (gofmt puts their bodies one level in).
    increase: /(?:[{[(]|^\s*(?:case\b.*|default\s*):)\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/,
    decrease: /^\s*[}\])]/,
    // gofmt: tabs, shown four columns wide by most editors.
    useTabs: true,
    size: 4,
  },
  completions: /* @__PURE__ */ [KEYWORDS, CONSTANTS, TYPES, BUILTINS].flatMap((s) => [...s]),
  states: {
    root: [
      [/\s+/],
      [/\/\/.*/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      ['"', 'string', '@string'],
      // Raw strings span lines and have no escapes (struct tags, SQL, templates).
      ['`', 'string', '@rawString'],
      // Runes: `'a'`, `'\n'`, `'\x41'`, `'\u00e9'`.
      [/'(?:[^'\\\n]|\\(?:[abfnrtv\\'"]|x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|[0-7]{3}))'/, 'string'],
      // Numbers: `1_000`, `0x1F`, `0o17`, `0b101`, `1.5e-3`, `0x1p-2`, imaginary `2i`.
      [/(?:0[xX][\da-fA-F_]+(?:\.[\da-fA-F_]*)?(?:[pP][-+]?\d+)?|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][-+]?\d+)?)i?/, 'number'],
      [/[\p{L}_][\p{L}\p{N}_]*/u, identifier],
      [/\.\.\./, 'operator'],
      [/<-|:=|&\^=?|<<=?|>>=?|&&|\|\||\+\+|--|[-+*/%&|^<>=!]=?|~/, 'operator'],
      [/[()[\]{}]/, 'punctuation.bracket'],
      [/[,;.:]/, 'punctuation'],
    ],
    comment: [
      [/[^*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      ['*', 'comment'],
    ],
    // Interpreted strings end with the line.
    string: [
      [/[^"\\]+/, 'string'],
      [/\\(?:[abfnrtv\\'"]|x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|[0-7]{3})/, 'string.escape'],
      ['"', 'string', '@pop'],
      ['\\', 'string'],
      [/$/, null, '@pop'],
    ],
    rawString: [
      [/[^`]+/, 'string'],
      ['`', 'string', '@pop'],
    ],
  },
}

/** Go. Indented with tabs (four columns wide) unless the editor is told otherwise. */
export const go = /* @__PURE__ */ defineLanguage(goSpec)
