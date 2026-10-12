// Virtualized rendering: huge documents keep a small DOM; scrolling and jumps show the right lines.
import type { Page } from '@playwright/test'
import { expect, firstVisibleLine, head, isLineVisible, keys, renderedLineCount, settle, test } from './helpers.ts'

const line = (n: number) => `const line${n} = compute(${n - 1}, ${(n - 1) * 2}) // ${n}`
const lineNumber = (text: string | null) => Number(text!.match(/\/\/ (\d+)$/)![1])

/** Waits until the scroller stops moving (smooth scrolling), returns its scrollTop. */
async function scrollSettled(page: Page): Promise<number> {
  let last = -1
  for (let i = 0; i < 50; i++) {
    const top = await page.evaluate(async () => {
      await window.settle()
      return ed.scrollDOM.scrollTop
    })
    if (top === last) return top
    last = top
    await page.waitForTimeout(50)
  }
  return last
}

test.describe('virtualization', () => {
  test('200k lines: small DOM, scrolling to the end and back', async ({ page }) => {
    await page.evaluate(() => void mount({ value: numberedLines(200_000), language: 'javascript', extensions: J.basicSetup() }))
    await settle(page)
    const count = await renderedLineCount(page)
    expect(count).toBeGreaterThan(5)
    expect(count).toBeLessThan(80)
    expect(await page.locator('.jc-gutter-lines .jc-gutter-cell').count()).toBeLessThan(80)
    await expect(page.locator('.jc-editor')).not.toHaveClass(/jc-compressed/)
    // The scrollable height is the real one.
    const { scrollHeight, lh } = await page.evaluate(() => ({ scrollHeight: ed.scrollDOM.scrollHeight, lh: ed.lineHeight }))
    expect(Math.abs(scrollHeight - (200_000 * lh + 16))).toBeLessThan(2)

    // Scrollbar to the very end: the last line is on screen.
    await page.evaluate(() => { ed.scrollDOM.scrollTop = ed.scrollDOM.scrollHeight })
    await settle(page)
    expect(await isLineVisible(page, line(200_000))).toBe(true)
    expect(await renderedLineCount(page)).toBeLessThan(80)

    // Mouse wheel (native scrolling here, possibly animated): the lines drawn follow the scroll position.
    const top0 = await page.evaluate(() => ed.scrollDOM.scrollTop)
    const box = (await page.locator('.jc-scroller').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -lh * 10)
    const top1 = await scrollSettled(page)
    expect(top1).toBeLessThan(top0 - lh)
    const expected = Math.ceil((top1 - 9) / lh) + 1
    expect(Math.abs(lineNumber(await firstVisibleLine(page)) - expected)).toBeLessThanOrEqual(1)

    // Keyboard: document start, then document end.
    await page.locator('.jc-content').click()
    await page.keyboard.press(keys.docStart)
    await settle(page)
    expect(await head(page)).toEqual({ line: 0, col: 0 })
    expect(await isLineVisible(page, line(1))).toBe(true)
    await page.keyboard.press(keys.docEnd)
    await settle(page)
    expect(await head(page)).toEqual({ line: 199_999, col: line(200_000).length })
    expect(await isLineVisible(page, line(200_000))).toBe(true)
    // Typing at the end of a huge document.
    await page.keyboard.type('!')
    await expect(page.locator('.jc-line', { hasText: '// 200000!' })).toHaveCount(1)
  })

  test('2M lines: compressed mode opens, scrolls and jumps', async ({ page }) => {
    test.slow()
    await page.evaluate(() => void mount({ value: numberedLines(2_000_000), language: 'javascript', extensions: J.basicSetup() }))
    await settle(page)
    await expect(page.locator('.jc-editor')).toHaveClass(/jc-compressed/)
    expect(await renderedLineCount(page)).toBeLessThan(80)
    // The scrollable height is capped (browsers limit element heights).
    const { scrollHeight, lh } = await page.evaluate(() => ({ scrollHeight: ed.scrollDOM.scrollHeight, lh: ed.lineHeight }))
    expect(scrollHeight).toBeLessThanOrEqual(10_000_016)

    // Scrollbar to the end, then to the middle.
    await page.evaluate(() => { ed.scrollDOM.scrollTop = ed.scrollDOM.scrollHeight })
    await settle(page)
    expect(await isLineVisible(page, line(2_000_000))).toBe(true)
    await page.evaluate(() => { ed.scrollDOM.scrollTop = (ed.scrollDOM.scrollHeight - ed.scrollDOM.clientHeight) / 2 })
    await settle(page)
    const mid = lineNumber(await firstVisibleLine(page))
    expect(Math.abs(mid - 1_000_000)).toBeLessThan(20_000)

    // The wheel moves the content 1:1 in pixels, not by the compressed scrollbar ratio.
    const box = (await page.locator('.jc-scroller').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, lh * 10)
    await expect.poll(async () => lineNumber(await firstVisibleLine(page))).toBeGreaterThan(mid)
    const wheeled = lineNumber(await firstVisibleLine(page))
    expect(Math.abs(wheeled - mid - 10)).toBeLessThanOrEqual(1)

    // Go to line (Ctrl-g) jumps and centers.
    await page.locator('.jc-content').click()
    await page.keyboard.press('Control+g')
    await expect(page.locator('.jc-goto')).toBeVisible()
    await page.keyboard.type('1500000')
    await page.keyboard.press('Enter')
    await expect(page.locator('.jc-goto')).toBeHidden()
    await settle(page)
    expect(await head(page)).toEqual({ line: 1_499_999, col: 0 })
    expect(await isLineVisible(page, line(1_500_000))).toBe(true)
    const centered = await page.evaluate(() => {
      const c = caretRect()
      const sc = ed.scrollDOM.getBoundingClientRect()
      return Math.abs((c.top + c.bottom) / 2 - (sc.top + ed.scrollDOM.clientHeight / 2))
    })
    expect(centered).toBeLessThan(lh * 2)

    // Document end with the keyboard, then type there.
    await page.keyboard.press(keys.docEnd)
    await settle(page)
    expect(await head(page)).toEqual({ line: 1_999_999, col: line(2_000_000).length })
    expect(await isLineVisible(page, line(2_000_000))).toBe(true)
    await page.keyboard.type('!')
    await expect(page.locator('.jc-line', { hasText: '// 2000000!' })).toHaveCount(1)
    expect(await renderedLineCount(page)).toBeLessThan(80)
  })

  // A fractional content width (the line-number gutter) must not turn into a scale factor: at y = 4M px a fake
  // scale of 1.0008 put clicks ~150 lines away.
  for (const lines of [200_000, 2_000_000]) {
    test(`${lines.toLocaleString('en')} lines: a click deep in the document lands on the line under the pointer`, async ({ page }) => {
      await page.evaluate((n) => void mount({ value: numberedLines(n), language: 'javascript', extensions: J.basicSetup() }), lines)
      await page.evaluate(() => { ed.scrollDOM.scrollTop = ed.scrollDOM.scrollHeight - 400 })
      await settle(page)
      const target = await page.evaluate(() => {
        const top = ed.scrollDOM.getBoundingClientRect().top
        const el = [...ed.dom.querySelectorAll('.jc-line')].map((e: any) => ({ e, r: e.getBoundingClientRect() }))
          .filter(({ r }) => r.top > top + 40).sort((a, b) => a.r.top - b.r.top)[0]!
        return { x: el.r.left + 30, y: el.r.top + el.r.height / 2, text: el.e.textContent }
      })
      await page.mouse.click(target.x, target.y)
      const clicked = await head(page)
      expect(await page.evaluate((l) => ed.doc.line(l), clicked.line)).toBe(target.text)
    })
  }
})

