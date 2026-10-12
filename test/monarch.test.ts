import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Highlighter } from '../src/language/highlighter.ts'
import { innerLanguage } from '../src/language/language.ts'
import { fromMonarch, type MonarchLanguage, type MonarchOptions } from '../src/language/monarch.ts'
import { TextDocument } from '../src/state/text.ts'
import { tokenize } from './helpers.ts'

// Token names unknown to the default map (`kw`, `id`…) are kept as they are,
// which shows exactly what the Monarch rules produced.

test('attributes, @attr in regexes and case guards', () => {
  const lang = fromMonarch({
    keywords: ['if', 'else'],
    types: ['int'],
    ident: /[a-z_]\w*/,
    digits: /\d+/,
    number: /@digits(?:\.@digits)?/, // attributes can reference attributes
    tokenizer: {
      root: [
        [/@ident/, { cases: { '@keywords': 'kw', '@types': 'ty', '~[a-z]+_[a-z]+': 'snake', 'x|y': 'xy', '!~.*\\d': 'id', '@default': 'id.digit' } }],
        [/@number/, 'num'],
        [/!/, { cases: { '@eos': 'bang.end', '@default': 'bang' } }],
        [/\s+/, 'white'],
      ],
    },
  })
  assert.deepEqual(tokenize(lang, 'if int snake_case x abc a1 3.14 7! !')[0], [
    ['if', 'kw'], ['int', 'ty'], ['snake_case', 'snake'], ['x', 'xy'], ['abc', 'id'], ['a1', 'id.digit'],
    ['3.14', 'num'], ['7', 'num'], ['!', 'bang'], ['!', 'bang.end'],
  ])
})

