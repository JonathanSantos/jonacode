/**
 * Monarch importer: turns a Monaco `language` definition (the declarative
 * grammars of `monaco-editor/esm/vs/basic-languages/*`) into a Jonacode
 * `Language`.
 *
 * It has its own tokenizer, faithful to Monarch's semantics: attributes
 * (`@keywords`), `cases` guards, groups, `@rematch`, `@push` / `@pop` /
 * `@popall` / `switchTo`, dotted sub-states (`string.double` → `$S2`),
 * `$n` / `$Sn` substitutions and embedded languages (`nextEmbedded`). Like
 * in Monaco, rules match the rest of the line (`\b` and an inner `^` see the
 * current position as a line start; a leading `^` only matches at column 0),
 * and they run once on an empty line but never at the end of a line.
 * Monarch token names are mapped to Jonacode's vocabulary (`identifier` →
 * `variable`, `delimiter.curly` → `punctuation.bracket`…).
 *
 * ```ts
 * import { conf, language } from 'monaco-editor/esm/vs/basic-languages/python/python.js'
 * const python = fromMonarch(language, { name: 'python', extensions: ['.py'], conf })
 * ```
 */

import { State, type EmbedFrame, type Language, type Token, type TokenType } from './language.ts'

export type MonarchAction = string | null | undefined | MonarchActionObject | readonly MonarchAction[]

export interface MonarchActionObject {
  /** Token name (may use `$0`, `$1`, `$S2`, `$#`), `@brackets` or `@rematch`. */
  token?: string
  /** `@pop`, `@push`, `@popall` or a state to push (`@string`, `@string.$S2`). */
  next?: string
  /** Replaces the current state. */
  switchTo?: string
  /** Gives back the last `n` matched chars. */
  goBack?: number
  /** `@open` / `@close`: ignored (Jonacode matches brackets by text). */
  bracket?: string
  /** Language id of an embedded region, or `@pop` to leave it. */
  nextEmbedded?: string
  /** Ignored. */
  log?: string
  /** `{ guard: action }`: `@keywords`, `@default`, `@eos`, `~regex`, `!~regex`, `==text`, `$1==$S2`… */
  cases?: object
  group?: readonly MonarchAction[]
}

export type MonarchRule =
  | readonly [regex: RegExp | string, action: MonarchAction, next?: string]
  | { regex?: RegExp | string; action?: MonarchAction; include?: string }

export interface MonarchLanguage {
  tokenizer: { [state: string]: readonly MonarchRule[] }
  start?: string
  ignoreCase?: boolean
  unicode?: boolean
  defaultToken?: string
  /** Appended to token names by Monaco (`.python`); stripped here when a name ends with it. */
  tokenPostfix?: string
  /** Ignored: rules never see the line feed. */
  includeLF?: boolean
  brackets?: readonly ({ open: string; close: string; token: string } | readonly [string, string, string])[]
  /** Attributes referenced as `@name`: word lists, regexes, strings. */
  [attribute: string]: unknown
}

/** The parts of Monaco's `LanguageConfiguration` (`conf`) that Jonacode uses. */
export interface MonarchConf {
  comments?: { lineComment?: string | { comment: string } | null; blockComment?: readonly [string, string] | null }
  brackets?: readonly (readonly [string, string])[]
  autoClosingPairs?: readonly ({ open: string; close: string } | readonly [string, string])[]
}

export interface MonarchOptions {
  /** Defaults to the grammar's `tokenPostfix` without its dot. */
  name?: string
  aliases?: readonly string[]
  extensions?: readonly string[]
  /**
   * Monarch token name (without the `tokenPostfix`) → Jonacode token type,
   * over the defaults. The longest matching dotted prefix wins
   * (`keyword.flow` uses `keyword`); unknown names are kept as they are.
   */
  tokenMap?: Record<string, TokenType>
  /** Monaco's language configuration: comments, brackets and auto-closing pairs are read from it. */
  conf?: MonarchConf
  comments?: Language['comments']
  brackets?: Language['brackets']
  closePairs?: Language['closePairs']
  indent?: { increase?: RegExp | null; decrease?: RegExp | null }
  wordChars?: string
  /**
   * Resolves the languages of `nextEmbedded` regions (`'text/javascript'`,
   * `'css'`, a Markdown fence language…); called once per id and host state.
   * Like in Monaco, regions whose language is not resolved are plain text.
   */
  embedded?: (id: string) => Language | null | undefined
}

type Test = (matched: string, m: RegExpExecArray, state: string, eos: boolean) => boolean
interface Cases { cases: [Test | null, Action][] }
type Action = string | MonarchActionObject | Cases | readonly Action[]

