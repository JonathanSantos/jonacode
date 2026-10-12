/**
 * Declarative, state-machine based languages (inspired by Monaco's Monarch).
 *
 * A language is a set of named states. Each state is an ordered list of rules
 * (regex + token). The tokenizer walks a line trying the rules of the current
 * state; rules can `push`, `pop` or switch (`next`) states, which is how
 * multi-line constructs (block comments, template strings…) are handled.
 * The state at the end of a line is carried to the next one, which makes
 * tokenization incremental and cheap.
 */

import { firstChars } from './first-chars.ts'

/**
 * A token type: dot separated scopes, e.g. `keyword`, `string.escape`.
 * Several types can be combined with spaces (`comment todo`): the element
 * gets the classes of all of them. `null` = plain text.
 */
export type TokenType = string | null

export interface Token {
  from: number
  to: number
  type: TokenType
  /** Inline CSS for this token only (set by token transforms such as `tokenRule`). */
  style?: string
}

export interface TokenContext {
  /** The whole line being tokenized. */
  readonly line: string
  /** Start offset of the match. */
  readonly from: number
  /** End offset of the match. */
  readonly to: number
  /** Name of the current state. */
  readonly state: string
  /** The raw regex match (with capture groups). */
  readonly match: RegExpExecArray
}

export type TokenFunction = (text: string, ctx: TokenContext) => TokenType

/**
 * - a string / null: the token type for the whole match
 * - a function: computes the token type (e.g. keyword lookup)
 * - an array: one token type per capture group (groups should cover the match)
 */
export type TokenSpec = TokenType | TokenFunction | readonly TokenType[]

export interface Rule {
  /** Regex (or literal string) matched at the current position. */
  match: RegExp | string
  token?: TokenSpec
  /** Enter a state, keeping the current one on the stack. */
  push?: string
  /** Leave the current state (or `n` states). */
  pop?: boolean | number
  /** Replace the current state. */
  next?: string
  /**
   * After the match (and the action), tokenize the text that follows with
   * another language until `embed.end` matches — `<script>` in HTML, a code
   * fence in Markdown…
   */
  embed?: EmbedSpec
}

export interface EmbedSpec {
  /** The embedded language, or a function that picks it from the opening match (`null`: don't embed). */
  language: Language | ((match: RegExpExecArray) => Language | null | undefined)
  /**
   * Where the embedded region ends. The end text is not consumed: the host
   * language tokenizes it (e.g. its rule for `</script>`). A function can
   * derive it from the opening match (a fence of four backticks ends on four).
   */
  end: RegExp | string | ((match: RegExpExecArray) => RegExp | string)
}

/** An embedded language region, interned so equal states stay `===`. */
export interface EmbedFrame {
  readonly id: number
  readonly language: Language
  /** Global regex searched from the current position. */
  readonly end: RegExp
}

/** Copies the rules of another state in place. */
export interface IncludeRule {
  include: string
}

/**
 * Compact rule form: `[match, token, action]`, where action is
 * `'@pop'`, `'@push:name'`, `'@next:name'` or just `'@name'` (push).
 */
export type RuleTuple = readonly [match: RegExp | string, token?: TokenSpec, action?: string]

export type RuleEntry = Rule | IncludeRule | RuleTuple

export interface LanguageSpec {
  /** Unique name, e.g. `javascript`. */
  name: string
  aliases?: readonly string[]
  /** File extensions, e.g. `['.js']`. Informational (useful for lookups). */
  extensions?: readonly string[]
  /** Name of the initial state. Defaults to `root`. */
  start?: string
  states: Record<string, readonly RuleEntry[]>
  /** Token for chars no rule matched. Defaults to `null` (plain text). */
  defaultToken?: TokenType
  comments?: { line?: string; block?: readonly [string, string] }
  /** Bracket pairs, used for matching and auto-indentation. */
  brackets?: readonly (readonly [string, string])[]
  /** Pairs automatically closed while typing (used by `closeBrackets`). */
  closePairs?: readonly (readonly [string, string])[]
  indent?: {
    /** Tested against the text before the cursor on Enter: indent the new line (`null`: never). */
    increase?: RegExp | null
    /** Tested against a line while typing: outdent it (e.g. a line starting with `}`). */
    decrease?: RegExp | null
  }
  /** Extra chars considered part of words (e.g. `$` for JavaScript). */
  wordChars?: string
  /** Words suggested by `autocomplete()` (keywords, builtins…). */
  completions?: readonly string[]
  /** Lines longer than this are only tokenized up to the limit. Default 10000. */
  maxLineLength?: number
}

