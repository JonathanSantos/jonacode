// Touch (mobile-chromium project only): tap, double tap, long press, selection handles and the toolbar.
import type { CDPSession, Page } from '@playwright/test'
import { charCenter, expect, head, settle, test, value } from './helpers.ts'

const DOC = 'const alpha = 1\nlet beta = alpha + 2\nreturn beta'

/** Raw touch events through CDP (Playwright's touchscreen only taps). */
async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
}

const selectedText = (page: Page) => page.evaluate(() => ed.getSelectedText())

/** Center of an element's box (handles, toolbar buttons). */
async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const b = (await page.locator(selector).boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

test.describe('touch', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((doc) => void mount({ value: doc, language: 'javascript', extensions: J.basicSetup() }, { width: '360px', height: '240px' }), DOC)
    await settle(page)
  })

  test('a tap places the cursor and switches to virtual-keyboard input', async ({ page }) => {
    const p = await charCenter(page, 1, 4)
    await page.touchscreen.tap(p.x - 3, p.y)
    await settle(page)
    expect(await head(page)).toEqual({ line: 1, col: 4 })
    await expect(page.locator('.jc-editor')).toHaveClass(/jc-touch/)
    await expect(page.locator('.jc-input')).toBeFocused()
    // No handles for a plain cursor.
    await expect(page.locator('.jc-handle-start')).toBeHidden()
    // Virtual keyboards insert text without key events, and delete through the sentinel char.
    await page.keyboard.insertText('my')
    expect(await page.evaluate(() => ed.doc.line(1))).toBe('let mybeta = alpha + 2')
    await page.keyboard.press('Backspace')
    expect(await page.evaluate(() => ed.doc.line(1))).toBe('let mbeta = alpha + 2')
  })

  test('double tap selects a word, with handles and the toolbar', async ({ page }) => {
    const p = await charCenter(page, 0, 8)
    await page.touchscreen.tap(p.x, p.y)
    await page.touchscreen.tap(p.x, p.y)
    await settle(page)
    expect(await selectedText(page)).toBe('alpha')
    const start = page.locator('.jc-handle-start')
    const end = page.locator('.jc-handle-end')
    await expect(start).toBeVisible()
    await expect(end).toBeVisible()
    // Handles hang under the ends of the selection.
    const [first, last] = await page.evaluate(() => [charRect(0, 6), charRect(0, 10)])
    const hs = await centerOf(page, '.jc-handle-start')
    const he = await centerOf(page, '.jc-handle-end')
    expect(Math.abs(hs.x - first!.left)).toBeLessThan(2)
    expect(Math.abs(he.x - last!.right)).toBeLessThan(2)
    expect(hs.y).toBeGreaterThan(first!.bottom)
    const bar = page.locator('.jc-touch-bar')
    await expect(bar).toBeVisible()
    await expect(bar.locator('button')).toHaveText(['Copy', 'Cut', 'Paste', 'Select all'])
    // Any other selection change hides them.
    const q = await charCenter(page, 2, 2)
    await page.touchscreen.tap(q.x, q.y)
    await expect(start).toBeHidden()
    await expect(bar).toBeHidden()
  })

  test('toolbar: select all, copy and paste through the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const p = await charCenter(page, 1, 5)
    await page.touchscreen.tap(p.x, p.y)
    await page.touchscreen.tap(p.x, p.y)
    await expect(page.locator('.jc-touch-bar')).toBeVisible()
    expect(await selectedText(page)).toBe('beta')
    let b = await centerOf(page, '.jc-touch-bar button[data-action="Copy"]')
    await page.touchscreen.tap(b.x, b.y)
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('beta')
    // Put the cursor at the end of the document.
    const end = await page.evaluate(() => charRect(2, 10))
    await page.touchscreen.tap(end.right + 2, end.top + end.height / 2)
    expect(await head(page)).toEqual({ line: 2, col: 11 })
    // Double tap on "return" to get the toolbar back, then Select all.
    const r = await charCenter(page, 2, 2)
    await page.touchscreen.tap(r.x, r.y)
    await page.touchscreen.tap(r.x, r.y)
    await expect(page.locator('.jc-touch-bar')).toBeVisible()
    b = await centerOf(page, '.jc-touch-bar button[data-action="Select all"]')
    await page.touchscreen.tap(b.x, b.y)
    expect(await selectedText(page)).toBe(DOC)
    b = await centerOf(page, '.jc-touch-bar button[data-action="Paste"]')
    await page.touchscreen.tap(b.x, b.y)
    await expect.poll(() => value(page)).toBe('beta')
    await expect(page.locator('.jc-input')).toBeFocused()
  })

  test('long press selects a word; dragging a handle extends the selection', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page)
    const p = await charCenter(page, 0, 2)
    // Hold until the long press selects the word (480 ms), then lift the finger.
    await touch(cdp, 'touchStart', p.x, p.y)
    await expect.poll(() => selectedText(page), { intervals: [50] }).toBe('const')
    await touch(cdp, 'touchEnd')
    await settle(page)
    expect(await selectedText(page)).toBe('const')
    await expect(page.locator('.jc-handle-end')).toBeVisible()
    // Drag the end handle to the middle of "beta" on line 2 (the finger is below the text, like the handle).
    const h = await centerOf(page, '.jc-handle-end')
    const to = await page.evaluate(() => {
      const r = charRect(1, 6)
      return { x: r.left, y: r.top + r.height / 2 + ed.lineHeight * 0.9 }
    })
    await touch(cdp, 'touchStart', h.x, h.y)
    for (let i = 1; i <= 5; i++) await touch(cdp, 'touchMove', h.x + ((to.x - h.x) * i) / 5, h.y + ((to.y - h.y) * i) / 5)
    await touch(cdp, 'touchEnd')
    await settle(page)
    expect(await selectedText(page)).toBe('const alpha = 1\nlet be')
    await expect(page.locator('.jc-handle-end')).toBeVisible()
  })

  test('a tap right after a double tap moves the cursor', async ({ page }) => {
    // The gesture's own compatibility mouse events are ignored, but not the next, unrelated tap.
    const p = await charCenter(page, 0, 8)
    await page.touchscreen.tap(p.x, p.y)
    await page.touchscreen.tap(p.x, p.y)
    expect(await selectedText(page)).toBe('alpha')
    // Right away (two lines down: too far to count as a third tap of the same gesture).
    const q = await charCenter(page, 2, 2)
    await page.touchscreen.tap(q.x - 3, q.y)
    expect(await head(page)).toEqual({ line: 2, col: 2 })
  })
})

