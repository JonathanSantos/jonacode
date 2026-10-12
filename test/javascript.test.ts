import assert from 'node:assert/strict'
import { test } from 'node:test'
import { javascript, jsx } from '../src/languages/javascript.ts'
import { tokenize, typeOf } from './helpers.ts'

const t = (src: string, text: string) => typeOf(javascript, src, text)

test('keywords, constants and literals', () => {
  assert.equal(t('const x = 1', 'const'), 'keyword')
  assert.equal(t('return null', 'null'), 'constant.language')
  assert.equal(t('let a = 0x1F_FFn', '0x1F_FFn'), 'number')
  assert.equal(t('a = 1.5e-3', '1.5e-3'), 'number')
  assert.equal(t('this.x', 'this'), 'variable.language')
})

test('identifiers by context', () => {
  assert.equal(t('foo(1)', 'foo'), 'function')
  assert.equal(t('obj.prop', 'prop'), 'property')
  assert.equal(t('obj.method()', 'method'), 'function.method')
  assert.equal(t('new Map()', 'Map'), 'type')
  assert.equal(t('const MAX_SIZE = 1', 'MAX_SIZE'), 'constant')
  assert.equal(t('const add = (a, b) => a + b', 'add'), 'function')
  assert.equal(t('x = { key: 1 }', 'key'), 'property')
  assert.equal(t('console.log(x)', 'console'), 'type.builtin')
  assert.equal(t('[...items]', 'items'), 'variable')
  assert.equal(t("import x from 'y'", 'from'), 'keyword')
  assert.equal(t('const from = 1', 'from'), 'variable')
})

test('strings and escapes', () => {
  assert.deepEqual(tokenize(javascript, `'a\\n'`)[0], [["'a", 'string'], ['\\n', 'string.escape'], ["'", 'string']])
  // Unterminated strings stop at the end of the line.
  const lines = tokenize(javascript, '"open\nlet x')
  assert.equal(lines[1]![0]![1], 'keyword')
})

test('template literals with nested expressions', () => {
  const lines = tokenize(javascript, 'const s = `a ${ {b: `c${d}`}.b } e\nstill string`')
  const flat = lines.flat()
  assert.deepEqual(flat.find(([x]) => x === '${'), ['${', 'punctuation.special'])
  assert.deepEqual(flat.find(([x]) => x === 'd'), ['d', 'variable'])
  assert.deepEqual(lines[1]![0], ['still string`', 'string'])
})

test('regex vs division', () => {
  assert.equal(t('const r = /ab+c/gi', '/ab+c/gi'), 'regexp')
  assert.equal(t('x.replace(/[/]/g, "")', '/[/]/g'), 'regexp')
  assert.equal(t('const half = total / 2 / 3', '/'), 'operator')
  assert.equal(t('return /x/.test(s)', '/x/'), 'regexp')
})

test('comments', () => {
  const lines = tokenize(javascript, '/**\n * @param a\n */ let b // c')
  assert.deepEqual(lines[1], [[' * ', 'comment'], ['@param', 'comment.tag'], [' a', 'comment']])
  assert.deepEqual(lines[2], [[' */', 'comment'], ['let', 'keyword'], ['b', 'variable'], ['// c', 'comment']])
})

test('tokenizes a large file quickly', () => {
  const src = Array.from({ length: 20_000 }, (_, i) => `const v${i} = fn(\`t \${i}\`, /re/g, 'str') // ${i}`).join('\n')
  const start = performance.now()
  let state = javascript.initialState
  for (const line of src.split('\n')) state = javascript.endState(line, state)
  const ms = performance.now() - start
  assert.ok(ms < 2000, `took ${ms}ms`)
})

// ---------------------------------------------------------------------------
// JSX

const j = (src: string, text: string) => typeOf(jsx, src, text)

test('jsx: language metadata', () => {
  assert.equal(jsx.name, 'jsx')
  assert.deepEqual(jsx.extensions, ['.jsx'])
  assert.ok(!javascript.aliases.includes('jsx'))
  assert.ok(!javascript.extensions.includes('.jsx'))
  // Enter indents after an opening tag (not after `a<b>` or a self-closing tag).
  const { increase, decrease } = jsx.indent
  for (const line of ['  <div>', '<A onClick={() => f()}>', '<>', 'return (']) assert.ok(increase!.test(line), line)
  for (const line of ['<br />', '<p>x</p>', 'x = a<b>', 'f = () =>']) assert.ok(!increase!.test(line), line)
  assert.ok(decrease!.test('  </div>'))
})

