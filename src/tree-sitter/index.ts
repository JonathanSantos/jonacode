/**
 * `jonacode/tree-sitter`: a real parser (tree-sitter, in WebAssembly) next to
 * the highlighter, to validate the code as it's typed, offer quick fixes for
 * syntax slips, and give extensions a syntax tree.
 *
 * Jonacode doesn't depend on tree-sitter: you pass `web-tree-sitter` in (so
 * your bundler decides how to load it, lazily by default) and the grammars
 * of the languages you use. Parsing is incremental and runs in idle time, in
 * slices of a few milliseconds, so typing never waits for it — even in files
 * with 100k lines. Embedded code is checked too: `<script>` and `<style>` in
 * HTML, fenced code blocks in Markdown.
 *
 * ```ts
 * import { treeSitter, cdnGrammars } from 'jonacode/tree-sitter'
 *
 * createEditor(el, {
 *   language: javascript,
 *   extensions: [basicSetup(), treeSitter({ load: () => import('web-tree-sitter'), grammars: cdnGrammars() })],
 * })
 * ```
 */
import type { ChangeEvent, Editor, Extension } from '../editor.ts'
import { diagnostics, setDiagnostics, type Diagnostic, type DiagnosticsOptions } from '../extensions/diagnostics.ts'
import type { Command, KeyBinding } from '../keymap.ts'
import { cmpPos, type Pos } from '../state/text.ts'
import { FENCE_ALIASES, type GrammarSource, type Grammars } from './grammars.ts'
import { LineOffsets } from '../state/offsets.ts'
import { combineFixes, findSyntaxProblems, type SyntaxProblem } from './problems.ts'
import type { TSLanguage, TSNode, TSParser, TSPoint, TSRange, TSTree, TreeSitterModule } from './types.ts'

export * from './grammars.ts'
export { findSyntaxProblems, combineFixes, type SyntaxProblem, type SyntaxFix, type ProblemOptions } from './problems.ts'
export type * from './types.ts'

export interface TreeSitterOptions {
  /** web-tree-sitter: `() => import('web-tree-sitter')` (loaded on first use), or the module itself. */
  load: TreeSitterModule | (() => TreeSitterModule | { default: TreeSitterModule } | Promise<TreeSitterModule | { default: TreeSitterModule }>)
  /** Where `web-tree-sitter.wasm` is, when your bundler doesn't serve it next to the module. */
  runtime?: string | URL
  /** The grammar of each language, by `editor.language.name`: see `cdnGrammars()` and `grammarsFrom()`. */
  grammars: Grammars
  /** Show syntax errors as diagnostics, with quick fixes (default true); false parses only (for `syntaxTree()`). */
  diagnostics?: boolean | DiagnosticsOptions
  /** Wait this long (ms) after an edit before parsing again (default 250). */
  delay?: number
  /** Also check `<script>`/`<style>` in HTML and fenced code blocks in Markdown (default true). */
  nested?: boolean
  /** Called after each parse (and again when the grammar of embedded code arrives). */
  onParse?: (result: ParseResult, editor: Editor) => void
}

export interface ParseResult {
  /** The language the tree is for (`editor.language.name`), and the tree (null when it has no grammar). */
  language: string
  tree: TSTree | null
  problems: readonly SyntaxProblem[]
  /** Time spent parsing, summed over the slices (ms). */
  ms: number
}

type GrammarOptions = Pick<TreeSitterOptions, 'load' | 'runtime' | 'grammars'>

/** Milliseconds of parsing per idle slice. */
const SLICE = 6

// ---------------------------------------------------------------------------
// Runtime: the module, initialized once, and the grammars loaded once each.

interface Runtime {
  mod: TreeSitterModule
  languages: Map<unknown, Promise<TSLanguage | null>>
}

const runtimes = new WeakMap<object, Promise<Runtime>>()
const inits = new WeakMap<object, Promise<void>>()