/**
 * The tokenizer state: an immutable, interned stack of state names.
 * Equal stacks are the same object, so states can be compared with `===`.
 */
export class State {
  readonly name: string
  readonly parent: State | null
  readonly depth: number
  readonly id: number
  /** Set when this state tokenizes an embedded language… */
  readonly embed: EmbedFrame | null
  /** …whose own state is this one. */
  readonly inner: State | null
  private children: Map<string, State> | null = null
  private static nextId = 0

  constructor(name: string, parent: State | null, embed: EmbedFrame | null = null, inner: State | null = null) {
    this.name = name
    this.parent = parent
    this.depth = parent ? parent.depth + 1 : 0
    this.id = State.nextId++
    this.embed = embed
    this.inner = inner
  }

  push(name: string): State {
    if (this.depth > 100) return this
    let child = this.children?.get(name)
    if (!child) {
      child = new State(name, this)
      ;(this.children ??= new Map()).set(name, child)
    }
    return child
  }

  pop(count = 1): State {
    let s: State = this
    while (count-- > 0 && s.parent && s.parent.parent) s = s.parent
    return s
  }

  swap(name: string): State {
    return this.parent ? this.parent.push(name) : this
  }

  /** Enters an embedded language region on top of this state. */
  enter(frame: EmbedFrame, inner: State): State {
    const key = `\0${frame.id}:${inner.id}`
    let child = this.children?.get(key)
    if (!child) {
      child = new State('@' + frame.language.name, this, frame, inner)
      ;(this.children ??= new Map()).set(key, child)
    }
    return child
  }

  /** Stack of state names, bottom first (embedded languages included). */
  get stack(): string[] {
    const out: string[] = this.inner ? this.inner.stack : []
    for (let s: State | null = this; s && s.parent; s = s.parent) out.unshift(s.name)
    return out
  }
}

export interface Language {
  readonly name: string
  readonly aliases: readonly string[]
  readonly extensions: readonly string[]
  readonly comments: { readonly line?: string; readonly block?: readonly [string, string] }
  readonly brackets: readonly (readonly [string, string])[]
  readonly closePairs: readonly (readonly [string, string])[]
  readonly indent: { readonly increase: RegExp | null; readonly decrease: RegExp | null }
  readonly wordChars: string
  /** Words suggested by `autocomplete()`. */
  readonly completions: readonly string[]
  readonly initialState: State
  /** Tokenizes one line starting in `state`. */
  tokenize(text: string, state: State): { tokens: Token[]; state: State }
  /** Like `tokenize` but only computes the end state (faster). */
  endState(text: string, state: State): State
  /** The state at column `col` of a line that starts in `state`. */
  stateAtColumn(text: string, state: State, col: number): State
  /** Whether some rule embeds another language. */
  readonly nested: boolean
  /** The original spec (handy to derive new languages from existing ones). */
  readonly spec: LanguageSpec
}

// ---------------------------------------------------------------------------

const ACTION_NONE = 0
const ACTION_PUSH = 1
const ACTION_POP = 2
const ACTION_NEXT = 3

interface CompiledRule {
  re: RegExp
  token: TokenSpec
  action: number
  target: string
  popCount: number
  /** ASCII chars that can start a match (null: any / unknown). */
  first: Uint8Array | null
  embed: EmbedSpec | null
}

/** Rules of a state indexed by the first char, so most rules are never tried. */
interface CompiledState {
  all: CompiledRule[]
  byChar: CompiledRule[][]
}

