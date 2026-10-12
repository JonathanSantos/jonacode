// Static highlight() output has the editor's geometry, and lazyEditor() swaps it in place without layout shift.
import type { Page } from '@playwright/test'
import { expect, head, settle, test, type Box } from './helpers.ts'

const CODE = 'function add(a, b) {\n  return a + b\n}\n\nconst total = add(1, 2) // three'
const LINES = CODE.split('\n')

/** Rect of the char at `col` of line `line` in a `.jc-static` block. */
function staticChar(page: Page, line: number, col: number): Promise<Box> {
  return page.evaluate(([l, c]) => {
    const row = document.querySelectorAll('.jc-static .jc-l')[l]!
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    let rest = c
    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      if (rest < node.data.length) break
      rest -= node.data.length
    }
    const range = document.createRange()
    range.setStart(node!, rest)
    range.setEnd(node!, rest + 1)
    const r = range.getBoundingClientRect()
    return { x: r.x, y: r.y, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  }, [line, col])
}

/** A static block above an editor with the same content, theme and gutter. */
async function sideBySide(page: Page): Promise<void> {
  await page.evaluate((code) => {
    const app = document.getElementById('app')!
    app.innerHTML = '<div id="static" style="width:420px;height:220px"></div><div id="live" style="width:420px;height:220px;margin-top:20px"></div>'
    const style = document.createElement('style')
    style.textContent = J.highlightStyles(J.oneDark)
    document.head.appendChild(style)
    document.getElementById('static')!.innerHTML = J.highlight(code, J.javascript, { theme: J.oneDark, lineNumbers: true })
    window.ed = J.createEditor(document.getElementById('live'), { value: code, language: J.javascript, extensions: J.basicSetup({ highlightActiveLine: false }) })
    ed.flush()
  }, CODE)
  await settle(page)
}

/** x of the first char of a line relative to its block, in the static block and in the editor. */
async function firstCharX(page: Page, line: number): Promise<[number, number]> {
  const col = LINES[line]!.search(/\S/)
  const s = await staticChar(page, line, col)
  const e = await page.evaluate(([l, c]) => charRect(l, c), [line, col])
  const o = await page.evaluate(() => [document.querySelector('.jc-static')!.getBoundingClientRect().left, ed.dom.getBoundingClientRect().left])
  return [s.left - o[0]!, e.left - o[1]!]
}

test.describe('static highlighting', () => {
  test('highlight() lays out lines exactly like the editor', async ({ page }) => {
    await sideBySide(page)
    const origins = await page.evaluate(() => ({
      s: document.querySelector('.jc-static')!.getBoundingClientRect().toJSON(),
      e: ed.dom.getBoundingClientRect().toJSON(),
    }))
    for (let i = 0; i < LINES.length; i++) {
      if (!LINES[i]) continue
      const col = LINES[i]!.search(/\S/)
      const s = await staticChar(page, i, col)
      const e = await page.evaluate(([l, c]) => charRect(l, c), [i, col])
      // Within a pixel here; the exact sub-pixel check is below.
      expect(Math.abs((s.left - origins.s.left) - (e.left - origins.e.left)), `x of line ${i + 1}`).toBeLessThan(1)
      expect(Math.abs((s.top - origins.s.top) - (e.top - origins.e.top)), `y of line ${i + 1}`).toBeLessThan(0.75)
    }
    // Same colors for the same tokens.
    const colors = await page.evaluate(() => {
      const sk = document.querySelector('.jc-static .jc-t-keyword')!
      const ek = ed.dom.querySelector('.jc-line .jc-t-keyword')!
      return [getComputedStyle(sk).color, getComputedStyle(ek).color, getComputedStyle(document.querySelector('.jc-static')!).backgroundColor, getComputedStyle(ed.dom).backgroundColor]
    })
    expect(colors[0]).toBe(colors[1])
    expect(colors[2]).toBe(colors[3])
  })

  test('static text starts at the exact (sub-pixel) x of the editor text', async ({ page }) => {
    // WebKit snaps inline-block widths to whole pixels: both gutters are whole pixels wide so nothing moves on swap.
    await sideBySide(page)
    for (const line of [0, 1, 4]) {
      const [s, e] = await firstCharX(page, line)
      expect(Math.abs(s - e), `x of line ${line + 1}`).toBeLessThan(0.1)
    }
  })

  test('lazyEditor() becomes an editor on click, with no layout shift and the cursor where clicked', async ({ page }) => {
    await page.evaluate((code) => {
      const app = document.getElementById('app')!
      app.innerHTML = '<div id="lazy" style="width:420px;height:220px"></div><p id="below">below</p>'
      const lazy = J.lazyEditor(document.getElementById('lazy'), { value: code, language: J.javascript, extensions: J.basicSetup({ highlightActiveLine: false }) })
      lazy.ready.then((e: any) => { window.ed = e })
    }, CODE)
    await expect(page.locator('.jc-static')).toBeVisible()
    await expect(page.locator('.jc-editor')).toHaveCount(0)
    const before = await Promise.all(LINES.map((l, i) => (l ? staticChar(page, i, l.search(/\S/)) : null)))
    const below = (await page.locator('#below').boundingBox())!
    // Click on the left edge of the "a" in "  return a + b".
    const a = await staticChar(page, 1, 9)
    await page.mouse.click(a.left + 1, a.top + a.height / 2)
    await expect(page.locator('.jc-editor')).toHaveCount(1)
    await expect(page.locator('.jc-static')).toHaveCount(0)
    await page.waitForFunction(() => window.ed)
    await settle(page)
    expect(await head(page)).toEqual({ line: 1, col: 9 })
    await expect(page.locator('.jc-input')).toBeFocused()
    // Every line's text is exactly where it was.
    for (let i = 0; i < LINES.length; i++) {
      if (!before[i]) continue
      const now = await page.evaluate(([l, c]) => charRect(l, c), [i, LINES[i]!.search(/\S/)])
      expect(Math.abs(now.left - before[i]!.left), `x of line ${i + 1}`).toBeLessThan(1)
      expect(Math.abs(now.top - before[i]!.top), `y of line ${i + 1}`).toBeLessThan(0.75)
    }
    expect(Math.abs((await page.locator('#below').boundingBox())!.y - below.y)).toBeLessThan(0.5)
    await page.keyboard.type('X')
    expect(await page.evaluate(() => ed.doc.line(1))).toBe('  return Xa + b')
  })

  test('lazyEditor() activates on keyboard focus and keeps it', async ({ page }) => {
    await page.evaluate((code) => {
      document.getElementById('app')!.innerHTML = '<div id="lazy" style="width:420px;height:220px"></div>'
      J.lazyEditor(document.getElementById('lazy'), { value: code, language: J.javascript, ariaLabel: 'Snippet' }).ready.then((e: any) => { window.ed = e })
    }, CODE)
    await expect(page.locator('.jc-static')).toHaveAttribute('aria-label', 'Snippet')
    await page.locator('#before').focus()
    await page.keyboard.press('Tab')
    await expect(page.locator('.jc-editor')).toHaveCount(1)
    await expect(page.getByRole('textbox', { name: 'Snippet' })).toBeFocused()
    await page.keyboard.type('// ')
    expect(await page.evaluate(() => ed.doc.line(0))).toBe('// function add(a, b) {')
  })
})
