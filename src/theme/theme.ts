/**
 * Themes are plain objects compiled to CSS: UI colors become CSS custom
 * properties (`--jc-bg`, `--jc-caret`…) and token styles become class rules
 * (`.jc-t-keyword`). Token scopes fall back to their parents, so a theme that
 * styles `string` also covers `string.escape` unless it styles it explicitly.
 */

/**
 * Style of a token: any CSS property, in camelCase (`textDecoration`) or
 * kebab-case (`text-decoration`). Avoid properties that change the text width
 * (padding, margin, letter-spacing, font-size): the editor measures the font
 * once for all the text, so a wider token shifts the caret after it.
 * Backgrounds, borders via box-shadow, outlines, colors, underlines, italic
 * and bold are all safe.
 */
export interface TokenStyle {
  color?: string
  background?: string
  fontStyle?: 'normal' | 'italic'
  fontWeight?: 'normal' | 'bold' | number
  textDecoration?: string
  [property: string]: string | number | undefined
}

export interface ThemeColors {
  background: string
  foreground: string
  caret: string
  selection: string
  selectionInactive: string
  activeLine: string
  gutterBackground: string
  gutterForeground: string
  gutterActiveForeground: string
  gutterBorder: string
  matchingBracket: string
  matchingBracketBorder: string
  placeholder: string
  scrollbar: string
  scrollbarHover: string
}

export interface ThemeSpec {
  name: string
  /** Dark themes get `color-scheme: dark` (native controls, scrollbars). */
  dark?: boolean
  /** Base theme to inherit colors and tokens from. */
  extends?: Theme
  colors?: Partial<ThemeColors>
  /** Token styles: a color string or a full style. Keys are token scopes, e.g. `keyword`, `string.escape`. */
  tokens?: Record<string, string | TokenStyle>
}

export interface Theme {
  readonly name: string
  readonly dark: boolean
  readonly colors: Readonly<ThemeColors>
  readonly tokens: Readonly<Record<string, TokenStyle>>
  /** Class added to the editor root. */
  readonly className: string
  /** Generated stylesheet. */
  readonly css: string
}

const mix = (pct: number, color = 'var(--jc-fg)') => `color-mix(in srgb, ${color} ${pct}%, transparent)`

/** Colors not given by a theme are derived from its background/foreground. */
const DEFAULT_COLORS: ThemeColors = {
  background: '#282c34',
  foreground: '#abb2bf',
  caret: 'var(--jc-fg)',
  selection: mix(22),
  selectionInactive: mix(12),
  activeLine: mix(5),
  gutterBackground: 'var(--jc-bg)',
  gutterForeground: mix(40),
  gutterActiveForeground: 'var(--jc-fg)',
  gutterBorder: 'transparent',
  matchingBracket: mix(14),
  matchingBracketBorder: mix(40),
  placeholder: mix(40),
  scrollbar: mix(18),
  scrollbarHover: mix(32),
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

/** CSS variable name used for a UI color, e.g. `activeLine` → `--jc-active-line`. */
export function colorVar(key: keyof ThemeColors): string {
  return key === 'background' ? '--jc-bg' : key === 'foreground' ? '--jc-fg' : `--jc-${kebab(key)}`
}

const classCache = new Map<string, string>()
const typeCache = new Map<string, string>()

function scopeClasses(type: string): string[] {
  const parts = type.split('.').map((p) => p.replace(/[^\w-]/g, '_'))
  return parts.map((_, i) => 'jc-t-' + parts.slice(0, i + 1).join('-'))
}

/**
 * Class list for a token type: `string.escape` → `jc-t-string jc-t-string-escape`.
 * Combined types (`comment todo`) get the classes of every part.
 */
export function tokenClass(type: string): string {
  let cls = classCache.get(type)
  if (cls === undefined) {
    cls = type.split(/\s+/).filter(Boolean).flatMap(scopeClasses).join(' ')
    classCache.set(type, cls)
    typeCache.set(cls, type)
  }
  return cls
}

/** The token type behind a class list produced by `tokenClass` (used by `tokenInspector`). */
export function tokenTypeOfClass(className: string): string | undefined {
  return typeCache.get(className)
}

/** CSS selector matching a token type: `comment todo` → `.jc-t-comment.jc-t-todo`. */
export function tokenSelector(type: string): string {
  return type.split(/\s+/).filter(Boolean).map((t) => '.' + scopeClasses(t).pop()).join('')
}

const kebabProp = (p: string) => (p.includes('-') ? p : p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()))

/** Serializes a style object (camelCase or kebab-case keys) to declarations. */
export function styleToCSS(style: TokenStyle): string {
  let css = ''
  for (const [prop, value] of Object.entries(style)) {
    if (value != null && value !== '') css += `${kebabProp(prop)}:${value};`
  }
  return css
}

const usedNames = new Map<string, number>()

/**
 * Creates a theme.
 *
 * ```ts
 * const midnight = defineTheme({
 *   name: 'midnight',
 *   extends: oneDark,
 *   colors: { background: '#0b0e14' },
 *   tokens: { keyword: { color: '#ff79c6', fontWeight: 'bold' } },
 * })
 * ```
 */
export function defineTheme(spec: ThemeSpec): Theme {
  const parent = spec.extends
  const colors: ThemeColors = { ...DEFAULT_COLORS, ...parent?.colors, ...spec.colors }
  const tokens: Record<string, TokenStyle> = { ...parent?.tokens }
  for (const [key, value] of Object.entries(spec.tokens ?? {})) {
    tokens[key] = typeof value === 'string' ? { color: value } : value
  }
  const dark = spec.dark ?? parent?.dark ?? true

  const slug = spec.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  const count = usedNames.get(slug) ?? 0
  usedNames.set(slug, count + 1)
  const className = `jc-theme-${slug}${count ? '-' + count : ''}`

  const scope = `.${className}`
  let css = `${scope}{color-scheme:${dark ? 'dark' : 'light'};`
  for (const key of Object.keys(colors) as (keyof ThemeColors)[]) css += `${colorVar(key)}:${colors[key]};`
  css += '}'
  // Parents first so more specific scopes win the cascade.
  const keys = Object.keys(tokens).sort((a, b) => a.split('.').length - b.split('.').length)
  for (const key of keys) css += `${scope} ${tokenSelector(key)}{${styleToCSS(tokens[key]!)}}`

  return { name: spec.name, dark, colors, tokens, className, css }
}
