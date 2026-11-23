import assert from 'node:assert/strict'
import { test } from 'node:test'
import { go } from '../src/languages/go.ts'
import { expectTokens } from '../src/testing.ts'
import { tokenize, typeOf } from './helpers.ts'

const t = (src: string, text: string) => typeOf(go, src, text)
/** `[text, type]` of the typed tokens of each line. */
const typed = (src: string) => tokenize(go, src).map((line) => line.filter(([, type]) => type !== null))

test('go: a small program', () => {
  expectTokens(go, `
package main
^^^^^^^ keyword

import "fmt"
^^^^^^ keyword
       ^^^^^ string

// Soma dois inteiros.
^^^^^^^^^^^^^^^^^^^^^^ comment
func Soma(a, b int) int {
^^^^ keyword
     ^^^^ function
          ^ variable
               ^^^ type.builtin
	return a + b
	^^^^^^ keyword
	         ^ operator
}
`)
})

test('go: keywords, constants and predeclared names', () => {
  for (const word of ['func', 'defer', 'go', 'chan', 'select', 'range', 'fallthrough', 'interface', 'struct', 'map']) assert.equal(t(`${word} x`, word), 'keyword', word)
  for (const word of ['true', 'false', 'nil', 'iota']) assert.equal(t(`x = ${word}`, word), 'constant.language', word)
  for (const word of ['int', 'string', 'error', 'float64', 'rune', 'any', 'uintptr']) assert.equal(t(`var x ${word}`, word), 'type.builtin', word)
  assert.equal(t('n := len(xs)', 'len'), 'function.builtin')
  assert.equal(t('xs = append(xs, 1)', 'append'), 'function.builtin')
  // A predeclared name used as a plain identifier isn't a call.
  assert.equal(t('len := 3', 'len'), 'variable')
})

test('go: declarations, calls and members', () => {
  assert.equal(t('type Point struct {', 'Point'), 'type')
  assert.equal(t('type Reader interface {', 'Reader'), 'type')
  assert.equal(t('func main() {', 'main'), 'function')
  assert.equal(t('func (p *Point) Norm() float64 {', 'Norm'), 'function')
  assert.equal(t('func (p *Point) Norm() float64 {', 'p'), 'variable')
  assert.equal(t('x := soma(1, 2)', 'soma'), 'function')
  assert.equal(t('fmt.Println("oi")', 'fmt'), 'variable')
  assert.equal(t('fmt.Println("oi")', 'Println'), 'function.method')
  assert.equal(t('n := p.name', 'name'), 'property')
  assert.equal(t('p := Point{X: 1, Y: 2}', 'Point'), 'type')
  assert.equal(t('p := Point{X: 1, Y: 2}', 'X'), 'property')
  assert.equal(t('ps := []Point{}', 'Point'), 'type')
  // Exported names in type position: after a name, a `*`, a `]` or `chan`.
  assert.equal(t('func Soma(p Point, q *Point) Point {', 'Point'), 'type')
  assert.deepEqual(typed('func Soma(p Point, q *Point) []Point')[0]!.filter(([text]) => text === 'Point').map(([, type]) => type), ['type', 'type', 'type'])
  assert.equal(t('var origin Point', 'Point'), 'type')
  assert.equal(t('m := map[string]Point{}', 'Point'), 'type')
  assert.equal(t('ch := make(chan Point)', 'Point'), 'type')
  assert.equal(t('type Path []Point', 'Point'), 'type')
  // …but not values: after a keyword, in a product, as an argument.
  assert.equal(t('return Max', 'Max'), 'variable')
  assert.equal(t('const Max = 10', 'Max'), 'variable')
  assert.equal(t('area := 2*Pi*r', 'Pi'), 'variable')
  assert.equal(t('x := a * B', 'B'), 'variable')
  assert.equal(t('f(a, Max)', 'Max'), 'variable')
  // `ok {` is a block, not a composite literal; `x := 1` and `case x:` aren't fields.
  assert.equal(t('if ok {', 'ok'), 'variable')
  assert.equal(t('x := 1', 'x'), 'variable')
  assert.equal(t('package main', 'main'), undefined)
  // Variadics: the name after `...` isn't a member.
  assert.equal(t('soma(xs...)', 'xs'), 'variable')
  assert.equal(t('func f(xs ...int) {', 'int'), 'type.builtin')
})

test('go: strings, raw strings and runes', () => {
  assert.deepEqual(typed('s := "a\\tb\\u00e9\\x41c"')[0]!.slice(2), [['"a', 'string'], ['\\t', 'string.escape'], ['b', 'string'], ['\\u00e9\\x41', 'string.escape'], ['c"', 'string']])
  // An interpreted string ends with its line.
  assert.equal(tokenize(go, 's := "open\nx := 1')[1]![0]![1], 'variable')
  // A raw string spans lines, with no escapes.
  const raw = tokenize(go, 'q := `SELECT *\n  FROM t \\n`\nx := 1')
  assert.deepEqual(raw[0]!.slice(-1), [['`SELECT *', 'string']])
  assert.deepEqual(raw[1], [['  FROM t \\n`', 'string']])
  assert.equal(raw[2]![0]![1], 'variable')
  assert.equal(t("r := 'a'", "'a'"), 'string')
  assert.equal(t("r := '\\n'", "'\\n'"), 'string')
  assert.equal(t("r := '\\u00e9'", "'\\u00e9'"), 'string')
  // Struct tags are raw strings.
  assert.equal(t('Name string `json:"name"`', '`json:"name"`'), 'string')
})

test('go: numbers', () => {
  for (const n of ['0', '42', '1_000_000', '0x1F', '0XfF_ff', '0o17', '0b1010', '3.14', '.5', '1e9', '1.5e-3', '0x1p-2', '2i', '1.5i']) {
    assert.deepEqual(typed(`x = ${n}`)[0]!.slice(-1), [[n, 'number']], n)
  }
})

test('go: comments and operators', () => {
  assert.equal(t('x := 1 // um', '// um'), 'comment')
  const block = tokenize(go, 'a /* um\ndois */ b')
  assert.deepEqual(block[0]!.slice(-1), [['/* um', 'comment']])
  assert.deepEqual(block[1], [['dois */', 'comment'], ['b', 'variable']])
  assert.equal(t('//go:build linux', '//go:build linux'), 'comment')
  for (const op of [':=', '<-', '&^', '&&', '||', '++', '!=', '<<=', '...']) assert.equal(t(`a ${op} b`, op), 'operator', op)
  assert.equal(t('ch <- v', '<-'), 'operator')
})

test('go: editing behaviour (tabs, indentation after brackets and case labels)', () => {
  assert.equal(go.indent.useTabs, true)
  assert.equal(go.indent.size, 4)
  for (const line of ['func main() {', 'x := []int{', 'fmt.Println(', '\tcase 1, 2:', '\tdefault:', 'if x { // comentário']) assert.ok(go.indent.increase!.test(line), line)
  for (const line of ['x := 1', 'return a + b', 'x := m["a:b"]', 'label := x']) assert.ok(!go.indent.increase!.test(line), line)
  assert.ok(go.indent.decrease!.test('\t}'))
  assert.deepEqual(go.comments, { line: '//', block: ['/*', '*/'] })
  assert.ok(go.completions.includes('func') && go.completions.includes('append') && go.completions.includes('error'))
})
