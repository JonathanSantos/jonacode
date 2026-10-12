import { defineLanguage, type LanguageSpec, type TokenType } from '../language/language.ts'
import { createIdentifier, javascriptSpec, javascriptStates, withJsx, type IdentifierHook } from './javascript.ts'

/** Reserved in TypeScript (and strict mode): always keywords. */
const RESERVED = new Set(['enum', 'implements', 'interface', 'private', 'protected', 'public'])
/** Contextual keywords: only when followed by a name (`readonly x`, `keyof T`, `declare module 'x'`). */
const CONTEXTUAL = new Set([
  'abstract', 'accessor', 'asserts', 'declare', 'infer', 'is', 'keyof', 'module', 'namespace', 'override',
  'readonly', 'type', 'unique',
])
/** Modifiers before a class member: `private readonly name: string`. */
const MODIFIERS = new Set(['private', 'public', 'protected', 'readonly', 'static', 'declare', 'override', 'abstract', 'accessor'])
/** Words introducing a type: `extends T`, `keyof T`, `x as T`… */
const TYPE_OPERATORS = new Set(['extends', 'implements', 'keyof', 'as', 'satisfies', 'is', 'infer', 'readonly', 'unique'])
const BUILTIN_TYPES = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'never', 'object', 'symbol', 'bigint'])

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_$]/u.test(c)

/** The word right before `from` (skipping blanks), or ''. */
function wordBefore(line: string, from: number): string {
  let end = from
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--
  let start = end
  while (start > 0 && isWordChar(line[start - 1])) start--
  return line.slice(start, end)
}

/** The innermost bracket still open at `from` on this line, or ''. */
function openBracket(line: string, from: number): string {
  let depth = 0
  for (let i = from - 1; i >= 0; i--) {
    const c = line[i]
    if (c === ')' || c === ']' || c === '}') depth++
    else if (c === '(' || c === '[' || c === '{') {
      if (!depth--) return c
    }
  }
  return ''
}

/** `|` / `&` as a union / intersection, not `||` / `&&`. */
const single = (line: string, i: number) => line[i - 1] !== line[i] && line[i + 1] !== line[i]

/** Index of the nearest non-blank char before `from` (or -1). */
function prevIndex(line: string, from: number): number {
  let i = from - 1
  while (i >= 0 && (line[i] === ' ' || line[i] === '\t')) i--
  return i
}

/** Index of the nearest non-blank char from `to` (or the line length). */
function nextIndex(line: string, to: number): number {
  let i = to
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++
  return i
}

const sticky = (re: RegExp, line: string, at: number) => {
  re.lastIndex = at
  return re.test(line)
}

const CONTEXTUAL_NEXT = /\s+(?!(?:in|of|instanceof|as|satisfies)\b)[\p{L}_$'"#[{(*]/uy
/** `: T`, `?: T` or `!: T` right after a name (annotation of a member / parameter). */
const ANNOTATION = /\s*[?!]?:/y
/** One char of a type argument list (`=>` is not a closing `>`, `a < b && c > (d)` is not a call). */
const TYPE_ARG = '(?:=>|=(?!>)|(?!&&|\\|\\|)[^<>=])'
const nest = (inner: string) => `(?:${TYPE_ARG}|<${inner}*>)`
/** `foo<T>(`: type arguments (nested up to 3 levels) followed by a call. */
const TYPE_ARGS_CALL = new RegExp(`<${nest(nest(TYPE_ARG))}*>\\s*\\(`, 'y')
/** `name = <T>(a: A): R =>`, `name = async (…): R =>` */
const TYPED_ARROW = /\s*=\s*(?:async\s*)?(?:<[^()]*>\s*)?\([^)]*\)\s*(?::[^=]*)?=>/y
/** `type Name<…> =` or a type parameter default `<T = …`, right before a type. */
const TYPE_ALIAS = /(?:\btype\s+[\p{L}_$][\p{L}\p{N}_$]*\s*(?:<.*>)?|<[^<>]*)\s*=\s*$/u