test.describe('page-tall editor', () => {
  test('without a fixed height it grows with its content and virtualizes against the window', async ({ page }) => {
    await page.evaluate(() => void mount({ value: numberedLines(5000), extensions: J.basicSetup() }, { height: 'auto' }))
    await settle(page)
    const { height, lh } = await page.evaluate(() => ({ height: ed.dom.getBoundingClientRect().height, lh: ed.lineHeight }))
    expect(lh).toBeGreaterThan(10)
    expect(Math.abs(height - (5000 * lh + 16))).toBeLessThan(2)
    expect(await renderedLineCount(page)).toBeLessThan(120)
    // Scroll the window to the middle of the editor: the lines in the viewport are drawn.
    await page.evaluate(() => window.scrollTo(0, 50_000))
    const covered = async () => page.evaluate(async () => {
      await window.settle()
      const lines = [...ed.dom.querySelectorAll('.jc-line')].map((el: any) => el.getBoundingClientRect())
      // Every 10px of the viewport has a line under it.
      for (let y = 0; y < innerHeight; y += 10) if (!lines.some((r) => r.top <= y && r.bottom > y)) return false
      return true
    })
    await expect.poll(covered).toBe(true)
    expect(await renderedLineCount(page)).toBeLessThan(120)
    // A click in the middle of the window lands on the line drawn there.
    const target = await page.evaluate(() => {
      const el = [...ed.dom.querySelectorAll('.jc-line')].find((e: any) => {
        const r = e.getBoundingClientRect()
        return r.top <= innerHeight / 2 && r.bottom > innerHeight / 2
      })!
      const r = el.getBoundingClientRect()
      return { line: Number(el.textContent.match(/\/\/ (\d+)$/)[1]) - 1, x: r.left + 20, y: r.top + r.height / 2 }
    })
    await page.mouse.click(target.x, target.y)
    const line = (await head(page)).line
    expect(line).toBe(target.line)
    // Moving with the keyboard scrolls the page to keep the cursor in view.
    const scrollY0 = await page.evaluate(() => scrollY)
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowDown')
    await settle(page)
    expect((await head(page)).line).toBe(line + 40)
    const caret = await page.evaluate(() => caretRect())
    // Within the viewport (WebKit leaves it a sub-pixel off the edge).
    expect(caret.top).toBeGreaterThanOrEqual(-1)
    expect(caret.bottom).toBeLessThanOrEqual((await page.evaluate(() => innerHeight)) + 1)
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(scrollY0)
    await expect.poll(covered).toBe(true)
  })
})
