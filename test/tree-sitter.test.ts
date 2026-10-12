import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as TreeSitter from 'web-tree-sitter'
import type { Editor, Extension } from '../src/editor.ts'
import { css } from '../src/languages/css.ts'
import { html } from '../src/languages/html.ts'
import { javascript } from '../src/languages/javascript.ts'
import { json } from '../src/languages/json.ts'
import { log } from '../src/languages/log.ts'
import { markdown } from '../src/languages/markdown.ts'
import { shell } from '../src/languages/shell.ts'
import { typescript } from '../src/languages/typescript.ts'
import {
  createSyntaxChecker, fixAllSyntax, GRAMMARS, getSyntaxProblems, grammarsFrom, nodeAt, selectSyntaxChild, selectSyntaxParent,
  syntaxTree, treeSitter, whenParsed, type TreeSitterModule, type TreeSitterOptions, type TSNode,
} from '../src/tree-sitter/index.ts'
import { LineOffsets } from '../src/state/offsets.ts'
import { cmpPos, TextDocument, type Pos } from '../src/state/text.ts'
import { fakeEditor } from './fake-editor.ts'

const modules = new URL('../node_modules/', import.meta.url)
const grammars = Object.fromEntries(Object.entries(GRAMMARS).map(([name, g]) => [name, new URL(`${g.package}/${g.file}`, modules).pathname]))
const mod = TreeSitter as unknown as TreeSitterModule
const options = (extra: Partial<TreeSitterOptions> = {}): TreeSitterOptions => ({ load: mod, grammars, diagnostics: false, delay: 5, ...extra })

function use(ext: Extension, ed: Editor): () => void {
  const list = (Array.isArray(ext) ? ext : [ext]).flat(3).filter(Boolean) as ((e: Editor) => void | (() => void))[]
  const off = list.map((fn) => fn(ed))
  return () => off.forEach((f) => f?.())
}

const messages = async (ed: Editor) => (await getSyntaxProblems(ed)).map((p) => `${p.from.line}:${p.from.col} ${p.message}`)

test('grammarsFrom maps every built-in language to its wasm file', () => {
  const g = grammarsFrom('https://example.com/wasm/')
  assert.equal(g.javascript, 'https://example.com/wasm/tree-sitter-javascript.wasm')
  assert.equal(g.tsx, 'https://example.com/wasm/tree-sitter-tsx.wasm')
  assert.equal(g.shell, 'https://example.com/wasm/tree-sitter-bash.wasm')
})

test('JavaScript: syntax errors with quick fixes; fixing them all leaves valid code', async () => {
  const ed = fakeEditor('if (x { y() }\nconst s = "abc\nfoo(a, b', { language: javascript })
  const off = use(treeSitter(options()), ed)
  // An unterminated string hides what comes after it (tree-sitter recovers there): it shows up once fixed.
  assert.deepEqual(await messages(ed), ['0:5 Missing `)`', '1:10 Unterminated string'])
  assert.equal(fixAllSyntax(ed), true)
  assert.deepEqual(await messages(ed), ['2:3 Unclosed `(`'])
  assert.equal(fixAllSyntax(ed), true)
  assert.equal(ed.getValue(), 'if (x) { y() }\nconst s = "abc"\nfoo(a, b)')
  assert.deepEqual(await messages(ed), [])
  ed.undo()
  assert.deepEqual(await messages(ed), ['2:3 Unclosed `(`'], 'each fix-all is one undo step')
  off()
})

test('LineOffsets follows every change, in any order, like the text it stands for', () => {
  const doc = new TextDocument('abc\né😀\n\nlast line')
  const offsets = new LineOffsets(doc.lines)
  let seed = 3
  const rnd = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n)
  const trueOffset = (p: Pos) => doc.lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.col
  const randomPos = (): Pos => {
    const line = rnd(doc.lineCount)
    return { line, col: rnd(doc.line(line).length + 1) }
  }
  for (let i = 0; i < 400; i++) {
    let from = randomPos()
    let to = rnd(2) ? randomPos() : from
    if (cmpPos(from, to) > 0) [from, to] = [to, from]
    const before = trueOffset(from)
    const insert = ['x', '\n', 'ab\ncd', '', 'é😀', '\n\n'][rnd(6)]!
    const change = doc.replace(from, to, insert)
    const edit = offsets.apply(change)
    assert.equal(edit.startIndex, before)
    assert.equal(edit.newEndIndex - edit.startIndex, insert.length)
    const probe = randomPos()
    assert.equal(offsets.offset(probe), trueOffset(probe), `step ${i}`)
  }
})

