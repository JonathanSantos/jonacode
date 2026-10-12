import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEdits, parseEdits, planEdits, type EditInput, type EditOp } from '../src/ai/edits.ts'
import { fakeEditor } from './fake-editor.ts'

const SRC = `import { readFile } from 'node:fs/promises'

export function add(a, b) {
  return a + b
}

export function sub(a, b) {
  return a - b
}

export class Counter {
  constructor(start = 0) {
    this.count = start
  }

  increment() {
    this.count++
    return this.count
  }

  reset() {
    this.count = 0
  }
}
`
const LINES = SRC.split('\n')

/** Plans on SRC (or `doc`) and returns the resulting text. */
function run(input: EditInput, options = {}, doc = SRC) {
  const ed = fakeEditor(doc)
  const result = applyEdits(ed, input, options)
  return { ...result, text: ed.getValue(), ed }
}

// ---------------------------------------------------------------------------
// Parsing

test('parseEdits: SEARCH/REPLACE blocks in fences, with a file name and prose around them', () => {
  const { ops, format } = parseEdits(`I'll rename the functions.

src/math.js
\`\`\`js
<<<<<<< SEARCH
export function add(a, b) {
=======
export function plus(a, b) {
>>>>>>> REPLACE
\`\`\`

And the other one:

\`\`\`js
<<<<<<< SEARCH
export function sub(a, b) {
=======
export function minus(a, b) {
>>>>>>> REPLACE
\`\`\`
That's it!`)
  assert.equal(format, 'blocks')
  assert.deepEqual(ops, [
    { old: 'export function add(a, b) {', new: 'export function plus(a, b) {' },
    { old: 'export function sub(a, b) {', new: 'export function minus(a, b) {' },
  ])
})

test('parseEdits: marker variants (5–9 chars, trailing spaces, ORIGINAL/UPDATED, CRLF)', () => {
  const text = '<<<<< SEARCH  \r\na\r\n=========\r\nb\r\n>>>>>>>>> REPLACE \r\n<<<<<<< ORIGINAL\nc\n=======\nd\n>>>>>>> UPDATED\n<<<<<<< search\ne\n=======\n>>>>>>>'
  assert.deepEqual(parseEdits(text).ops, [
    { old: 'a', new: 'b' },
    { old: 'c', new: 'd' },
    { old: 'e', new: '' },
  ])
})

test('parseEdits: unified diff hunks, whole files', () => {
  const diff = parseEdits('--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9 +9 @@\n-y\n+z\n')
  assert.equal(diff.format, 'diff')
  assert.deepEqual(diff.ops, [
    { type: 'patch', diff: '@@ -1,2 +1,2 @@\n a\n-b\n+c' },
    { type: 'patch', diff: '@@ -9 +9 @@\n-y\n+z' },
  ])
  assert.deepEqual(parseEdits('```ts\nconst a = 1\n```'), { ops: [{ type: 'write', text: 'const a = 1' }], format: 'whole' })
  assert.deepEqual(parseEdits('const a = 1\n'), { ops: [{ type: 'write', text: 'const a = 1\n' }], format: 'whole' })
})

test('malformed and unterminated blocks are errors, nothing is guessed', () => {
  const missingDivider = run('<<<<<<< SEARCH\n  return a + b\n>>>>>>> REPLACE')
  assert.equal(missingDivider.ok, false)
  assert.match(missingDivider.errors[0]!.message, /malformed SEARCH\/REPLACE block/)
  // Cut off before the end marker (a truncated reply must not apply half of it).
  const truncated = run('<<<<<<< SEARCH\n  return a + b\n=======\n  return a +')
  assert.equal(truncated.ok, false)
  assert.equal(truncated.text, SRC)
})

// ---------------------------------------------------------------------------
// Matching tiers

