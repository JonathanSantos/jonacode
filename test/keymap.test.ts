import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eventKeyNames, normalizeKey } from '../src/keymap.ts'
import { defineTheme, tokenClass } from '../src/theme/theme.ts'

test('normalizeKey: modifiers are canonical', () => {
  assert.equal(normalizeKey('Mod-Shift-Z', true), 'Meta-Shift-z')
  assert.equal(normalizeKey('Mod-z', false), 'Ctrl-z')
  assert.equal(normalizeKey('Shift-Alt-ArrowUp'), 'Alt-Shift-ArrowUp')
  assert.equal(normalizeKey('Ctrl--'), 'Ctrl--')
  assert.throws(() => normalizeKey('Hyper-a'))
})

test('eventKeyNames: letters, shifted symbols and Alt on macOS', () => {
  const ev = (init: Partial<KeyboardEvent>) => ({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, code: '', ...init }) as KeyboardEvent
  assert.deepEqual(eventKeyNames(ev({ key: 'Z', shiftKey: true, metaKey: true, code: 'KeyZ' })), ['Meta-Shift-z'])
  assert.deepEqual(eventKeyNames(ev({ key: '{', shiftKey: true })), ['Shift-{', '{'])
  assert.deepEqual(eventKeyNames(ev({ key: '∆', altKey: true, code: 'KeyJ' })), ['Alt-j'])
})

test('themes compile to scoped CSS with fallbacks', () => {
  const theme = defineTheme({ name: 'Test Theme', colors: { background: '#000' }, tokens: { string: 'red', 'string.escape': { color: 'blue', fontStyle: 'italic' } } })
  assert.match(theme.className, /^jc-theme-test-theme/)
  assert.match(theme.css, /--jc-bg:#000/)
  assert.ok(theme.css.indexOf('.jc-t-string{') < theme.css.indexOf('.jc-t-string-escape{'))
  assert.equal(tokenClass('string.escape'), 'jc-t-string jc-t-string-escape')
  const child = defineTheme({ name: 'child', extends: theme, tokens: { keyword: 'green' } })
  assert.equal(child.tokens.string!.color, 'red')
  assert.equal(child.colors.background, '#000')
})
