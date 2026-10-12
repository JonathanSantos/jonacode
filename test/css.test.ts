import assert from 'node:assert/strict'
import { test } from 'node:test'
import { css } from '../src/languages/css.ts'
import { tokenize, typeOf } from './helpers.ts'

const t = (src: string, text: string) => typeOf(css, src, text)

test('selectors', () => {
  assert.deepEqual(tokenize(css, 'ul > li.item#main:hover::before, *[data-x~="y"] {}')[0], [
    ['ul', 'tag'], ['>', 'operator'], ['li', 'tag'], ['.item', 'type'], ['#main', 'constant'],
    [':hover::before', 'keyword'], [',', 'punctuation'], ['*', 'tag'], ['[', 'punctuation.bracket'],
    ['data-x', 'attribute'], ['~=', 'operator'], ['"y"', 'string'], [']', 'punctuation.bracket'],
    ['{}', 'punctuation.bracket'],
  ])
  assert.equal(t('[type=text] {}', 'text'), 'string')
  assert.equal(t('my-element {}', 'my-element'), 'tag')
})

test('pseudo-class arguments', () => {
  assert.deepEqual(tokenize(css, 'li:nth-child(2n of .a):not(p) {}')[0]!.slice(0, 8), [
    ['li', 'tag'], [':nth-child', 'keyword'], ['(', 'punctuation.bracket'], ['2n', 'number'],
    ['of', 'keyword'], ['.a', 'type'], [')', 'punctuation.bracket'], [':not', 'keyword'],
  ])
  assert.equal(t('tr:nth-child(odd) {}', 'odd'), 'keyword')
})

test('declarations and values', () => {
  const [line] = tokenize(css, 'a { margin: 0 -1.5em calc(100% - 2px) !important; color: #fff }')
  assert.deepEqual(line, [
    ['a', 'tag'], ['{', 'punctuation.bracket'], ['margin', 'property'], [':', 'punctuation'], ['0', 'number'],
    ['-1.5em', 'number'], ['calc', 'function'], ['(', 'punctuation.bracket'], ['100%', 'number'], ['-', 'operator'],
    ['2px', 'number'], [')', 'punctuation.bracket'], ['!important', 'keyword'], [';', 'punctuation'],
    ['color', 'property'], [':', 'punctuation'], ['#fff', 'number'], ['}', 'punctuation.bracket'],
  ])
  assert.equal(t('a { border: 1px solid red }', 'solid'), 'constant')
  assert.equal(t('a { font-family: "Fira Code", monospace }', '"Fira Code"'), 'string')
})

test('custom properties and var()', () => {
  const lines = tokenize(css, ':root { --gap: 4px; }\na { gap: var(--gap, 2px) }')
  assert.deepEqual(lines[0]!.slice(1, 4), [['{', 'punctuation.bracket'], ['--gap', 'variable'], [':', 'punctuation']])
  assert.deepEqual(lines[1]!.slice(4, 7), [['var', 'function'], ['(', 'punctuation.bracket'], ['--gap', 'variable']])
})

test('url()', () => {
  assert.deepEqual(tokenize(css, 'a { background: url(img/a.png) }')[0]!.slice(4, 8), [
    ['url', 'function'], ['(', 'punctuation.bracket'], ['img/a.png', 'string'], [')', 'punctuation.bracket'],
  ])
  assert.equal(t('a { background: url("b.png") }', '"b.png"'), 'string')
})

