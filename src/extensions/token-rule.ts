/**
 * Capture new token types without touching the language grammar: a regex is
 * run over each line and the matched text gets a new token type (optionally
 * only inside tokens of some type, like `comment`).
 *
 * ```ts
 * tokenRule({ match: /\b(TODO|FIXME)\b/, token: 'todo', inside: 'comment' })
 * tokenRule({ match: /#[\da-f]{6}\b/i, token: 'color', style: (m) => `--swatch:${m[0]}` })
 * ```
 */
import type { Extension, TokenTransform } from '../editor.ts'
import type { Token } from '../language/language.ts'

export interface TokenRuleSpec {
  /** What to capture. Runs over the whole line text. */
  match: RegExp | string
  /** Token type of the capture (e.g. `todo`), or a function of the match (null = skip). */
  token: string | ((match: RegExpExecArray) => string | null | undefined)
  /** Only inside tokens of these types (`comment` also covers `comment.doc`). Default: anywhere. */
  inside?: string | readonly string[]
  /** Keep the original type and add the new one (`comment todo`), so both styles apply. Default true. */
  keepType?: boolean
  /** Inline CSS for each capture, e.g. a color swatch: `(m) => \`--swatch:${m[0]}\``. */
  style?: (match: RegExpExecArray) => string | null | undefined
}

interface Mark {
  from: number
  to: number
  type: string
  style: string | undefined
}

/** The token transform behind `tokenRule` (usable directly with `editor.addTokenTransform`). */
export function createTokenRule(spec: TokenRuleSpec): TokenTransform {
  const source = typeof spec.match === 'string' ? spec.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : spec.match.source
  const flags = typeof spec.match === 'string' ? 'g' : spec.match.flags.replace(/[gy]/g, '') + 'g'
  const re = new RegExp(source, flags)
  const inside = spec.inside == null ? null : typeof spec.inside === 'string' ? [spec.inside] : spec.inside
  const keepType = spec.keepType !== false
  const allowed = (type: string | null) => {
    if (!inside) return true
    if (!type) return false
    return type.split(' ').some((part) => inside.some((p) => part === p || part.startsWith(p + '.')))
  }

  return (text: string, tokens: Token[]): Token[] => {
    const marks: Mark[] = []
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (!m[0].length) {
        re.lastIndex++
        continue
      }
      const type = typeof spec.token === 'function' ? spec.token(m) : spec.token
      if (type) marks.push({ from: m.index, to: m.index + m[0].length, type, style: spec.style?.(m) ?? undefined })
    }
    if (!marks.length) return tokens

    const out: Token[] = []
    let changed = false
    let first = 0
    for (const t of tokens) {
      while (first < marks.length && marks[first]!.to <= t.from) first++
      let pos = t.from
      if (allowed(t.type)) {
        for (let k = first; k < marks.length && marks[k]!.from < t.to; k++) {
          const mark = marks[k]!
          const from = Math.max(mark.from, pos)
          const to = Math.min(mark.to, t.to)
          if (to <= from) continue
          changed = true
          if (from > pos) out.push({ ...t, from: pos, to: from })
          const token: Token = { from, to, type: keepType && t.type ? `${t.type} ${mark.type}` : mark.type }
          const style = mark.style ?? t.style
          if (style) token.style = style
          out.push(token)
          pos = to
        }
      }
      if (pos < t.to) out.push(pos === t.from ? t : { ...t, from: pos, to: t.to })
    }
    return changed ? out : tokens
  }
}

/** Adds a token rule to the editor. Style the new type with `tokenStyles`, a theme or plain CSS. */
export function tokenRule(spec: TokenRuleSpec): Extension {
  const transform = createTokenRule(spec)
  return (editor) => {
    editor.addTokenTransform(transform)
  }
}
