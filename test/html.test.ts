import assert from 'node:assert/strict'
import { test } from 'node:test'
import { innerLanguage } from '../src/language/language.ts'
import { css } from '../src/languages/css.ts'
import { createHtml, html } from '../src/languages/html.ts'
import { javascript } from '../src/languages/javascript.ts'
import { typescript } from '../src/languages/typescript.ts'
import { tokenize, typeOf } from './helpers.ts'

const t = (src: string, text: string) => typeOf(html, src, text)

test('tags, attributes, values and entities', () => {
  assert.deepEqual(tokenize(html, '<a href="/x" data-id=7 hidden>Tom &amp; Jerry</a>')[0], [
    ['<', 'punctuation.tag'], ['a', 'tag'], ['href', 'attribute'], ['=', 'punctuation'], ['"/x"', 'string'],
    ['data-id', 'attribute'], ['=', 'punctuation'], ['7', 'string'], ['hidden', 'attribute'], ['>', 'punctuation.tag'],
    ['Tom ', null], ['&amp;', 'string.escape'], [' Jerry', null], ['</', 'punctuation.tag'], ['a', 'tag'], ['>', 'punctuation.tag'],
  ])
  assert.equal(t('<!doctype html>', '<!doctype html>'), 'meta')
  assert.equal(t('<br/>', '/>'), 'punctuation.tag')
})

test('comments and attributes span lines', () => {
  const lines = tokenize(html, '<!-- a\nb -->\n<div\n  class="x\ny">')
  assert.deepEqual(lines[1], [['b -->', 'comment']])
  assert.deepEqual(lines[3], [['class', 'attribute'], ['=', 'punctuation'], ['"x', 'string']])
  assert.deepEqual(lines[4], [['y"', 'string'], ['>', 'punctuation.tag']])
})

test('<script> and <style> embed JavaScript and CSS', () => {
  const lines = tokenize(html, '<script type="module">\n  const s = "</div>"\n</script>\n<style>\n  a { color: red }\n</style>')
  assert.deepEqual(lines[1], [['const', 'keyword'], ['s', 'variable'], ['=', 'operator'], ['"</div>"', 'string']])
  assert.deepEqual(lines[2], [['</', 'punctuation.tag'], ['script', 'tag'], ['>', 'punctuation.tag']])
  assert.equal(lines[4]![0]![1], 'tag')
  assert.deepEqual(lines[4]!.find(([x]) => x === 'color'), ['color', 'property'])
  // The script ends at `</script>` even inside a JS string (like browsers do).
  const one = tokenize(html, '<script>let a = "</script><b>')[0]!
  assert.deepEqual(one.slice(-6), [['"', 'string'], ['</', 'punctuation.tag'], ['script', 'tag'], ['><', 'punctuation.tag'], ['b', 'tag'], ['>', 'punctuation.tag']])
})

test('event handler attributes hold JavaScript', () => {
  const line = tokenize(html, '<button onclick="go(1)">x</button>')[0]!
  assert.deepEqual(line.slice(2, 8), [['onclick', 'attribute'], ['=', 'punctuation'], ['"', 'string'], ['go', 'function'], ['(', 'punctuation.bracket'], ['1', 'number']])
  assert.deepEqual(line[9], ['"', 'string'])
  assert.deepEqual(line[10], ['>', 'punctuation.tag'])
})

test('language at a position', () => {
  const src = ['<p>hi</p>', '<script>', '  run()', '</script>', '<style>a{}</style>']
  let state = html.initialState
  const starts = src.map((line) => {
    const s = state
    state = html.endState(line, state)
    return s
  })
  const at = (line: number, col: number) => innerLanguage(html, html.stateAtColumn(src[line]!, starts[line]!, col))
  assert.equal(at(0, 4), html)
  assert.equal(at(2, 3), javascript)
  assert.equal(at(4, 8), css)
  assert.equal(at(4, 12), html)
})

test('createHtml with other languages, or none', () => {
  const ts = createHtml({ script: typescript })
  assert.equal(typeOf(ts, '<script>let x: string</script>', 'string'), 'type.builtin')
  const plain = createHtml({ script: null, style: null })
  assert.deepEqual(tokenize(plain, '<script>if (a < b) {}</script>')[0]!.slice(3, 4), [['if (a < b) {}', null]])
})
