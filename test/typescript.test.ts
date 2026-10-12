import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tsx, typescript } from '../src/languages/typescript.ts'
import { tokenize, typeOf } from './helpers.ts'

const t = (src: string, text: string) => typeOf(typescript, src, text)
/** Types of every token whose text equals `text`. */
const all = (src: string, text: string, lang = typescript) =>
  tokenize(lang, src).flat().filter(([x]) => x === text).map(([, type]) => type)

test('metadata', () => {
  assert.equal(typescript.name, 'typescript')
  assert.deepEqual(typescript.aliases, ['ts', 'mts', 'cts'])
  assert.deepEqual(typescript.extensions, ['.ts', '.mts', '.cts'])
  assert.equal(tsx.name, 'tsx')
  assert.deepEqual(tsx.extensions, ['.tsx'])
})

test('javascript still works', () => {
  assert.equal(t('const x = 1', 'const'), 'keyword')
  assert.equal(t('const r = /ab+c/gi', '/ab+c/gi'), 'regexp')
  assert.equal(t('obj.method()', 'method'), 'function.method')
  assert.equal(t('const s = `a ${b}`', 'b'), 'variable')
  assert.equal(t('@Component({})', '@Component'), 'meta')
})

test('interfaces and annotations', () => {
  const lines = tokenize(typescript, [
    'interface Props<T> extends Base {',
    '  readonly title: string',
    '  count?: number',
    '  items: Array<T>',
    '  onClick(e: MouseEvent): void',
    '}',
  ].join('\n'))
  assert.deepEqual(lines[0], [
    ['interface', 'keyword'], ['Props', 'type'], ['<', 'operator'], ['T', 'type'], ['>', 'operator'],
    ['extends', 'keyword'], ['Base', 'type'], ['{', 'punctuation.bracket'],
  ])
  assert.deepEqual(lines[1], [['readonly', 'keyword'], ['title', 'property'], [':', 'operator'], ['string', 'type.builtin']])
  assert.deepEqual(lines[2], [['count', 'property'], ['?:', 'operator'], ['number', 'type.builtin']])
  assert.deepEqual(lines[3]!.slice(0, 3), [['items', 'property'], [':', 'operator'], ['Array', 'type']])
  assert.deepEqual(lines[4], [
    ['onClick', 'function'], ['(', 'punctuation.bracket'], ['e', 'variable.parameter'], [':', 'operator'],
    ['MouseEvent', 'type'], [')', 'punctuation.bracket'], [':', 'operator'], ['void', 'type.builtin'],
  ])
  assert.equal(t('let x: number = 1', 'number'), 'type.builtin')
  assert.equal(t('let x: number = 1', 'x'), 'variable')
})

test('type aliases, unions and builtin types', () => {
  const line = tokenize(typescript, "export type Status = 'idle' | { error: string } | null")[0]!
  assert.deepEqual(line.slice(0, 4), [['export', 'keyword'], ['type', 'keyword'], ['Status', 'type'], ['=', 'operator']])
  assert.deepEqual(line.find(([x]) => x === 'string'), ['string', 'type.builtin'])
  assert.deepEqual(line.at(-1), ['null', 'type.builtin'])
  assert.equal(t('type A = string', 'string'), 'type.builtin')
  assert.equal(t('type Fn<T = unknown> = () => void', 'unknown'), 'type.builtin')
  assert.equal(t('type Fn<T = unknown> = () => void', 'void'), 'type.builtin')
  assert.equal(t('let u: string | undefined', 'undefined'), 'type.builtin')
  assert.equal(t('type K = keyof typeof obj', 'keyof'), 'keyword')
  assert.equal(t('type R<T> = T extends Array<infer U> ? U : never', 'infer'), 'keyword')
  assert.equal(t('type R<T> = T extends Array<infer U> ? U : never', 'never'), 'type.builtin')
  assert.equal(t('let s: unique symbol', 'unique'), 'keyword')
  assert.equal(t('let s: unique symbol', 'symbol'), 'type.builtin')
  // Values keep their JavaScript meaning.
  assert.equal(t('const n = a ? b : null', 'null'), 'constant.language')
  assert.equal(t('x = y || undefined', 'undefined'), 'constant.language')
  assert.equal(t('void 0', 'void'), 'keyword')
  assert.equal(t('const number = 1', 'number'), 'variable')
  assert.equal(t('return number * 2', 'number'), 'variable')
  // `type` is only a keyword before a name.
  assert.equal(t('const type = node.type', 'type'), 'variable')
  assert.deepEqual(all('if (type === "a") f({ type: 1 })', 'type'), ['variable', 'property'])
  assert.deepEqual(all('import { type A, b } from "x"', 'type'), ['keyword'])
})

