import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { collab, getPeers, yjs, type CollabAdapter, type TextDelta, type TextOp } from '../src/collab/index.ts'
import type { Editor, Extension } from '../src/editor.ts'
import { fakeEditor } from './fake-editor.ts'

function use(ext: Extension, ed: Editor): () => void {
  const off = (ext as (e: Editor) => void | (() => void))(ed)
  return () => off?.()
}

/** Awareness keeps a timer running: stop them all so the test process can exit. */
const awarenesses: Awareness[] = []
after(() => awarenesses.forEach((a) => a.destroy()))

/**
 * Two people, each with a Y.Doc and an awareness, over a fake network: updates
 * are queued and delivered on `flush()` (or right away when `instant`).
 */
function room(instant = true) {
  const queue: (() => void)[] = []
  const peers = [0, 1].map(() => {
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    awarenesses.push(awareness)
    return { doc, text: doc.getText('code'), awareness }
  })
  const send = (fn: () => void) => (instant ? fn() : queue.push(fn))
  peers.forEach((p, i) => {
    const other = peers[1 - i]!
    p.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'network') send(() => Y.applyUpdate(other.doc, update, 'network'))
    })
    p.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === 'network') return
      const update = encodeAwarenessUpdate(p.awareness, [...added, ...updated, ...removed])
      send(() => applyAwarenessUpdate(other.awareness, update, 'network'))
    })
  })
  const flush = () => {
    while (queue.length) queue.shift()!()
  }
  return { peers, flush }
}

test('two editors over Yjs converge under concurrent edits with latency', () => {
  const { peers, flush } = room(false)
  const eds = peers.map(() => fakeEditor(''))
  const offs = eds.map((ed, i) => use(collab(yjs({ Y, text: peers[i]!.text, awareness: peers[i]!.awareness }), { user: { name: `P${i}` } }), ed))
  let seed = 11
  const rnd = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n)
  const words = ['a', 'bc', '\n', 'déf', '😀', ' ', 'xyz\nw']
  for (let round = 0; round < 60; round++) {
    for (const ed of eds) {
      for (let k = 0; k < 3; k++) {
        const line = rnd(ed.doc.lineCount)
        const col = rnd(ed.doc.line(line).length + 1)
        const at = { line, col: /[\udc00-\udfff]/.test(ed.doc.line(line)[col] ?? '') ? col - 1 : col }
        if (rnd(4) === 0 && ed.getValue().length > 3) {
          const to = ed.doc.clamp({ line: at.line, col: at.col + 1 + rnd(3) })
          const safeTo = /[\udc00-\udfff]/.test(ed.doc.line(to.line)[to.col] ?? '') ? { ...to, col: to.col + 1 } : to
          ed.dispatch({ changes: { from: at, to: safeTo }, origin: 'input' })
        } else ed.dispatch({ changes: { from: at, insert: words[rnd(words.length)] }, origin: 'input' })
      }
    }
    if (rnd(3) === 0) flush()
  }
  flush()
  assert.equal(eds[0]!.getValue(), eds[1]!.getValue())
  assert.equal(eds[0]!.getValue(), peers[0]!.text.toString())
  assert.ok(eds[0]!.getValue().length > 50)
  offs.forEach((off) => off())
})

test('Yjs: undo only undoes your own changes, and the other side sees it', () => {
  const { peers } = room()
  const [a, b] = peers.map(() => fakeEditor(''))
  use(collab(yjs({ Y, text: peers[0]!.text, undo: 0 })), a!)
  use(collab(yjs({ Y, text: peers[1]!.text, undo: 0 })), b!)
  a!.dispatch({ changes: { from: { line: 0, col: 0 }, insert: 'hello' }, origin: 'input' })
  b!.dispatch({ changes: { from: { line: 0, col: 5 }, insert: ' world' }, origin: 'input' })
  assert.equal(a!.getValue(), 'hello world')
  assert.equal(a!.undo(), true)
  assert.equal(a!.getValue(), ' world')
  assert.equal(b!.getValue(), ' world')
  assert.equal(b!.undo(), true)
  assert.equal(b!.getValue(), '')
  assert.equal(a!.redo(), true)
  assert.equal(b!.getValue(), 'hello')
})

test('presence: names, colors and cursors of the others, resolved in this text', () => {
  const { peers } = room()
  const a = fakeEditor('')
  const b = fakeEditor('')
  let seen: readonly unknown[] = []
  use(collab(yjs({ Y, text: peers[0]!.text, awareness: peers[0]!.awareness }), { user: { name: 'Ana', data: { role: 'dev' } } }), a)
  use(collab(yjs({ Y, text: peers[1]!.text, awareness: peers[1]!.awareness }), { user: { name: 'Bia', color: '#61afef' }, onPeers: (p) => (seen = p) }), b)
  a.dispatch({ changes: { from: { line: 0, col: 0 }, insert: 'const x = 1\nconst y = 2' }, origin: 'input' })
  a.dispatch({ selection: { anchor: { line: 1, col: 6 }, head: { line: 1, col: 7 } } })
  return new Promise<void>((resolve) => setTimeout(() => {
    const [ana] = getPeers(b)
    assert.equal(ana!.name, 'Ana')
    assert.equal(ana!.data.role, 'dev')
    assert.deepEqual([ana!.anchor, ana!.head], [{ line: 1, col: 6 }, { line: 1, col: 7 }])
    assert.equal(seen.length, 1)
    // An edit above her cursor moves it.
    b.dispatch({ changes: { from: { line: 0, col: 0 }, insert: '// novo\n' }, origin: 'input' })
    assert.deepEqual(getPeers(b)[0]!.head, { line: 2, col: 7 })
    assert.equal(getPeers(a)[0]!.color, '#61afef')
    resolve()
  }, 120))
})

