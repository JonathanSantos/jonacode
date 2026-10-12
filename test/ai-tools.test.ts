import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getAIMarks } from '../src/ai/marks.ts'
import { editorTools, exposeTools, textEditorTool, type EditorToolsOptions } from '../src/ai/tools.ts'
import type { Editor } from '../src/editor.ts'
import { setDiagnostics } from '../src/extensions/diagnostics.ts'
import { css } from '../src/languages/css.ts'
import { html } from '../src/languages/html.ts'
import { javascript } from '../src/languages/javascript.ts'
import { fakeEditor } from './fake-editor.ts'

const p = (line: number, col: number) => ({ line, col })

/** Just enough of a DOM for `injectStyle` and decorations. */
function withDom<T extends Editor>(ed: T): T {
  const style = { setAttribute() {}, textContent: '' }
  const doc = { createElement: () => style, head: { appendChild() {} } }
  ;(ed as { dom: unknown }).dom = { getRootNode: () => doc, ownerDocument: doc }
  return ed
}

const JS = `import { sum } from './sum.js'

export function add(a, b) {
  return a + b
}

export function mul(a, b) {
  return a * b
}
`

function js(text = JS, options: EditorToolsOptions = {}) {
  const ed = fakeEditor(text, { language: javascript })
  return { ed, tools: editorTools(ed, { settle: 0, ...options }) }
}

function playground() {
  const eds = {
    './index.html': fakeEditor('<!doctype html>\n<script src="app.js"></script>\n<div class="box"></div>', { language: html }),
    '/style.css': fakeEditor('.box {\n  color: red;\n}', { language: css }),
    'app.js': fakeEditor('const box = document.querySelector(".box")\nbox.textContent = "hi"', { language: javascript }),
  }
  return { eds, tools: editorTools(eds, { settle: 0 }) }
}

const names = (list: object[]) => list.map((t) => (t as { name: string }).name)

// --- definitions ---------------------------------------------------------------