/** Is this a type position (`x: T`, `A | T`, `Array<T>`, `extends T`, `type X = T`…)? */
function inType(line: string, from: number, to: number, prev: string): boolean {
  const p = prevIndex(line, from)
  if (prev === ':' || prev === '<' || prev === ',' || prev === '(' || prev === '[') return true
  if ((prev === '|' || prev === '&') && single(line, p)) return true
  if (prev === '>' && line[p - 1] === '=') return true // `() => T`
  if (prev === '=' && TYPE_ALIAS.test(line.slice(Math.max(0, p - 80), p + 1))) return true
  if (TYPE_OPERATORS.has(wordBefore(line, from))) return true
  const n = nextIndex(line, to)
  const next = line[n]
  return next === '>' || (next === '[' && line[n + 1] === ']') || ((next === '|' || next === '&') && single(line, n))
}

/** TypeScript additions to the JavaScript identifier classification. */
const typescriptHook: IdentifierHook = (word, { line, from, to }, prev, next): TokenType | undefined => {
  if (RESERVED.has(word)) return 'keyword'
  if ((word === 'as' || word === 'satisfies') && /[\w$*})\]'"`]/.test(prev) && /[\p{L}_${[(]/u.test(next)) return 'keyword'
  if (CONTEXTUAL.has(word) && sticky(CONTEXTUAL_NEXT, line, to)) return 'keyword'
  if (word === 'global' && wordBefore(line, from) === 'declare') return 'keyword'
  if (BUILTIN_TYPES.has(word)) {
    // `number.toFixed()`, `{ string: 1 }` are values (and `const number = 1` is not a type position).
    if (next !== '.' && next !== ':' && inType(line, from, to, prev)) return 'type.builtin'
    return undefined
  }
  // `void`, `null` and `undefined` are also values: only obvious type positions.
  if (word === 'void' && (next === '' || ';,)|&>]}='.includes(next))) return 'type.builtin'
  if (word === 'null' || word === 'undefined') {
    const p = prevIndex(line, from)
    const n = nextIndex(line, to)
    if (prev === '<' || next === '>' || ((prev === '|' || prev === '&') && single(line, p)) ||
        ((next === '|' || next === '&') && single(line, n))) return 'type.builtin'
    return undefined
  }
  if (/^[A-Z]/.test(word)) return undefined
  // Annotated names: parameters `(a: T, b?: U)`, members `{ a?: T; b: U }`, `private x: T`.
  if ((next === ':' || next === '?' || next === '!') && sticky(ANNOTATION, line, to)) {
    if (prev === '(') return 'variable.parameter'
    if (prev === ',') return openBracket(line, from) === '(' ? 'variable.parameter' : 'property'
    if (prev === '{' || prev === ';' || prev === '') return 'property'
    if (MODIFIERS.has(wordBefore(line, from))) return 'property'
  }
  // Generic calls and declarations: `useState<string>()`, `function id<T>(x: T)`.
  if (next === '<' && sticky(TYPE_ARGS_CALL, line, nextIndex(line, to))) return 'function'
  if (next === '=' && sticky(TYPED_ARROW, line, to)) return 'function'
  return undefined
}

/** The spec is exported so other languages can extend it. */
export const typescriptSpec: LanguageSpec = {
  ...javascriptSpec,
  name: 'typescript',
  aliases: ['ts', 'mts', 'cts'],
  extensions: ['.ts', '.mts', '.cts'],
  // JavaScript's words plus TypeScript keywords, primitive and utility types, for `autocomplete()`.
  completions: /* @__PURE__ */ Array.from(new Set([
    javascriptSpec.completions!, RESERVED, CONTEXTUAL, BUILTIN_TYPES,
    'satisfies Record Partial Required Readonly Pick Omit ReturnType Awaited'.split(' '),
  ].flatMap((s) => [...s]))),
  states: /* @__PURE__ */ javascriptStates(/* @__PURE__ */ createIdentifier(typescriptHook)),
}

/** TypeScript: JavaScript plus types (annotations, generics, interfaces, enums…). */
export const typescript = /* @__PURE__ */ defineLanguage(typescriptSpec)

/**
 * In TSX, `<T,>(x: T) => x` and `<T extends U>` are generic arrows (see `withJsx`),
 * and `<T>(` in a type (`type F = <T>(x: T) => T`) is not an element either.
 */
export const tsxSpec: LanguageSpec = /* @__PURE__ */ withJsx(
  typescriptSpec,
  { name: 'tsx', aliases: [], extensions: ['.tsx'] },
  '[A-Z][\\p{L}\\p{N}_$]*>\\s*\\(',
)

/** TypeScript with JSX (React…). */
export const tsx = /* @__PURE__ */ defineLanguage(tsxSpec)
