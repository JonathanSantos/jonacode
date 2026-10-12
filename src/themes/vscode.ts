/**
 * Imports VS Code color themes (`*-color-theme.json`, also the old
 * `.tmTheme`-style `settings` arrays) as Jonacode themes.
 *
 * ```ts
 * import { fromVSCodeTheme } from 'jonacode/themes/vscode'
 * import text from './dracula-color-theme.json?raw' // JSONC text or a parsed object
 *
 * const dracula = fromVSCodeTheme(text, { tokens: { comment: '#7f8bb3' } })
 * createEditor(parent, { theme: dracula })
 * ```
 *
 * How token colors are mapped: each Jonacode token type is looked up through
 * representative TextMate scope stacks (`tag` → `meta.tag entity.name.tag`,
 * `keyword` → `keyword.other`, then `keyword.control`…, see `SCOPES`),
 * resolved like VS Code does: a selector matches a scope when it is a
 * dot-segment prefix of it (`keyword` matches `keyword.control.flow`,
 * `keyword.c` does not), the longest selector wins, a descendant selector
 * (`meta.tag entity`) beats a plain one of the same length when its ancestors
 * are in the stack, the later rule wins a tie, and color, background and font
 * style are resolved independently. The stacks carry no language root or
 * suffix, so language-specific rules (`source.css variable`,
 * `entity.name.tag.css`) never match: applied to every language, they make
 * the result worse (measured against VS Code's own rendering of its themes).
 * Only styles that differ from the parent type (or the plain text) are
 * emitted, so a subtype the theme does not style falls back to its parent
 * (`string.escape` → `string`). Not supported: `semanticTokenColors`,
 * `tokenColors` given as a path to a `.tmTheme`, exclusions (`a - b`) and
 * child combinators (`a > b`), which never match.
 */
import { defineTheme, type Theme, type ThemeColors, type TokenStyle } from '../theme/theme.ts'

export interface VSCodeTokenColor {
  name?: string
  /** A selector, comma-separated selectors or an array of them. Missing: the global defaults. */
  scope?: string | string[]
  settings?: {
    foreground?: string
    background?: string
    /** Space-separated `italic`, `bold`, `underline`, `strikethrough`; `''` resets to normal. */
    fontStyle?: string
    [key: string]: string | undefined
  }
}

export interface VSCodeTheme {
  name?: string
  /** `dark`, `light`, `hc-black`, `hc-light` (or the `uiTheme` names `vs-dark`, `vs`). Inferred from the background when missing. */
  type?: string
  /** Path of a base theme (VS Code's built-in themes chain `./dark_vs.json`…), see `include` in the options. */
  include?: string
  colors?: Record<string, string | null | undefined>
  tokenColors?: VSCodeTokenColor[] | string
  /** Old `.tmTheme`-style rules. */
  settings?: VSCodeTokenColor[]
}

export interface VSCodeThemeOptions {
  /** Theme name (default: the file's `name`, else `vscode`). */
  name?: string
  /** Base theme for the colors and token styles the VS Code theme leaves out. */
  extends?: Theme
  /** Token styles applied on top of the mapped ones. */
  tokens?: Record<string, string | TokenStyle>
  /**
   * Loads the theme named by an `include` (the path as written in the file,
   * e.g. `./dark_vs.json`). Its colors and rules come first, the including
   * file's on top. Without a resolver, `include` is ignored.
   */
  include?: (path: string) => VSCodeTheme | string | undefined
}

/** Our UI colors and the VS Code colors they come from, in order (`$x`: the global `settings.x` of a `.tmTheme`). */
const COLORS: Partial<Record<keyof ThemeColors, string>> = {
  background: 'editor.background $background',
  foreground: 'editor.foreground $foreground',
  caret: 'editorCursor.foreground $caret',
  selection: 'editor.selectionBackground $selection',
  selectionInactive: 'editor.inactiveSelectionBackground',
  activeLine: 'editor.lineHighlightBackground editor.lineHighlightBorder $lineHighlight',
  gutterBackground: 'editorGutter.background',
  gutterForeground: 'editorLineNumber.foreground',
  gutterActiveForeground: 'editorLineNumber.activeForeground',
  matchingBracket: 'editorBracketMatch.background',
  matchingBracketBorder: 'editorBracketMatch.border',
  placeholder: 'editorGhostText.foreground input.placeholderForeground',
  scrollbar: 'scrollbarSlider.background',
  scrollbarHover: 'scrollbarSlider.hoverBackground',
}

