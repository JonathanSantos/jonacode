import { defineLanguage, type Language, type LanguageSpec, type RuleEntry } from '../language/language.ts'
import { css } from './css.ts'
import { javascript } from './javascript.ts'

export interface HtmlOptions {
  /** Language of `<script>` blocks and `on*="…"` handlers. Default `javascript`; `null` leaves them plain. */
  script?: Language | null
  /** Language of `<style>` blocks. Default `css`; `null` leaves them plain. */
  style?: Language | null
}

const VOID = 'area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr'

/** Attributes of an open tag, shared by every kind of tag. */
function attributes(script: Language | null): RuleEntry[] {
  return [
    { match: /\s+/, token: null },
    ...(script
      ? [{ match: /(on[a-z]+)(\s*=\s*)(")/i, token: ['attribute', 'punctuation', 'string'], push: 'handlerEnd', embed: { language: script, end: '"' } }]
      : []),
    [/(=)(\s*)([^\s"'=<>`]+)/, ['punctuation', null, 'string']],
    ['=', 'punctuation'],
    ['"', 'string', '@doubleValue'],
    ["'", 'string', '@singleValue'],
    [/[^\s"'>/=]+/, 'attribute'],
    ['/', 'punctuation.tag'],
  ]
}

/**
 * The HTML spec, with the languages embedded in `<script>`/`<style>`.
 * Rules and states can be reused by other markup languages (Vue, Svelte…).
 */
export function htmlSpec(options: HtmlOptions = {}): LanguageSpec {
  const script = options.script === undefined ? javascript : options.script
  const style = options.style === undefined ? css : options.style
  const attrs = attributes(script)
  return {
    name: 'html',
    aliases: ['htm', 'xhtml'],
    extensions: ['.html', '.htm', '.xhtml'],
    comments: { block: ['<!--', '-->'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    closePairs: [['{', '}'], ['[', ']'], ['(', ')'], ['"', '"'], ["'", "'"]],
    indent: {
      // After an opening tag that isn't closed on the same line (void elements excluded).
      increase: new RegExp(`<(?!(?:${VOID})\\b)[a-zA-Z][\\w:-]*(?:[^>"']|"[^"]*"|'[^']*')*>(?!.*<\\/)\\s*$`),
      // Enter between `<div>` and `</div>` splits them on three lines.
      decrease: /^\s*<\//,
    },
    wordChars: '-',
    // Common tag names, for `autocomplete()`.
    completions: (
      'html head body title meta link script style div span p a img br ul ol li h1 h2 h3 header footer main nav ' +
      'section article button input form label select option textarea table tr th td pre code strong em template svg'
    ).split(' '),
    states: {
      root: [
        [/[^<&]+/, null],
        [/<!--/, 'comment', '@comment'],
        [/<![a-zA-Z][^>]*>?/, 'meta'],
        [/<!\[CDATA\[/, 'string', '@cdata'],
        [/(<)(script)(?![\w:-])/i, ['punctuation.tag', 'tag'], '@scriptTag'],
        [/(<)(style)(?![\w:-])/i, ['punctuation.tag', 'tag'], '@styleTag'],
        [/(<\/?)([a-zA-Z][\w:.-]*)/, ['punctuation.tag', 'tag'], '@tag'],
        [/&(?:[a-zA-Z][a-zA-Z\d]*|#\d+|#[xX][\da-fA-F]+);/, 'string.escape'],
      ],
      comment: [
        [/-->/, 'comment', '@pop'],
        [/[^-]+|-/, 'comment'],
      ],
      cdata: [
        [/\]\]>/, 'string', '@pop'],
        [/[^\]]+|\]/, 'string'],
      ],
      tag: [
        [/\/?>/, 'punctuation.tag', '@pop'],
        ...attrs,
      ],
      scriptTag: [
        ['/>', 'punctuation.tag', '@pop'],
        script ? { match: '>', token: 'punctuation.tag', pop: true, embed: { language: script, end: /<\/script(?![\w:-])/i } } : ['>', 'punctuation.tag', '@next:rawScript'],
        ...attrs,
      ],
      styleTag: [
        ['/>', 'punctuation.tag', '@pop'],
        style ? { match: '>', token: 'punctuation.tag', pop: true, embed: { language: style, end: /<\/style(?![\w:-])/i } } : ['>', 'punctuation.tag', '@next:rawStyle'],
        ...attrs,
      ],
      // Without an embedded language the content is still raw text, never tags.
      rawScript: [
        [/(?=<\/script(?![\w:-]))/i, null, '@pop'],
        [/[^<]+|</, null],
      ],
      rawStyle: [
        [/(?=<\/style(?![\w:-]))/i, null, '@pop'],
        [/[^<]+|</, null],
      ],
      handlerEnd: [['"', 'string', '@pop']],
      doubleValue: [
        [/[^"&]+/, 'string'],
        [/&(?:[a-zA-Z][a-zA-Z\d]*|#\d+|#[xX][\da-fA-F]+);/, 'string.escape'],
        ['"', 'string', '@pop'],
        ['&', 'string'],
      ],
      singleValue: [
        [/[^'&]+/, 'string'],
        [/&(?:[a-zA-Z][a-zA-Z\d]*|#\d+|#[xX][\da-fA-F]+);/, 'string.escape'],
        ["'", 'string', '@pop'],
        ['&', 'string'],
      ],
    },
  }
}

/** HTML with another script or style language, e.g. `createHtml({ script: typescript })`. */
export function createHtml(options: HtmlOptions = {}): Language {
  return defineLanguage(htmlSpec(options))
}

/** HTML, with JavaScript in `<script>` and CSS in `<style>`. */
export const html: Language = /* @__PURE__ */ createHtml()
