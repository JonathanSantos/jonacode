import { defineLanguage, type LanguageSpec, type TokenContext } from '../language/language.ts'

/*
 * Token choices:
 * - selectors: element → `tag`, `.class` → `type`, `#id` → `constant`,
 *   `:hover` / `::before` → `keyword`, `[attr=value]` → `attribute` + `string`,
 *   `&` → `variable.language` (like `this`), `*` → `tag`, combinators → `operator`
 * - at-rules (`@media`…) → `keyword`; media features `(min-width: …)` → `property`
 * - declarations: `color` → `property`, `--custom` → `variable`; values: numbers with
 *   units and `#fff` → `number`, keywords (`solid`, `auto`) → `constant`,
 *   `calc(` / `var(` → `function`, `!important` → `keyword`
 *
 * Nesting: inside a block, `name:` starts a declaration unless a `{` comes
 * before the next `;` / `}` (then it is a nested selector such as `a:hover {`).
 */

// Written without a leading `-?` so the tokenizer can dispatch on the first char.
const NAME = /(?:[a-zA-Z_]|-[a-zA-Z_])[\w-]*/
const NUM = String.raw`(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?(?:%|[a-zA-Z]+)?`

const ident = (_: string, { line, to }: TokenContext) => (line[to] === '(' ? 'function' : 'constant')

export const cssSpec: LanguageSpec = {
  name: 'css',
  extensions: ['.css'],
  comments: { block: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  closePairs: [['{', '}'], ['[', ']'], ['(', ')'], ['"', '"'], ["'", "'"]],
  indent: { increase: /[{[(]\s*(?:\/\*.*\*\/\s*)?$/, decrease: /^\s*[}\])]/ },
  wordChars: '-',
  // Common properties and at-rules (without the `@`, which isn't a word char), for `autocomplete()`.
  completions: /* @__PURE__ */ (
    'display position top right bottom left width height min-width max-width min-height max-height margin padding ' +
    'margin-top margin-bottom padding-top padding-bottom border border-radius border-color outline box-shadow ' +
    'box-sizing background background-color background-image color opacity font font-family font-size font-weight ' +
    'line-height text-align text-decoration text-transform text-overflow white-space vertical-align overflow ' +
    'z-index cursor pointer-events user-select visibility content transition transform animation flex ' +
    'flex-direction flex-wrap align-items justify-content gap grid grid-template-columns object-fit ' +
    'media keyframes import font-face supports container'
  ).split(' '),
  states: {
    // Top level: selectors and at-rules.
    root: [
      { include: 'common' },
      [/@[\w-]+/, 'keyword', '@atRule'],
      ['{', 'punctuation.bracket', '@block'],
      ['}', 'punctuation.bracket'],
      { include: 'selector' },
    ],
    // Inside `{ }`: declarations or nested rules.
    block: [
      { include: 'common' },
      ['}', 'punctuation.bracket', '@pop'],
      ['{', 'punctuation.bracket', '@block'],
      [/@[\w-]+/, 'keyword', '@atRule'],
      [/(--[\w-]*)(\s*)(:)/, ['variable', null, 'punctuation'], '@value'],
      [new RegExp(`(${NAME.source})(\\s*)(:)(?![^;{}]*\\{)`), ['property', null, 'punctuation'], '@value'],
      { include: 'selector' },
    ],
    // After `prop:`, up to `;` or `}` (may span lines).
    value: [
      { include: 'common' },
      [';', 'punctuation', '@pop'],
      { match: '}', token: 'punctuation.bracket', pop: 2 },
      // `a:hover` with its `{` on the next line: recover as a block.
      ['{', 'punctuation.bracket', '@next:block'],
      [/!\s*important\b/i, 'keyword'],
      { include: 'values' },
    ],
    // `@media screen and (min-width: 40em) {`, `@import url(x.css);`
    atRule: [
      { include: 'common' },
      ['{', 'punctuation.bracket', '@next:block'],
      [';', 'punctuation', '@pop'],
      { match: '}', token: 'punctuation.bracket', pop: 2 },
      [new RegExp(`(${NAME.source})(\\s*)(:)`), ['property', null, 'punctuation']],
      [/(?:and|or|not|only)(?![\w-])/, 'keyword'],
      { include: 'values' },
    ],
    selector: [
      [/\.-?[a-zA-Z_][\w-]*/, 'type'],
      [/#[\w-]+/, 'constant'],
      [/(::?[\w-]+)(\()/, ['keyword', 'punctuation.bracket'], '@pseudoArgs'],
      [/::?[\w-]+/, 'keyword'],
      ['[', 'punctuation.bracket', '@attr'],
      [NAME, 'tag'],
      ['*', 'tag'],
      ['&', 'variable.language'],
      [/[>+~|]/, 'operator'],
      [/[,;]/, 'punctuation'],
      [/[()]/, 'punctuation.bracket'],
      // Keyframe selectors (`50%`).
      [/\d+(?:\.\d+)?%?/, 'number'],
    ],
    // `:not(…)`, `:nth-child(2n + 1)`
    pseudoArgs: [
      [')', 'punctuation.bracket', '@pop'],
      ['(', 'punctuation.bracket', '@pseudoArgs'],
      [/\d+n?|n(?![\w-])/, 'number'],
      ['-', 'operator'],
      [/(?:odd|even|of)(?![\w-])/, 'keyword'],
      { include: 'common' },
      { include: 'selector' },
    ],
    attr: [
      [']', 'punctuation.bracket', '@pop'],
      [/([~|^$*]=|=)(\s*)([\w-]+)/, ['operator', null, 'string']],
      [/[~|^$*]=|=/, 'operator'],
      { include: 'common' },
      [/[\w-]+/, 'attribute'],
    ],
    values: [
      [/(url)(\()([^)'"]*)(\))/i, ['function', 'punctuation.bracket', 'string', 'punctuation.bracket']],
      [/--[\w-]+/, 'variable'],
      [/#[\da-fA-F]+\b/, 'number'],
      [new RegExp(`${NUM}|-${NUM}`), 'number'],
      [NAME, ident],
      [/[()[\]]/, 'punctuation.bracket'],
      [',', 'punctuation'],
      [/[-+*/=<>:]+/, 'operator'],
    ],
    common: [
      [/\s+/],
      [/\/\*/, 'comment', '@comment'],
      ['"', 'string', '@doubleString'],
      ["'", 'string', '@singleString'],
    ],
    comment: [
      [/[^*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      ['*', 'comment'],
    ],
    doubleString: [
      [/[^"\\]+/, 'string'],
      [/\\(?:[\da-fA-F]{1,6}\s?|[^])?/, 'string.escape'],
      ['"', 'string', '@pop'],
      // A `\` at the end of the line continues the string.
      [/(?<!\\)$/, null, '@pop'],
    ],
    singleString: [
      [/[^'\\]+/, 'string'],
      [/\\(?:[\da-fA-F]{1,6}\s?|[^])?/, 'string.escape'],
      ["'", 'string', '@pop'],
      [/(?<!\\)$/, null, '@pop'],
    ],
  },
}

/** CSS (with nesting). */
export const css = /* @__PURE__ */ defineLanguage(cssSpec)