/**
 * Our token types and the TextMate scopes real grammars give the same text,
 * tried in order (comma-separated) until one matches a rule. Spaces separate
 * the scopes of a stack, outermost first. Parents come before their subtypes.
 * Where grammars split one of our types (`const` is `storage.type`, `if` is
 * `keyword.control`, JSON keys are `support.type.property-name`, `obj.key` is
 * `variable.other.property`), the first scope is the one that matched VS Code
 * best on its bundled themes. Methods are `entity.name.function` in VS Code's
 * JS/TS grammars, so `function.method` inherits `function`.
 */
const SCOPES: Record<string, string> = {
  comment: 'comment.line.double-slash',
  'comment.tag': 'comment storage.type.class.jsdoc',
  keyword: 'keyword.other,keyword.control,storage.type',
  operator: 'keyword.operator',
  punctuation: 'punctuation.separator',
  'punctuation.bracket': 'meta.brace.round',
  'punctuation.special': 'meta.template.expression punctuation.definition.template-expression.begin',
  'punctuation.tag': 'meta.tag punctuation.definition.tag',
  string: 'string.quoted.double',
  'string.escape': 'constant.character.escape',
  regexp: 'string.regexp',
  number: 'constant.numeric',
  constant: 'variable.other.constant,support.constant',
  'constant.language': 'constant.language',
  variable: 'variable.other.readwrite',
  'variable.language': 'variable.language.this',
  'variable.parameter': 'variable.parameter',
  property: 'support.type.property-name,variable.other.property',
  function: 'entity.name.function,support.function',
  type: 'entity.name.type,entity.name.class,support.class',
  'type.builtin': 'support.type.primitive',
  meta: 'meta.decorator entity.name.function',
  tag: 'meta.tag entity.name.tag',
  attribute: 'meta.tag entity.other.attribute-name',
  heading: 'markup.heading entity.name.section',
  emphasis: 'markup.italic',
  strong: 'markup.bold',
  link: 'string.other.link,markup.underline.link',
  inserted: 'markup.inserted',
  deleted: 'markup.deleted',
  invalid: 'invalid.illegal',
}

/**
 * Parses JSON with comments and trailing commas (JSONC), the format of VS Code
 * theme files. Strings are matched first, so `"https://…"` is left alone.
 */
export function parseJSONC(text: string): unknown {
  return JSON.parse(
    text
      .replace(/("(?:[^"\\]|\\.)*")|\/\/.*|\/\*[\s\S]*?\*\/|^\uFEFF/g, (_, s) => s ?? '')
      .replace(/("(?:[^"\\]|\\.)*")|,(?=\s*[\]}])/g, (_, s) => s ?? ''),
  )
}

const rulesOf = (theme: VSCodeTheme) => [theme.tokenColors, theme.settings, []].find(Array.isArray) as VSCodeTokenColor[]

function load(input: VSCodeTheme | string, include: VSCodeThemeOptions['include'], depth = 0): VSCodeTheme {
  const theme = (typeof input == 'string' ? parseJSONC(input) : input) as VSCodeTheme
  const base = theme.include && depth < 9 ? include?.(theme.include) : undefined
  if (!base) return theme
  const parent = load(base, include, depth + 1)
  return { ...parent, ...theme, colors: { ...parent.colors, ...theme.colors }, tokenColors: [...rulesOf(parent), ...rulesOf(theme)] }
}

function toStyle({ foreground, background, fontStyle }: NonNullable<VSCodeTokenColor['settings']>): TokenStyle {
  const style: TokenStyle = {}
  if (foreground) style.color = foreground.toLowerCase()
  if (background) style.background = background
  if (typeof fontStyle == 'string') {
    style.fontStyle = /italic/.test(fontStyle) ? 'italic' : 'normal'
    style.fontWeight = /bold/.test(fontStyle) ? 'bold' : 'normal'
    style.textDecoration = fontStyle.replace(/italic|bold/g, '').trim().replace('strikethrough', 'line-through') || 'none'
  }
  return style
}