interface Rule {
  /** `^(?:src)`, matched on the rest of the line; null when it depends on the state (`$Sn`). */
  re: RegExp | null
  src: string
  /** Only tried at the start of the line (the regex started with `^`). */
  bol: boolean
  action: Action
  /** Leaves an embedded language (`nextEmbedded: '@pop'`). */
  pops: boolean
  byState?: Map<string, RegExp>
}

/** Default token map: `monarch=jonacode`, `name` (kept as is) or `name=` (plain text). */
const TOKENS =
  '= white= source= identifier=variable operators=operator delimiter=punctuation ' +
  'delimiter.bracket=punctuation.bracket delimiter.parenthesis=punctuation.bracket delimiter.square=punctuation.bracket ' +
  'delimiter.curly=punctuation.bracket delimiter.angle=punctuation.bracket string.invalid=invalid annotation=meta ' +
  'metatag=meta attribute.name=attribute attribute.value=string predefined=type.builtin ' +
  'variable.predefined=variable.language header=heading key=property type keyword operator number string string.escape regexp ' +
  'comment meta tag constant variable emphasis strong invalid'

const escapeRegExp = (s: string) => s.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&')
const pairs = (list: readonly ({ open: string; close: string } | readonly string[])[]) =>
  list.map((p): [string, string] => ('open' in p ? [p.open, p.close] : [p[0]!, p[1]!]))

/** Whether some action of the tree satisfies `test`. */
const some = (a: Action, test: (a: MonarchActionObject) => boolean): boolean =>
  typeof a === 'object' &&
  (Array.isArray(a) ? a.some((x) => some(x, test)) : isCases(a) ? a.cases.some((c) => some(c[1], test)) : test(a as MonarchActionObject))
const isCases = (a: Action): a is Cases => typeof a === 'object' && Array.isArray((a as Cases).cases)

/** The longest dotted prefix of `name` (`a.b.c`, `a.b`, `a`) that `has`, or the last one tried. */
const prefix = (name: string, has: (key: string) => unknown) => {
  while (!has(name) && name.includes('.')) name = name.slice(0, name.lastIndexOf('.'))
  return name
}

let frameIds = 0