test('tier 1: exact match, also inside a line', () => {
  const r = run({ old: 'a + b', new: 'a + b + 0' })
  assert.equal(r.ok, true)
  assert.equal(r.text, SRC.replace('a + b', 'a + b + 0'))
  assert.deepEqual(r.changes, [{ from: { line: 3, col: 14 }, to: { line: 3, col: 14 }, insert: ' + 0' }])
  assert.equal(r.summary, 'Applied 1 edit (line 4).')
})

test('tier 1: ambiguous matches list the lines; `all` replaces every one', () => {
  const r = run({ old: 'this.count = ', new: 'this.total = ' })
  assert.equal(r.ok, false)
  assert.equal(r.errors[0]!.message, 'the search text matches 2 places (lines 13, 22); include more surrounding lines so it is unique')
  assert.equal(r.text, SRC)
  const all = run({ old: 'this.count', new: 'this.total', all: true })
  assert.equal(all.ok, true)
  assert.equal(all.text, SRC.replaceAll('this.count', 'this.total'))
})

test('tier 2: trailing whitespace and line endings are ignored', () => {
  const r = run({ old: 'export function add(a, b) {   \r\n  return a + b  \r\n}', new: 'export function add(a, b) {\n  return b + a\n}' })
  assert.equal(r.ok, true)
  assert.equal(r.text, SRC.replace('a + b', 'b + a'))
})

test('tier 3: indentation is ignored, and the replacement re-indented', () => {
  // The model dropped the class's indentation level.
  const r = run({ old: 'reset() {\n  this.count = 0\n}', new: 'reset(to = 0) {\n  this.count = to\n  return this\n}' })
  assert.equal(r.ok, true)
  assert.equal(r.text, SRC.replace('  reset() {\n    this.count = 0\n  }', '  reset(to = 0) {\n    this.count = to\n    return this\n  }'))
  // The model added a level.
  const more = run({ old: '    return a - b', new: '    return b - a' })
  assert.equal(more.text, SRC.replace('return a - b', 'return b - a'))
  // The model stripped all indentation: each line takes the indentation of its line in the file.
  const flat = run({ old: 'increment() {\nthis.count++\nreturn this.count\n}', new: 'increment(by = 1) {\nthis.count += by\nreturn this.count\n}' })
  assert.equal(flat.text, SRC.replace('increment() {\n    this.count++', 'increment(by = 1) {\n    this.count += by'))
})

test('tier 4: approximate matches apply above the threshold, with the replacement re-indented', () => {
  // Whitespace differences inside lines and a stray semicolon.
  const input = { old: 'constructor(start=0) {\n  this.count = start;\n}', new: 'constructor(start = 0, step = 1) {\n  this.count = start\n  this.step = step\n}' }
  const r = run(input)
  assert.equal(r.ok, true, r.summary)
  assert.equal(r.text, SRC.replace('  constructor(start = 0) {\n    this.count = start\n', '  constructor(start = 0, step = 1) {\n    this.count = start\n    this.step = step\n'))
  // Disabled, or a stricter threshold: an error with the most similar place.
  for (const fuzzy of [false, 0.99]) {
    const off = run(input, { fuzzy })
    assert.equal(off.ok, false)
    assert.equal(off.errors[0]!.hint?.line, 12)
    assert.ok(off.errors[0]!.hint!.similarity >= 0.9)
    assert.equal(off.errors[0]!.hint!.text, '  constructor(start = 0) {\n    this.count = start\n  }')
    assert.match(off.errors[0]!.message, /most similar text is at line 12 \(9\d% similar\): "constructor\(start = 0\) \{"/)
  }
})

test('not found: the message points at the most similar place', () => {
  const r = run({ old: 'decrement() {\n  this.count--\n  return this.count\n}', new: '' })
  assert.equal(r.ok, false)
  assert.equal(r.errors[0]!.hint?.line, 16)
  assert.match(r.summary, /^No edits applied\. The search text was not found; the most similar text is at line 16 \(\d+% similar\): "increment\(\) \{"\. It must match the file exactly/)
})

