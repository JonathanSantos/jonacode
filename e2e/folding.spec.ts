// Code folding: gutter markers, the ⋯ placeholder, keyboard shortcuts, arrows skipping folds.
import type { Page } from '@playwright/test'
import { clickAt, expect, head, keys, renderedLineCount, settle, test, value } from './helpers.ts'

const CODE = `function a() {
  const x = 1
  const y = 2
  return x + y
}
function b() {
  return 3
}
done()`

/** Clicks the fold marker of a line (in the fold gutter, at the height of the line). */
async function clickFoldMarker(page: Page, line: number): Promise<void> {
  const p = await page.evaluate((l) => {
    const g = ed.dom.querySelector('.jc-gutter-fold').getBoundingClientRect()
    const r = lineEl(l)!.getBoundingClientRect()
    return { x: g.left + g.width / 2, y: r.top + ed.lineHeight / 2 }
  }, line)
  await page.mouse.move(p.x, p.y)
  await page.mouse.click(p.x, p.y)
  await settle(page)
}

test.describe('folding', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((code) => void mount({ value: code, language: 'javascript', extensions: [J.basicSetup(), J.folding()] }), CODE)
    await settle(page)
  })

  test('the gutter marker folds a block, the placeholder unfolds it', async ({ page }) => {
    await expect(page.locator('.jc-fold-open')).toHaveCount(2)
    const lineTop = (l: number) => page.evaluate((n) => lineEl(n)!.getBoundingClientRect().top, l)
    const top0 = await lineTop(0)
    const lh = await page.evaluate(() => ed.lineHeight)

    await clickFoldMarker(page, 0)
    expect(await page.evaluate(() => ed.folds)).toEqual([{ from: 1, to: 3 }])
    expect(await renderedLineCount(page)).toBe(6)
    // The closing line moves right under the header; the text is untouched.
    expect(Math.abs((await lineTop(4)) - (top0 + lh))).toBeLessThan(1)
    expect(await value(page)).toBe(CODE)
    await expect(page.locator('.jc-fold-closed')).toHaveCount(1)
    // Line numbers skip the hidden lines.
    await expect(page.locator('.jc-gutter-lines .jc-gutter-cell')).toHaveText(['1', '5', '6', '7', '8', '9'])

    const placeholder = page.locator('.jc-fold-placeholder')
    await expect(placeholder).toBeVisible()
    await expect(placeholder).toHaveAttribute('aria-label', /Unfold \(3\)/)
    await placeholder.click()
    await settle(page)
    expect(await page.evaluate(() => ed.folds)).toEqual([])
    expect(await renderedLineCount(page)).toBe(9)
    await expect(page.locator('.jc-input')).toBeFocused()
  })

  test('keyboard: fold / unfold at the cursor, arrows skip over a fold', async ({ page }) => {
    await clickAt(page, 1, 4)
    await page.keyboard.press(keys.fold)
    await settle(page)
    expect(await page.evaluate(() => ed.folds)).toEqual([{ from: 1, to: 3 }])
    // The cursor was inside: it moved to the end of the header line.
    expect(await head(page)).toEqual({ line: 0, col: 14 })
    await page.keyboard.press('ArrowDown')
    expect((await head(page)).line).toBe(4)
    await page.keyboard.press('ArrowUp')
    expect((await head(page)).line).toBe(0)
    await page.keyboard.press(keys.unfold)
    await settle(page)
    expect(await page.evaluate(() => ed.folds)).toEqual([])
    expect(await renderedLineCount(page)).toBe(9)
  })

  test('typing on the header keeps the fold; going to a hidden line opens it', async ({ page }) => {
    await clickFoldMarker(page, 0)
    await clickAt(page, 0, 10)
    await page.keyboard.type('Name')
    expect(await page.evaluate(() => ed.folds)).toEqual([{ from: 1, to: 3 }])
    expect(await page.evaluate(() => ed.doc.line(0))).toBe('function aName() {')
    // Go to line 3 (hidden).
    await page.keyboard.press('Control+g')
    await page.keyboard.type('3')
    await page.keyboard.press('Enter')
    await settle(page)
    expect(await head(page)).toEqual({ line: 2, col: 0 })
    expect(await page.evaluate(() => ed.folds)).toEqual([])
    expect(await renderedLineCount(page)).toBe(9)
  })
})
