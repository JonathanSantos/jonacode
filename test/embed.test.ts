import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defineLanguage, findLanguage, innerLanguage } from '../src/language/language.ts'
import { javascript } from '../src/languages/javascript.ts'
import { createMarkdown, markdown } from '../src/languages/markdown.ts'
import { tokenize } from './helpers.ts'

// A tiny host: `{{ … }}` holds JavaScript.
const host = defineLanguage({
  name: 'tpl',
  states: {
    root: [
      { match: '{{', token: 'punctuation.special', push: 'close', embed: { language: javascript, end: '}}' } },
      [/[^{]+|\{/, 'string'],
    ],
    close: [['}}', 'punctuation.special', '@pop']],
  },
})

test('embedded region is tokenized by the other language', () => {
  assert.deepEqual(tokenize(host, 'a {{ x + 1 }} b')[0], [
    ['a ', 'string'], ['{{', 'punctuation.special'], ['x', 'variable'], ['+', 'operator'], ['1', 'number'],
    ['}}', 'punctuation.special'], [' b', 'string'],
  ])
})

test('embedded state carries across lines and converges', () => {
  const lines = tokenize(host, '{{ `multi\nline ${a}` }} after')
  assert.deepEqual(lines[1], [['line ', 'string'], ['${', 'punctuation.special'], ['a', 'variable'], ['}', 'punctuation.special'], ['`', 'string'], ['}}', 'punctuation.special'], [' after', 'string']])
  // Equal embedded states are the same object (the highlighter compares with ===).
  const a = host.endState('{{ `x', host.initialState)
  const b = host.endState('{{ `y', host.initialState)
  assert.equal(a, b)
  assert.equal(innerLanguage(host, a), javascript)
  assert.deepEqual(a.stack, ['root', 'close', '@javascript', 'root', 'template'])
})

test('state and language at a column', () => {
  const line = 'text {{ call() }} text'
  const at = (col: number) => innerLanguage(host, host.stateAtColumn(line, host.initialState, col)).name
  assert.equal(at(2), 'tpl')
  assert.equal(at(7), 'javascript')
  assert.equal(at(12), 'javascript')
  assert.equal(at(20), 'tpl')
})

test('findLanguage by name, alias or extension', () => {
  const list = [javascript, markdown]
  assert.equal(findLanguage(list, 'JS'), javascript)
  assert.equal(findLanguage(list, 'mjs'), javascript)
  assert.equal(findLanguage(list, '.md'), markdown)
  assert.equal(findLanguage(list, 'python'), undefined)
})

test('markdown: blocks and inline', () => {
  const [h, p, list, task, quote] = tokenize(markdown, '# Title\nSome **bold**, *it*, `code` and [a link](https://x.dev).\n- item\n- [x] done\n> quote')
  assert.deepEqual(h, [['# Title', 'heading']])
  assert.deepEqual(p!.filter(([, t]) => t), [['**bold**', 'strong'], ['*it*', 'emphasis'], ['`code`', 'string'],
    ['[', 'punctuation'], ['a link', 'link'], ['](', 'punctuation'], ['https://x.dev', 'string'], [')', 'punctuation']])
  assert.deepEqual(list![0], ['-', 'keyword'])
  assert.deepEqual(task!.slice(0, 2), [['-', 'keyword'], ['[x]', 'constant']])
  assert.deepEqual(quote![0], ['> ', 'comment'])
  // snake_case is not emphasis; bare URLs are links.
  assert.deepEqual(tokenize(markdown, 'a snake_case_name')[0]!.filter(([, t]) => t), [])
  assert.deepEqual(tokenize(markdown, 'see https://jonacode.dev.')[0]!.filter(([, t]) => t), [['https://jonacode.dev', 'link']])
})

test('markdown: tables and front matter', () => {
  const lines = tokenize(markdown, '---\ntitle: x\n---\n| a | b |\n|---|:-:|')
  assert.deepEqual(lines[1], [['title: x', 'meta']])
  assert.deepEqual(lines[3]!.filter(([, t]) => t).map(([x]) => x), ['|', '|', '|'])
  assert.deepEqual(lines[4], [['|---|:-:|', 'punctuation']])
  // A `---` later in the document is a thematic break, not front matter.
  assert.deepEqual(tokenize(markdown, 'text\n---\nmore')[2], [['more', null]])
})

test('markdown: fenced code with and without a language', () => {
  const plain = tokenize(markdown, '```js\nconst a = 1\n```\n*after*')
  assert.deepEqual(plain[1], [['const a = 1', 'string']])
  assert.deepEqual(plain[3], [['*after*', 'emphasis']])

  const md = createMarkdown({ codeLanguages: [javascript] })
  const lines = tokenize(md, '````js title="x"\nconst a = `\n```\n````\n*after*')
  assert.deepEqual(lines[0], [['````', 'punctuation.special'], ['js', 'type'], [' title="x"', 'comment']])
  assert.deepEqual(lines[1]!.slice(0, 2), [['const', 'keyword'], ['a', 'variable']])
  // A shorter fence doesn't close a longer one (here it's still JavaScript)…
  assert.deepEqual(lines[2], [['```', 'string']])
  // …and the closing fence wins even inside an open template string.
  assert.deepEqual(lines[3], [['````', 'punctuation.special']])
  assert.deepEqual(lines[4], [['*after*', 'emphasis']])
  // Unknown languages fall back to plain code.
  assert.deepEqual(tokenize(md, '```python\nx = 1\n```')[1], [['x = 1', 'string']])
})
