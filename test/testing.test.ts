import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defineLanguage, type Language } from '../src/language/language.ts'
import { javascript } from '../src/languages/javascript.ts'
import { json } from '../src/languages/json.ts'
import { log } from '../src/languages/log.ts'
import { sql } from '../src/languages/sql.ts'
import { describeTokens, expectTokens, tokenizeLines } from '../src/testing.ts'

/** The message of the error thrown by `fn`. */
function failure(fn: () => void): string {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof Error)
    return e.message
  }
  return assert.fail('expected expectTokens to throw')
}

/** A tiny language with a multi-line state. */
const mini = defineLanguage({
  name: 'mini',
  states: {
    root: [[/\s+/], [/\/\*/, 'comment', '@block'], [/\w+/, 'variable'], [/[=+]/, 'operator']],
    block: [[/\*\//, 'comment', '@pop'], [/[^*]+|\*/, 'comment']],
  },
})

test('describeTokens: one caret line per token, plain and blank tokens skipped', () => {
  assert.equal(
    describeTokens(javascript, 'const answer = 42 // ok'),
    [
      'const answer = 42 // ok',
      '^^^^^ keyword',
      '      ^^^^^^ variable',
      '             ^ operator',
      '               ^^ number',
      '                  ^^^^^ comment',
    ].join('\n'),
  )
  // Empty lines stay; lines without tokens have no markers.
  assert.equal(describeTokens(sql, 'SELECT\n\nid'), 'SELECT\n^^^^^^ keyword\n\nid')
})

test('describeTokens: `all` also marks plain and whitespace tokens', () => {
  // Carets leave out the blanks at the edges of a token (`id` is the plain token ` id`).
  assert.equal(describeTokens(sql, 'SELECT id', { all: true }), 'SELECT id\n^^^^^^ keyword\n       ^^ null')
  assert.equal(describeTokens(mini, 'a = b', { all: true }), 'a = b\n^ variable\n ^ null\n  ^ operator\n   ^ null\n    ^ variable')
})

test('describeTokens: the state is carried across lines', () => {
  assert.equal(describeTokens(mini, 'a /* b\nc */ d'), 'a /* b\n^ variable\n  ^^^^ comment\nc */ d\n^^^^ comment\n     ^ variable')
})

test('round trip: describeTokens output passes expectTokens (default, strict, all)', () => {
  const samples: [Language, string][] = [
    [javascript, 'const answer = 42 // ok\n/* multi\n\tline */ let s = `a${b}c`\n\n\tif (x)\treturn "a\tb"'],
    [json, '{\n  "a": [1, 2.5, true, null],\n  "b": "x\\"y" // c\n}'],
    [sql, "SELECT 'a\nb' FROM t -- c\n  WHERE x = $1"],
    [mini, '/*\n\n*/ a = b /* c'],
    [log, '2024-01-02 03:04:05 ERROR boom id=42\n\tat a.B.c(B.java:3)\n  File "x.py", line 3, in f'],
  ]
  for (const [lang, src] of samples) {
    const annotated = describeTokens(lang, src)
    expectTokens(lang, annotated)
    expectTokens(lang, annotated, { strict: true })
    expectTokens(lang, describeTokens(lang, src, { all: true }), { strict: true })
    expectTokens(lang, describeTokens(lang, src, { tabSize: 8 }), { tabSize: 8, strict: true })
  }
})

test('expectTokens: failures show the line, both carets and the actual tokens', () => {
  const message = failure(() =>
    expectTokens(javascript, `
      const answer = 42
      ^^^^^ keyword
            ^^^^^^ keyword
                     ^^ string
      let x
      ^^^ keyword
    `),
  )
  assert.match(message, /^expectTokens \(javascript\): 2 mismatches\n/)
  assert.ok(message.includes('line 1: expected "keyword" on "answer", found "variable" "answer"\n'), message)
  assert.ok(
    message.includes(['    const answer = 42', '          ^^^^^^ keyword   <- expected', '          ^^^^^^ variable   <- actual'].join('\n')),
    message,
  )
  assert.ok(message.includes('line 1: expected "string" on "42", found "number" "42"'), message)
  // The whole line in the caret format, to paste into the test.
  const actual = describeTokens(javascript, 'const answer = 42').replace(/^/gm, '    ')
  assert.ok(message.includes(`actual tokens of line 1 (copy to fix):\n${actual}`), message)
  // Line 2 is fine: not reported.
  assert.ok(!message.includes('line 2'), message)
})

test('expectTokens: carets over several tokens', () => {
  const message = failure(() => expectTokens(mini, 'a=b\n^^^ variable'))
  assert.ok(message.includes('expected "variable" on "a=b", found "variable" "a", "operator" "=", "variable" "b"'), message)
  assert.ok(message.includes('a=b\n    ^^^ variable   <- expected\n    ^ variable   <- actual\n     ^ operator   <- actual'), message)
})

test('expectTokens: whole tokens by default, `partial` accepts part of one', () => {
  const src = `
    function answer() {}
    ^^^^ keyword
  `
  assert.match(failure(() => expectTokens(javascript, src)), /found "keyword" "function" \(the carets must cover the whole token, or pass \{ partial: true \}\)/)
  expectTokens(javascript, src, { partial: true })
  // Still one token of that type.
  assert.throws(() => expectTokens(javascript, 'function answer() {}\n^^^^^^^^^^ keyword', { partial: true }), /found "keyword" "function", null " ", /)
  assert.throws(() => expectTokens(javascript, 'function answer() {}\n^^^^ number', { partial: true }), /expected "number" on "func"/)
  // Blanks at the edges of a token may be left out (JSON folds `: ` into one token).
  expectTokens(json, '{"a": 1}\n    ^ punctuation')
})

test('expectTokens: `null` and `-` mean plain text', () => {
  expectTokens(sql, `
    SELECT id FROM users
           ^^ null
                   ^^^^^ -
  `)
  assert.throws(() => expectTokens(sql, 'SELECT id\n^^^^^^ null'), /expected null on "SELECT", found "keyword" "SELECT"/)
})

test('expectTokens: `strict` requires every token of annotated lines to be marked', () => {
  const src = `
    let a = 1
    ^^^ keyword
            ^ number
  `
  expectTokens(javascript, src)
  const message = failure(() => expectTokens(javascript, src, { strict: true }))
  assert.match(message, /: 2 mismatches\n/)
  assert.ok(message.includes('line 1: "variable" "a" is not marked (strict)\n    let a = 1\n        ^ variable'), message)
  assert.ok(message.includes('line 1: "operator" "=" is not marked (strict)'), message)
  // Lines without markers are only tokenized (for the state).
  expectTokens(javascript, 'let a = 1\nlet b\n^^^ keyword\n    ^ variable', { strict: true })
})

test('expectTokens: lines without markers still carry the state', () => {
  expectTokens(mini, `
    a /* b
      ^^^^ comment
    not code
    */ c
    ^^ comment
       ^ variable
  `)
  assert.throws(() => expectTokens(mini, '/*\nx\n^ variable'), /line 2: expected "variable" on "x", found "comment" "x"/)
})

test('expectTokens: dedent of template literals', () => {
  // The common indentation goes, the code's own indentation stays.
  expectTokens(javascript, `
    if (a) {
    ^^ keyword
      return 1
      ^^^^^^ keyword
    }
  `)
  // Without a blank first line the text is read verbatim.
  expectTokens(javascript, '  let a\n  ^^^ keyword')
  // A snippet whose lines are all indented needs `dedent: false`…
  const frame = '\n    at foo (a.js:1:2)\n    ^^^^^^^^ comment\n'
  expectTokens(log, frame, { dedent: false })
  // …otherwise it is dedented (here: no longer a stack frame).
  assert.throws(() => expectTokens(log, frame), /found null "at foo \("/)
  // CRLF line breaks.
  expectTokens(javascript, '\r\n  let a\r\n  ^^^ keyword\r\n')
})

test('expectTokens: tabs', () => {
  const src = 'if (a)\n\treturn "x\ty"'
  const out = describeTokens(javascript, src)
  // Blanks before the carets mirror the tabs; carets span the visual width.
  assert.deepEqual(out.split('\n').slice(-2), ['\t^^^^^^ keyword', '\t       ^^^^^^^ string'])
  expectTokens(javascript, out, { strict: true })
  // Markers written with spaces under a tab (4 columns by default, or `tabSize`).
  expectTokens(javascript, 'if (a)\n\treturn 1\n    ^^^^^^ keyword\n           ^ number')
  expectTokens(javascript, 'if (a)\n\treturn 1\n  ^^^^^^ keyword', { tabSize: 2 })
  // Dedent with tabs.
  expectTokens(javascript, '\n\t\tlet a\n\t\t    ^ variable\n\t')
})

test('expectTokens: invalid markers and marker-like code', () => {
  assert.match(failure(() => expectTokens(javascript, 'let a\n    ^^^ variable')), /line 1: the carets go past the end of the line \("variable"\)/)
  // A line of carets alone is code (Python tracebacks draw them).
  expectTokens(log, '    foo()\n    ^^^^^\nValueError: x\n^^^^^^^^^^ type')
  // No markers: nothing to check.
  expectTokens(javascript, 'let a')
})

test('tokenizeLines', () => {
  assert.deepEqual(tokenizeLines(javascript, 'let a = 1\n\n/* x\ny */'), [
    [{ text: 'let', type: 'keyword' }, { text: 'a', type: 'variable' }, { text: '=', type: 'operator' }, { text: '1', type: 'number' }],
    [],
    [{ text: '/* x', type: 'comment' }],
    [{ text: 'y */', type: 'comment' }],
  ])
  // `all` keeps every token (the texts join back into the line).
  const all = tokenizeLines(sql, 'SELECT  id', { all: true })[0]!
  assert.deepEqual(all, [{ text: 'SELECT', type: 'keyword' }, { text: '  id', type: null }])
})