test('tools: definitions are valid JSON Schema objects', () => {
  const { tools } = js()
  assert.deepEqual(names(tools.definitions), [
    'read_file', 'search_file', 'edit_file', 'insert_lines', 'write_file', 'get_selection', 'get_problems', 'undo_last_edit',
  ])
  for (const d of tools.definitions) {
    assert.ok(d.description.length > 20)
    assert.equal(d.inputSchema.type, 'object')
    assert.equal(typeof d.inputSchema.properties, 'object')
    assert.ok(Array.isArray(d.inputSchema.required))
    for (const r of d.inputSchema.required!) assert.ok(r in d.inputSchema.properties, `${d.name}.${r}`)
    assert.doesNotMatch(JSON.stringify(d.inputSchema), /"required":\["path"/, 'path is optional with one file')
  }
  assert.match(tools.definitions[0]!.description, /1-based/)
  assert.deepEqual(names(editorTools(fakeEditor(''), { readOnly: true }).definitions), ['read_file', 'search_file', 'get_selection', 'get_problems'])
})

test('tools: several files → path is an enum, required except for search and problems', () => {
  const { tools } = playground()
  for (const d of tools.definitions) {
    assert.deepEqual((d.inputSchema.properties.path as { enum: string[] }).enum, ['index.html', 'style.css', 'app.js'])
    assert.equal(d.inputSchema.required!.includes('path'), d.name !== 'search_file' && d.name !== 'get_problems', d.name)
  }
})

test('tools: anthropic() and openai() shapes', () => {
  const { tools } = js()
  const a = tools.anthropic() as { name: string; description: string; input_schema: { type: string } }[]
  assert.equal(a.length, 8)
  for (const t of a) {
    assert.deepEqual(Object.keys(t), ['name', 'description', 'input_schema'])
    assert.equal(t.input_schema.type, 'object')
  }
  const te = tools.anthropic({ textEditor: true })
  assert.deepEqual(te[0], { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' })
  assert.deepEqual(names(te.slice(1)), ['search_file', 'get_selection', 'get_problems', 'undo_last_edit'])
  const o = tools.openai() as { type: string; function: { name: string; description: string; parameters: { type: string } } }[]
  assert.equal(o.length, 8)
  for (const t of o) {
    assert.equal(t.type, 'function')
    assert.deepEqual(Object.keys(t.function), ['name', 'description', 'parameters'])
    assert.equal(t.function.parameters.type, 'object')
  }
  JSON.stringify(a) && JSON.stringify(o)   // serializable
})

test('tools: run() never throws; accepts JSON strings; unknown tools and paths explain themselves', async () => {
  const { tools } = js()
  const bad = await tools.run('delete_everything', {})
  assert.equal(bad.isError, true)
  assert.match(bad.content, /Unknown tool "delete_everything"\. Tools: read_file, /)
  assert.equal((await tools.run('toString', {})).isError, true)
  assert.match((await tools.run('read_file', '{"start_line": 3, "end_line": 3}')).content, /\n     3\texport function add/)
  assert.equal((await tools.run('read_file', '{oops')).isError, true)
  const unknown = await tools.run('read_file', { path: 'other.js' })
  assert.equal(unknown.isError, true)
  assert.match(unknown.content, /Unknown file "other\.js"\. Files: main\.js\./)
  assert.equal((await tools.run('read_file', { path: '/main.js' })).isError, undefined)
  assert.equal((await tools.run('read_file', { path: './main.js' })).isError, undefined)
  assert.equal((await tools.run('read_file', { path: '/home/user/project/main.js' })).isError, undefined)
  assert.match((await editorTools(fakeEditor('x'), { path: 'notes.md' }).run('read_file', {})).content, /^notes\.md \(text, 1 lines\)/)
  assert.equal((await editorTools(fakeEditor('')).run('read_file', {})).content, 'file.txt (text, 0 lines)\n')
  assert.throws(() => editorTools({}), /no editor/)
})

// --- reading -------------------------------------------------------------------

test('read_file: numbered lines with a header; ranges; -1; errors', async () => {
  const { tools } = js()
  const all = await tools.run('read_file', {})
  assert.equal(all.content.split('\n')[0], 'main.js (javascript, 9 lines)')
  assert.match(all.content, /\n     1\timport \{ sum \} from '\.\/sum\.js'\n     2\t\n     3\texport function add\(a, b\) \{\n/)
  assert.doesNotMatch(all.content, /Continue from/)
  const range = await tools.run('read_file', { start_line: 7, end_line: 8 })
  assert.equal(range.content, 'main.js (javascript, 9 lines)\n     7\texport function mul(a, b) {\n     8\t  return a * b\n')
  assert.match((await tools.run('read_file', { start_line: 8, end_line: -1 })).content, /\n     8\t  return a \* b\n     9\t}\n$/)
  assert.match((await tools.run('read_file', { start_line: 99 })).content, /start_line 99 is past the end of main\.js \(9 lines\)/)
  assert.equal((await tools.run('read_file', { start_line: 5, end_line: 2 })).isError, true)
  assert.equal((await tools.run('read_file', { start_line: 'two' })).isError, true)
})

test('read_file: long lines are cut; maxLines / maxChars caps say how to go on', async () => {
  const ed = fakeEditor(Array.from({ length: 30 }, (_, i) => (i === 3 ? 'x'.repeat(5000) : `line ${i + 1}`)).join('\n'))
  const tools = editorTools(ed, { maxLines: 10 })
  const first = await tools.run('read_file', { start_line: 1 })
  assert.match(first.content, /\n     4\tx{2000} … \[3000 more chars\]\n/)
  assert.match(first.content, /\n    10\tline 10\n\[Lines 1-10 of 30 shown\. Continue from line 11\.\]\n$/)
  const narrow = editorTools(ed, { maxChars: 100 })
  assert.match((await narrow.run('read_file', { start_line: 5 })).content, /Continue from line \d+\.\]\n$/)
})

test('read_file: a 100k-line file without a range → its start and an outline, fast and bounded', async () => {
  const parts: string[] = []
  for (let i = 0; i < 10_000; i++) {
    parts.push(`export function fn${i}(a) {`, '  // body', '  const x = a * 2', '  if (x > 10) {', '    return x', '  }', '  return a', '}', '', '')
  }
  const ed = fakeEditor(parts.join('\n'), { language: javascript })
  assert.equal(ed.doc.lineCount, 100_000)   // 99 999 for the model: the last one is after the final newline
  const tools = editorTools(ed)
  const t = performance.now()
  const out = (await tools.run('read_file', {})).content
  const ms = performance.now() - t
  assert.ok(ms < 300, `took ${ms} ms`)
  assert.ok(out.length <= 20_000, `${out.length} chars`)
  assert.match(out, /^main\.js \(javascript, 99999 lines\)\n     1\texport function fn0\(a\) \{\n/)
  assert.match(out, /\n   200\t.*\n\[Lines 1-200 of 99999 shown\. Continue from line 201, or use search_file\.\]\n/)
  assert.match(out, /Outline \(10000 definitions, every 67th shown\):\n     1\texport function fn0\(a\) \{\n   671\texport function fn67\(a\) \{\n/)
  assert.doesNotMatch(out.slice(out.indexOf('Outline')), /return/, 'only definitions in the outline')
  // A range reads any part.
  assert.match((await tools.run('read_file', { start_line: 99_991, end_line: 99_992 })).content, / 99991\texport function fn9999\(a\) \{\n 99992\t  \/\/ body\n$/)
})

test('search_file: text, case, regex, caps and errors', async () => {
  const { tools } = js()
  assert.equal((await tools.run('search_file', { query: 'return' })).content, '2 matches in 2 lines:\n4:   return a + b\n8:   return a * b\n')
  assert.match((await tools.run('search_file', { query: 'EXPORT' })).content, /^2 matches/)
  assert.match((await tools.run('search_file', { query: 'EXPORT', case_sensitive: true })).content, /^No matches for "EXPORT"\./)
  assert.match((await tools.run('search_file', { query: 'a [*+] b', regex: true })).content, /^2 matches in 2 lines:\n4: .*\n8: /)
  assert.match((await tools.run('search_file', { query: 'a.b' })).content, /^No matches/, 'plain text by default')
  const bad = await tools.run('search_file', { query: '(', regex: true })
  assert.equal(bad.isError, true)
  assert.match(bad.content, /^Invalid regular expression/)
  assert.equal((await tools.run('search_file', { query: '' })).isError, true)
  const many = editorTools(fakeEditor(Array.from({ length: 200 }, () => 'x x').join('\n')))
  const r = (await many.run('search_file', { query: 'x' })).content
  assert.match(r, /^400 matches in 200 lines \(first 50 shown\):\n1: x x\n/)
  assert.equal(r.trim().split('\n').length, 51)
  const long = editorTools(fakeEditor('a'.repeat(1000) + 'NEEDLE' + 'b'.repeat(1000)))
  assert.match((await long.run('search_file', { query: 'needle' })).content, /^1 match in 1 line:\n1: …a{80}NEEDLEb{154}…\n$/)
})

test('get_selection: cursors and selected text, 1-based', async () => {
  const { ed, tools } = js()
  ed.setSelection(p(2, 7))
  assert.equal((await tools.run('get_selection', {})).content, 'main.js:\nCursor at line 3, col 8, nothing selected.')
  ed.setSelection(p(3, 9), p(2, 16))
  assert.equal((await tools.run('get_selection', {})).content, 'main.js:\nSelection from line 3, col 17 to line 4, col 10:\nadd(a, b) {\n  return ')
  ed.dispatch({ selection: { ranges: [{ anchor: p(0, 0), head: p(0, 0) }, { anchor: p(1, 0), head: p(1, 0) }], main: 0 } })
  assert.match((await tools.run('get_selection', {})).content, /line 1, col 1 \(main\)/)
})

test('get_problems: current diagnostics (1-based) or none', async () => {
  const { ed, tools } = js()
  assert.equal((await tools.run('get_problems', {})).content, 'No problems.')
  withDom(ed)
  setDiagnostics(ed, [{ from: p(3, 9), to: p(3, 10), severity: 'error', message: 'a is not defined', source: 'lint' }])
  assert.equal((await tools.run('get_problems', {})).content, '1 problem (line:col):\n- 4:10 error: a is not defined [lint]')
})

// --- editing -------------------------------------------------------------------

test('edit_file: exact replacements → summary, numbered snippet, problems', async () => {
  const { ed, tools } = js()
  const r = await tools.run('edit_file', { edits: [{ old: '  return a + b', new: '  return sum(a, b)' }] })
  assert.equal(r.isError, undefined, r.content)
  assert.match(ed.getValue(), /return sum\(a, b\)/)
  assert.match(r.content, /main\.js after the edit:\n     1\t.*\n     2\t\n     3\texport function add\(a, b\) \{\n     4\t  return sum\(a, b\)\n     5\t}\n     6\t\n     7\texport function mul/)
  assert.match(r.content, /\n\nNo problems reported\.$/)
  assert.equal(ed.origins.at(-1), 'ai')
})

test('edit_file: failures are errors for the model and change nothing (all or nothing)', async () => {
  const { ed, tools } = js()
  const r = await tools.run('edit_file', { edits: [{ old: 'return a * b', new: 'return a ** b' }, { old: 'return nothing at all', new: 'x' }] })
  assert.equal(r.isError, true)
  assert.ok(r.content.length > 10)
  assert.equal(ed.getValue(), JS)
  assert.equal(ed.version, 0)
  assert.equal((await tools.run('edit_file', {})).isError, true)
  assert.equal((await tools.run('edit_file', { edits: 'nope' })).isError, true)
  const whole = await tools.run('edit_file', { patch: 'just some text\nthat is not a patch' })
  assert.equal(whole.isError, true)
  assert.match(whole.content, /write_file/)
  assert.equal(ed.getValue(), JS)
})

test('edit_file: all, JSON-string edits and patches (SEARCH/REPLACE, unified diff)', async () => {
  const { ed, tools } = js()
  assert.equal((await tools.run('edit_file', { edits: [{ old: '(a, b)', new: '(x, y)', all: true }] })).isError, undefined)
  assert.equal((ed.getValue().match(/\(x, y\)/g) ?? []).length, 2)
  assert.equal((await tools.run('edit_file', { edits: JSON.stringify([{ old: 'a + b', new: 'x + y' }]) })).isError, undefined)
  // Other spellings of old / new that models use are understood by applyEdits.
  assert.equal((await tools.run('edit_file', { edits: [{ old_str: 'x + y', new_str: 'y + x' }] })).isError, undefined)
  assert.equal((await tools.run('edit_file', { edits: [{ old_str: 'y + x', new_str: 'x + y' }] })).isError, undefined)
  const malformed = await tools.run('edit_file', { patch: '<<<<<<< SEARCH\nreturn x\n>>>>>>> REPLACE' })
  assert.equal(malformed.isError, true)
  assert.match(malformed.content, /=======/)
  const blocks = '<<<<<<< SEARCH\n  return a * b\n=======\n  return x * y\n>>>>>>> REPLACE\n'
  const r = await tools.run('edit_file', { patch: blocks })
  assert.equal(r.isError, undefined, r.content)
  assert.match(ed.getValue(), /return x \* y/)
  const diff = '--- a/main.js\n+++ b/main.js\n@@ -1,3 +1,3 @@\n-import { sum } from \'./sum.js\'\n+import { sum } from \'./math.js\'\n \n export function add(x, y) {\n'
  const d = await tools.run('edit_file', { patch: diff })
  assert.equal(d.isError, undefined, d.content)
  assert.match(ed.getValue(), /^import \{ sum \} from '\.\/math\.js'\n/)
})

test('edits: verify results are appended; a failing verify is reported', async () => {
  const { tools } = js(JS, {
    verify: async (ed) => [{ from: { line: ed.doc.lineCount - 1, col: 0 }, severity: 'error', message: 'Unexpected end of input' }, { from: p(0, 9), severity: 'warning', message: 'sum is unused' }],
  })
  const r = await tools.run('insert_lines', { line: 9, text: 'export {' })
  assert.match(r.content, /\n\nProblems after the edit \(line:col\):\n- 1:10 warning: sum is unused\n- 11:1 error: Unexpected end of input$/)
  const failing = editorTools(fakeEditor('a'), { verify: () => { throw new Error('tsc crashed') } })
  assert.match((await failing.run('write_file', { content: 'b' })).content, /Could not check for problems: tsc crashed$/)
})

test('edits: default check reads the diagnostics after settling', async () => {
  const ed = withDom(fakeEditor('let a = 1'))
  const tools = editorTools(ed, { settle: 20, markEdits: false })
  setTimeout(() => setDiagnostics(ed, [{ from: p(0, 4), severity: 'warning', message: 'b is never read' }]), 5)
  const r = await tools.run('edit_file', { edits: [{ old: 'a', new: 'b' }] })
  assert.match(r.content, /Problems after the edit \(line:col\):\n- 1:5 warning: b is never read$/)
})

test('insert_lines and write_file', async () => {
  const { ed, tools } = js()
  assert.equal((await tools.run('insert_lines', { line: 0, text: '// header' })).isError, undefined)
  assert.equal(ed.doc.line(0), '// header')
  assert.equal((await tools.run('insert_lines', { line: '5', text: '  // inside add' })).isError, undefined)
  assert.equal(ed.doc.line(5), '  // inside add')
  assert.equal((await tools.run('insert_lines', { text: 'x' })).isError, true)
  const w = await tools.run('write_file', { content: 'export const answer = 42\n' })
  assert.equal(w.isError, undefined, w.content)
  assert.equal(ed.getValue(), 'export const answer = 42\n')
  assert.equal(ed.origins.at(-1), 'ai')
})

test('edits: marks what the AI wrote (with a DOM) and calls onEdit', async () => {
  const ed = withDom(fakeEditor('a\nb\nc'))
  const seen: string[] = []
  const tools = editorTools(ed, { settle: 0, path: 'x.txt', onEdit: (r, path) => seen.push(`${path}:${r.ok}`) })
  await tools.run('edit_file', { edits: [{ old: 'b', new: 'BEE' }] })
  assert.deepEqual(getAIMarks(ed), [{ from: p(1, 0), to: p(1, 3) }])
  assert.deepEqual(seen, ['x.txt:true'])
  const quiet = withDom(fakeEditor('a\nb\nc'))
  await editorTools(quiet, { settle: 0, markEdits: false }).run('edit_file', { edits: [{ old: 'b', new: 'BEE' }] })
  assert.deepEqual(getAIMarks(quiet), [])
})

test('undo_last_edit: undoes the tools\' edits, one by one, never over the user\'s', async () => {
  const { ed, tools } = js()
  assert.match((await tools.run('undo_last_edit', {})).content, /No edit of yours to undo/)
  await tools.run('edit_file', { edits: [{ old: 'a + b', new: 'a - b' }] })
  await tools.run('edit_file', { edits: [{ old: 'a * b', new: 'a / b' }] })
  const r = await tools.run('undo_last_edit', {})
  assert.equal(r.isError, undefined, r.content)
  assert.match(ed.getValue(), /a - b[^]*a \* b/)
  assert.equal((await tools.run('undo_last_edit', {})).isError, undefined)
  assert.equal(ed.getValue(), JS)
  assert.equal((await tools.run('undo_last_edit', {})).isError, true)

  await tools.run('edit_file', { edits: [{ old: 'a + b', new: 'a - b' }] })
  ed.dispatch({ changes: { from: p(0, 0), insert: '// user\n' }, origin: 'input' })
  const refused = await tools.run('undo_last_edit', {})
  assert.equal(refused.isError, true)
  assert.match(refused.content, /changed since your last edit/)
  assert.match(ed.getValue(), /^\/\/ user\n[^]*a - b/)
})

test('readOnly: no edit tools; the text editor only views', async () => {
  const { ed, tools } = js(JS, { readOnly: true })
  assert.match((await tools.run('edit_file', { edits: [{ old: 'a', new: 'b' }] })).content, /Unknown tool "edit_file"/)
  const te = await tools.run('str_replace_based_edit_tool', { command: 'str_replace', path: 'main.js', old_str: 'a + b', new_str: 'b' })
  assert.equal(te.isError, true)
  assert.match((await tools.run('str_replace_based_edit_tool', { command: 'view', path: 'main.js' })).content, /^main\.js/)
  assert.equal(ed.getValue(), JS)
  assert.deepEqual(names(tools.anthropic({ textEditor: true }).slice(1)), ['search_file', 'get_selection', 'get_problems'])
})

// --- several files -------------------------------------------------------------

test('several files: path picks the editor, search and problems span all files', async () => {
  const { eds, tools } = playground()
  const noPath = await tools.run('read_file', {})
  assert.equal(noPath.isError, true)
  assert.match(noPath.content, /Several files are open; pass path \(one of: index\.html, style\.css, app\.js\)/)
  assert.match((await tools.run('read_file', { path: 'style.css' })).content, /^style\.css \(css, 3 lines\)\n     1\t\.box \{\n/)
  assert.match((await tools.run('read_file', { path: '/app.js' })).content, /^app\.js \(javascript, 2 lines\)/)
  assert.equal((await tools.run('search_file', { query: 'box' })).content, '5 matches in 4 lines:\nindex.html:3: <div class="box"></div>\nstyle.css:1: .box {\napp.js:1: const box = document.querySelector(".box")\napp.js:2: box.textContent = "hi"\n')
  assert.match((await tools.run('search_file', { query: 'box', path: 'style.css' })).content, /^1 match in 1 line:\nstyle\.css:1: \.box \{\n$/)
  assert.equal((await tools.run('get_problems', {})).content, 'index.html: No problems.\nstyle.css: No problems.\napp.js: No problems.')
  const r = await tools.run('edit_file', { path: 'style.css', edits: [{ old: 'red', new: 'rebeccapurple' }] })
  assert.equal(r.isError, undefined, r.content)
  assert.match(r.content, /style\.css after the edit:/)
  assert.match(eds['/style.css'].getValue(), /rebeccapurple/)
  assert.equal(eds['app.js'].version, 0)
})

// --- Claude's text editor tool -------------------------------------------------

test('text editor: view lists the files for a directory, numbers a file, honours view_range', async () => {
  const { tools } = playground()
  const run = (input: object) => tools.run('str_replace_based_edit_tool', input)
  for (const path of ['/', '.', '', './']) {
    assert.equal((await run({ command: 'view', path })).content, 'Files:\nindex.html (html, 3 lines)\nstyle.css (css, 3 lines)\napp.js (javascript, 2 lines)')
  }
  assert.equal((await run({ command: 'view', path: '/style.css' })).content, 'style.css (css, 3 lines)\n     1\t.box {\n     2\t  color: red;\n     3\t}\n')
  assert.equal((await run({ command: 'view', path: 'style.css', view_range: [2, -1] })).content, 'style.css (css, 3 lines)\n     2\t  color: red;\n     3\t}\n')
  assert.equal((await run({ command: 'view', path: 'style.css', view_range: [1, 1] })).content, 'style.css (css, 3 lines)\n     1\t.box {\n')
  assert.equal((await run({ command: 'view', path: 'style.css', view_range: 3 })).isError, true)
  assert.match((await run({ command: 'view', path: 'nope.css' })).content, /Unknown file "nope\.css"/)
})

test('text editor: str_replace with 1, 0 (tolerant) and 2 matches', async () => {
  const { ed } = js()
  const run = textEditorTool(ed, { settle: 0 })
  const one = await run({ command: 'str_replace', path: '/main.js', old_str: '  return a + b', new_str: '  return b + a' })
  assert.equal(one.isError, undefined, one.content)
  assert.match(ed.getValue(), /return b \+ a/)
  assert.match(one.content, /     4\t  return b \+ a\n/)

  const two = await run({ command: 'str_replace', path: 'main.js', old_str: 'export function', new_str: 'function' })
  assert.equal(two.isError, true)
  assert.match(two.content, /old_str appears 2 times in main\.js \(lines 3, 7\)/)

  const none = await run({ command: 'str_replace', path: 'main.js', old_str: 'return nothing', new_str: 'x' })
  assert.equal(none.isError, true)

  // Same text with a different indentation: applied by the tolerant match, and said so.
  const fuzzy = await run({ command: 'str_replace', path: 'main.js', old_str: 'export function mul(a, b) {\n    return a * b\n}', new_str: 'export function mul(a, b) {\n  return b * a\n}' })
  assert.equal(fuzzy.isError, undefined, fuzzy.content)
  assert.match(fuzzy.content, /^Applied 1 edit \(line 8\)\.\n\(old_str had no exact match: [^\n]+\)\n\nmain\.js after the edit:\n     5\t}\n[^]*\n     9\t}\n\nNo problems reported\.$/)
  assert.match(ed.getValue(), /return b \* a/)
  assert.equal((await run({ command: 'str_replace', path: 'main.js', old_str: '', new_str: 'x' })).isError, true)
})

test('text editor: insert (insert_text or new_str), create, undo_edit, unknown commands', async () => {
  const { ed, tools } = js()
  const run = (input: object) => tools.run('str_replace_based_edit_tool', input)
  assert.equal((await run({ command: 'insert', path: 'main.js', insert_line: 0, insert_text: '// top' })).isError, undefined)
  assert.equal(ed.doc.line(0), '// top')
  assert.equal((await run({ command: 'insert', path: 'main.js', insert_line: 1, new_str: '// second' })).isError, undefined)
  assert.equal(ed.doc.line(1), '// second')
  const undone = await run({ command: 'undo_edit', path: 'main.js' })
  assert.equal(undone.isError, undefined, undone.content)
  assert.equal(ed.doc.line(1), "import { sum } from './sum.js'")
  const created = await run({ command: 'create', path: 'main.js', file_text: 'console.log(1)\n' })
  assert.equal(created.isError, undefined, created.content)
  assert.equal(ed.getValue(), 'console.log(1)\n')
  const other = await run({ command: 'create', path: 'new.js', file_text: 'x' })
  assert.equal(other.isError, true)
  assert.match(other.content, /Can't create new files here; the files are: main\.js\./)
  assert.match((await run({ command: 'rename', path: 'main.js' })).content, /Unknown command "rename"/)
})

// --- WebMCP --------------------------------------------------------------------

test('exposeTools: registers with document.modelContext and unregisters with the signal', async () => {
  const g = globalThis as { document?: unknown; navigator?: unknown }
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const registered: { tool: { name: string; inputSchema: object; annotations: { readOnlyHint: boolean }; execute: (i: unknown) => Promise<unknown> }; signal: AbortSignal }[] = []
  g.document = { modelContext: { registerTool: async (tool: never, o: { signal: AbortSignal }) => void registered.push({ tool, signal: o.signal }) } }
  try {
    const { tools } = js()
    const dispose = exposeTools(tools, { prefix: 'editor_' })
    assert.deepEqual(registered.map((r) => r.tool.name), tools.definitions.map((d) => 'editor_' + d.name))
    assert.equal(registered[0]!.tool.annotations.readOnlyHint, true)
    assert.equal(registered[2]!.tool.annotations.readOnlyHint, false)
    const result = await registered[0]!.tool.execute({ start_line: 1, end_line: 1 })
    assert.deepEqual(result, { content: [{ type: 'text', text: "main.js (javascript, 9 lines)\n     1\timport { sum } from './sum.js'\n" }], isError: false })
    dispose()
    assert.ok(registered.every((r) => r.signal.aborted))
  } finally {
    delete g.document
  }

  // The older navigator.modelContext shape, with unregisterTool(name).
  const unregistered: string[] = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { modelContext: { registerTool() {}, unregisterTool: (n: string) => unregistered.push(n) } },
  })
  try {
    const dispose = exposeTools(editorTools(fakeEditor('x'), { readOnly: true }))
    dispose()
    assert.deepEqual(unregistered, ['read_file', 'search_file', 'get_selection', 'get_problems'])
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved)
    else delete g.navigator
  }
  // Nothing to register with: a no-op.
  assert.equal(typeof exposeTools(editorTools(fakeEditor('x'))), 'function')
})
