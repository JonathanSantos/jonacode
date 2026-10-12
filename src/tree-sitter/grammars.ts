/**
 * Which tree-sitter grammar each Jonacode language uses, and where to get it.
 * Grammars are `.wasm` files shipped by their npm packages: serve them from
 * your app (copy them, or import their URL with your bundler), or use
 * `cdnGrammars()` to start quickly.
 */
import type { TreeSitterModule } from './types.ts'

/** A grammar: a URL (string or URL), the wasm bytes, or a function that gives either. */
export type GrammarSource = string | URL | Uint8Array | (() => string | URL | Uint8Array | Promise<string | URL | Uint8Array>)

/** Language name (`editor.language.name`) → grammar, or a function that picks one. */
export type Grammars = Readonly<Record<string, GrammarSource>> | ((languageName: string) => GrammarSource | null | undefined)

export interface GrammarInfo {
  /** npm package that ships the wasm. */
  package: string
  /** Version tested with this module (ABI 14/15, for web-tree-sitter 0.25–0.27). */
  version: string
  /** File inside the package. */
  file: string
}

/**
 * The grammars of the built-in languages. JSX uses the JavaScript grammar
 * (it parses JSX), shell uses bash. Markdown needs none: its fenced code
 * blocks are checked with their own language. SQL has no prebuilt wasm on
 * npm: build one with `tree-sitter build --wasm` and pass it as `sql`.
 */
export const GRAMMARS: Readonly<Record<string, GrammarInfo>> = {
  javascript: { package: 'tree-sitter-javascript', version: '0.25.0', file: 'tree-sitter-javascript.wasm' },
  jsx: { package: 'tree-sitter-javascript', version: '0.25.0', file: 'tree-sitter-javascript.wasm' },
  typescript: { package: 'tree-sitter-typescript', version: '0.23.2', file: 'tree-sitter-typescript.wasm' },
  tsx: { package: 'tree-sitter-typescript', version: '0.23.2', file: 'tree-sitter-tsx.wasm' },
  json: { package: 'tree-sitter-json', version: '0.24.8', file: 'tree-sitter-json.wasm' },
  css: { package: 'tree-sitter-css', version: '0.25.0', file: 'tree-sitter-css.wasm' },
  html: { package: 'tree-sitter-html', version: '0.23.2', file: 'tree-sitter-html.wasm' },
  shell: { package: 'tree-sitter-bash', version: '0.25.1', file: 'tree-sitter-bash.wasm' },
}

/**
 * Grammars from a folder where you copied the wasm files (e.g. `/wasm/`):
 * `grammarsFrom('/wasm/')`. Copy them from `node_modules/<package>/<file>`
 * (see `GRAMMARS`).
 */
export function grammarsFrom(base: string | URL, only?: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, g] of Object.entries(GRAMMARS)) if (!only || only.includes(name)) out[name] = new URL(g.file, base).href
  return out
}

/**
 * The same grammars from the jsDelivr CDN, pinned to the tested versions.
 * Handy for demos and prototypes; for production, serve the files yourself.
 */
export function cdnGrammars(only?: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, g] of Object.entries(GRAMMARS)) {
    if (!only || only.includes(name)) out[name] = `https://cdn.jsdelivr.net/npm/${g.package}@${g.version}/${g.file}`
  }
  return out
}

/** web-tree-sitter on the jsDelivr CDN (the module finds its runtime wasm next to it). */
export const CDN_TREE_SITTER = 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.27.0/web-tree-sitter.js'

/**
 * Loads web-tree-sitter from the CDN, with no install and no bundler:
 * `treeSitter({ load: cdnTreeSitter, grammars: cdnGrammars() })`.
 */
export const cdnTreeSitter = (): Promise<TreeSitterModule> => import(/* @vite-ignore */ /* webpackIgnore: true */ CDN_TREE_SITTER) as Promise<TreeSitterModule>

/** Fenced code block info strings (Markdown) → language names. */
export const FENCE_ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript', javascript: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', typescript: 'typescript', mts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json', css: 'css', html: 'html',
  sh: 'shell', bash: 'shell', shell: 'shell', zsh: 'shell', sql: 'sql',
}