test('approximate matches that are not clearly better than the second best are ambiguous', () => {
  const doc = 'function a() {\n  const total = compute(items, 1, true)\n  return total\n}\n\nfunction b() {\n  const total = compute(items, 2, true)\n  return total\n}\n'
  const r = run({ old: '  const total = compute(items, 3, true)\n  return total', new: '  return 0' }, {}, doc)
  assert.equal(r.ok, false)
  assert.match(r.errors[0]!.message, /several places are similar \(lines \d, \d\)/)
})

test('empty search text is an error (except in an empty document)', () => {
  const r = run({ old: '  ', new: 'x' })
  assert.match(r.errors[0]!.message, /search text is empty; use an insert edit/)
  assert.equal(run({ old: '', new: 'hello\n' }, {}, '').text, 'hello\n')
})

test('placeholders that would delete code are rejected', () => {
  for (const placeholder of ['// ... existing code ...', '# ...rest of the file...', '/* ... */', '...', '// rest of the method remains the same', '{/* ... */}']) {
    const r = run({ old: '  increment() {\n    this.count++\n    return this.count\n  }', new: `  increment() {\n    ${placeholder}\n  }` })
    assert.equal(r.ok, false, placeholder)
    assert.match(r.errors[0]!.message, /placeholder .* would delete the code/)
  }
  // Fine when the old text has it too, or when nothing is deleted; spread syntax isn't a placeholder.
  assert.equal(run({ old: '// ...\nx', new: '// ...\ny' }, {}, '// ...\nx').ok, true)
  assert.equal(run({ old: '  return a + b', new: '  // ... existing code ...\n  return a + b' }).ok, true)
  assert.equal(run({ old: '  return a + b', new: '  return {\n    ...a,\n  }' }).ok, true)
})

// ---------------------------------------------------------------------------
// Other ops

test('insert after a 1-based line; 0 is the top; out of range is an error', () => {
  assert.equal(run({ type: 'insert', line: 0, text: '// top' }).text, '// top\n' + SRC)
  assert.equal(run({ type: 'insert', line: 5, text: '\n// after add\n' }).text, SRC.replace('a + b\n}\n', 'a + b\n}\n\n// after add\n'))
  // The final newline doesn't count as a line: line 24 is the last one.
  assert.equal(run({ type: 'insert', line: 24, text: '// end' }).text, SRC + '// end\n')
  assert.equal(run({ type: 'insert', line: 1, text: 'b' }, {}, 'a').text, 'a\nb')
  const r = run({ type: 'insert', line: 25, text: 'x' })
  assert.equal(r.errors[0]!.message, 'line 25 is out of range: the file has 24 lines, so line must be 0–24 (0 inserts at the top)')
})

test('write: the whole file becomes a minimal change, keeping the final newline', () => {
  const next = SRC.replace('this.count = 0', 'this.count = this.start')
  const r = run({ type: 'write', text: next.trimEnd() })
  assert.equal(r.text, next)
  assert.deepEqual(r.changes, [{ from: { line: 21, col: 17 }, to: { line: 21, col: 18 }, insert: 'this.start' }])
  assert.deepEqual(r.ranges, [{ from: { line: 21, col: 0 }, to: { line: 21, col: 27 } }])
})

test('whole file in a fence with a line of prose: only the edited lines change', () => {
  const next = SRC.replace('  increment() {\n    this.count++', '  increment(by = 1) {\n    this.count += by').replace("import { readFile } from 'node:fs/promises'\n\n", '')
  const r = run('Here is the updated file:\n\n```javascript\n' + next + '```\n')
  assert.equal(r.format, 'whole')
  assert.equal(r.text, next)
  // Only lines 0–1 (removed import) and 15–16 (increment) are touched.
  for (const c of r.changes) assert.ok([0, 15, 16].includes(c.from.line) && [2, 15, 16].includes((c.to ?? c.from).line), JSON.stringify(c))
  assert.equal(r.changes.length, 3)
  assert.equal(r.summary, 'Applied 1 edit (lines 1, 14–15).')
})

