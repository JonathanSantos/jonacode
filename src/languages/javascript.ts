import {
  defineLanguage,
  type LanguageSpec,
  type RuleEntry,
  type TokenContext,
  type TokenFunction,
  type TokenType,
} from '../language/language.ts'

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'of', 'return', 'static', 'switch', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
])
const CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])
const LANGUAGE_VARS = new Set(['this', 'super', 'arguments', 'globalThis'])
const BUILTINS = new Set([
  'console', 'window', 'document', 'navigator', 'process', 'require', 'module', 'exports', 'JSON', 'Math',
  'Intl', 'Reflect', 'Atomics',
])

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

/**
 * Extra identifier classification for derived languages (TypeScript…), tried
 * after member access (`a.b`) and before the JavaScript rules. `prev` / `next`
 * are the nearest non-blank chars around the word. Return `undefined` to fall through.
 */
export type IdentifierHook = (word: string, ctx: TokenContext, prev: string, next: string) => TokenType | undefined

/** Classifies an identifier using its neighbours (member access, calls, object keys…). */
export function createIdentifier(hook?: IdentifierHook): TokenFunction {
  return (word, ctx) => {
    const { line, from, to } = ctx
    const prev = prevChar(line, from)
    const next = nextChar(line, to)
    const isMember = prev === '.' && line.slice(Math.max(0, from - 3), from).trimEnd() !== '...'
    if (isMember) return next === '(' || line.startsWith('?.(', to) ? 'function.method' : 'property'
    const custom = hook?.(word, ctx, prev, next)
    if (custom !== undefined) return custom
    if (KEYWORDS.has(word)) return 'keyword'
    // Contextual keywords.
    if (word === 'from' && (next === '"' || next === "'")) return 'keyword'
    if (word === 'as' && /[\w$*}]/.test(prev) && /[\p{L}_${]/u.test(next)) return 'keyword'
    if ((word === 'get' || word === 'set') && /^\s+[\p{L}_$#[]/u.test(line.slice(to))) return 'keyword'
    if (CONSTANTS.has(word)) return 'constant.language'
    if (LANGUAGE_VARS.has(word)) return 'variable.language'
    if (BUILTINS.has(word)) return 'type.builtin'
    if (/^[A-Z][A-Z\d_]+$/.test(word)) return 'constant'
    if (/^[A-Z]/.test(word)) return 'type'
    if (next === '(' || line.startsWith('?.(', to)) return 'function'
    // `name = (…) =>`, `name = function`, `name = async`
    if (next === '=' && line[line.indexOf('=', to) + 1] !== '=' &&
        /^\s*=\s*(async\b|function\b|\([^)]*\)\s*=>|[\p{L}_$][\p{L}\p{N}_$]*\s*=>)/u.test(line.slice(to))) return 'function'
    if (next === ':' && (prev === '{' || prev === ',' || prev === '') && line[line.indexOf(':', to) + 1] !== ':') return 'property'
    return 'variable'
  }
}

const ID = /[\p{L}_$][\p{L}\p{N}_$\u200c\u200d]*/u

/**
 * Lookbehind matching the positions where an expression can start: a `/` there
 * is a regex literal (not a division), a `<` there opens a JSX element.
 */
const EXPR_START = '(?<=(?:^|[(,=:[!&|?{};~+\\-*%<>^]|\\b(?:return|typeof|case|do|else|in|instanceof|new|void|delete|throw|yield|await|of))\\s*)'

const REGEX = new RegExp(EXPR_START + '\\/(?![*/])(?:[^\\\\/[\\n]|\\\\.|\\[(?:[^\\]\\\\\\n]|\\\\.)*\\])+\\/[dgimsuyv]*')

const ESCAPE = /\\(?:x[\da-fA-F]{2}|u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|[0-7]{1,3}|[^])?/

const NUMBER =
  /(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*)n?|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?n?/

/**
 * The JavaScript states, with a custom identifier classifier (derived
 * languages such as TypeScript pass their own, see `createIdentifier`).
 */
export function javascriptStates(identifier: TokenFunction): Record<string, readonly RuleEntry[]> {
  return {
    root: [
      { match: /\s+/, token: null },
      { match: /^#!.*/, token: 'comment' },
      { match: /\/\/.*/, token: 'comment' },
      { match: /\/\*/, token: 'comment', push: 'comment' },
      { match: REGEX, token: 'regexp' },
      { match: ID, token: identifier },
      { match: new RegExp('#' + ID.source, 'u'), token: 'property' },
      { match: new RegExp('@' + ID.source + '(?:\\.' + ID.source + ')*', 'u'), token: 'meta' },
      { match: NUMBER, token: 'number' },
      { match: '"', token: 'string', push: 'doubleString' },
      { match: "'", token: 'string', push: 'singleString' },
      { match: '`', token: 'string', push: 'template' },
      { match: '=>', token: 'keyword' },
      { match: /\.\.\.|[-+*/%=&|^~!<>?:]+/, token: 'operator' },
      { match: /[{}()[\]]/, token: 'punctuation.bracket' },
      { match: /[;,.]/, token: 'punctuation' },
    ],
    comment: [
      { match: /\*\//, token: 'comment', pop: true },
      { match: /@[a-zA-Z]+/, token: 'comment.tag' },
      { match: /[^*@]+|[*@]/, token: 'comment' },
    ],
    doubleString: [
      { match: /[^"\\]+/, token: 'string' },
      { match: ESCAPE, token: 'string.escape' },
      { match: '"', token: 'string', pop: true },
      { match: /$/, pop: true },
    ],
    singleString: [
      { match: /[^'\\]+/, token: 'string' },
      { match: ESCAPE, token: 'string.escape' },
      { match: "'", token: 'string', pop: true },
      { match: /$/, pop: true },
    ],
    template: [
      { match: /[^`\\$]+/, token: 'string' },
      { match: ESCAPE, token: 'string.escape' },
      { match: '${', token: 'punctuation.special', push: 'templateExpr' },
      { match: '`', token: 'string', pop: true },
      { match: '$', token: 'string' },
    ],
    templateExpr: [
      { match: '}', token: 'punctuation.special', pop: true },
      { match: '{', token: 'punctuation.bracket', push: 'templateBlock' },
      { include: 'root' },
    ],
    templateBlock: [
      { match: '}', token: 'punctuation.bracket', pop: true },
      { match: '{', token: 'punctuation.bracket', push: 'templateBlock' },
      { include: 'root' },
    ],
  }
}

/** The spec is exported so other languages (TypeScript, JSX…) can extend it. */
export const javascriptSpec: LanguageSpec = {
  name: 'javascript',
  aliases: ['js', 'mjs', 'cjs'],
  extensions: ['.js', '.mjs', '.cjs'],
  comments: { line: '//', block: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  closePairs: [['{', '}'], ['[', ']'], ['(', ')'], ['"', '"'], ["'", "'"], ['`', '`']],
  indent: {
    increase: /[{[(]\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/,
    decrease: /^\s*[}\])]/,
  },
  wordChars: '$',
  // Keywords, constants and common globals, for `autocomplete()`.
  completions: /* @__PURE__ */ [
    KEYWORDS, CONSTANTS, LANGUAGE_VARS, BUILTINS,
    'Promise Array Object String Number Boolean Symbol Map Set Error Date RegExp fetch setTimeout setInterval clearTimeout parseInt parseFloat from as'.split(' '),
  ].flatMap((s) => [...s]),
  states: /* @__PURE__ */ javascriptStates(/* @__PURE__ */ createIdentifier()),
}

/** JavaScript (ES2024+). */
export const javascript = /* @__PURE__ */ defineLanguage(javascriptSpec)

// ---------------------------------------------------------------------------
// JSX

/** A JSX name segment (`div`, `my-element`, `Foo`). */
const JSX_NAME = '[\\p{L}_$][\\p{L}\\p{N}_$-]*'

const ENTITY = /&(?:[a-zA-Z][a-zA-Z\d]*|#\d+|#[xX][\da-fA-F]+);/

/** `div`, `svg:rect` → tag; `Foo`, `Foo.Bar`, `motion.div` (components) → type. */
function tagName(word: string, { line, from }: TokenContext): TokenType {
  return /^[A-Z]/.test(word) || line[from - 1] === '.' ? 'type' : 'tag'
}

/**
 * JSX states, added by `withJsx`. Elements live on the state stack: `jsxOpen`
 * (tag name) → `jsxAttrs` → `jsxChildren` → `jsxClose`, which pops back to
 * whatever opened the element (JavaScript code, or the parent's children).
 * (No spreads in here: they would keep this object in bundles that only use `javascript`.)
 */
export const jsxStates: Record<string, readonly RuleEntry[]> = {
  jsxOpen: [
    { match: '>', token: 'punctuation', next: 'jsxChildren' }, // fragment `<>`
    { match: /\s+/, token: null },
    { match: /[\p{L}_$][\p{L}\p{N}_$-]*(?=\.)/u, token: 'type' }, // `Foo.Bar`: split on the dots
    { match: '.', token: 'punctuation' },
    { match: /[\p{L}_$][\p{L}\p{N}_$-]*(?::[\p{L}_$][\p{L}\p{N}_$-]*)?/u, token: tagName, next: 'jsxAttrs' },
  ],
  jsxAttrs: [
    { match: /\s+/, token: null },
    { match: '/>', token: 'punctuation', pop: true },
    { match: '>', token: 'punctuation', next: 'jsxChildren' },
    { match: '{', token: 'punctuation.bracket', push: 'jsxExpr' },
    { match: /[\p{L}_$][\p{L}\p{N}_$-]*(?::[\p{L}_$][\p{L}\p{N}_$-]*)?/u, token: 'attribute' },
    { match: '=', token: 'operator' },
    { match: '"', token: 'string', push: 'jsxDoubleString' },
    { match: "'", token: 'string', push: 'jsxSingleString' },
    { match: /\/\/.*/, token: 'comment' },
    { match: /\/\*/, token: 'comment', push: 'comment' },
    // Type arguments of a generic component (TSX): `<Table<Row> rows={rows} />`.
    { match: '<', token: 'operator', push: 'jsxTypeArgs' },
  ],
  jsxTypeArgs: [
    { match: '>', token: 'operator', pop: true },
    { match: '<', token: 'operator', push: 'jsxTypeArgs' },
    { include: 'root' },
  ],
  jsxChildren: [
    { match: /[^<{&]+/, token: null },
    { match: '</', token: 'punctuation', next: 'jsxClose' },
    { match: /<(?=[\p{L}_$>])/u, token: 'punctuation', push: 'jsxOpen' },
    { match: '{', token: 'punctuation.bracket', push: 'jsxExpr' },
    { match: ENTITY, token: 'string.escape' },
  ],
  jsxClose: [
    { match: '>', token: 'punctuation', pop: true },
    { match: /\s+/, token: null },
    { match: /[\p{L}_$][\p{L}\p{N}_$-]*(?=\.)/u, token: 'type' }, // `Foo.Bar`: split on the dots
    { match: '.', token: 'punctuation' },
    { match: /[\p{L}_$][\p{L}\p{N}_$-]*(?::[\p{L}_$][\p{L}\p{N}_$-]*)?/u, token: tagName },
  ],
  // `{…}` in attributes and children: JavaScript, with nested braces tracked.
  jsxExpr: [
    { match: '}', token: 'punctuation.bracket', pop: true },
    { match: '{', token: 'punctuation.bracket', push: 'templateBlock' },
    { include: 'root' },
  ],
  jsxDoubleString: [
    { match: /[^"&]+/, token: 'string' },
    { match: ENTITY, token: 'string.escape' },
    { match: '"', token: 'string', pop: true },
    { match: '&', token: 'string' },
  ],
  jsxSingleString: [
    { match: /[^'&]+/, token: 'string' },
    { match: ENTITY, token: 'string.escape' },
    { match: "'", token: 'string', pop: true },
    { match: '&', token: 'string' },
  ],
}

/**
 * Adds JSX to a JavaScript-like spec (used for `jsx` and `tsx`). An element
 * starts where an expression can (`return <div>`, `(<A />)`, `x = <>…</>`), so
 * `a < b` and `i<n` stay comparisons. `exclude` is a regex source tested
 * right after the `<`: matches are not JSX (TSX uses it for `<T>(x: T) => …`).
 */
export function withJsx(spec: LanguageSpec, overrides: Partial<LanguageSpec>, exclude = ''): LanguageSpec {
  // `<>`, or a name followed by what can follow a tag name (`<T,>` and `<T extends U>` are generics).
  const open = new RegExp(
    `${EXPR_START}<(?=>|(?!${JSX_NAME}\\s+extends\\b${exclude ? '|' + exclude : ''})${JSX_NAME}(?:[.:]${JSX_NAME})*(?:[\\s/>{<]|$))`,
    'u',
  )
  return {
    ...spec,
    indent: {
      // Also indent after an opening tag (not `Array<T>`), and split `<div>|</div>` on Enter.
      increase: /(?:[{[(]|(?<![\p{L}\p{N}_$])<(?:[\p{L}_$](?:=>|[^<>])*(?<![/=]))?>)\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/u,
      decrease: /^\s*(?:[}\])]|<\/)/,
    },
    ...overrides,
    states: { ...spec.states, ...jsxStates, root: [{ match: open, token: 'punctuation', push: 'jsxOpen' }, ...spec.states.root!] },
  }
}

export const jsxSpec: LanguageSpec = /* @__PURE__ */ withJsx(javascriptSpec, { name: 'jsx', aliases: [], extensions: ['.jsx'] })

/** JavaScript with JSX (React…). */
export const jsx = /* @__PURE__ */ defineLanguage(jsxSpec)