test('generics', () => {
  assert.deepEqual(tokenize(typescript, 'const m = new Map<string, Set<number>>()')[0]!.slice(3), [
    ['new', 'keyword'], ['Map', 'type'], ['<', 'operator'], ['string', 'type.builtin'], [',', 'punctuation'],
    ['Set', 'type'], ['<', 'operator'], ['number', 'type.builtin'], ['>>', 'operator'], ['()', 'punctuation.bracket'],
  ])
  assert.equal(t('const [v, setV] = useState<string | null>(null)', 'useState'), 'function')
  assert.deepEqual(all('const [v, setV] = useState<string | null>(null)', 'null'), ['type.builtin', 'constant.language'])
  assert.equal(t('function id<T>(x: T): T { return x }', 'id'), 'function')
  assert.equal(t('class Store<S extends object> {}', 'object'), 'type.builtin')
  // Comparisons are not type arguments.
  assert.equal(t('if (a < b && c > (d)) {}', 'a'), 'variable')
})

test('functions: parameters and return types', () => {
  const line = tokenize(typescript, 'const add = (a: number, b?: number): number => a + b')[0]!
  assert.deepEqual(line.slice(0, 12), [
    ['const', 'keyword'], ['add', 'function'], ['=', 'operator'], ['(', 'punctuation.bracket'],
    ['a', 'variable.parameter'], [':', 'operator'], ['number', 'type.builtin'], [',', 'punctuation'],
    ['b', 'variable.parameter'], ['?:', 'operator'], ['number', 'type.builtin'], [')', 'punctuation.bracket'],
  ])
  assert.deepEqual(line.slice(12, 15), [[':', 'operator'], ['number', 'type.builtin'], ['=>', 'keyword']])
  assert.equal(t('const id = <T,>(x: T): T => x', 'id'), 'function')
  assert.equal(t('function isFoo(x: unknown): x is Foo {}', 'is'), 'keyword')
  assert.equal(t('function check(v: unknown): asserts v {}', 'asserts'), 'keyword')
  // Object literals keep properties.
  assert.deepEqual(all('f({ a: 1, b: 2 })', 'b'), ['property'])
})

test('enums, classes and access modifiers', () => {
  assert.deepEqual(tokenize(typescript, "enum Color { Red, Green = 'g' }")[0]!.slice(0, 2), [['enum', 'keyword'], ['Color', 'type']])
  assert.deepEqual(tokenize(typescript, 'const enum Dir { UP }')[0]!.slice(0, 3), [['const', 'keyword'], ['enum', 'keyword'], ['Dir', 'type']])
  const lines = tokenize(typescript, [
    'abstract class Store<S> implements Readable<S> {',
    '  private readonly state: S',
    '  public name!: string',
    '  constructor(protected api: Api) { super() }',
    '  abstract reset(): void',
    '  override accessor id = 1',
    '}',
  ].join('\n'))
  assert.deepEqual(lines[0]!.slice(0, 3), [['abstract', 'keyword'], ['class', 'keyword'], ['Store', 'type']])
  assert.deepEqual(lines[0]!.find(([x]) => x === 'implements'), ['implements', 'keyword'])
  assert.deepEqual(lines[1]!.slice(0, 3), [['private', 'keyword'], ['readonly', 'keyword'], ['state', 'property']])
  assert.deepEqual(lines[2], [['public', 'keyword'], ['name', 'property'], ['!:', 'operator'], ['string', 'type.builtin']])
  assert.deepEqual(lines[3]!.slice(2, 4), [['protected', 'keyword'], ['api', 'property']])
  assert.deepEqual(lines[4]!.slice(0, 2), [['abstract', 'keyword'], ['reset', 'function']])
  assert.deepEqual(lines[5]!.slice(0, 2), [['override', 'keyword'], ['accessor', 'keyword']])
})