test('a reply that is only prose is not taken as the whole file', () => {
  const r = run('Sorry, I could not find a `multiply` function in this file.')
  assert.equal(r.ok, false)
  assert.equal(r.format, 'whole')
  assert.match(r.errors[0]!.message, /no line in common with the file/)
  assert.equal(r.text, SRC)
  // A structured write is taken as asked.
  assert.equal(run({ type: 'write', text: 'new content\n' }).text, 'new content\n')
})

test('unified diff: wrong line numbers, missing numbers, blank context without its space', () => {
  const diff = `--- a/math.js
+++ b/math.js
@@ -40,4 +40,5 @@
 export function sub(a, b) {
-  return a - b
+  const d = a - b
+  return d
 }

@@ @@
   reset() {
-    this.count = 0
+    this.count = this.start
   }
`
  const r = run(diff)
  assert.equal(r.format, 'diff')
  assert.equal(r.ok, true, r.summary)
  assert.equal(r.text, SRC.replace('  return a - b', '  const d = a - b\n  return d').replace('this.count = 0', 'this.count = this.start'))
})

test('unified diff: of several matches, the one closest to the stated line wins', () => {
  const doc = 'a\nx\nb\n\na\nx\nb\n'
  assert.equal(run('@@ -5,3 +5,3 @@\n a\n-x\n+y\n b\n', {}, doc).text, 'a\nx\nb\n\na\ny\nb\n')
  assert.equal(run('@@ -2,3 +2,3 @@\n a\n-x\n+y\n b\n', {}, doc).text, 'a\ny\nb\n\na\nx\nb\n')
  // Without a line number it is ambiguous.
  assert.equal(run('@@ @@\n a\n-x\n+y\n b\n', {}, doc).ok, false)
  // A pure insertion goes after the stated line; "\ No newline at end of file" is ignored.
  assert.equal(run('@@ -2,0 +3,1 @@\n+new\n\\ No newline at end of file', {}, doc).text, 'a\nx\nnew\nb\n\na\nx\nb\n')
})

// ---------------------------------------------------------------------------
// Transactions

test('several edits are planned on the original text and dispatched as one undo step', () => {
  const r = run([
    { old: 'export function add(a, b) {\n  return a + b\n}', new: 'export function add(a, b) {\n  // sum\n  return a + b\n}' },
    { old: '    this.count = 0', new: '    this.count = 0\n    return this' },
  ])
  assert.equal(r.ok, true)
  assert.equal(r.applied, 2)
  // Ranges are in the document after the edit: the second one moved down by one line.
  assert.deepEqual(r.ranges, [
    { from: { line: 3, col: 0 }, to: { line: 3, col: 8 } },
    { from: { line: 23, col: 0 }, to: { line: 23, col: 15 } },
  ])
  assert.equal(r.summary, 'Applied 2 edits (lines 4, 24).')
  assert.deepEqual(r.ed.origins, ['ai'])
  assert.equal(r.ed.undo(), true)
  assert.equal(r.ed.getValue(), SRC)
})

test('overlapping edits are an error', () => {
  const r = run([
    { old: 'export function add(a, b) {\n  return a + b', new: 'x' },
    { old: '  return a + b\n}', new: 'y' },
  ])
  assert.equal(r.ok, false)
  assert.deepEqual(r.errors, [{ index: 1, message: 'edits 1 and 2 overlap (line 4); merge them into one edit' }])
  assert.equal(r.text, SRC)
})

test('atomic (default) applies nothing on error; atomic: false applies the rest', () => {
  const ops: EditOp[] = [{ old: 'a + b', new: 'a * b' }, { old: 'nope', new: 'x' }, { type: 'insert', line: 0, text: '// hi' }]
  const atomic = run(ops)
  assert.equal(atomic.applied, 0)
  assert.equal(atomic.text, SRC)
  assert.deepEqual(atomic.changes, [])
  assert.match(atomic.summary, /^No edits applied\. Edit 2: The search text was not found/)
  const partial = run(ops, { atomic: false })
  assert.equal(partial.ok, false)
  assert.equal(partial.applied, 2)
  assert.equal(partial.text, '// hi\n' + SRC.replace('a + b', 'a * b'))
  assert.match(partial.summary, /^Applied 2 of 3 edits \(lines 1, 5\)\. Edit 2: The search text was not found/)
})