function compileDispatch(rules: CompiledRule[], prefilter: boolean): CompiledState {
  const byChar: CompiledRule[][] = []
  for (let c = 0; c < 128; c++) byChar.push(prefilter ? rules.filter((r) => !r.first || r.first[c]) : rules)
  return { all: rules, byChar }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

function parseTuple(entry: RuleTuple): Rule {
  const [match, token, action] = entry
  const rule: Rule = { match, token }
  if (action) {
    if (action === '@pop') rule.pop = true
    else if (action.startsWith('@next:')) rule.next = action.slice(6)
    else if (action.startsWith('@push:')) rule.push = action.slice(6)
    else if (action.startsWith('@')) rule.push = action.slice(1)
    else throw new Error(`Invalid rule action "${action}"`)
  }
  return rule
}

function compileRule(rule: Rule, stateName: string, spec: LanguageSpec): CompiledRule {
  const { match, token = null } = rule
  const source = typeof match === 'string' ? escapeRegExp(match) : match.source
  let flags = typeof match === 'string' ? '' : match.flags.replace(/[gy]/g, '')
  flags += 'y'
  if (Array.isArray(token) && !flags.includes('d')) flags += 'd'
  const target = rule.push ?? rule.next ?? ''
  if (target && !spec.states[target]) {
    throw new Error(`[jonacode] Language "${spec.name}": state "${stateName}" references unknown state "${target}"`)
  }
  return {
    re: new RegExp(source, flags),
    token: token as TokenSpec,
    action: rule.push ? ACTION_PUSH : rule.next ? ACTION_NEXT : rule.pop ? ACTION_POP : ACTION_NONE,
    target,
    popCount: typeof rule.pop === 'number' ? rule.pop : 1,
    first: firstChars(source, flags),
    embed: rule.embed ?? null,
  }
}

const frames = new WeakMap<Language, Map<string, EmbedFrame>>()
let nextFrameId = 0

/** One frame per (language, end regex), so states stay comparable with `===`. */
function frameFor(language: Language, end: RegExp | string): EmbedFrame {
  const source = typeof end === 'string' ? escapeRegExp(end) : end.source
  const flags = typeof end === 'string' ? 'g' : end.flags.replace(/[gy]/g, '') + 'g'
  const key = flags + '/' + source
  let byEnd = frames.get(language)
  if (!byEnd) frames.set(language, (byEnd = new Map()))
  let frame = byEnd.get(key)
  if (!frame) byEnd.set(key, (frame = { id: nextFrameId++, language, end: new RegExp(source, flags) }))
  return frame
}

function enterEmbed(state: State, spec: EmbedSpec, m: RegExpExecArray): State {
  const language = typeof spec.language === 'function' ? spec.language(m) : spec.language
  if (!language) return state
  const end = typeof spec.end === 'function' ? spec.end(m) : spec.end
  return state.enter(frameFor(language, end), language.initialState)
}

function compileState(spec: LanguageSpec, name: string, stack: string[] = []): CompiledRule[] {
  const entries = spec.states[name]
  if (!entries) throw new Error(`[jonacode] Language "${spec.name}": unknown state "${name}"`)
  if (stack.includes(name)) throw new Error(`[jonacode] Language "${spec.name}": circular include of "${name}"`)
  const out: CompiledRule[] = []
  for (const entry of entries) {
    if (Array.isArray(entry)) out.push(compileRule(parseTuple(entry as RuleTuple), name, spec))
    else if ('include' in (entry as IncludeRule)) out.push(...compileState(spec, (entry as IncludeRule).include, [...stack, name]))
    else out.push(compileRule(entry as Rule, name, spec))
  }
  return out
}

function defaultIncrease(brackets: readonly (readonly [string, string])[]): RegExp | null {
  if (!brackets.length) return null
  return new RegExp(`[${brackets.map((b) => escapeRegExp(b[0])).join('')}]\\s*$`)
}

function defaultDecrease(brackets: readonly (readonly [string, string])[]): RegExp | null {
  if (!brackets.length) return null
  return new RegExp(`^\\s*[${brackets.map((b) => escapeRegExp(b[1])).join('')}]`)
}

/**
 * Defines a language from a declarative spec.
 *
 * ```ts
 * const ini = defineLanguage({
 *   name: 'ini',
 *   comments: { line: ';' },
 *   states: {
 *     root: [
 *       [/;.*$/, 'comment'],
 *       [/^\[.*\]/, 'keyword'],
 *       [/^([\w.]+)(\s*)(=)/, ['property', null, 'operator']],
 *       [/".*?"/, 'string'],
 *     ],
 *   },
 * })
 * ```
 */
export function defineLanguage(spec: LanguageSpec, options: { prefilter?: boolean } = {}): Language {
  const start = spec.start ?? 'root'
  const rules: Record<string, CompiledState> = Object.create(null)
  for (const name of Object.keys(spec.states)) rules[name] = compileDispatch(compileState(spec, name), options.prefilter !== false)
  if (!rules[start]) throw new Error(`[jonacode] Language "${spec.name}": missing start state "${start}"`)

  const defaultToken = spec.defaultToken ?? null
  const maxLen = spec.maxLineLength ?? 10000
  const base = new State('', null)
  const initialState = base.push(start)
  const brackets = spec.brackets ?? []

  function run(line: string, state: State, out: Token[] | null, stopAt = Infinity): State {
    const text = line.length > maxLen ? line.slice(0, maxLen) : line
    const len = text.length
    let pos = 0
    let guard = 0

    const emit = (from: number, to: number, type: TokenType) => {
      if (!out || to <= from) return
      const last = out[out.length - 1]
      if (last && last.type === type && last.to === from) last.to = to
      else out.push({ from, to, type })
    }

    outer: for (;;) {
      if (pos >= stopAt) break
      const frame = state.embed
      if (frame) {
        // Inside an embedded language: hand it the text up to its end marker.
        frame.end.lastIndex = pos
        const m = frame.end.exec(text)
        const stop = m ? m.index : len
        const lang = frame.language
        const seg = pos === 0 && stop === len ? text : text.slice(pos, stop)
        if (stopAt < stop || (stopAt === stop && !m)) {
          return state.parent!.enter(frame, lang.stateAtColumn(seg, state.inner!, stopAt - pos))
        }
        let inner: State
        if (out) {
          const res = lang.tokenize(seg, state.inner!)
          for (const t of res.tokens) emit(pos + t.from, pos + t.to, t.type)
          inner = res.state
        } else inner = lang.endState(seg, state.inner!)
        pos = stop
        if (m) {
          state = state.parent!
          continue
        }
        state = state.parent!.enter(frame, inner)
        break
      }
      const compiled = rules[state.name]!
      const code = pos < len ? text.charCodeAt(pos) : 128
      const list = code < 128 ? compiled.byChar[code]! : compiled.all
      for (let r = 0; r < list.length; r++) {
        const rule = list[r]!
        rule.re.lastIndex = pos
        const m = rule.re.exec(text)
        if (!m) continue
        const end = pos + m[0].length
        // A match across the requested column: the state before it is the one in effect there.
        if (end > stopAt) break outer
        if (end === pos) {
          // Zero-length matches are only useful when they change the state.
          if ((rule.action === ACTION_NONE && !rule.embed) || ++guard > 64) continue
        } else if (out) {
          const tok = rule.token
          if (typeof tok === 'function') {
            emit(pos, end, tok(m[0], { line: text, from: pos, to: end, state: state.name, match: m }))
          } else if (Array.isArray(tok)) {
            const indices = m.indices!
            let at = pos
            for (let g = 1; g < m.length && g <= tok.length; g++) {
              const idx = indices[g]
              if (!idx || idx[0] < at) continue
              emit(at, idx[0], defaultToken)
              emit(idx[0], idx[1], (tok as readonly TokenType[])[g - 1] ?? null)
              at = idx[1]
            }
            emit(at, end, defaultToken)
          } else {
            emit(pos, end, tok as TokenType)
          }
        }
        switch (rule.action) {
          case ACTION_PUSH: state = state.push(rule.target); break
          case ACTION_POP: state = state.pop(rule.popCount); break
          case ACTION_NEXT: state = state.swap(rule.target); break
        }
        if (rule.embed) state = enterEmbed(state, rule.embed, m)
        pos = end
        continue outer
      }
      if (pos >= len) break
      // Nothing matched: consume one code point as default text.
      const step = code >= 0xd800 && code <= 0xdbff && pos + 1 < len ? 2 : 1
      emit(pos, pos + step, defaultToken)
      pos += step
    }
    if (out && len < line.length) emit(len, line.length, null)
    return state
  }

  return {
    name: spec.name,
    aliases: spec.aliases ?? [],
    extensions: spec.extensions ?? [],
    comments: spec.comments ?? {},
    brackets,
    closePairs: spec.closePairs ?? brackets,
    indent: {
      increase: spec.indent?.increase !== undefined ? spec.indent.increase : defaultIncrease(brackets),
      decrease: spec.indent?.decrease !== undefined ? spec.indent.decrease : defaultDecrease(brackets),
    },
    wordChars: spec.wordChars ?? '',
    completions: spec.completions ?? [],
    initialState,
    spec,
    tokenize(text, state) {
      const tokens: Token[] = []
      const end = run(text, state, tokens)
      return { tokens, state: end }
    },
    endState: (text, state) => run(text, state, null),
    stateAtColumn: (text, state, col) => run(text, state, null, col),
    nested: Object.values(rules).some((c) => c.all.some((r) => r.embed)),
  }
}

/**
 * Finds a language by name, alias or file extension (`'js'`, `'.ts'`,
 * `'TypeScript'`) — handy to map a Markdown fence or an attribute to one.
 */
export function findLanguage(languages: readonly Language[], name: string): Language | undefined {
  const n = name.trim().toLowerCase()
  if (!n) return undefined
  const ext = n.startsWith('.') ? n : '.' + n
  return languages.find((l) => l.name === n || l.aliases.includes(n)) ?? languages.find((l) => l.extensions.includes(ext))
}

/** The language in effect in `state` (the innermost embedded one). */
export function innerLanguage(language: Language, state: State): Language {
  while (state.embed) {
    language = state.embed.language
    state = state.inner!
  }
  return language
}

/** Plain text: no highlighting at all. Used when no language is given. */
export const plainText: Language = /* @__PURE__ */ defineLanguage({ name: 'text', aliases: ['plain', 'txt'], states: { root: [] } })

/**
 * Helper to classify words, e.g. keywords:
 *
 * ```ts
 * { match: /[a-z]+/, token: words({ keyword: ['if', 'else'], constant: ['true', 'false'] }, 'variable') }
 * ```
 */
export function words(groups: Record<string, readonly string[]>, fallback: TokenType = null): TokenFunction {
  const map = new Map<string, string>()
  for (const [type, list] of Object.entries(groups)) for (const w of list) map.set(w, type)
  return (text) => map.get(text) ?? fallback
}

export interface LanguageExtension {
  /** Name of the new language (defaults to the base name). */
  name?: string
  /** Rules added at the start of existing states (they win over the original ones). */
  prepend?: Record<string, readonly RuleEntry[]>
  /** Rules added at the end of existing states. */
  append?: Record<string, readonly RuleEntry[]>
  /** New states (or states replaced entirely). */
  states?: Record<string, readonly RuleEntry[]>
}

/**
 * Creates a new language from an existing one, adding rules without
 * rewriting the grammar. Handy to capture new token types:
 *
 * ```ts
 * const js = extendLanguage(javascript, {
 *   prepend: { comment: [[/\b(TODO|FIXME)\b/, 'comment todo']] },
 * })
 * ```
 */
export function extendLanguage(base: Language | LanguageSpec, ext: LanguageExtension & Partial<Omit<LanguageSpec, 'states' | 'name'>>): Language {
  const spec = 'spec' in base ? base.spec : base
  const { prepend = {}, append = {}, states = {}, name, ...rest } = ext
  const merged: Record<string, readonly RuleEntry[]> = { ...spec.states, ...states }
  for (const [state, rules] of Object.entries(prepend)) {
    if (!merged[state]) throw new Error(`[jonacode] extendLanguage: unknown state "${state}"`)
    merged[state] = [...rules, ...merged[state]!]
  }
  for (const [state, rules] of Object.entries(append)) {
    if (!merged[state]) throw new Error(`[jonacode] extendLanguage: unknown state "${state}"`)
    merged[state] = [...merged[state]!, ...rules]
  }
  return defineLanguage({ ...spec, ...rest, name: name ?? spec.name, states: merged })
}
