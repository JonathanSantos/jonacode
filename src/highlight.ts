/**
 * Static highlighting: the same grammars and themes as the editor, without
 * the editor. `highlight()` returns an HTML string and never touches the DOM,
 * so it runs on a server (SSR, static site generators) as well as in the
 * browser. The markup has the editor's exact geometry (padding, rounded line
 * height, line-number gutter), so `lazyEditor()` can swap it for a real editor
 * without anything moving.
 *
 * ```ts
 * import { highlight, highlightStyles } from 'jonacode/highlight'
 * const html = highlight(code, javascript, { theme: oneDark, lineNumbers: true })
 * const css = highlightStyles(oneDark)        // on a server: the CSS, as a string, once per page
 * ensureHighlightStyles(document, oneDark)    // in the browser: puts it in the page (once)
 * ```
 */
import { findLanguage, plainText, type Language } from './language/language.ts'
import { tokenClass, type Theme } from './theme/theme.ts'
import { injectStyle } from './view/style.ts'

export interface HighlightOptions {
  /** Adds the theme's class. Its CSS has to be in the page: `ensureHighlightStyles(root, theme)`, or `highlightStyles(theme)` on a server. */
  theme?: Theme
  /** Line numbers, drawn with CSS counters (they're not copied with the text). */
  lineNumbers?: boolean
  /** Number of the first line. Default 1. */
  firstLine?: number
  tabSize?: number
  /** Space around the text, in px, like the editor's `padding` option (default `x` 12, `y` 8). */
  padding?: { x?: number; y?: number }
  /** Extra class on the `<pre>`. */
  className?: string
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))

/** Highlights `code` into `<pre class="jc-static"><code>…</code></pre>`. */
export function highlight(code: string, language: Language = plainText, options: HighlightOptions = {}): string {
  const lines = code.split(/\r\n?|\n/)
  let state = language.initialState
  let body = ''
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!
    const res = language.tokenize(text, state)
    state = res.state
    let html = ''
    for (const t of res.tokens) {
      const s = esc(text.slice(t.from, t.to))
      html += t.type ? `<span class="${tokenClass(t.type)}">${s}</span>` : s
    }
    body += (i ? '\n' : '') + `<span class="jc-l">${html}</span>`
  }
  const first = options.firstLine ?? 1
  const cls = ['jc-static', options.theme?.className, options.lineNumbers && 'jc-static-ln', options.className].filter(Boolean).join(' ')
  let style = options.tabSize ? `--jc-tab-size:${options.tabSize};` : ''
  const { x, y } = options.padding ?? {}
  if (x != null) style += `--jc-pad-x:${Math.max(0, x)}px;`
  if (y != null) style += `--jc-pad-y:${Math.max(0, y)}px;`
  if (options.lineNumbers) {
    style += `--jc-ln-chars:${Math.max(2, String(first + lines.length - 1).length)};`
    if (first !== 1) style += `counter-reset:jc-line ${first - 1};`
  }
  return `<pre class="${cls}" data-language="${esc(language.name)}"${style ? ` style="${style}"` : ''}><code>${body}</code></pre>`
}

/**
 * Structural CSS of static blocks. Mirrors the editor: 8px vertical padding,
 * 12px before the text (`--jc-pad-y` / `--jc-pad-x`, see the `padding` option), the line-number gutter
 * (`Nch + 26px`, rounded up to whole pixels) and the line height rounded to whole pixels like the editor measures it.
 */
export const STATIC_CSS = `
.jc-static{margin:0;padding:var(--jc-pad-y,8px) 0;overflow:auto;box-sizing:border-box;background:var(--jc-bg);color:var(--jc-fg);text-align:left;direction:ltr;
font-family:var(--jc-font-family,'JetBrains Mono','Fira Code','SF Mono',ui-monospace,Menlo,Consolas,'Liberation Mono',monospace);
font-size:var(--jc-font-size,14px);line-height:var(--jc-line-height,1.6);line-height:round(calc(var(--jc-font-size,14px) * var(--jc-line-height,1.6)),1px);
font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;white-space:pre;tab-size:var(--jc-tab-size,4);-webkit-text-size-adjust:none;text-size-adjust:none;counter-reset:jc-line}
.jc-static code{display:block;min-width:max-content;padding:0 var(--jc-pad-x,12px);font:inherit;background:none;color:inherit}
.jc-static-ln code{padding-left:0}
.jc-static-ln .jc-l::before{counter-increment:jc-line;content:counter(jc-line);display:inline-block;box-sizing:border-box;width:calc(var(--jc-ln-chars,2) * 1ch + 27px);width:calc(round(up,var(--jc-ln-chars,2) * 1ch + 26px,1px) + 1px);
margin-right:var(--jc-pad-x,12px);padding:0 10px 0 16px;text-align:right;color:var(--jc-gutter-foreground);background:var(--jc-gutter-background);
border-right:1px solid var(--jc-gutter-border);font-variant-numeric:tabular-nums;user-select:none;-webkit-user-select:none}
`

/** The CSS a page needs for static blocks: `STATIC_CSS` plus the themes' CSS. */
export function highlightStyles(...themes: Theme[]): string {
  return STATIC_CSS + themes.map((t) => t.css).join('')
}

/**
 * Puts the CSS of static blocks and of the given themes in the page, once per
 * document or shadow root (`root`: the document, a shadow root, or any element
 * inside one). Calling it again, or creating an editor with the same theme,
 * adds nothing. `highlightAll()` and `lazyEditor()` call it themselves.
 */
export function ensureHighlightStyles(root: ParentNode, ...themes: Theme[]): void {
  injectStyle(root as Node, 'static', STATIC_CSS)
  // The id the editor uses for a theme: one copy of its CSS, whoever comes first.
  for (const theme of themes) injectStyle(root as Node, theme.className, theme.css)
}

export interface HighlightAllOptions extends Omit<HighlightOptions, 'className'> {
  /** Languages picked by the block's class (`language-js`, `lang-ts`) or `data-language`. */
  languages: readonly Language[]
  /** Blocks to highlight. Default `pre > code`. */
  selector?: string
  root?: ParentNode
}

/**
 * Highlights existing `<pre><code class="language-…">` blocks in the page
 * (blogs, docs, Markdown output), like Prism or highlight.js. Returns how many
 * blocks were highlighted. The CSS they need (with the theme's, when one is
 * given) is put in the page, or in the shadow root `root` lives in.
 */
export function highlightAll(options: HighlightAllOptions): number {
  const root = options.root ?? document
  const doc = (root as Node).ownerDocument ?? (root as Document)
  let n = 0
  for (const code of root.querySelectorAll<HTMLElement>(options.selector ?? 'pre > code')) {
    const pre = code.parentElement!
    if (pre.classList.contains('jc-static')) continue
    const name = code.dataset.language ?? pre.dataset.language ?? /\b(?:language|lang)-([\w+#.-]+)/.exec(code.className + ' ' + pre.className)?.[1]
    const language = name ? findLanguage(options.languages, name) : undefined
    if (!language) continue
    const tpl = doc.createElement('template')
    tpl.innerHTML = highlight(code.textContent ?? '', language, options)
    pre.replaceWith(tpl.content)
    n++
  }
  if (n) ensureHighlightStyles(root, ...(options.theme ? [options.theme] : []))
  return n
}
