import assert from 'node:assert/strict'
import { test } from 'node:test'
import { widgetPatch, type LineWidget } from '../src/extensions/line-widgets.ts'

const run = () => {}
const base = (extra: Partial<LineWidget> = {}): LineWidget => ({ key: 'TestSoma', line: 4, actions: [{ label: '▶ Rodar', run }], ...extra })

test('line widgets: nothing to change when a round returns the same widget (new closures included)', () => {
  assert.deepEqual(widgetPatch(base(), base({ actions: [{ label: '▶ Rodar', run: () => {} }] })), {})
  // The line isn't compared here: the zone follows edits on its own.
  assert.deepEqual(widgetPatch(base(), base({ line: 9 })), {})
  assert.deepEqual(widgetPatch(base({ status: { text: 'ok' } }), base({ status: { text: 'ok' } })), {})
  assert.deepEqual(widgetPatch(base({ content: 'texto' }), base({ content: 'texto' })), {})
})

test('line widgets: actions are rebuilt only when what they show changes', () => {
  const label = widgetPatch(base(), base({ actions: [{ label: '■ Parar', run }] }))
  assert.deepEqual(Object.keys(label), ['actions'])
  assert.equal(label.actions![0]!.label, '■ Parar')
  assert.deepEqual(Object.keys(widgetPatch(base(), base({ actions: [{ label: '▶ Rodar', run, disabled: true }] }))), ['actions'])
  assert.deepEqual(Object.keys(widgetPatch(base(), base({ actions: [{ label: '▶ Rodar', run, class: 'ok' }] }))), ['actions'])
  assert.deepEqual(Object.keys(widgetPatch(base(), base({ actions: [{ label: '▶ Rodar', run }, { label: 'Depurar', run }] }))), ['actions'])
  // `disabled: false` and no `disabled` look the same.
  assert.deepEqual(widgetPatch(base(), base({ actions: [{ label: '▶ Rodar', run, disabled: false }] })), {})
})

test('line widgets: the status is patched on its own, and removed when it goes away', () => {
  assert.deepEqual(widgetPatch(base(), base({ status: { text: 'passou · 0,3 s' } })), { status: { text: 'passou · 0,3 s' } })
  assert.deepEqual(widgetPatch(base({ status: { text: 'a' } }), base({ status: { text: 'a', class: 'falhou' } })), { status: { text: 'a', class: 'falhou' } })
  const gone = widgetPatch(base({ status: { text: 'a' } }), base())
  assert.equal('status' in gone, true)
  assert.equal(gone.status, undefined)
})

test('line widgets: content given as a function is built once per key; strings and elements are compared', () => {
  assert.deepEqual(widgetPatch(base({ content: () => null as never }), base({ content: () => null as never })), {})
  assert.deepEqual(widgetPatch(base({ content: 'a' }), base({ content: 'b' })), { content: 'b' })
  const el = {} as HTMLElement
  assert.deepEqual(widgetPatch(base({ content: el }), base({ content: el })), {})
  assert.deepEqual(Object.keys(widgetPatch(base({ content: el }), base({ content: {} as HTMLElement }))), ['content'])
  assert.deepEqual(Object.keys(widgetPatch(base({ content: 'a' }), base({ content: () => el }))), ['content'])
  assert.deepEqual(Object.keys(widgetPatch(base({ gutter: '●' }), base({ gutter: '○' }))), ['gutter'])
})

test('line widgets: plain options are patched one by one', () => {
  assert.deepEqual(widgetPatch(base(), base({ side: 'below', keepFocus: true, separator: false })), { side: 'below', separator: false, keepFocus: true })
  assert.deepEqual(widgetPatch(base({ class: 'a' }), base({ class: 'b' })), { class: 'b' })
  assert.deepEqual(widgetPatch(base({ order: 1 }), base()), { order: undefined })
})