test('the editor starts from the shared text; `initial: "local"` publishes the editor’s text instead', () => {
  const { peers } = room()
  peers[0]!.text.insert(0, 'shared')
  const a = fakeEditor('local')
  use(collab(yjs({ Y, text: peers[0]!.text })), a)
  assert.equal(a.getValue(), 'shared')
  const b = fakeEditor('fresh room')
  const doc = new Y.Doc()
  use(collab(yjs({ Y, text: doc.getText('t') }), { initial: 'local' }), b)
  assert.equal(doc.getText('t').toString(), 'fresh room')
})

/** A bare adapter (no undo of its own): remote changes are injected by the test. */
function bareAdapter(initial = '') {
  let text = initial
  let listener: ((delta: TextDelta, origin: 'remote') => void) | null = null
  const apply = (at: number, remove: number, insert: string) => (text = text.slice(0, at) + insert + text.slice(at + remove))
  const adapter: CollabAdapter = {
    text: () => text,
    send: (ops: readonly TextOp[]) => ops.forEach((op) => apply(op.at, op.remove, op.insert)),
    receive: (fn) => ((listener = fn), () => (listener = null)),
  }
  return {
    adapter,
    text: () => text,
    remote(at: number, remove: number, insert: string) {
      apply(at, remove, insert)
      listener!([...(at ? [{ retain: at }] : []), ...(remove ? [{ delete: remove }] : []), ...(insert ? [{ insert }] : [])], 'remote')
    },
  }
}

test('own history: undo skips the others’ changes and follows them', () => {
  const server = bareAdapter('function f() {\n}\n')
  const ed = fakeEditor('')
  use(collab(server.adapter), ed)
  ed.dispatch({ changes: { from: { line: 1, col: 0 }, insert: '  return 1\n' }, origin: 'input' })
  server.remote(0, 0, '// by someone else\n')
  assert.equal(ed.getValue(), '// by someone else\nfunction f() {\n  return 1\n}\n')
  assert.equal(ed.undo(), true)
  assert.equal(ed.getValue(), '// by someone else\nfunction f() {\n}\n')
  assert.equal(server.text(), ed.getValue())
  assert.equal(ed.redo(), true)
  assert.equal(ed.getValue(), '// by someone else\nfunction f() {\n  return 1\n}\n')
  // Typing in a row is one step.
  for (const ch of 'abc') ed.dispatch({ changes: { from: ed.doc.end, insert: ch }, origin: 'input' })
  ed.undo()
  assert.equal(ed.getValue(), '// by someone else\nfunction f() {\n  return 1\n}\n')
})

test('own history: when someone edits over your change, that step is dropped instead of destroying their work', () => {
  const server = bareAdapter('')
  const ed = fakeEditor('')
  use(collab(server.adapter), ed)
  ed.dispatch({ changes: { from: { line: 0, col: 0 }, insert: 'draft text' }, origin: 'input' })
  server.remote(2, 3, 'AF')
  assert.equal(ed.getValue(), 'drAF text')
  assert.equal(ed.undo(), false)
  assert.equal(ed.getValue(), 'drAF text')
})

test('own history (fuzz): undoing all your steps leaves exactly the others’ edits', () => {
  // You edit the first part, someone else edits the second one, interleaved.
  let seed = 5
  const rnd = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n)
  for (let trial = 0; trial < 80; trial++) {
    const mine = 'my part of the text\n'.repeat(4)
    const theirs = 'their part\n'.repeat(4)
    const server = bareAdapter(mine + '---\n' + theirs)
    const ed = fakeEditor('')
    use(collab(server.adapter), ed)
    let theirsNow = theirs
    for (let step = 0; step < 40; step++) {
      if (rnd(2)) {
        const sep = ed.getValue().indexOf('---')
        const at = rnd(sep)
        const line = ed.getValue().slice(0, at).split('\n').length - 1
        const col = at - (ed.getValue().lastIndexOf('\n', at - 1) + 1)
        if (rnd(3) === 0 && at + 2 < sep) ed.dispatch({ changes: { from: { line, col }, to: { line, col: Math.min(col + 2, ed.doc.line(line).length) } }, origin: 'delete.forward' })
        else ed.dispatch({ changes: { from: { line, col }, insert: ['x', 'yz', '\n', ' '][rnd(4)] }, origin: ['input', 'input.paste'][rnd(2)] })
      } else {
        const base = server.text().indexOf('---\n') + 4
        const at = rnd(theirsNow.length)
        const insert = ['Q', 'rs', '\n'][rnd(3)]!
        theirsNow = theirsNow.slice(0, at) + insert + theirsNow.slice(at)
        server.remote(base + at, 0, insert)
      }
    }
    while (ed.undo());
    assert.equal(ed.getValue(), mine + '---\n' + theirsNow, `trial ${trial}`)
    assert.equal(server.text(), ed.getValue())
  }
})
