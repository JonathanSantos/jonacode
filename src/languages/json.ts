import { defineLanguage, type LanguageSpec, type TokenContext, type TokenType } from '../language/language.ts'

/** A string is an object key when the next non-blank char is `:`. */
function keyOrString(_: string, { line, to }: TokenContext): TokenType {
  let i = to
  while (line[i] === ' ' || line[i] === '\t') i++
  return line[i] === ':' ? 'property' : 'string'
}

/**
 * JSON, tolerating `//` and `/* *\/` comments (JSONC, as in `tsconfig.json`).
 * Kept deliberately small: JSON is what people open as huge files, so the
 * root state has few rules, each starting with a concrete char.
 */
export const jsonSpec: LanguageSpec = {
  name: 'json',
  aliases: ['jsonc'],
  extensions: ['.json', '.jsonc', '.webmanifest'],
  comments: { line: '//', block: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']']],
  closePairs: [['{', '}'], ['[', ']'], ['"', '"']],
  indent: { increase: /[{[]\s*$/, decrease: /^\s*[}\]]/ },
  states: {
    root: [
      [/\s+/],
      // Fast path: strings without escapes (the vast majority), keys or values.
      [/"[^"\\]*"/, keyOrString],
      // Keys with escapes are rare: take them whole.
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'property'],
      ['"', 'string', '@string'],
      [/(?:-\d|\d)\d*(?:\.\d+)?(?:[eE][-+]?\d+)?/, 'number'],
      [/[{}[\]]/, 'punctuation.bracket'],
      // The following blanks are folded in: fewer tokens on dense lines.
      [/[:,]\s*/, 'punctuation'],
      [/[a-zA-Z_]\w*/, (w) => (w === 'true' || w === 'false' || w === 'null' ? 'constant.language' : null)],
      [/\/\/.*/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
    ],
    string: [
      [/[^"\\]+/, 'string'],
      [/\\(?:u[\da-fA-F]{4}|.)/, 'string.escape'],
      ['"', 'string', '@pop'],
      // Strings cannot span lines.
      [/$/, null, '@pop'],
    ],
    comment: [
      [/[^*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      ['*', 'comment'],
    ],
  },
}

/** JSON and JSON with comments. */
export const json = /* @__PURE__ */ defineLanguage(jsonSpec)