test('dryRun plans without touching the document', () => {
  const r = run({ old: 'a + b', new: 'a * b' }, { dryRun: true })
  assert.equal(r.text, SRC)
  assert.equal(r.ed.version, 0)
  assert.equal(r.changes.length, 1)
  assert.equal(r.applied, 1)
  assert.equal(r.summary, 'Would apply 1 edit (line 4).')
})

test('a vetoing change filter (read-only region) makes the edit fail', () => {
  const ed = fakeEditor(SRC)
  ed.addChangeFilter((changes) => changes.every((c) => c.from.line > 10))
  const r = applyEdits(ed, { old: 'a + b', new: 'a * b' })
  assert.equal(r.ok, false)
  assert.equal(r.applied, 0)
  assert.match(r.summary, /protected \(read-only\) part of the file/)
  assert.equal(ed.getValue(), SRC)
  assert.equal(applyEdits(ed, { old: 'this.count++', new: 'this.count += 1' }).ok, true)
})

test('select moves the cursor to the first edit', () => {
  const r = run({ old: 'this.count++', new: 'this.count += 1' }, { select: true })
  assert.deepEqual(r.ed.selection.head, { line: 16, col: 0 })
})

test('no-op edits apply without changes', () => {
  const r = run({ old: 'a + b', new: 'a + b' })
  assert.equal(r.ok, true)
  assert.equal(r.summary, 'Applied 1 edit (no change).')
  assert.deepEqual(r.ed.origins, [])
})

test('CRLF documents and inputs', () => {
  const doc = 'function f() {\r\n  return 1\r\n}\r\n'
  const r = run('<<<<<<< SEARCH\r\nfunction f() {\r\n  return 1\r\n}\r\n=======\r\nfunction f() {\r\n  return 2\r\n}\r\n>>>>>>> REPLACE\r\n', {}, doc)
  assert.equal(r.ok, true)
  assert.equal(r.text, 'function f() {\r\n  return 2\r\n}\r\n')
  assert.equal(run({ type: 'write', text: 'a\r\nb\r\n' }, {}, 'a\r\nc\r\n').text, 'a\r\nb\r\n')
})

test('field aliases and text-editor tool commands', () => {
  const expected = SRC.replace('a + b', 'a * b')
  for (const op of [
    { old_str: 'a + b', new_str: 'a * b' },
    { oldText: 'a + b', newText: 'a * b' },
    { search: 'a + b', replace: 'a * b' },
    { old_string: 'a + b', new_string: 'a * b' },
    { command: 'str_replace', path: '/x.js', old_str: 'a + b', new_str: 'a * b' },
  ]) {
    assert.equal(run(op as unknown as EditOp).text, expected, JSON.stringify(op))
  }
  assert.equal(run({ command: 'insert', insert_line: 0, new_str: '// hi' } as unknown as EditOp).text, '// hi\n' + SRC)
  assert.equal(run({ command: 'create', file_text: 'x\n' } as unknown as EditOp).text, 'x\n')
  assert.equal(run({ type: 'patch', diff: '@@ -4 +4 @@\n-  return a + b\n+  return a * b' }).text, expected)
  assert.match(run({ type: 'rename' } as unknown as EditOp).errors[0]!.message, /unknown edit type "rename"/)
  assert.match(run({ old: 'a' } as unknown as EditOp).errors[0]!.message, /new text \("new"\) is missing/)
})

test('chained blocks (each written against the result of the previous) still apply', () => {
  const r = run(`<<<<<<< SEARCH
  return a + b
=======
  const sum = a + b
  return sum
>>>>>>> REPLACE
<<<<<<< SEARCH
  const sum = a + b
  return sum
=======
  const sum = a + b
  console.log(sum)
  return sum
>>>>>>> REPLACE`)
  assert.equal(r.ok, true, r.summary)
  assert.equal(r.text, SRC.replace('  return a + b', '  const sum = a + b\n  console.log(sum)\n  return sum'))
  assert.deepEqual(r.ed.origins, ['ai'])
})