test.describe('touch: blocks and diffs', () => {
  test('tapping Reject in a diff block works and leaves the caret alone', async ({ page }) => {
    await page.evaluate(() => void mount({
      value: 'const a = 2\nconst b = 3\nkeep()',
      language: 'javascript',
      extensions: [J.basicSetup(), J.diffView({ original: 'const a = 1\nconst b = 1\nkeep()' })],
    }, { width: '360px', height: '300px' }))
    await expect(page.locator('.jc-diff-deleted')).toHaveCount(1)
    const q = await charCenter(page, 2, 2)
    await page.touchscreen.tap(q.x - 3, q.y)
    expect(await head(page)).toEqual({ line: 2, col: 2 })
    const reject = page.locator('.jc-diff-deleted .jc-diff-reject')
    const b = (await reject.boundingBox())!
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2)
    await expect.poll(() => value(page)).toBe('const a = 1\nconst b = 1\nkeep()')
    expect(await head(page)).toEqual({ line: 2, col: 2 })
    await expect(page.locator('.jc-diff-deleted')).toHaveCount(0)
  })

  test("tapping a block's input focuses it without moving the caret", async ({ page }) => {
    await page.evaluate(() => {
      mount({ value: 'one\ntwo\nthree', extensions: J.basicSetup() }, { width: '360px', height: '300px' })
      const el = document.createElement('div')
      el.innerHTML = '<input class="blk-input" aria-label="comment">'
      J.setDecorations(ed, 'c', [{ from: { line: 1, col: 0 }, block: 'above', lines: 2, widget: el }])
      ed.flush()
    })
    const q = await charCenter(page, 2, 2)
    await page.touchscreen.tap(q.x - 3, q.y)
    expect(await head(page)).toEqual({ line: 2, col: 2 })
    const box = (await page.locator('.blk-input').boundingBox())!
    await page.touchscreen.tap(box.x + 10, box.y + box.height / 2)
    await expect(page.locator('.blk-input')).toBeFocused()
    expect(await head(page)).toEqual({ line: 2, col: 2 })
    await page.keyboard.insertText('ok')
    await expect(page.locator('.blk-input')).toHaveValue('ok')
    expect(await value(page)).toBe('one\ntwo\nthree')
  })
  test('tapping a zone action runs it, and its input takes the keyboard, without moving the caret', async ({ page }) => {
    await page.evaluate(() => {
      mount({ value: 'one\ntwo\nthree', extensions: J.basicSetup() }, { width: '360px', height: '300px' })
      ;(window as any).ran = 0
      J.addZone(ed, { line: 1, actions: [{ label: 'Executar', run: () => (window as any).ran++ }] })
      const el = document.createElement('div')
      el.innerHTML = '<input class="zone-input" aria-label="comment">'
      J.addZone(ed, { line: 2, side: 'below', content: el })
      ed.flush()
    })
    const q = await charCenter(page, 2, 2)
    await page.touchscreen.tap(q.x - 3, q.y)
    expect(await head(page)).toEqual({ line: 2, col: 2 })
    const b = (await page.getByRole('button', { name: 'Executar' }).boundingBox())!
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2)
    await expect.poll(() => page.evaluate(() => (window as any).ran)).toBe(1)
    expect(await head(page)).toEqual({ line: 2, col: 2 })
    const box = (await page.locator('.zone-input').boundingBox())!
    await page.touchscreen.tap(box.x + 10, box.y + box.height / 2)
    await expect(page.locator('.zone-input')).toBeFocused()
    expect(await head(page)).toEqual({ line: 2, col: 2 })
    await page.keyboard.insertText('ok')
    await expect(page.locator('.zone-input')).toHaveValue('ok')
    expect(await value(page)).toBe('one\ntwo\nthree')
  })
})