/** A selector's parts, innermost first; its rank; its style. */
type Rule = [parts: string[], rank: number, style: TokenStyle]

const matches = (selector: string, scope = '') => scope == selector || scope.startsWith(selector + '.')

/**
 * Style of a scope stack (outermost first). For each scope, per property, the
 * best matching rule wins; inner scopes override what they set.
 */
function resolve(rules: Rule[], stack: string[]): TokenStyle {
  const out: TokenStyle = {}
  stack.forEach((_, i) => {
    const best: Record<string, number> = {}
    for (const [parts, rank, style] of rules) {
      let j = i + 1
      // The innermost part matches this scope, the others its ancestors, in order.
      if (parts.every((part, k) => { while (--j >= 0 && !matches(part, stack[j])) if (!k) return false; return j >= 0 })) {
        for (const key in style) {
          if (rank >= (best[key] ?? 0)) {
            out[key] = style[key]
            best[key] = rank
          }
        }
      }
    }
  })
  return out
}

/** Whether a `#rgb(a)` / `#rrggbb(aa)` color is dark (perceived brightness of the high nibbles below half). */
function isDark(color: string): boolean {
  const step = color.length < 6 ? 1 : 2
  const nibble = (i: number) => parseInt(color[1 + i * step]!, 16)
  return nibble(0) * 3 + nibble(1) * 6 + nibble(2) < 75
}

/**
 * Creates a theme from a VS Code color theme: the parsed JSON object or the
 * raw (JSONC) file text.
 */
export function fromVSCodeTheme(input: VSCodeTheme | string, options: VSCodeThemeOptions = {}): Theme {
  const theme = load(input, options.include)
  const global: Record<string, string | undefined> = {}
  const rules: Rule[] = []
  for (const { scope, settings } of rulesOf(theme)) {
    if (!settings) continue
    if (!scope) Object.assign(global, settings)
    else {
      const style = toStyle(settings)
      for (const selector of [scope].flat().join(',').split(',')) {
        const parts = selector.trim().split(/\s+/).reverse()
        // Longest innermost part first, then the longest ancestors.
        if (parts[0]) rules.push([parts, parts[0].length * 1e3 + parts.join().length, style])
      }
    }
  }

  const colors: Partial<ThemeColors> = {}
  for (const key in COLORS) {
    for (const id of COLORS[key as keyof ThemeColors]!.split(' ')) {
      const value = id[0] == '$' ? global[id.slice(1)] : theme.colors?.[id]
      if (value && typeof value == 'string') {
        colors[key as keyof ThemeColors] = value
        break
      }
    }
  }

  const { type, name } = theme
  const { background: bg, foreground: fg } = colors
  // Without type or colors (VS Code's `hc_light.json`), only the name is left.
  const dark = type ? /dark|black/.test(type) : bg ? isDark(bg) : fg ? !isDark(fg) : /\blight\b/i.test(name!) ? false : undefined
  // Our default background is dark: a light theme without one gets VS Code's.
  if (dark === false && !options.extends) {
    colors.background ??= '#ffffff'
    colors.foreground ??= '#000000'
  }

  const plain: TokenStyle = { color: colors.foreground?.toLowerCase(), fontStyle: 'normal', fontWeight: 'normal', textDecoration: 'none' }
  const effective: Record<string, TokenStyle> = {}
  const tokens: Record<string, string | TokenStyle> = {}
  for (const token in SCOPES) {
    // Top-level types are compared with plain text, subtypes with their parent.
    const parent = effective[token.replace(/\.[^.]+$/, '')] ?? plain
    let style: TokenStyle = {}
    for (const stack of SCOPES[token]!.split(',')) if (Object.keys((style = resolve(rules, stack.split(' ')))).length) break
    const full = (effective[token] = { ...parent, ...style })
    const diff: TokenStyle = {}
    for (const key in full) if (full[key] !== parent[key]) diff[key] = full[key]
    if (Object.keys(diff).length) tokens[token] = diff
  }

  return defineTheme({
    name: options.name ?? name ?? 'vscode',
    dark,
    extends: options.extends,
    colors,
    tokens: { ...tokens, ...options.tokens },
  })
}
