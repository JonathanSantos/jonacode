import { defineLanguage, findLanguage, type Language, type LanguageSpec, type RuleEntry } from '../language/language.ts'

export interface MarkdownOptions {
  /**
   * Languages for fenced code blocks, picked by the fence's info string
   * (```` ```js ````, ```` ```ts ````…) through their name, aliases or
   * extensions. A function can map the info string itself. Blocks without a
   * known language are shown as plain code.
   */
  codeLanguages?: readonly Language[] | ((info: string) => Language | null | undefined)
  /** Language of the `---` front matter block. Plain by default. */
  frontMatter?: Language | null
}

const INLINE: readonly RuleEntry[] = [
  // Plain text runs stop only where an inline construct may start.
  [/(?:[^`*_~[!<\\h|]|h(?!ttps?:\/\/))+/, null],
  [/\\[!-/:-@[-`{-~]/, 'string.escape'],
  [/``[^]*?``|`[^`]+`/, 'string'],
  [/\*\*(?=\S)(?:[^*\\]|\\.|\*(?!\*))+?\*\*|__(?=\S)(?:[^_\\]|\\.)+?__(?!\w)/, 'strong'],
  [/\*(?=[^\s*])(?:[^*\\]|\\.)+?\*|_(?=[^\s_])(?:[^_\\]|\\.)+?_(?!\w)/, 'emphasis'],
  [/~~(?=\S)[^~]+?~~/, 'deleted'],
  // [text](url "title") and ![alt](src)
  [/(!?\[)((?:[^\]\\]|\\.)*)(\]\()([^)\s]*)((?:\s+"[^"]*")?)(\))/, ['punctuation', 'link', 'punctuation', 'string', 'string', 'punctuation']],
  // [text][ref]
  [/(!?\[)((?:[^\]\\]|\\.)*)(\]\[)([^\]]*)(\])/, ['punctuation', 'link', 'punctuation', 'string', 'punctuation']],
  [/<(?:https?|mailto|ftp):[^\s>]+>|https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/, 'link'],
  [/<!--/, 'comment', '@comment'],
  [/<\/?[a-zA-Z][\w-]*(?:\s+[^<>]*?)?\/?>/, 'tag'],
]

/** The Markdown spec (CommonMark + GitHub tables, task lists and strikethrough). */
export function markdownSpec(options: MarkdownOptions = {}): LanguageSpec {
  const { codeLanguages, frontMatter = null } = options
  const pick = typeof codeLanguages === 'function'
    ? codeLanguages
    : codeLanguages?.length ? (info: string) => findLanguage(codeLanguages, info) : null
  // The closing fence uses the same char, at least as long as the opening one.
  const fenceEnd = (m: RegExpExecArray) => new RegExp(`^ {0,3}${m[2]![0] === '`' ? '`' : '~'}{${m[2]!.length},}\\s*$`)
  const fence = (char: '`' | '~'): RuleEntry => ({
    match: char === '`' ? /^( {0,3})(`{3,})([^`\s]*)([^`]*)$/ : /^( {0,3})(~{3,})(\S*)(.*)$/,
    token: [null, 'punctuation.special', 'type', 'comment'],
    push: char === '`' ? 'fenceBacktick' : 'fenceTilde',
    ...(pick ? { embed: { language: (m: RegExpExecArray) => (m[3] ? pick(m[3]) : null), end: fenceEnd } } : {}),
  })

  return {
    name: 'markdown',
    aliases: ['md', 'mkd', 'gfm'],
    extensions: ['.md', '.markdown', '.mdx'],
    start: 'start',
    comments: { block: ['<!--', '-->'] },
    brackets: [['[', ']'], ['(', ')']],
    closePairs: [['[', ']'], ['(', ')'], ['`', '`'], ['"', '"']],
    indent: { increase: null, decrease: null },
    states: {
      // Only the first line can open a front matter block.
      start: [
        frontMatter
          ? { match: /^---\s*$/, token: 'punctuation.special', next: 'frontMatter', embed: { language: frontMatter, end: /^(?:---|\.\.\.)\s*$/ } }
          : [/^---\s*$/, 'punctuation.special', '@next:frontMatter'],
        [/(?:)/, null, '@next:root'],
      ],
      frontMatter: [
        [/^(?:---|\.\.\.)\s*$/, 'punctuation.special', '@next:root'],
        [/.+/, 'meta'],
      ],
      root: [
        fence('`'),
        fence('~'),
        [/^ {0,3}(#{1,6})(?=\s|$).*/, 'heading'],
        // Setext heading underline / thematic break.
        [/^ {0,3}=+\s*$/, 'heading'],
        [/^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/, 'punctuation.special'],
        // Link reference definition: [ref]: url "title"
        [/^( {0,3}\[)([^\]]+)(\]:)(\s*)(\S+)(.*)$/, ['punctuation', 'link', 'punctuation', null, 'string', 'string']],
        [/^ {0,3}(?:>\s?)+/, 'comment'],
        // List markers, with an optional task box.
        [/^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\])(?=\s)/, [null, 'keyword', null, 'constant']],
        [/^(\s*)([-*+]|\d{1,9}[.)])(?=\s|$)/, [null, 'keyword']],
        // Table delimiter row, then cell separators.
        [/^ {0,3}\|?(?:\s*:?-+:?\s*\|)+(?:\s*:?-+:?\s*)?\|?\s*$/, 'punctuation'],
        ['|', 'punctuation'],
        ...INLINE,
      ],
      fenceBacktick: [
        [/^ {0,3}`{3,}\s*$/, 'punctuation.special', '@pop'],
        [/.+/, 'string'],
      ],
      fenceTilde: [
        [/^ {0,3}~{3,}\s*$/, 'punctuation.special', '@pop'],
        [/.+/, 'string'],
      ],
      comment: [
        [/-->/, 'comment', '@pop'],
        [/[^-]+|-/, 'comment'],
      ],
    },
  }
}

/**
 * Markdown with highlighted code blocks:
 *
 * ```ts
 * createMarkdown({ codeLanguages: [javascript, css, html] })
 * ```
 */
export function createMarkdown(options: MarkdownOptions = {}): Language {
  return defineLanguage(markdownSpec(options))
}

/** Markdown; code blocks are shown as plain code (see `createMarkdown`). */
export const markdown: Language = /* @__PURE__ */ createMarkdown()