test('jsx: elements, attributes and expressions', () => {
  assert.deepEqual(tokenize(jsx, 'const a = <div className="x" id={id} />')[0], [
    ['const', 'keyword'], ['a', 'variable'], ['=', 'operator'],
    ['<', 'punctuation'], ['div', 'tag'], ['className', 'attribute'], ['=', 'operator'], ['"x"', 'string'],
    ['id', 'attribute'], ['=', 'operator'], ['{', 'punctuation.bracket'], ['id', 'variable'], ['}', 'punctuation.bracket'],
    ['/>', 'punctuation'],
  ])
  assert.equal(j('x = <Foo bar />', 'Foo'), 'type')
  assert.equal(j('x = <Foo.Bar />', 'Bar'), 'type')
  assert.equal(j('x = <my-element aria-label="a" />', 'my-element'), 'tag')
  assert.equal(j('x = <my-element aria-label="a" />', 'aria-label'), 'attribute')
  assert.equal(j('x = <A {...props} />', 'props'), 'variable')
  assert.equal(j('x = <A onClick={() => go(1)} />', 'go'), 'function')
  assert.equal(j("x = <A title='a &amp; b' />", '&amp;'), 'string.escape')
})

test('jsx: children, entities, nested and closing tags', () => {
  const line = tokenize(jsx, "return (<p>Don't &amp; {n > 1 ? 's' : ''}<b>x</b></p>) + 1")[0]!
  assert.deepEqual(line, [
    ['return', 'keyword'], ['(', 'punctuation.bracket'], ['<', 'punctuation'], ['p', 'tag'], ['>', 'punctuation'],
    ["Don't ", null], ['&amp;', 'string.escape'], ['{', 'punctuation.bracket'], ['n', 'variable'], ['>', 'operator'],
    ['1', 'number'], ['?', 'operator'], ["'s'", 'string'], [':', 'operator'], ["''", 'string'], ['}', 'punctuation.bracket'],
    ['<', 'punctuation'], ['b', 'tag'], ['>', 'punctuation'], ['x', null], ['</', 'punctuation'], ['b', 'tag'],
    ['></', 'punctuation'], ['p', 'tag'], ['>', 'punctuation'],
    // Back to JavaScript after the outermost closing tag.
    [')', 'punctuation.bracket'], ['+', 'operator'], ['1', 'number'],
  ])
})

test('jsx: fragments', () => {
  const lines = tokenize(jsx, 'const f = <>\n  <A />text\n</>\nlet z')
  assert.deepEqual(lines[0]!.slice(-1), [['<>', 'punctuation']])
  assert.deepEqual(lines[1], [['<', 'punctuation'], ['A', 'type'], ['/>', 'punctuation'], ['text', null]])
  assert.deepEqual(lines[2], [['</>', 'punctuation']])
  assert.deepEqual(lines[3], [['let', 'keyword'], ['z', 'variable']])
})

test('jsx: multi-line tags and nested expressions', () => {
  const src = [
    'function App() {',
    '  return (',
    '    <Button',
    '      disabled',
    '      label="a',
    'b"',
    '      onClick={() => {',
    '        if (a < b) setOpen({ open: true })',
    '      }}',
    '    >',
    '      {items.map((i) => <li key={i}>{i}</li>)}',
    '      <br />',
    '    </Button>',
    '  )',
    '}',
    'const n = 1',
  ].join('\n')
  const lines = tokenize(jsx, src)
  assert.deepEqual(lines[3], [['disabled', 'attribute']])
  assert.deepEqual(lines[5], [['b"', 'string']])
  assert.deepEqual(lines[7]!.find(([x]) => x === 'open'), ['open', 'property'])
  assert.deepEqual(lines[7]!.find(([x]) => x === '<'), ['<', 'operator'])
  assert.deepEqual(lines[9], [['>', 'punctuation']])
  assert.deepEqual(lines[10]!.find(([x]) => x === 'li'), ['li', 'tag'])
  assert.deepEqual(lines[10]!.find(([x]) => x === 'key'), ['key', 'attribute'])
  assert.deepEqual(lines[11], [['<', 'punctuation'], ['br', 'tag'], ['/>', 'punctuation']])
  assert.deepEqual(lines[12], [['</', 'punctuation'], ['Button', 'type'], ['>', 'punctuation']])
  assert.deepEqual(lines[15], [['const', 'keyword'], ['n', 'variable'], ['=', 'operator'], ['1', 'number']])
  // The state goes back to plain JavaScript.
  let state = jsx.initialState
  for (const line of src.split('\n')) state = jsx.endState(line, state)
  assert.equal(state, jsx.initialState)
})

test('jsx: elements only where an expression can start', () => {
  for (const src of ['if (a < b) x()', 'for (let i = 0; i<n; i++) {}', 'x = a <b']) {
    assert.ok(tokenize(jsx, src)[0]!.every(([, type]) => type !== 'tag'), src)
    assert.equal(typeOf(jsx, src, '<'), 'operator', src)
  }
  assert.equal(j('cond && <A />', 'A'), 'type')
  assert.equal(j('x = [<A key="1" />, <B />]', 'B'), 'type')
  assert.equal(j('const f = () => <A />', 'A'), 'type')
})

test('jsx: plain javascript has no jsx', () => {
  const line = tokenize(javascript, 'return <div className="x">a</div>')[0]!
  assert.ok(line.every(([, type]) => type !== 'tag' && type !== 'attribute'))
  assert.equal(t('return <div>', '<'), 'operator')
  assert.equal(t('if (a < b) x()', '<'), 'operator')
  assert.ok(!Object.keys(javascript.spec.states).some((s) => s.startsWith('jsx')))
})
