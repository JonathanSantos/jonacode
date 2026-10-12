import type { Language } from '../src/language/language.ts'

/** Tokenizes lines and returns `[text, type]` pairs per line (whitespace-only plain tokens dropped). */
export function tokenize(lang: Language, source: string): [string, string | null][][] {
  let state = lang.initialState
  return source.split('\n').map((line) => {
    const { tokens, state: next } = lang.tokenize(line, state)
    state = next
    return tokens
      .map((t) => [line.slice(t.from, t.to), t.type] as [string, string | null])
      .filter(([text, type]) => type !== null || text.trim() !== '')
  })
}

/** Type of the first token whose text equals `text`. */
export function typeOf(lang: Language, source: string, text: string): string | null | undefined {
  for (const line of tokenize(lang, source)) for (const [t, type] of line) if (t === text) return type
  return undefined
}