/** The leaves of a tree: type and offsets of every token. */
function tokens(node: TSNode, out: string[] = []): string[] {
  if (!node.childCount) out.push(`${node.type}@${node.startIndex}-${node.endIndex}`)
  for (const c of node.children) if (c) tokens(c, out)
  return out
}

test('the tree follows edits incrementally: same tokens as a fresh parse', async () => {
  const src = Array.from({ length: 60 }, (_, i) => `function f${i}(a, b) {\n  const x = a + b * ${i} // é😀\n  if (x > ${i}) { return [x, "s${i}"] }\n}`).join('\n')
  const ed = fakeEditor(src, { language: javascript })
  const off = use(treeSitter(options({ delay: 1 })), ed)
  await whenParsed(ed)
  const parser = new mod.Parser()
  const { Language } = mod
  parser.setLanguage(await Language.load(grammars.javascript!))
  let seed = 7
  const rnd = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n)
  // Edits that keep the code valid (with errors, tree-sitter may recover differently when parsing incrementally).
  const edits: ((line: number) => void)[] = [
    (line) => { // grow a name
      const m = /\b(f\d+|x)\b/.exec(ed.doc.line(line))
      if (m) ed.dispatch({ changes: { from: { line, col: m.index + 1 }, insert: 'z' } })
    },
    (line) => { // text inside a comment, with non-BMP chars
      const at = ed.doc.line(line).indexOf('// ')
      if (at >= 0) ed.dispatch({ changes: { from: { line, col: at + 3 }, insert: ['é', '😀', 'ok '][rnd(3)] } })
    },
    (line) => { // a new statement after a declaration
      if (/^  const /.test(ed.doc.line(line))) ed.dispatch({ changes: { from: { line, col: ed.doc.line(line).length }, insert: '\n  let y = [1, "😀"]' } })
    },
    (line) => { // remove such a statement
      if (/^  let y = /.test(ed.doc.line(line))) ed.dispatch({ changes: { from: { line: line - 1, col: ed.doc.line(line - 1).length }, to: { line, col: ed.doc.line(line).length } } })
    },
    () => { // several changes in one transaction, last first (like applyEdits / diffToChanges)
      const lines = [rnd(ed.doc.lineCount), rnd(ed.doc.lineCount)].sort((a, b) => b - a)
      ed.dispatch({ changes: lines.map((line) => ({ from: { line, col: ed.doc.line(line).length }, insert: ' // n' })) })
    },
  ]
  for (let round = 0; round < 15; round++) {
    for (let k = 0; k < 10; k++) edits[rnd(edits.length)]!(rnd(ed.doc.lineCount))
    const tree = await whenParsed(ed)
    const fresh = parser.parse(ed.doc.lines.join('\n'))!
    assert.equal(fresh.rootNode.hasError, false)
    assert.equal(tree!.rootNode.hasError, false)
    // Every token at the same place (where tree-sitter hangs extras like comments may differ between the two).
    assert.deepEqual(tokens(tree!.rootNode), tokens(fresh.rootNode), `round ${round}`)
    fresh.delete()
  }
  parser.delete()
  off()
})

test('JSON, CSS, TypeScript and shell have their own fixes', async () => {
  const cases: [Editor, string, string][] = [
    [fakeEditor('{"a": 1, "b": 2,}', { language: json }), '0:15 Unexpected `,`', '{"a": 1, "b": 2}'],
    [fakeEditor('{"a": 1 "b": 2}', { language: json }), '0:1 Missing `,`', '{"a": 1, "b": 2}'],
    // Across lines the parser closes the object early; the real slip is the comma (the rest is its recovery).
    [fakeEditor('{\n  "nome": "jonacode",\n  "versao": "0.1.0"\n  "privado": true\n}', { language: json }), '2:19 Missing `,`', '{\n  "nome": "jonacode",\n  "versao": "0.1.0",\n  "privado": true\n}'],
    [fakeEditor('a {\n  color: red;\n\nb { color: blue }', { language: css }), '3:17 Missing `}`', 'a {\n  color: red;\n}\n\nb { color: blue }'],
    [fakeEditor('function f(a: string { }', { language: typescript }), '0:20 Missing `)`', 'function f(a: string) { }'],
    [fakeEditor('if [ -f x ]; then\n  echo hi', { language: shell }), '0:0 Unclosed `if`', 'if [ -f x ]; then\n  echo hi\nfi'],
  ]
  for (const [ed, message, fixed] of cases) {
    const off = use(treeSitter(options()), ed)
    assert.deepEqual(await messages(ed), [message])
    fixAllSyntax(ed)
    assert.equal(ed.getValue(), fixed)
    assert.deepEqual(await messages(ed), [])
    off()
  }
})

