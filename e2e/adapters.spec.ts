// The React and Vue components: props reach the editor, change it when they change, and leave it alone when they don't.
import type { Page } from '@playwright/test'
import { expect, settle, test } from './helpers.ts'

const DOC = 'package main\n\nfunc main() {\n}'

/** Loads the adapters bundle and mounts one of the components in a fresh host. `window.A` is the bundle, `window.app` the mounted component. */
async function mountAdapter(page: Page, kind: 'React' | 'Vue', props: string): Promise<void> {
  await page.evaluate(async ([k, source, doc]) => {
    const w = window as any
    // Not a literal for the compiler: the file is built by global-setup.ts.
    const A = (w.A ??= await import('/e2e/.build/adapters.js' as string))
    const host = document.createElement('div')
    host.style.cssText = 'width:560px;height:240px'
    document.getElementById('app')!.replaceChildren(host)
    w.tabs = A.core.defineLanguage({ name: 'tabs', states: { root: [] }, indent: { useTabs: true, size: 4 } })
    w.installs = 0
    w.probe = () => void w.installs++
    w.base = A.core.basicSetup()
    w.changes = []
    w.ed = null
    w.app = A['mount' + k](host, new Function('w', 'A', 'DOC', `return (${source})`)(w, A, doc))
  }, [kind, props, DOC] as const)
  await settle(page)
}

/** Where the text starts, relative to the gutters. */
const textOffset = (page: Page) => page.evaluate(() => {
  const e = (window as any).ed
  const range = document.createRange()
  range.selectNodeContents(e.dom.querySelector('.jc-line'))
  return Math.round(range.getClientRects()[0]!.left - e.dom.querySelector('.jc-gutters').getBoundingClientRect().right)
})
const state = (page: Page) => page.evaluate(() => {
  const w = window as any
  return { value: w.ed.getValue(), padding: w.ed.padding, insertSpaces: w.ed.options.insertSpaces, tabSize: w.ed.options.tabSize, installs: w.installs }
})
/** Counts the `setOptions` calls made while `fn` runs in the page (and the frames after it). */
async function optionCalls(page: Page, fn: string): Promise<number> {
  const calls = await page.evaluate(async (source) => {
    const w = window as any
    const original = w.ed.setOptions
    let n = 0
    w.ed.setOptions = function (...args: unknown[]) {
      n++
      return original.apply(this, args)
    }
    new Function('w', source)(w)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    w.ed.setOptions = original
    return n
  }, fn)
  return calls
}

test.describe('React adapter', () => {
  const PROPS = `{
    value: DOC, language: w.tabs, extensions: [w.base, w.probe], padding: { x: 4 },
    onReady: (e) => (w.ed = e), onChange: (v) => w.changes.push(v),
  }`

  test('padding reaches the editor and follows the prop, by value', async ({ page }) => {
    await mountAdapter(page, 'React', PROPS)
    expect((await state(page)).padding).toEqual({ x: 4, y: 8 })
    expect(await textOffset(page)).toBe(4)
    // An equal object on a new render (what an inline `padding={{ x: 4 }}` is) changes nothing.
    expect(await optionCalls(page, 'w.app.update({ padding: { x: 4 } })')).toBe(0)
    expect(await optionCalls(page, 'w.app.update({ padding: { x: 20, y: 3 } })')).toBe(1)
    expect((await state(page)).padding).toEqual({ x: 20, y: 3 })
    expect(await textOffset(page)).toBe(20)
  })

  test('the language decides the indentation until a prop says otherwise', async ({ page }) => {
    await mountAdapter(page, 'React', PROPS)
    expect(await state(page)).toMatchObject({ insertSpaces: false, tabSize: 4 })
    await page.evaluate(() => (window as any).app.update({ insertSpaces: true, tabSize: 2 }))
    await settle(page)
    expect(await state(page)).toMatchObject({ insertSpaces: true, tabSize: 2 })
    // Another language no longer changes what the app chose.
    await page.evaluate(() => (window as any).app.update({ language: (window as any).A.core.plainText }))
    await settle(page)
    expect(await state(page)).toMatchObject({ insertSpaces: true, tabSize: 2 })
  })

  test('extensions that stay in a new list are not reinstalled; the value is controlled', async ({ page }) => {
    await mountAdapter(page, 'React', PROPS)
    expect((await state(page)).installs).toBe(1)
    // A new array with the same extensions (and one more): the old ones stay as they are.
    await page.evaluate(() => {
      const w = window as any
      w.app.update({ extensions: [w.base, w.probe, w.A.core.search()] })
    })
    await settle(page)
    expect((await state(page)).installs).toBe(1)
    await page.evaluate(() => (window as any).app.update({ value: 'x := 1' }))
    await settle(page)
    expect((await state(page)).value).toBe('x := 1')
    // Typing reports the new value; setting the prop did not.
    await page.evaluate(() => (window as any).ed.focus())
    await page.keyboard.type('// ')
    expect(await page.evaluate(() => (window as any).changes)).toEqual(['/x := 1', '//x := 1', '// x := 1'])
  })
})

test.describe('Vue adapter', () => {
  const PROPS = `{
    modelValue: DOC, language: w.tabs, extensions: [w.base, w.probe], padding: { x: 4 },
    onReady: (e) => (w.ed = e), 'onUpdate:modelValue': (v) => w.changes.push(v),
  }`

  test('padding reaches the editor and follows the prop', async ({ page }) => {
    await mountAdapter(page, 'Vue', PROPS)
    expect((await state(page)).padding).toEqual({ x: 4, y: 8 })
    expect(await textOffset(page)).toBe(4)
    await page.evaluate(() => void ((window as any).app.props.padding = { x: 20, y: 3 }))
    await settle(page)
    expect((await state(page)).padding).toEqual({ x: 20, y: 3 })
    expect(await textOffset(page)).toBe(20)
  })

  test('without the insertSpaces prop the language decides; with it, the prop does', async ({ page }) => {
    await mountAdapter(page, 'Vue', PROPS)
    expect(await state(page)).toMatchObject({ insertSpaces: false, tabSize: 4 })
    await page.evaluate(() => void ((window as any).app.props.insertSpaces = true))
    await settle(page)
    expect(await state(page)).toMatchObject({ insertSpaces: true, tabSize: 4 })
    // A plain language, never told about spaces: the editor's own default.
    await mountAdapter(page, 'Vue', `{ modelValue: DOC, onReady: (e) => (w.ed = e) }`)
    expect(await state(page)).toMatchObject({ insertSpaces: true, tabSize: 2 })
    await mountAdapter(page, 'Vue', `{ modelValue: DOC, language: w.tabs, insertSpaces: false, tabSize: 8, onReady: (e) => (w.ed = e) }`)
    expect(await state(page)).toMatchObject({ insertSpaces: false, tabSize: 8 })
  })

  test('v-model: the prop sets the value, typing emits it; kept extensions are not reinstalled', async ({ page }) => {
    await mountAdapter(page, 'Vue', PROPS)
    expect((await state(page)).installs).toBe(1)
    await page.evaluate(() => {
      const w = window as any
      w.app.props.extensions = [w.base, w.probe, w.A.core.search()]
      w.app.props.modelValue = 'x := 1'
    })
    await settle(page)
    expect(await state(page)).toMatchObject({ installs: 1, value: 'x := 1' })
    await page.evaluate(() => (window as any).ed.focus())
    await page.keyboard.type('// ')
    expect(await page.evaluate(() => (window as any).changes)).toEqual(['/x := 1', '//x := 1', '// x := 1'])
  })
})