test('nesting: property vs nested selector', () => {
  const lines = tokenize(css, [
    '.card {',
    '  color: red;',
    '  a:hover { color: blue }',
    '  &:focus-visible,',
    '  & > p { margin: 0 }',
    '  .title { font-weight: 700 }',
    '}',
    'b {}',
  ].join('\n'))
  assert.deepEqual(lines[1], [['color', 'property'], [':', 'punctuation'], ['red', 'constant'], [';', 'punctuation']])
  assert.deepEqual(lines[2]!.slice(0, 4), [['a', 'tag'], [':hover', 'keyword'], ['{', 'punctuation.bracket'], ['color', 'property']])
  assert.deepEqual(lines[3], [['&', 'variable.language'], [':focus-visible', 'keyword'], [',', 'punctuation']])
  assert.deepEqual(lines[4]!.slice(0, 3), [['&', 'variable.language'], ['>', 'operator'], ['p', 'tag']])
  assert.deepEqual(lines[5]!.slice(0, 3), [['.title', 'type'], ['{', 'punctuation.bracket'], ['font-weight', 'property']])
  // Back at the top level.
  assert.deepEqual(lines[7], [['b', 'tag'], ['{}', 'punctuation.bracket']])
})

test('declarations spanning several lines', () => {
  const lines = tokenize(css, 'a {\n  grid-template-areas:\n    "head head"\n    "side main";\n  transition: color .2s,\n    opacity 1s\n}\nb {}')
  assert.deepEqual(lines[2], [['"head head"', 'string']])
  assert.deepEqual(lines[3], [['"side main"', 'string'], [';', 'punctuation']])
  assert.deepEqual(lines[5], [['opacity', 'constant'], ['1s', 'number']])
  assert.deepEqual(lines[7], [['b', 'tag'], ['{}', 'punctuation.bracket']])
})

test('at-rules', () => {
  const lines = tokenize(css, '@import url(base.css) layer(base);\n@media screen and (min-width: 40em) {\n  body { margin: 0 }\n}\n@font-face { font-family: X }')
  assert.deepEqual(lines[0], [
    ['@import', 'keyword'], ['url', 'function'], ['(', 'punctuation.bracket'], ['base.css', 'string'], [')', 'punctuation.bracket'],
    ['layer', 'function'], ['(', 'punctuation.bracket'], ['base', 'constant'], [')', 'punctuation.bracket'], [';', 'punctuation'],
  ])
  assert.deepEqual(lines[1], [
    ['@media', 'keyword'], ['screen', 'constant'], ['and', 'keyword'], ['(', 'punctuation.bracket'],
    ['min-width', 'property'], [':', 'punctuation'], ['40em', 'number'], [')', 'punctuation.bracket'], ['{', 'punctuation.bracket'],
  ])
  assert.deepEqual(lines[2], [['body', 'tag'], ['{', 'punctuation.bracket'], ['margin', 'property'], [':', 'punctuation'], ['0', 'number'], ['}', 'punctuation.bracket']])
  assert.deepEqual(lines[4]!.slice(0, 3), [['@font-face', 'keyword'], ['{', 'punctuation.bracket'], ['font-family', 'property']])
  // Nested at-rule inside a rule.
  const nested = tokenize(css, '.a {\n  @media (width >= 600px) { color: red }\n  color: blue;\n}')
  assert.equal(nested[1]!.find(([x]) => x === '>=')![1], 'operator')
  assert.deepEqual(nested[2], [['color', 'property'], [':', 'punctuation'], ['blue', 'constant'], [';', 'punctuation']])
})

test('keyframes', () => {
  const lines = tokenize(css, '@keyframes spin {\n  from { opacity: 0 }\n  50% { opacity: .5 }\n}')
  assert.deepEqual(lines[1]!.slice(0, 2), [['from', 'tag'], ['{', 'punctuation.bracket']])
  assert.deepEqual(lines[2]!.slice(0, 2), [['50%', 'number'], ['{', 'punctuation.bracket']])
})

test('comments and strings', () => {
  const lines = tokenize(css, '/* a\n b */ a { content: "\\201C" }')
  assert.deepEqual(lines[0], [['/* a', 'comment']])
  assert.deepEqual(lines[1]!.slice(0, 2), [[' b */', 'comment'], ['a', 'tag']])
  assert.equal(t('a { content: "\\201C" }', '\\201C'), 'string.escape')
  // A trailing `\` continues the string on the next line.
  const cont = tokenize(css, 'a { content: "x\\\ny" }')
  assert.deepEqual(cont[1]![0], ['y"', 'string'])
})
