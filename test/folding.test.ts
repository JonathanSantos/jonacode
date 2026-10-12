import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Editor } from '../src/editor.ts'
import { foldableRange } from '../src/extensions/folding.ts'
import { Highlighter } from '../src/language/highlighter.ts'
import { plainText, type Language } from '../src/language/language.ts'
import { javascript } from '../src/languages/javascript.ts'
import { markdown } from '../src/languages/markdown.ts'
import { TextDocument } from '../src/state/text.ts'

/** Just what fold detection reads from an editor: the document, tokens and languages. */
function fakeEditor(text: string, language: Language): Editor {
  const doc = new TextDocument(text)
  const hl = new Highlighter(language, doc)
  return { doc, language, getTokens: (line: number) => hl.tokens(line), languageAt: () => language } as unknown as Editor
}

test('brackets: fold between the opening line and the closing one', () => {
  const ed = fakeEditor('function f() {\n  a()\n  b()\n}\nconst x = [\n  1,\n]\nif (y) { z() }', javascript)
  assert.deepEqual(foldableRange(ed, 0), { from: 1, to: 2 })
  assert.deepEqual(foldableRange(ed, 4), { from: 5, to: 5 })
  // Opened and closed on the same line: nothing to fold.
  assert.equal(foldableRange(ed, 7), null)
})

test('brackets in strings and comments are ignored', () => {
  const ed = fakeEditor("const s = '{'\n  x\nfoo() // {\n  y", javascript)
  // Falls back to indentation for both lines.
  assert.deepEqual(foldableRange(ed, 0), { from: 1, to: 1 })
  assert.deepEqual(foldableRange(ed, 2), { from: 3, to: 3 })
})

test('indentation: the more indented block, skipping trailing blank lines', () => {
  const ed = fakeEditor('def f():\n    a = 1\n\n    return a\n\nprint(f())', plainText)
  assert.deepEqual(foldableRange(ed, 0), { from: 1, to: 3 })
  assert.equal(foldableRange(ed, 1), null)
  assert.equal(foldableRange(ed, 2), null)
})

test('markdown: a heading folds until the next heading of the same level', () => {
  const ed = fakeEditor('# A\ntext\n## A.1\nmore\n\n# B\nend', markdown)
  assert.deepEqual(foldableRange(ed, 0), { from: 1, to: 3 })
  assert.deepEqual(foldableRange(ed, 2), { from: 3, to: 3 })
  assert.deepEqual(foldableRange(ed, 5), { from: 6, to: 6 })
})