function runtimeFor(options: GrammarOptions): Promise<Runtime> {
  const key = options.load as object
  let rt = runtimes.get(key)
  if (!rt) {
    rt = (async () => {
      const loaded = typeof options.load === 'function' ? await options.load() : options.load
      const mod = ('Parser' in loaded ? loaded : loaded.default) as TreeSitterModule
      let init = inits.get(mod)
      if (!init) {
        const wasm = options.runtime && String(options.runtime)
        inits.set(mod, (init = mod.Parser.init(wasm ? { locateFile: () => wasm } : undefined)))
      }
      await init
      return { mod, languages: new Map() }
    })()
    runtimes.set(key, rt)
  }
  return rt
}

function grammarSource(grammars: Grammars, name: string): GrammarSource | null {
  return (typeof grammars === 'function' ? grammars(name) : grammars[name]) ?? null
}

/** The tree-sitter language of a Jonacode language name (null when there's no grammar for it). */
function languageFor(rt: Runtime, grammars: Grammars, name: string): Promise<TSLanguage | null> {
  const src = grammarSource(grammars, name)
  if (!src) return Promise.resolve(null)
  let lang = rt.languages.get(src)
  if (!lang) {
    lang = (async () => {
      const input = typeof src === 'function' ? await src() : src
      if (input instanceof Uint8Array) return rt.mod.Language.load(input)
      // In Node, web-tree-sitter reads paths from the disk: `file:` URLs become paths.
      const url = String(input)
      return rt.mod.Language.load(url.startsWith('file:') ? decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1') : url)
    })().catch((err) => {
      console.error(`[jonacode] could not load the tree-sitter grammar for "${name}"`, err)
      return null
    })
    rt.languages.set(src, lang)
  }
  return lang
}

// ---------------------------------------------------------------------------
// Embedded code: which parts of a document are in another language.

interface Region {
  language: string
  from: Pos
  to: Pos
}

/** `<script>` (JavaScript or JSON by its `type`) and `<style>` contents. */
function htmlRegions(root: TSNode): Region[] {
  const out: Region[] = []
  for (const el of root.descendantsOfType(['script_element', 'style_element'])) {
    if (!el) continue
    const raw = el.children.find((c) => c?.type === 'raw_text')
    if (!raw) continue
    let language = 'css'
    if (el.type === 'script_element') {
      const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(el.child(0)?.text ?? '')?.[1]?.toLowerCase()
      language = !type || type === 'module' || /javascript|ecmascript|jsx/.test(type) ? 'javascript' : /json|importmap/.test(type) ? 'json' : ''
    }
    if (language) out.push({ language, from: pos(raw.startPosition), to: pos(raw.endPosition) })
  }
  return out
}

/** Fenced code blocks with a known language. */
function markdownRegions(lines: readonly string[]): Region[] {
  const out: Region[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(lines[i]!)
    if (!open) continue
    const fence = open[1]!
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
    let j = i + 1
    while (j < lines.length && !close.test(lines[j]!)) j++
    const language = FENCE_ALIASES[open[2]!.toLowerCase()]
    if (language && j > i + 1) out.push({ language, from: { line: i + 1, col: 0 }, to: { line: j - 1, col: lines[j - 1]!.length } })
    i = j
  }
  return out
}

function regionsOf(language: string, root: TSNode | null, lines: readonly string[]): Region[] {
  if (language === 'html' && root) return htmlRegions(root)
  if (language === 'markdown') return markdownRegions(lines)
  return []
}

const pos = (p: TSPoint): Pos => ({ line: p.row, col: p.column })
const point = (p: Pos): TSPoint => ({ row: p.line, column: p.col })

/** tree-sitter input over an array of lines (joined by `\n`), without joining them. */
const reader = (lines: () => readonly string[]) => (_index: number, p: TSPoint): string => {
  const all = lines()
  const line = all[p.row]
  if (line === undefined) return ''
  const rest = p.column ? line.slice(p.column) : line
  return p.row < all.length - 1 ? rest + '\n' : rest
}

// ---------------------------------------------------------------------------
// The engine: one per editor.

interface Engine {
  editor: Editor
  options: TreeSitterOptions
  rt: Runtime | null
  /** `editor.language.name` the parser is set up for. */
  language: string
  parser: TSParser | null
  tree: TSTree | null
  offsets: LineOffsets
  /** The document changed since the tree was made. */
  dirty: boolean
  /** A sliced parse is under way (an edit abandons it). */
  parsing: boolean
  spent: number
  timer: ReturnType<typeof setTimeout> | undefined
  cancelIdle: (() => void) | null
  problems: SyntaxProblem[]
  /** `editor.version` the problems (and their fixes) are for. */
  version: number
  nested: Map<string, TSParser | null>
  waiters: (() => void)[]
  /** Selections before each "expand selection", to shrink back. */
  expanded: { anchor: Pos; head: Pos }[]
  destroyed: boolean
}

const engines = new WeakMap<Editor, Engine>()

function idle(eng: Engine, fn: () => void): void {
  const win = eng.editor.dom?.ownerDocument?.defaultView
  if (win?.requestIdleCallback) {
    const id = win.requestIdleCallback(fn, { timeout: 100 })
    eng.cancelIdle = () => win.cancelIdleCallback(id)
  } else {
    const id = setTimeout(fn, 0)
    eng.cancelIdle = () => clearTimeout(id)
  }
}

function schedule(eng: Engine, ms = eng.options.delay ?? 250): void {
  clearTimeout(eng.timer)
  eng.timer = setTimeout(() => void run(eng), ms)
}

/** Sets the parser up for the editor's current language (loads its grammar the first time). */
async function prepare(eng: Engine): Promise<boolean> {
  const name = eng.editor.language.name
  if (name === eng.language && eng.rt) return true
  eng.rt ??= await runtimeFor(eng.options)
  const grammar = await languageFor(eng.rt, eng.options.grammars, name)
  if (eng.destroyed) return false
  if (eng.editor.language.name !== name) return prepare(eng)
  eng.language = name
  eng.tree?.delete()
  eng.tree = null
  eng.offsets = new LineOffsets(eng.editor.doc.lines)
  if (grammar) {
    eng.parser ??= new eng.rt.mod.Parser()
    eng.parser.setLanguage(grammar)
  } else {
    eng.parser?.delete()
    eng.parser = null
  }
  return true
}

async function run(eng: Engine): Promise<void> {
  if (eng.destroyed || eng.parsing) return
  if (!(await prepare(eng))) return
  // A fresh parse: drop what a parse abandoned by an edit had done (it read the old text).
  eng.parser?.reset()
  eng.parsing = true
  eng.spent = 0
  const input = reader(() => eng.editor.doc.lines)
  const step = () => {
    eng.cancelIdle = null
    if (eng.destroyed || !eng.parsing) return
    const parser = eng.parser
    if (!parser) return finish(eng, null)
    const t0 = performance.now()
    const tree = parser.parse(input, eng.tree, { progressCallback: () => performance.now() - t0 > SLICE })
    eng.spent += performance.now() - t0
    if (tree) finish(eng, tree)
    else idle(eng, step)
  }
  idle(eng, step)
}

function finish(eng: Engine, tree: TSTree | null): void {
  if (tree && eng.tree !== tree) eng.tree?.delete()
  eng.tree = tree
  eng.parsing = false
  eng.dirty = false
  refresh(eng)
  for (const w of eng.waiters.splice(0)) w()
}

/** The problems of the tree and of the embedded code, published as diagnostics. */
function refresh(eng: Engine): void {
  const { editor, options } = eng
  const lines = editor.doc.lines
  const phrase = (s: string) => editor.phrase(s)
  const problems = eng.tree ? findSyntaxProblems(eng.tree.rootNode, lines, { phrase, grammar: eng.language }) : []
  if (options.nested !== false) {
    const input = reader(() => editor.doc.lines)
    for (const region of regionsOf(eng.language, eng.tree?.rootNode ?? null, lines)) {
      const parser = nestedParser(eng, region.language)
      if (!parser) continue
      const range: TSRange = {
        startIndex: eng.offsets.offset(region.from), endIndex: eng.offsets.offset(region.to),
        startPosition: point(region.from), endPosition: point(region.to),
      }
      const tree = parser.parse(input, null, { includedRanges: [range] })
      if (!tree) continue
      problems.push(...findSyntaxProblems(tree.rootNode, lines, { phrase, grammar: region.language }))
      tree.delete()
    }
    problems.sort((a, b) => cmpPos(a.from, b.from))
  }
  eng.problems = problems
  eng.version = editor.version
  options.onParse?.({ language: eng.language, tree: eng.tree, problems, ms: eng.spent }, editor)
  if (options.diagnostics !== false) {
    const version = editor.version
    setDiagnostics(editor, problems.map((p): Diagnostic => ({
      from: p.from, to: p.to, severity: p.severity, message: p.message, source: editor.phrase('syntax'),
      actions: p.fixes.map((f) => ({
        name: f.label,
        // Fixes are computed for one version of the document: after an edit they wait for the next parse.
        apply: (ed) => void (ed.version === version && ed.dispatch({ changes: f.changes, origin: 'input.fix', scrollIntoView: true })),
      })),
    })), 'syntax')
  }
}

/** A parser for embedded code; loads its grammar the first time (and checks again when it's there). */
function nestedParser(eng: Engine, language: string): TSParser | null {
  if (eng.nested.has(language)) return eng.nested.get(language)!
  eng.nested.set(language, null)
  const rt = eng.rt
  if (rt) {
    void languageFor(rt, eng.options.grammars, language).then((grammar) => {
      if (!grammar || eng.destroyed) return
      const parser = new rt.mod.Parser()
      parser.setLanguage(grammar)
      eng.nested.set(language, parser)
      if (!eng.dirty && !eng.parsing) refresh(eng)
    })
  }
  return null
}

function onChange(eng: Engine, event: ChangeEvent): void {
  if (event.origin === 'setValue') {
    // A whole new document: start from scratch.
    eng.tree?.delete()
    eng.tree = null
    eng.offsets = new LineOffsets(eng.editor.doc.lines)
  } else {
    for (const change of event.changes) {
      const edit = eng.offsets.apply(change)
      eng.tree?.edit(edit)
    }
  }
  eng.dirty = true
  if (eng.parsing) {
    // The slices so far read the old text: start over after the pause.
    eng.cancelIdle?.()
    eng.cancelIdle = null
    eng.parsing = false
  }
  schedule(eng)
}

/**
 * Validates the code with tree-sitter: syntax errors become diagnostics
 * (wavy underline, gutter, F8), with quick fixes when the slip is clear.
 */
export function treeSitter(options: TreeSitterOptions): Extension {
  const diag = options.diagnostics === false ? null : diagnostics(typeof options.diagnostics === 'object' ? options.diagnostics : {})
  return [diag, (editor) => {
    const eng: Engine = {
      editor, options, rt: null, language: '', parser: null, tree: null, offsets: new LineOffsets(editor.doc.lines),
      dirty: true, parsing: false, spent: 0, timer: undefined, cancelIdle: null,
      problems: [], version: -1, nested: new Map(), waiters: [], expanded: [], destroyed: false,
    }
    engines.set(editor, eng)
    const offChange = editor.on('change', (e) => onChange(eng, e))
    const offKeys = editor.addKeymap(syntaxKeymap)
    schedule(eng, 0)
    return () => {
      eng.destroyed = true
      clearTimeout(eng.timer)
      eng.cancelIdle?.()
      offChange()
      offKeys()
      eng.tree?.delete()
      eng.parser?.delete()
      for (const p of eng.nested.values()) p?.delete()
      engines.delete(editor)
      if (options.diagnostics !== false) setDiagnostics(editor, [], 'syntax')
      for (const w of eng.waiters.splice(0)) w()
    }
  }]
}

// ---------------------------------------------------------------------------
// API

/** The latest syntax tree (null before the first parse, or without a grammar). It follows edits until the next parse. */
export function syntaxTree(editor: Editor): TSTree | null {
  return engines.get(editor)?.tree ?? null
}

/** Resolves when the tree matches the document (parsing right away if an edit is waiting). */
export function whenParsed(editor: Editor): Promise<TSTree | null> {
  const eng = engines.get(editor)
  if (!eng) return Promise.resolve(null)
  if (!eng.dirty && !eng.parsing && eng.version === editor.version) return Promise.resolve(eng.tree)
  return new Promise((resolve) => {
    eng.waiters.push(() => resolve(eng.tree))
    if (!eng.parsing) schedule(eng, 0)
  })
}

/**
 * The current syntax problems (after the pending parse). Works as the
 * `verify` of `editorTools`, so an AI agent sees syntax errors after each edit.
 */
export async function getSyntaxProblems(editor: Editor): Promise<SyntaxProblem[]> {
  await whenParsed(editor)
  return engines.get(editor)?.problems ?? []
}

/** The smallest (named) node at a position. */
export function nodeAt(editor: Editor, at: Pos, named = true): TSNode | null {
  let node = syntaxTree(editor)?.rootNode.descendantForPosition(point(at)) ?? null
  while (named && node && !node.isNamed && node.parent) node = node.parent
  return node
}

/** Applies the first quick fix of every syntax problem (the ones that don't overlap), in one undo step. */
export const fixAllSyntax: Command = (editor) => {
  const eng = engines.get(editor)
  if (!eng || eng.version !== editor.version) return false
  const changes = combineFixes(eng.problems)
  if (!changes.length) return false
  editor.dispatch({ changes, origin: 'input.fix', scrollIntoView: true })
  return true
}

const nodeRange = (n: TSNode) => ({ anchor: pos(n.startPosition), head: pos(n.endPosition) })

/** Selects the syntax node around the selection, then its parent… (expand selection). */
export const selectSyntaxParent: Command = (editor) => {
  const eng = engines.get(editor)
  const tree = eng?.tree
  if (!eng || !tree) return false
  const sel = editor.selection
  const from = cmpPos(sel.anchor, sel.head) <= 0 ? sel.anchor : sel.head
  const to = cmpPos(sel.anchor, sel.head) <= 0 ? sel.head : sel.anchor
  let node: TSNode | null = tree.rootNode.descendantForPosition(point(from), point(to))
  // The first node strictly larger than the selection.
  while (node && cmpPos(pos(node.startPosition), from) === 0 && cmpPos(pos(node.endPosition), to) === 0) node = node.parent
  if (!node) return false
  eng.expanded.push({ anchor: sel.anchor, head: sel.head })
  editor.dispatch({ selection: nodeRange(node), scrollIntoView: true, origin: 'select.syntax' })
  return true
}

/** Undoes the last `selectSyntaxParent` (shrink selection). */
export const selectSyntaxChild: Command = (editor) => {
  const eng = engines.get(editor)
  const prev = eng?.expanded.pop()
  if (!prev) return false
  editor.dispatch({ selection: prev, scrollIntoView: true, origin: 'select.syntax' })
  return true
}

/** Alt+Shift+→ / ← (Ctrl+Shift+Cmd+→ / ← on macOS), like VS Code. */
export const syntaxKeymap: readonly KeyBinding[] = [
  { key: 'Alt-Shift-ArrowRight', mac: 'Ctrl-Shift-Mod-ArrowRight', run: selectSyntaxParent },
  { key: 'Alt-Shift-ArrowLeft', mac: 'Ctrl-Shift-Mod-ArrowLeft', run: selectSyntaxChild },
]

/**
 * Checks text that isn't in an editor — for example what an AI wants to
 * write, before applying it. Uses the same module and grammars.
 */
export function createSyntaxChecker(options: GrammarOptions & { phrase?: (text: string) => string }) {
  return {
    async check(source: string, language: string): Promise<SyntaxProblem[]> {
      const rt = await runtimeFor(options)
      const lines = source.split(/\r\n?|\n/)
      const input = reader(() => lines)
      const offsets = new LineOffsets(lines)
      const problems: SyntaxProblem[] = []
      const parse = async (name: string, range?: TSRange) => {
        const grammar = await languageFor(rt, options.grammars, name)
        if (!grammar) return null
        const parser = new rt.mod.Parser()
        parser.setLanguage(grammar)
        const tree = parser.parse(input, null, range ? { includedRanges: [range] } : undefined)
        parser.delete()
        if (tree) problems.push(...findSyntaxProblems(tree.rootNode, lines, { phrase: options.phrase, grammar: name }))
        return tree
      }
      const tree = await parse(language)
      for (const r of regionsOf(language, tree?.rootNode ?? null, lines)) {
        const nested = await parse(r.language, { startIndex: offsets.offset(r.from), endIndex: offsets.offset(r.to), startPosition: point(r.from), endPosition: point(r.to) })
        nested?.delete()
      }
      tree?.delete()
      return problems.sort((a, b) => cmpPos(a.from, b.from))
    },
  }
}