test('HTML checks the code in <script> and <style>; Markdown checks fenced blocks', async () => {
  const page = fakeEditor('<p>ok</p>\n<script>\nlet x = (1 + 2\n</script>\n<script type="application/json">{"a": 1,}</script>\n<style>a { color: red</style>\n<script type="text/template">{{ not code</script>', { language: html })
  const off1 = use(treeSitter(options()), page)
  await getSyntaxProblems(page)
  // Embedded grammars load on first use: check again once they're there.
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(await messages(page), ['2:8 Unclosed `(`', '4:39 Unexpected `,`', '5:9 Unclosed `{`'])
  off1()

  const doc = fakeEditor('# Título\n\n```js\nfoo(1, 2\n```\n\n```json\n[1, 2\n```\n\n```python\nnot checked(\n```', { language: markdown })
  const off2 = use(treeSitter(options()), doc)
  await getSyntaxProblems(doc)
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(await messages(doc), ['3:3 Unclosed `(`', '7:5 Missing `]`'])
  off2()
})

test('languages without a grammar are simply not checked', async () => {
  const ed = fakeEditor('2024-01-01 ERROR (unbalanced', { language: log })
  const off = use(treeSitter(options()), ed)
  assert.equal(await whenParsed(ed), null)
  assert.deepEqual(await messages(ed), [])
  off()
})

test('setValue starts over; the tree is available for extensions', async () => {
  const ed = fakeEditor('let a = 1', { language: javascript })
  const off = use(treeSitter(options()), ed)
  await whenParsed(ed)
  assert.equal(syntaxTree(ed)!.rootNode.type, 'program')
  ed.setValue('const b = [1, 2')
  assert.deepEqual(await messages(ed), ['0:10 Unclosed `[`'])
  ed.setValue('const total = [1, 2]')
  assert.deepEqual(await messages(ed), [])
  assert.equal(nodeAt(ed, { line: 0, col: 8 })!.type, 'identifier')
  assert.equal(nodeAt(ed, { line: 0, col: 18 })!.type, 'number')
  off()
})

test('expand / shrink selection by syntax node', async () => {
  const ed = fakeEditor('const total = soma(a, b * 2)', { language: javascript })
  const off = use(treeSitter(options()), ed)
  await whenParsed(ed)
  ed.setSelection({ line: 0, col: 22 })
  const sel = () => ed.doc.slice(ed.selection.anchor, ed.selection.head)
  selectSyntaxParent(ed)
  assert.equal(sel(), 'b')
  selectSyntaxParent(ed)
  assert.equal(sel(), 'b * 2')
  selectSyntaxParent(ed)
  assert.equal(sel(), '(a, b * 2)')
  selectSyntaxChild(ed)
  assert.equal(sel(), 'b * 2')
  off()
})

test('createSyntaxChecker validates text outside an editor (e.g. an AI answer before applying it)', async () => {
  const checker = createSyntaxChecker({ load: () => mod, grammars })
  assert.deepEqual((await checker.check('const x = [1, 2', 'javascript')).map((p) => p.message), ['Unclosed `[`'])
  assert.deepEqual(await checker.check('<script>let ok = 1</script>', 'html'), [])
  assert.deepEqual(await checker.check('anything', 'log'), [])
})

test('a big document parses in slices and the result stays correct', async () => {
  const unit = 'function f(a, b) {\n  const x = a + b * 2\n  if (x > 10) { return x } else { return -x }\n}\n'
  const ed = fakeEditor(unit.repeat(5000) + 'oops(', { language: javascript })
  let ms = 0
  const off = use(treeSitter(options({ onParse: (r) => (ms = r.ms) })), ed)
  assert.deepEqual(await messages(ed), ['20000:4 Unclosed `(`'])
  assert.ok(ms > 0)
  off()
})