/** Converts a Monarch grammar (Monaco's `language` export) into a Jonacode language. */
export function fromMonarch(def: MonarchLanguage, options: MonarchOptions = {}): Language {
  const { conf, embedded } = options
  const name = options.name ?? (def.tokenPostfix?.replace(/^\./, '') || 'monarch')
  const fail = (msg: string) => new Error(`[jonacode] Monarch "${name}": ${msg}`)
  const tokenizer = def.tokenizer
  const ignoreCase = !!def.ignoreCase
  const flags = (ignoreCase ? 'i' : '') + (def.unicode ? 'u' : '')
  const fix = (s: string) => (ignoreCase ? s.toLowerCase() : s)
  const postfix = def.tokenPostfix ?? ''
  const table: Record<string, TokenType> = Object.create(null)
  for (const entry of TOKENS.split(' ')) {
    const [key, type = key] = entry.split('=')
    table[key!] = type || null
  }
  Object.assign(table, options.tokenMap)

  // `@attr` in a regex: its source (strings and regexes; word lists as alternatives), 5 levels deep.
  const expand = (src: string) => {
    src = src.replace(/@@/g, '\x01')
    for (let n = 0; n < 5 && /@\w/.test(src); n++) {
      src = src.replace(/@(\w+)/g, (all, attr: string) => {
        const v = def[attr]
        const s = v instanceof RegExp ? v.source : typeof v === 'string' ? v : Array.isArray(v) ? v.map(escapeRegExp).join('|') : null
        return s === null ? all.replace('@', '\x01') : s && `(?:${s})`
      })
    }
    return src.replace(/\x01/g, '@')
  }

  /** `$S0` is the whole state name, `$S1`, `$S2`… its dot separated parts. */
  const statePart = (state: string, n: number) => fix((n ? state.split('.')[n - 1] : state) ?? '')

  /** `$$`, `$#` (matched text), `$n` (group), `$Sn` (state part), `$@attr` (string attribute). */
  const substitute = (str: string, matched: string, m: RegExpExecArray, state: string) =>
    str.replace(/\$(?:(\$)|(#)|(\d\d?)|[sS](\d\d?)|@(\w+))/g, (_, dollar, hash, n, s, attr) =>
      dollar ? '$'
      : hash ? fix(matched)
      : n ? fix(m[+n] ?? '')
      : attr ? (typeof def[attr] === 'string' ? (def[attr] as string) : '')
      : statePart(state, +s))

  function guard(key: string): Test | null {
    if (key === '@default' || key === '@' || !key) return null
    if (key === '@eos') return (_s, _m, _st, eos) => eos
    const k = /^\$(?:([sS]?)(\d\d?)|#)(.*)$/.exec(key)
    const scrutinee = k?.[2] ? +k[2] + (k[1] ? 100 : 0) : -1
    let pat = k ? k[3]! : key
    let op = '~'
    if (!pat) op = '!='
    else if (/^\w*$/.test(pat)) op = '=='
    else {
      const o = /^(@|!@|~|!~|==|!=)(.*)$/.exec(pat)
      if (o) (op = o[1]!), (pat = o[2]!)
    }
    const negate = op[0] === '!'
    const dynamic = pat.includes('$')
    let test: (s: string, matched: string, m: RegExpExecArray, state: string) => boolean
    if (op.includes('@') || (op.includes('~') && /^[\w|]*$/.test(pat))) {
      const list = op.includes('@') ? def[pat] : pat.split('|')
      if (!Array.isArray(list)) throw fail(`"@${pat}" is not a word list`)
      const set = new Set(list.map(fix))
      test = (s) => set.has(fix(s))
    } else if (op.includes('~')) {
      const re = dynamic ? null : new RegExp(`^${expand(pat)}$`, flags)
      test = (s, matched, m, state) => (re ?? new RegExp(`^${expand(substitute(pat, matched, m, state))}$`, flags)).test(s)
    } else {
      const p = fix(pat)
      test = (s, matched, m, state) => s === (dynamic ? substitute(p, matched, m, state) : p)
    }
    return (matched, m, state) => {
      const s = scrutinee < 0 ? matched : scrutinee < 100 ? m[scrutinee] : statePart(state, scrutinee - 100)
      return negate !== test(s ?? '', matched, m, state)
    }
  }

  function action(a: MonarchAction, next?: string): Action {
    if (a == null) return ''
    if (typeof a === 'string') return next ? { token: a, next } : a
    if (Array.isArray(a)) return a.map((x) => action(x))
    const o = a as MonarchActionObject
    if (o.group) return action(o.group)
    if (o.cases) return { cases: Object.entries(o.cases).map(([key, value]): [Test | null, Action] => [guard(key), action(value)]) }
    return next && o.token != null ? { ...o, next } : o
  }

  const compiled: Record<string, Rule[]> = Object.create(null)
  function addRules(out: Rule[], state: string, depth: number) {
    const rules = tokenizer[state]
    if (!rules || depth > 20) throw fail(rules ? `circular include of "${state}"` : `unknown state "${state}"`)
    for (const r of rules) {
      const include = (r as { include?: string }).include
      if (include) {
        addRules(out, include.replace(/^@/, ''), depth + 1)
        continue
      }
      const [regex, act, next] = Array.isArray(r) ? (r as readonly [RegExp | string, MonarchAction, string?]) : [(r as { regex?: RegExp | string }).regex, (r as { action?: MonarchAction }).action]
      if (regex == null) continue
      let src = typeof regex === 'string' ? regex : regex.source
      const bol = src[0] === '^'
      src = expand(bol ? src.slice(1) : src)
      const compiledAction = action(act, next)
      out.push({
        re: /\$[sS]\d/.test(src) ? null : new RegExp(`^(?:${src})`, flags),
        src,
        bol,
        action: compiledAction,
        pops: some(compiledAction, (o) => o.nextEmbedded === '@pop'),
      })
    }
  }
  for (const state in tokenizer) addRules((compiled[state] = []), state, 0)
  const start = def.start ?? Object.keys(tokenizer)[0]!
  if (!compiled[start]) throw fail(`unknown start state "${start}"`)

  /** Rules of a state; `a.b.c` falls back to `a.b`, then `a`. */
  const found = new Map<string, Rule[] | undefined>()
  const rulesFor = (state: string) => {
    if (!found.has(state)) found.set(state, compiled[prefix(state, (s) => compiled[s])])
    return found.get(state)
  }

  const sourceIn = (rule: Rule, state: string) => rule.src.replace(/\$[sS](\d\d?)/g, (_, n) => escapeRegExp(statePart(state, +n)))
  const regexFor = (rule: Rule, state: string) => {
    let re = rule.byState?.get(state)
    if (!re) (rule.byState ??= new Map()).set(state, (re = new RegExp(`^(?:${sourceIn(rule, state)})`, flags)))
    return re
  }

  const brackets = new Map<string, string>()
  for (const b of def.brackets ?? [['{', '}', 'delimiter.curly'], ['[', ']', 'delimiter.square'], ['(', ')', 'delimiter.parenthesis'], ['<', '>', 'delimiter.angle']]) {
    const [open, close, token] = 'open' in b ? [b.open, b.close, b.token] : b
    for (const s of [open, close]) if (!brackets.has(fix(s))) brackets.set(fix(s), token)
  }

  const mapped = new Map<string, TokenType>()
  function tokenType(token: string): TokenType {
    let type = mapped.get(token)
    if (type === undefined) {
      const tok = postfix && token.endsWith(postfix) ? token.slice(0, -postfix.length) : token
      const key = prefix(tok, (k) => k in table)
      mapped.set(token, (type = key in table ? table[key] : tok))
    }
    return type
  }
  const defaultToken = def.defaultToken ?? 'source'

  /** One frame per (language, host state) so embedded states stay interned. */
  const frames = new Map<string, EmbedFrame | null>()
  function frameFor(id: string, host: string): EmbedFrame | null {
    const key = id + '\n' + host
    let frame = frames.get(key)
    if (frame === undefined) {
      // The region ends where a rule of the host state that leaves it would match.
      const ends = rulesFor(host)!.filter((r) => r.pops).map((r) => (r.bol ? '^' : '') + `(?:${sourceIn(r, host)})`)
      // Like Monaco, a language that cannot be resolved is plain text.
      const language = embedded?.(id) ?? fromMonarch({ tokenizer: { root: [] } }, { name: id })
      // Negative ids: never equal to the frames of `defineLanguage`. The end is searched in the rest of the line.
      frame = ends.length ? { id: --frameIds, language, end: new RegExp(ends.join('|'), flags + 'g') } : null
      frames.set(key, frame)
    }
    return frame
  }

  function transition(state: State, next: string, swap: boolean, matched: string, m: RegExpExecArray, current: string): State {
    if (next === '@pop') return state.pop()
    if (next === '@popall') return state.pop(state.depth)
    let target = next === '@push' ? current : next.includes('$') ? substitute(next, matched, m, current) : next
    if (target[0] === '@') target = target.slice(1)
    return !rulesFor(target) ? state : swap ? state.swap(target) : state.push(target)
  }

  function run(line: string, state: State, out: Token[] | null, stopAt = Infinity): State {
    const text = line.length > 10000 ? line.slice(0, 10000) : line
    const len = text.length
    let pos = 0
    // Where rules starting with `^` can match (the host language resumes "at line start" after an embedded region).
    let lineStart = 0
    // Like Monaco, the rules are tried at least once, even on an empty line.
    let force = true
    let spins = 0
    let group: readonly Action[] | null = null
    let groupIndex = 0
    let m: RegExpExecArray | null = null

    const emit = (from: number, to: number, type: TokenType) => {
      if (!out || to <= from) return
      const last = out[out.length - 1]
      if (last && last.type === type && last.to === from) last.to = to
      else out.push({ from, to, type })
    }

    while (force || pos < len) {
      if (pos >= stopAt) break
      const frame = state.embed
      if (frame) {
        // Inside an embedded language: hand it the text up to the end of the region.
        const rest = pos ? text.slice(pos) : text
        frame.end.lastIndex = 0
        const end = frame.end.exec(rest)
        const seg = end ? rest.slice(0, end.index) : rest
        const stop = pos + seg.length
        const lang = frame.language
        if (stopAt < stop || (stopAt === stop && !end)) return state.parent!.enter(frame, lang.stateAtColumn(seg, state.inner!, stopAt - pos))
        let inner = state.inner!
        if (out && seg) {
          const res = lang.tokenize(seg, inner)
          for (const t of res.tokens) emit(pos + t.from, pos + t.to, t.type)
          inner = res.state
        } else if (!end) inner = lang.endState(seg, inner)
        if (!end) {
          state = state.parent!.enter(frame, inner)
          break
        }
        // Back to the host language, as if the line started here.
        pos = lineStart = stop
        force = true
        state = state.parent!
        continue
      }

      const current = state.name
      const inGroup = !!group
      let act: Action = defaultToken
      let matched: string
      if (group) {
        act = group[groupIndex++]!
        matched = m![groupIndex] ?? ''
        if (groupIndex >= group.length) group = null
      } else {
        force = false
        m = null
        // Like Monaco, rules match the rest of the line: `^` and `\b` behave as at a line start.
        const rest = pos ? text.slice(pos) : text
        const rules = rulesFor(current) ?? []
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i]!
          if (rule.bol && pos !== lineStart) continue
          if ((m = (rule.re ?? regexFor(rule, current)).exec(rest))) {
            act = rule.action
            break
          }
        }
        matched = m ? m[0] : ''
      }

      const from = pos
      pos += matched.length
      // Resolve `cases` (they can nest).
      while (isCases(act)) {
        const eos = pos === len
        let next: Action = defaultToken
        for (const [test, value] of act.cases) {
          if (!test || test(matched, m!, current, eos)) {
            next = value
            break
          }
        }
        act = next
      }
      if (Array.isArray(act) && m) {
        // One action per capture group, applied in turn.
        group = act
        groupIndex = 0
        pos = from
        continue
      }
      if (pos > stopAt) {
        pos = from
        break
      }

      const o = typeof act === 'object' ? (act as MonarchActionObject) : null
      let token = o ? o.token ?? '' : (act as string)
      const before = state
      if (o) {
        const nextEmbedded = o.nextEmbedded
        if (o.goBack) pos = Math.max(from, pos - o.goBack)
        if (o.switchTo) state = transition(state, o.switchTo, true, matched, m!, current)
        else if (o.next) state = transition(state, o.next, false, matched, m!, current)
        if (nextEmbedded && nextEmbedded !== '@pop') {
          const frame = frameFor(substitute(nextEmbedded, matched, m!, current), state.name)
          if (frame) {
            state = state.enter(frame, frame.language.initialState)
            group = null
          }
        }
      }
      if (token === '@rematch') {
        pos = from
        matched = ''
      }
      if (!m || (!matched && len && state === before && !inGroup) || (!matched && ++spins > 100)) {
        // No rule matched, or no progress: one char of default text.
        if (pos >= len) break
        const c = text.charCodeAt(pos)
        const step = c >= 0xd800 && c < 0xdc00 && pos + 1 < len ? 2 : 1
        if (pos + step > stopAt) break
        emit(pos, (pos += step), tokenType(defaultToken))
        spins = 0
        continue
      }
      if (!matched) continue
      spins = 0
      if (out) {
        // Like Monaco, only `{ token }` objects are substituted (not plain string actions).
        if (o && token.includes('$')) token = substitute(token, matched, m, current)
        if (token.startsWith('@brackets')) token = (brackets.get(fix(matched)) ?? defaultToken) + token.slice(9)
        emit(from, pos, tokenType(token))
      }
    }
    if (out && len < line.length) emit(len, line.length, null)
    return state
  }

  const bracketPairs: Language['brackets'] =
    options.brackets ?? conf?.brackets ?? (def.brackets ? pairs(def.brackets) : [['(', ')'], ['[', ']'], ['{', '}']])
  const alternatives = (i: 0 | 1) => bracketPairs.map((b) => escapeRegExp(b[i])).join('|')
  const cc = conf?.comments
  const lineComment = cc?.lineComment

  return {
    name,
    aliases: options.aliases ?? [],
    extensions: options.extensions ?? [],
    comments: options.comments ?? {
      line: (typeof lineComment === 'object' ? lineComment?.comment : lineComment) ?? undefined,
      block: cc?.blockComment ?? undefined,
    },
    brackets: bracketPairs,
    closePairs: options.closePairs ?? (conf?.autoClosingPairs ? pairs(conf.autoClosingPairs) : bracketPairs),
    indent: {
      increase: bracketPairs.length ? new RegExp(`(?:${alternatives(0)})\\s*$`) : null,
      decrease: bracketPairs.length ? new RegExp(`^\\s*(?:${alternatives(1)})`) : null,
      ...options.indent,
    },
    wordChars: options.wordChars ?? '',
    // Word lists of the grammar (keywords, typeKeywords, builtins…) feed autocomplete().
    completions: [...new Set(Object.entries(def).flatMap(([k, v]) =>
      k !== 'operators' && Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string' && /^[\w$#@-]+$/.test(w)) : []))],
    initialState: new State('', null).push(start),
    nested: Object.values(compiled).some((rules) => rules.some((r) => some(r.action, (o) => !!o.nextEmbedded && o.nextEmbedded !== '@pop'))),
    // Not a declarative Jonacode spec: `extendLanguage` cannot derive from a Monarch language.
    spec: { name, states: {} },
    tokenize(text, state) {
      const tokens: Token[] = []
      return { tokens, state: run(text, state, tokens) }
    },
    endState: (text, state) => run(text, state, null),
    stateAtColumn: (text, state, col) => run(text, state, null, col),
  }
}