test('states: next, @push, @pop, @popall and switchTo', () => {
  const lang = fromMonarch({
    tokenizer: {
      root: [
        [/\{/, 'open', '@block'],
        [/#/, { token: 'hash', switchTo: '@comment' }],
        [/\w+/, 'word'],
      ],
      block: [
        [/\{/, { token: 'open', next: '@push' }],
        [/\}/, { token: 'close', next: '@pop' }],
        [/!/, { token: 'reset', next: '@popall' }],
        [/\w+/, 'inner'],
      ],
      comment: [[/.+/, { token: 'comment', switchTo: 'root' }]],
    },
  })
  const init = lang.initialState
  assert.deepEqual(tokenize(lang, 'a { b { c } d } e')[0], [
    ['a', 'word'], ['{', 'open'], ['b', 'inner'], ['{', 'open'], ['c', 'inner'], ['}', 'close'], ['d', 'inner'], ['}', 'close'], ['e', 'word'],
  ])
  assert.deepEqual(lang.endState('{ {', init).stack, ['root', 'block', 'block'])
  assert.equal(lang.endState('{ { { !', init), init)
  // switchTo replaces the current state (here across a line break).
  assert.deepEqual(lang.endState('#', init).stack, ['comment'])
  assert.deepEqual(tokenize(lang, '#\nnote\nword'), [[['#', 'hash']], [['note', 'comment']], [['word', 'word']]])
  assert.equal(lang.endState('# note', init), init)
})

test('dotted sub-states: $S2 in regexes, tokens and guards', () => {
  const lang = fromMonarch({
    tokenizer: {
      root: [
        [/["']/, { token: 'q', next: '@str.$0' }],
        [/(\w+)\(/, { token: 'call', next: '@args.$1' }],
      ],
      str: [
        [/[^$S2\\]+/, 'str'],
        [/\\./, 'esc'],
        [/["']/, { cases: { '$#==$S2': { token: 'q', next: '@pop' }, '@default': 'str' } }],
      ],
      args: [
        [/\w+/, { cases: { '$S2==max': 'arg.max', '@default': { token: 'arg.$S2' } } }],
        [/\)/, { token: 'close', next: '@pop' }],
        // Like Monaco, a plain string action is not substituted.
        [/,/, 'comma.$S2'],
      ],
    },
  })
  assert.deepEqual(tokenize(lang, `"it's" 'say "hi"'`)[0], [['"', 'q'], ["it's", 'str'], ['"', 'q'], ["'", 'q'], ['say "hi"', 'str'], ["'", 'q']])
  assert.deepEqual(lang.endState('"abc', lang.initialState).stack, ['root', 'str."'])
  assert.deepEqual(tokenize(lang, 'min(a,b) max(c)')[0], [
    ['min(', 'call'], ['a', 'arg.min'], [',', 'comma.$S2'], ['b', 'arg.min'], [')', 'close'], ['max(', 'call'], ['c', 'arg.max'], [')', 'close'],
  ])
})

test('groups, @brackets and @rematch', () => {
  const lang = fromMonarch({
    brackets: [['<', '>', 'delimiter.angle'], ['(', ')', 'delimiter.parenthesis']],
    tokenizer: {
      root: [
        [/(<)(\w+)/, ['@brackets', { token: 'tag', next: '@tag' }]],
        [/[()>]/, '@brackets'],
        [/(\w+)(\s*)(=)(\s*)(\d+)/, ['attribute.name', '', 'operator', '', 'number']],
        [/\w+/, 'identifier'],
      ],
      tag: [
        [/\s+/, 'white'],
        [/\w+/, 'attribute.name'],
        // Leaves the state without consuming `>`: the root rules tokenize it.
        [/>/, { token: '@rematch', next: '@pop' }],
      ],
    },
  })
  assert.deepEqual(tokenize(lang, '<div id> x = 1 (y) z=2')[0], [
    ['<', 'punctuation.bracket'], ['div', 'tag'], ['id', 'attribute'], ['>', 'punctuation.bracket'],
    ['x', 'attribute'], ['=', 'operator'], ['1', 'number'], ['(', 'punctuation.bracket'], ['y', 'variable'],
    [')', 'punctuation.bracket'], ['z', 'attribute'], ['=', 'operator'], ['2', 'number'],
  ])
  assert.equal(lang.endState('<div id>', lang.initialState), lang.initialState)
})

test('ignoreCase and unicode', () => {
  const lang = fromMonarch({
    ignoreCase: true,
    unicode: true,
    keywords: ['select', 'from'],
    tokenizer: {
      root: [
        ['\\p{L}+', { cases: { '@keywords': 'keyword', '~s.*': 'keyword.s', '@default': 'identifier' } }],
        [/\s+/, 'white'],
      ],
    },
  })
  assert.deepEqual(tokenize(lang, 'SELECT Ação FROM Sales')[0], [['SELECT', 'keyword'], ['Ação', 'variable'], ['FROM', 'keyword'], ['Sales', 'keyword']])
})

test('rules match the rest of the line, like in Monaco', () => {
  const lang = fromMonarch({
    tokenizer: {
      root: [
        [/^#.*/, 'directive'], // `^`: only at the start of the line
        [/(^#.*$)/, 'comment'], // an inner `^` matches anywhere
        [/\d+/, 'num'],
        [/\b[a-z]+/, 'word'], // `\b` behaves as at a line start
        [/\s+/, 'white'],
      ],
    },
  })
  assert.deepEqual(tokenize(lang, '#if x # note'), [[['#if x # note', 'directive']]])
  assert.deepEqual(tokenize(lang, 'x # note'), [[['x', 'word'], ['# note', 'comment']]])
  assert.deepEqual(tokenize(lang, '12px'), [[['12', 'num'], ['px', 'word']]])
})

test('empty lines run the rules once; end of line does not', () => {
  const lang = fromMonarch({
    tokenizer: {
      root: [[/\S.*/, 'text', '@para']],
      para: [
        [/$/, { token: '', next: '@pop' }],
        [/.+/, 'text'],
      ],
    },
  })
  const init = lang.initialState
  const para = lang.endState('first', init)
  assert.deepEqual(para.stack, ['root', 'para'])
  assert.equal(lang.endState('second', para), para)
  assert.equal(lang.endState('', para), init)
})

test('token mapping: postfix, defaults, dotted prefixes and overrides', () => {
  // `{ token: '$0' }`: the matched text is the token name.
  const echo = (options?: MonarchOptions) =>
    fromMonarch({ tokenPostfix: '.demo', tokenizer: { root: [[/.+/, { token: '$0' }]] } }, options)
  const map = (options?: MonarchOptions) => {
    const names = [
      'keyword.demo', 'keyword.flow', 'identifier', 'type.identifier', 'type', 'operators', 'delimiter', 'delimiter.curly',
      'delimiter.angle', 'number.hex', 'string', 'string.escape', 'string.invalid', 'string.quote', 'regexp', 'comment.doc',
      'annotation', 'metatag.content', 'tag.id', 'attribute.name', 'attribute.value', 'predefined', 'constant',
      'variable.predefined', 'variable.name', 'emphasis', 'strong', 'header', 'invalid', 'key', 'custom.name', 'white', 'source',
    ]
    const lang = echo(options)
    return Object.fromEntries(names.map((name) => [name, lang.tokenize(name, lang.initialState).tokens[0]!.type]))
  }
  assert.deepEqual(map(), {
    'keyword.demo': 'keyword', 'keyword.flow': 'keyword', identifier: 'variable', 'type.identifier': 'type', type: 'type',
    operators: 'operator', delimiter: 'punctuation', 'delimiter.curly': 'punctuation.bracket', 'delimiter.angle': 'punctuation.bracket',
    'number.hex': 'number', string: 'string', 'string.escape': 'string.escape', 'string.invalid': 'invalid', 'string.quote': 'string',
    regexp: 'regexp', 'comment.doc': 'comment', annotation: 'meta', 'metatag.content': 'meta', 'tag.id': 'tag',
    'attribute.name': 'attribute', 'attribute.value': 'string', predefined: 'type.builtin', constant: 'constant',
    'variable.predefined': 'variable.language', 'variable.name': 'variable', emphasis: 'emphasis', strong: 'strong',
    header: 'heading', invalid: 'invalid', key: 'property', 'custom.name': 'custom.name', white: null, source: null,
  })
  const custom = map({ tokenMap: { keyword: 'strong', 'keyword.flow': 'function', custom: 'attribute', 'delimiter.curly': null } })
  assert.equal(custom['keyword.demo'], 'strong')
  assert.equal(custom['keyword.flow'], 'function')
  assert.equal(custom['custom.name'], 'attribute')
  assert.equal(custom['delimiter.curly'], null)
  assert.equal(custom['delimiter.angle'], 'punctuation.bracket')
  assert.equal(echo().name, 'demo')
})

test('states are interned and converge', () => {
  const lang = fromMonarch({
    tokenizer: {
      root: [[/"/, 'string', '@string'], [/\/\*/, 'comment', '@comment'], [/[^"/]+|\//, '']],
      string: [[/[^"\\]+/, 'string'], [/\\./, 'string.escape'], [/"/, 'string', '@pop']],
      comment: [[/\*\//, 'comment', '@pop'], [/[^*]+|\*/, 'comment']],
    },
  })
  const init = lang.initialState
  const a = lang.endState('x = "abc', init)
  assert.equal(a, lang.endState('y = "other \\"', init))
  assert.equal(a, lang.tokenize('x = "abc', init).state)
  assert.equal(lang.endState('/* a */ "b" /* c', init), lang.endState('/*', init))
  assert.equal(lang.endState('"a" /* b */', init), init)
})

test('state at a column', () => {
  const lang = fromMonarch({ tokenizer: { root: [[/\{/, 'open', '@block']], block: [[/\}/, 'close', '@pop']] } })
  const line = 'a { b } c'
  const at = (col: number) => lang.stateAtColumn(line, lang.initialState, col).name
  assert.equal(at(0), 'root')
  assert.equal(at(3), 'block')
  assert.equal(at(6), 'block')
  assert.equal(at(7), 'root')
})

test('embedded languages: nextEmbedded, end of region and unresolved ids', () => {
  const inner = fromMonarch(
    {
      keywords: ['let'],
      tokenizer: {
        root: [[/[a-z]+/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }], [/\d+/, 'number'], [/"/, 'string', '@str']],
        str: [[/[^"]+/, 'string'], [/"/, 'string', '@pop']],
      },
    },
    { name: 'inner' },
  )
  const host = fromMonarch(
    {
      tokenizer: {
        root: [
          [/<code lang=(\w+)>/, { token: 'tag', next: '@code', nextEmbedded: '$1' }],
          [/[^<]+/, 'text'],
        ],
        code: [[/<\/code>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]],
      },
    },
    { name: 'host', embedded: (id) => (id === 'inner' ? inner : undefined) },
  )
  assert.equal(host.nested, true)
  const src = '<code lang=inner>let x = "a\nb" 1</code> after\n<code lang=nope>let y</code>'
  assert.deepEqual(tokenize(host, src), [
    [['<code lang=inner>', 'tag'], ['let', 'keyword'], ['x', 'variable'], [' = ', null], ['"a', 'string']],
    [['b"', 'string'], ['1', 'number'], ['</code>', 'tag'], [' after', 'text']],
    // Like Monaco, a language that cannot be resolved is plain text.
    [['<code lang=nope>', 'tag'], ['let y', null], ['</code>', 'tag']],
  ])
  const init = host.initialState
  const open = host.endState('<code lang=inner>"x', init)
  assert.equal(open, host.endState('<code lang=inner>let "y', init))
  assert.deepEqual(open.stack, ['root', 'code', '@inner', 'root', 'str'])
  assert.equal(innerLanguage(host, open), inner)
  const line = '<code lang=inner>let</code>'
  assert.equal(innerLanguage(host, host.stateAtColumn(line, init, 18)), inner)
  assert.equal(innerLanguage(host, host.stateAtColumn(line, init, 5)), host)
  assert.equal(host.endState(line, init), init)
})

test('conf: comments, brackets and auto-closing pairs', () => {
  const lang = fromMonarch(
    { tokenizer: { root: [] } },
    {
      name: 'x',
      aliases: ['ex'],
      conf: {
        comments: { lineComment: '#', blockComment: ["'''", "'''"] },
        brackets: [['{', '}'], ['[', ']']],
        autoClosingPairs: [{ open: '{', close: '}' }, { open: '"', close: '"' }],
      },
    },
  )
  assert.deepEqual(lang.comments, { line: '#', block: ["'''", "'''"] })
  assert.deepEqual(lang.brackets, [['{', '}'], ['[', ']']])
  assert.deepEqual(lang.closePairs, [['{', '}'], ['"', '"']])
  assert.deepEqual(lang.aliases, ['ex'])
  assert.ok(lang.indent.increase!.test('a = {'))
  assert.ok(lang.indent.decrease!.test('  ]'))
  const own = fromMonarch({ tokenizer: { root: [] } }, { comments: { line: '--' }, brackets: [['(', ')']], indent: { increase: null } })
  assert.deepEqual(own.comments, { line: '--' })
  assert.deepEqual(own.closePairs, [['(', ')']])
  assert.equal(own.indent.increase, null)
  assert.equal(own.name, 'monarch')
  // Recent Monaco versions also accept `lineComment: { comment }`.
  assert.equal(fromMonarch({ tokenizer: { root: [] } }, { conf: { comments: { lineComment: { comment: '//' } } } }).comments.line, '//')
})

test('works with the incremental highlighter', () => {
  const lang = fromMonarch({
    tokenizer: {
      root: [[/\/\*/, 'comment', '@comment'], [/\w+/, 'identifier']],
      comment: [[/\*\//, 'comment', '@pop'], [/[^*]+|\*/, 'comment']],
    },
  })
  const doc = new TextDocument(Array.from({ length: 1000 }, (_, i) => `x${i}`).join('\n'))
  const hl = new Highlighter(lang, doc)
  assert.ok(hl.ensure(999))
  hl.applyChange(doc.replace({ line: 10, col: 0 }, { line: 10, col: 0 }, '/*'))
  hl.ensure(999)
  assert.equal(hl.stateAt(500).name, 'comment')
  hl.applyChange(doc.replace({ line: 20, col: 0 }, { line: 20, col: 0 }, '*/'))
  hl.ensure(999)
  assert.equal(hl.stateAt(500), lang.initialState)
  assert.deepEqual(hl.tokens(15), [{ from: 0, to: 3, type: 'comment' }])
})

test('helpful errors and no infinite loops', () => {
  assert.throws(() => fromMonarch({ tokenizer: { root: [{ include: '@nope' }] } }), /unknown state "nope"/)
  assert.throws(() => fromMonarch({ words: 'a', tokenizer: { root: [[/\w+/, { cases: { '@words': 'x' } }]] } }), /not a word list/)
  // A zero-length match that changes nothing: one char of default text.
  const look = fromMonarch({ tokenizer: { root: [[/(?=a)/, 'look'], [/b/, 'b']] } })
  assert.deepEqual(tokenize(look, 'ab'), [[['a', null], ['b', 'b']]])
  // Zero-length state cycles are broken.
  const loop = fromMonarch({ tokenizer: { root: [[/(?=a)/, '', '@other']], other: [[/(?=a)/, '', '@pop']] } })
  assert.deepEqual(tokenize(loop, 'aa'), [[['aa', null]]])
  // Unmatched text advances by code point: an emoji is never split.
  const emoji = fromMonarch({ tokenizer: { root: [[/[\udc00-\udfff]/, 'low']] } })
  assert.deepEqual(emoji.tokenize('😀', emoji.initialState).tokens, [{ from: 0, to: 2, type: null }])
})

test('performance: 20k lines', () => {
  const def: MonarchLanguage = {
    tokenPostfix: '.perf',
    keywords: ['function', 'return', 'const', 'let', 'if', 'else', 'for', 'while', 'new', 'class'],
    operators: ['=', '==', '===', '+', '-', '*', '/', '<', '>', '&&', '||', '=>'],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{2})/,
    tokenizer: {
      root: [
        [/[a-z_$][\w$]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/[A-Z][\w$]*/, 'type.identifier'],
        { include: '@whitespace' },
        [/[{}()[\]]/, '@brackets'],
        [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
        [/\d+(\.\d+)?/, 'number'],
        [/[;,.]/, 'delimiter'],
        [/"/, 'string', '@string'],
      ],
      whitespace: [
        [/[ \t]+/, 'white'],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
      string: [
        [/[^\\"]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/"/, 'string', '@pop'],
      ],
    },
  }
  const lang = fromMonarch(def)
  const block = [
    '/* A block comment',
    '   over two lines */',
    'class Point extends Base {',
    '  constructor(x, y) { this.x = x; this.y = y + 1.5 }',
    '  length() { return Math.sqrt(this.x * this.x + this.y * this.y) } // line comment',
    '}',
    'const p = new Point(1, 2), s = "text \\"with\\" escapes\\n"',
    'for (let i = 0; i < 10; i++) if (i === 3 && p.x > 0) console.log(i, s)',
  ]
  const lines = Array.from({ length: 20_000 }, (_, i) => block[i % block.length]!)
  const start = performance.now()
  let state = lang.initialState
  for (const line of lines) state = lang.endState(line, state)
  let tokens = 0
  state = lang.initialState
  for (const line of lines) {
    const res = lang.tokenize(line, state)
    tokens += res.tokens.length
    state = res.state
  }
  const elapsed = performance.now() - start
  assert.equal(state, lang.initialState)
  assert.ok(tokens > 300_000)
  assert.ok(elapsed < 1500, `20k lines took ${elapsed.toFixed(0)} ms`)
})