test('planEdits works on plain lines', () => {
  const r = planEdits(LINES, { old: 'a - b', new: 'b - a' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.changes, [
    { from: { line: 7, col: 13 }, to: { line: 7, col: 14 }, insert: 'a' },
    { from: { line: 7, col: 9 }, to: { line: 7, col: 10 }, insert: 'b' },
  ])
})

// ---------------------------------------------------------------------------
// A corpus of messy, realistic model outputs.

const PY = `import os


def load(path):
    with open(path) as f:
        return f.read()


class Store:
    def __init__(self, root):
        self.root = root

    def get(self, key):
        path = os.path.join(self.root, key)
        if not os.path.exists(path):
            return None
        return load(path)
`

const CORPUS: { name: string; doc: string; input: EditInput; expected: string }[] = [
  {
    name: 'Aider-style blocks with file name, fences and prose',
    doc: PY,
    input: `To support defaults, update \`get\`:

store.py
\`\`\`python
<<<<<<< SEARCH
    def get(self, key):
        path = os.path.join(self.root, key)
        if not os.path.exists(path):
            return None
=======
    def get(self, key, default=None):
        path = os.path.join(self.root, key)
        if not os.path.exists(path):
            return default
>>>>>>> REPLACE
\`\`\`

This keeps the old behaviour when no default is given.`,
    expected: PY.replace('def get(self, key):', 'def get(self, key, default=None):').replace('return None', 'return default'),
  },
  {
    name: 'search text with trailing spaces the file does not have',
    doc: PY,
    input: '<<<<<<< SEARCH\ndef load(path):   \n    with open(path) as f:  \n=======\ndef load(path, mode="r"):\n    with open(path, mode) as f:\n>>>>>>> REPLACE',
    expected: PY.replace('def load(path):\n    with open(path) as f:', 'def load(path, mode="r"):\n    with open(path, mode) as f:'),
  },
  {
    name: 'method quoted without its class indentation',
    doc: PY,
    input: '<<<<<<< SEARCH\ndef __init__(self, root):\n    self.root = root\n=======\ndef __init__(self, root):\n    self.root = root\n    self.cache = {}\n>>>>>>> REPLACE',
    expected: PY.replace('        self.root = root\n', '        self.root = root\n        self.cache = {}\n'),
  },
  {
    name: 'unified diff with made-up line numbers',
    doc: PY,
    input: '```diff\n--- a/store.py\n+++ b/store.py\n@@ -120,3 +120,3 @@ class Store:\n         path = os.path.join(self.root, key)\n-        if not os.path.exists(path):\n+        if not os.path.isfile(path):\n             return None\n```',
    expected: PY.replace('os.path.exists', 'os.path.isfile'),
  },
  {
    name: 'unified diff without hunk numbers and blank context lines without a space',
    doc: PY,
    input: `--- store.py
+++ store.py
@@ @@
 import os
+import json


 def load(path):
`,
    expected: PY.replace('import os\n', 'import os\nimport json\n'),
  },
  {
    name: 'git diff with index line, two hunks, prose after',
    doc: PY,
    input: `diff --git a/store.py b/store.py
index 3b18e51..a9c4d2f 100644
--- a/store.py
+++ b/store.py
@@ -4,3 +4,3 @@ import os
 def load(path):
-    with open(path) as f:
+    with open(path, encoding="utf-8") as f:
         return f.read()
@@ -16,3 +16,3 @@ class Store:
         if not os.path.exists(path):
-            return None
+            raise KeyError(key)
         return load(path)

This makes missing keys explicit.`,
    expected: PY.replace('open(path) as f', 'open(path, encoding="utf-8") as f').replace('return None', 'raise KeyError(key)'),
  },
  {
    name: 'whole file in a fence after a sentence',
    doc: PY,
    input: 'Here is the complete updated file:\n\n```python\n' + PY.replace('import os\n', 'import os\nimport sys\n') + '```',
    expected: PY.replace('import os\n', 'import os\nimport sys\n'),
  },
  {
    name: 'str_replace with CRLF line endings on an LF file',
    doc: PY,
    input: { command: 'str_replace', old_str: '    def get(self, key):\r\n        path = os.path.join(self.root, key)\r\n', new_str: '    def get(self, key):\r\n        path = os.path.join(self.root, *key.split("/"))\r\n' } as unknown as EditOp,
    expected: PY.replace('os.path.join(self.root, key)', 'os.path.join(self.root, *key.split("/"))'),
  },
  {
    name: 'search text with a small typo',
    doc: PY,
    input: '<<<<<<< SEARCH\n    def get(self, key):\n        path = os.path.join(self.root, key)\n        if not os.path.exist(path):\n            return None\n=======\n    def get(self, key):\n        path = os.path.join(self.root, key)\n        if not os.path.exists(path):\n            return {}\n>>>>>>> REPLACE',
    expected: PY.replace('return None', 'return {}'),
  },
  {
    name: 'second block searches the result of the first',
    doc: PY,
    input: '<<<<<<< SEARCH\nimport os\n=======\nimport os\nimport json\n>>>>>>> REPLACE\n\n<<<<<<< SEARCH\nimport os\nimport json\n=======\nimport os\nimport json\nimport logging\n>>>>>>> REPLACE',
    expected: PY.replace('import os\n', 'import os\nimport json\nimport logging\n'),
  },
  {
    name: 'Claude Code Edit tool shape',
    doc: PY,
    input: { file_path: '/repo/store.py', old_string: '        return load(path)', new_string: '        return load(path).strip()' } as unknown as EditOp,
    expected: PY.replace('return load(path)', 'return load(path).strip()'),
  },
  {
    name: 'text editor insert command',
    doc: PY,
    input: { command: 'insert', path: '/repo/store.py', insert_line: 1, new_str: 'import json' } as unknown as EditOp,
    expected: PY.replace('import os\n', 'import os\nimport json\n'),
  },
  {
    name: 'old ORIGINAL/UPDATED markers',
    doc: PY,
    input: '```\n<<<<<<< ORIGINAL\n        self.root = root\n=======\n        self.root = os.path.abspath(root)\n>>>>>>> UPDATED\n```',
    expected: PY.replace('self.root = root', 'self.root = os.path.abspath(root)'),
  },
  {
    name: 'whole file without the final newline',
    doc: PY,
    input: PY.replace('return f.read()', 'return f.read().strip()').trimEnd(),
    expected: PY.replace('return f.read()', 'return f.read().strip()'),
  },
  {
    name: 'diff context indented with tabs instead of spaces',
    doc: PY,
    input: '@@ -13,2 +13,2 @@\n \tdef get(self, key):\n-\t\tpath = os.path.join(self.root, key)\n+\t\tpath = os.path.join(self.root, str(key))\n',
    expected: PY.replace('os.path.join(self.root, key)', 'os.path.join(self.root, str(key))'),
  },
  {
    name: 'block with lowercase markers and too many equals signs',
    doc: PY,
    input: '<<<<<<< search\n            return None\n=========\n            return None  # missing\n>>>>>>> replace',
    expected: PY.replace('return None', 'return None  # missing'),
  },
]

test('messy corpus: realistic model outputs apply correctly', (t) => {
  let ok = 0
  const failures: string[] = []
  for (const c of CORPUS) {
    const ed = fakeEditor(c.doc)
    const r = applyEdits(ed, c.input)
    if (r.ok && ed.getValue() === c.expected) ok++
    else failures.push(`${c.name}: ${r.summary}\n${ed.getValue()}`)
  }
  t.diagnostic(`messy corpus: ${ok}/${CORPUS.length} applied correctly`)
  assert.deepEqual(failures, [])
})
