// Soft wrapping: row geometry, clicks and cursor positions on wrapped rows.
import type { Page } from '@playwright/test'
import { charCenter, charStart, expect, head, settle, test, type Box } from './helpers.ts'

const LONG = Array.from({ length: 24 }, (_, i) => `word${String(i).padStart(2, '0')}`).join(' ')

/** Rows of a rendered line, read from the DOM: the first column of each visual row. */
function rowStarts(page: Page, line: number): Promise<number[]> {
  return page.evaluate((l) => {
    const text = ed.doc.line(l)
    const starts = [0]
    let top = charRect(l, 0).top
    for (let c = 1; c < text.length; c++) {
      const t = charRect(l, c).top
      if (t > top + 2) {
        starts.push(c)
        top = t
      }
    }
    return starts
  }, line)
}

test.describe('line wrapping', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((long) => void mount({ value: `short\n${long}\nafter`, lineWrapping: true, extensions: J.basicSetup() }, { width: '420px' }), LONG)
    await settle(page)
  })

  test('a long line takes several rows, the next line starts below them', async ({ page }) => {
    const rows = await rowStarts(page, 1)
    expect(rows.length).toBeGreaterThanOrEqual(3)
    const { lh, long, after } = await page.evaluate(() => {
      const r = (el: Element) => el.getBoundingClientRect()
      return { lh: ed.lineHeight, long: r(lineEl(1)!), after: r(lineEl(2)!) }
    })
    expect(Math.abs(long.height - rows.length * lh)).toBeLessThan(1)
    expect(Math.abs(after.top - (long.top + rows.length * lh))).toBeLessThan(1)
    // No horizontal scrolling while wrapping.
    expect(await page.evaluate(() => ed.scrollDOM.scrollWidth <= ed.scrollDOM.clientWidth)).toBe(true)
    // Rows break at word boundaries.
    const text = LONG
    for (const s of rows.slice(1)) expect(text[s - 1]).toBe(' ')
  })

  test('clicking on each row puts the cursor on the clicked char, drawn on that row', async ({ page }) => {
    const rows = await rowStarts(page, 1)
    for (const start of rows) {
      const col = start + 3
      const p = await charStart(page, 1, col)
      await page.mouse.click(p.x, p.y)
      await settle(page)
      expect(await head(page)).toEqual({ line: 1, col })
      const [caret, ch] = await page.evaluate((c) => [caretRect(), charRect(1, c)] as [Box, Box], col)
      expect(Math.abs(caret.top - ch.top)).toBeLessThan(4)
      expect(Math.abs(caret.left + caret.width / 2 - ch.left)).toBeLessThan(2)
    }
  })

  test('the start of a row and the end of the previous one are different caret places', async ({ page }) => {
    const rows = await rowStarts(page, 1)
    const second = rows[1]!
    // Past the end of the first row: the cursor stays on that row (before the break).
    const endOfRow = await page.evaluate((c) => charRect(1, c - 1), second)
    const lh = await page.evaluate(() => ed.lineHeight)
    await page.mouse.click(endOfRow.right + 40, endOfRow.top + lh / 2)
    await settle(page)
    expect((await head(page)).col).toBe(second - 1)
    let caret = await page.evaluate(() => caretRect())
    expect(Math.abs(caret.top - endOfRow.top)).toBeLessThan(4)
    // At the very left of the second row: its first char.
    const rowStart = await page.evaluate((c) => charRect(1, c), second)
    await page.mouse.click(rowStart.left + 1, rowStart.top + lh / 2)
    await settle(page)
    expect(await head(page)).toEqual({ line: 1, col: second })
    caret = await page.evaluate(() => caretRect())
    expect(Math.abs(caret.top - rowStart.top)).toBeLessThan(4)
  })

  test('ArrowDown / ArrowUp move by visual rows and keep the column', async ({ page }) => {
    const rows = await rowStarts(page, 1)
    const p = await charCenter(page, 1, 2)
    await page.mouse.click(p.x - 3, p.y)
    const start = await head(page)
    await page.keyboard.press('ArrowDown')
    const down = await head(page)
    expect(down.line).toBe(1)
    expect(down.col).toBe(rows[1]! + start.col)
    await page.keyboard.press('ArrowUp')
    expect(await head(page)).toEqual(start)
    // From the last row, ArrowDown goes to the next line.
    for (let i = 0; i < rows.length; i++) await page.keyboard.press('ArrowDown')
    expect((await head(page)).line).toBe(2)
  })

  test('typing in a wrapped line re-wraps it', async ({ page }) => {
    const before = (await rowStarts(page, 1)).length
    await page.mouse.click(...Object.values(await charStart(page, 1, 0)) as [number, number])
    await page.keyboard.type('prefix '.repeat(8))
    await settle(page)
    const after = await rowStarts(page, 1)
    expect(after.length).toBeGreaterThan(before)
    const { lh, long, next } = await page.evaluate(() => ({ lh: ed.lineHeight, long: lineEl(1)!.getBoundingClientRect().height, next: lineEl(2)!.getBoundingClientRect().top - lineEl(1)!.getBoundingClientRect().top }))
    expect(Math.abs(long - after.length * lh)).toBeLessThan(1)
    expect(Math.abs(next - after.length * lh)).toBeLessThan(1)
  })
})
