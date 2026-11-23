import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ptBR } from '../src/locales/pt-BR.ts'
import { PHRASES, type PhraseKey } from '../src/phrases.ts'

const SRC = join(import.meta.dirname, '../src')
const sources = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.ts') && f !== 'phrases.ts' && !f.startsWith('locales'))
  .map((file) => ({ file, code: readFileSync(join(SRC, file), 'utf8') }))

/** A JS string literal (single or double quoted) → its value. */
const unquote = (lit: string) => lit.slice(1, -1).replace(/\\(.)/g, '$1')
const STRING = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"`
/**
 * `phrase('…')`, and the local helpers built on it: `t('…')`, `say('…')`. `phrase` and `t` take the English
 * text as an optional second literal (the second argument of `say` is the token it fills in).
 */
const CALL = new RegExp(String.raw`(\.phrase|\bt|\bsay)\(\s*(${STRING})(?:\s*,\s*(${STRING}))?`, 'g')

test('phrases: every phrase call in the source uses a key of PHRASES', () => {
  let calls = 0
  for (const { file, code } of sources) {
    for (const m of code.matchAll(CALL)) {
      const key = unquote(m[2]!)
      const english = m[1] === 'say' ? undefined : m[3]
      calls++
      assert.ok(key in PHRASES, `${file}: "${key}" is not in PHRASES`)
      // A key that isn't the English text itself: the call site carries that text, and it must be the one listed.
      if (PHRASES[key as PhraseKey] !== key) assert.ok(english, `${file}: "${key}" needs its English text as the second argument`)
      if (english) assert.equal(unquote(english), PHRASES[key as PhraseKey], `${file}: the English text of "${key}" differs from PHRASES`)
    }
  }
  assert.ok(calls > 40, `only ${calls} phrase calls found: did the scan break?`)
})

test('phrases: every key of PHRASES is used somewhere in the source', () => {
  const all = sources.map((s) => s.code).join('\n')
  for (const key of Object.keys(PHRASES)) {
    assert.ok(all.includes(`'${key}'`) || all.includes(`"${key}"`), `"${key}" is in PHRASES but nothing uses it`)
  }
})

test('phrases: keys are the English text, except the short ones', () => {
  for (const [key, text] of Object.entries(PHRASES)) {
    if (/^[a-z]+[A-Z]\w*\.\w+$/.test(key)) assert.notEqual(text, key, `"${key}" should spell out its text`)
    else assert.equal(text, key, `"${key}" should be its own text (or get a short key)`)
  }
})

test('phrases: the pt-BR pack translates every key and keeps the placeholders', () => {
  assert.deepEqual(Object.keys(ptBR).sort(), Object.keys(PHRASES).sort())
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
  for (const [key, text] of Object.entries(PHRASES)) {
    const translated = ptBR[key as PhraseKey]
    assert.ok(translated.trim(), `"${key}" has an empty translation`)
    assert.deepEqual(holes(translated), holes(text), `"${key}": the placeholders differ`)
  }
})