test('declarations, as / satisfies and non-null', () => {
  assert.deepEqual(all("declare module 'x' {}", 'declare').concat(all("declare module 'x' {}", 'module')), ['keyword', 'keyword'])
  assert.equal(t('declare global { }', 'global'), 'keyword')
  assert.equal(t('namespace NS { }', 'namespace'), 'keyword')
  assert.equal(t('module.exports = x', 'module'), 'type.builtin')
  assert.equal(t('const x = y as unknown as Foo', 'as'), 'keyword')
  assert.equal(t('const x = y as unknown as Foo', 'unknown'), 'type.builtin')
  assert.equal(t("const x = ['a'] as const", 'as'), 'keyword')
  assert.equal(t('const c = { a: 1 } satisfies Config', 'satisfies'), 'keyword')
  const line = tokenize(typescript, 'el!.value')[0]!
  assert.deepEqual(line, [['el', 'variable'], ['!', 'operator'], ['.', 'punctuation'], ['value', 'property']])
})

test('typescript has no jsx; tsx does', () => {
  assert.ok(tokenize(typescript, 'return <div>a</div>')[0]!.every(([, type]) => type !== 'tag'))
  const lines = tokenize(tsx, [
    'export function Modal({ title }: Props): JSX.Element {',
    '  const [n, setN] = useState<number>(0)',
    '  return (',
    '    <Dialog<Item> open={n > 0} onClose={() => setN(0)}>',
    '      <h1 className="title">{title as string}</h1>',
    '    </Dialog>',
    '  )',
    '}',
    'const x: number = 1',
  ].join('\n'))
  assert.deepEqual(lines[1]!.find(([x]) => x === 'number'), ['number', 'type.builtin'])
  assert.deepEqual(lines[3]!.slice(0, 5), [['<', 'punctuation'], ['Dialog', 'type'], ['<', 'operator'], ['Item', 'type'], ['>', 'operator']])
  assert.deepEqual(lines[3]!.find(([x]) => x === 'open'), ['open', 'attribute'])
  assert.deepEqual(lines[4]!.slice(0, 5), [['<', 'punctuation'], ['h1', 'tag'], ['className', 'attribute'], ['=', 'operator'], ['"title"', 'string']])
  assert.deepEqual(lines[4]!.find(([x]) => x === 'string'), ['string', 'type.builtin'])
  assert.deepEqual(lines[5], [['</', 'punctuation'], ['Dialog', 'type'], ['>', 'punctuation']])
  assert.deepEqual(lines[8], [['const', 'keyword'], ['x', 'variable'], [':', 'operator'], ['number', 'type.builtin'], ['=', 'operator'], ['1', 'number']])
})

test('tsx: generic arrows and function types are not elements', () => {
  for (const src of ['const id = <T,>(x: T) => x', 'const f = <T extends object>(o: T) => o', 'type F = <T>(x: T) => T']) {
    const lines = tokenize(tsx, src + '\nlet a')
    assert.ok(lines[0]!.every(([, type]) => type !== 'tag' && type !== 'attribute'), src)
    assert.deepEqual(lines[1], [['let', 'keyword'], ['a', 'variable']], src)
  }
  assert.equal(typeOf(tsx, 'const el = <T>text</T>', 'T'), 'type')
  assert.equal(typeOf(tsx, 'const el = <div>text</div>', 'div'), 'tag')
})

test('tokenizes a large file quickly (identifier classification included)', () => {
  const src = Array.from({ length: 20_000 }, (_, i) =>
    `export const v${i}: Map<string, number[]> = useMemo<Props>((a: number, b?: string): void => call(a as any), [])`,
  ).join('\n')
  const start = performance.now()
  let state = typescript.initialState
  for (const line of src.split('\n')) state = typescript.tokenize(line, state).state
  const ms = performance.now() - start
  assert.ok(ms < 3000, `took ${ms}ms`)
})
