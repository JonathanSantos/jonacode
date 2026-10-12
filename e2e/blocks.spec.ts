// Block widgets: rows of their own between lines (block decorations, setLineGaps / gapBlock).
import type { Page } from '@playwright/test'
import { charStart, clickAt, expect, head, isLineVisible, keys, settle, test } from './helpers.ts'

const DOC = Array.from({ length: 12 }, (_, i) => `line ${i + 1} text`).join('\n')

/** Client tops of the rendered lines and of their line-number cells, by line index. */
const tops = (page: Page) => page.evaluate(() => {
  const lines: Record<number, number> = {}
  const cells: Record<number, number> = {}
  for (const el of ed.dom.querySelectorAll('.jc-line')) {
    const n = Number(el.textContent.match(/^line (\d+)/)?.[1]) - 1
    if (n >= 0) lines[n] = el.getBoundingClientRect().top
  }
  for (const el of ed.dom.querySelectorAll('.jc-gutter-lines .jc-gutter-cell')) cells[Number(el.textContent) - 1] = el.getBoundingClientRect().top
  return { lines, cells, lh: ed.lineHeight as number }
})

/** A block with a button (counting clicks) and an input, above or below `line`. */
const addBlock = (page: Page, line: number, side: 'above' | 'below', rows = 2, set = 'review') => page.evaluate(([l, s, n, key]) => {
  const w = window as any
  w.clicks = 0
  J.setDecorations(ed, key, [{
    from: { line: l, col: 0 }, block: s, lines: n, class: 'test-block',
    widget: () => {
      const el = document.createElement('div')
      el.innerHTML = '<button type="button" class="blk-btn">Resolve</button> <input class="blk-input" aria-label="comment">'
      el.querySelector('button')!.addEventListener('click', () => w.clicks++)
      return el
    },
  }])
  ed.flush()
}, [line, side, rows, set] as const)

test.describe('block widgets', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((doc) => void mount({ value: doc, extensions: J.basicSetup() }, { height: '400px' }), DOC)
    await settle(page)
  })

  test('a block above a line pushes it and the lines below down; gutter numbers follow', async ({ page }) => {
    const before = await tops(page)
    await addBlock(page, 3, 'above', 2)
    await settle(page)
    const after = await tops(page)
    const lh = before.lh
    for (let l = 0; l < 12; l++) {
      const shift = l >= 3 ? 2 * lh : 0
      expect(Math.abs(after.lines[l]! - before.lines[l]! - shift), `line ${l + 1}`).toBeLessThan(0.5)
      expect(Math.abs(after.cells[l]! - after.lines[l]!), `gutter ${l + 1}`).toBeLessThan(0.5)
    }
    // The block fills the gap: from the bottom of line 3 to the top of line 4.
    const block = (await page.locator('.test-block').boundingBox())!
    expect(Math.abs(block.y - (after.lines[2]! + lh))).toBeLessThan(0.5)
    expect(Math.abs(block.height - 2 * lh)).toBeLessThan(0.5)
    // Clicks on the text around the block land on their lines.
    for (const l of [2, 3, 5]) {
      await clickAt(page, l, 2)
      expect(await head(page)).toEqual({ line: l, col: 2 })
    }
    // ArrowDown goes over a block above a line.
    await clickAt(page, 2, 2)
    await page.keyboard.press('ArrowDown')
    expect(await head(page)).toEqual({ line: 3, col: 2 })
    await page.keyboard.press('ArrowDown')
    expect(await head(page)).toEqual({ line: 4, col: 2 })
  })

  test('ArrowUp / ArrowDown step over blocks', async ({ page }) => {
    await addBlock(page, 3, 'above', 2)
    await clickAt(page, 4, 2)
    const up: number[] = []
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowUp')
      up.push((await head(page)).line)
    }
    expect(up).toEqual([3, 2, 1])
    await addBlock(page, 3, 'below', 2)
    await clickAt(page, 2, 2)
    const down: number[] = []
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowDown')
      down.push((await head(page)).line)
    }
    expect(down).toEqual([3, 4, 5])
  })

  test('a block below a line pushes only the lines after it', async ({ page }) => {
    const before = await tops(page)
    await addBlock(page, 3, 'below', 3)
    await settle(page)
    const after = await tops(page)
    for (let l = 0; l < 12; l++) {
      const shift = l > 3 ? 3 * before.lh : 0
      expect(Math.abs(after.lines[l]! - before.lines[l]! - shift), `line ${l + 1}`).toBeLessThan(0.5)
    }
    const block = (await page.locator('.test-block').boundingBox())!
    expect(Math.abs(block.y - (after.lines[3]! + before.lh))).toBeLessThan(0.5)
  })

  test("clicks inside a block go to its controls, not to the editor's caret", async ({ page }) => {
    await addBlock(page, 3, 'above', 2)
    await clickAt(page, 0, 4)
    await page.locator('.blk-btn').click()
    expect(await page.evaluate(() => (window as any).clicks)).toBe(1)
    expect(await head(page)).toEqual({ line: 0, col: 4 })
    // Typing in the block's own input doesn't touch the document.
    const input = page.locator('.blk-input')
    await input.click()
    await expect(input).toBeFocused()
    await page.keyboard.type('looks good')
    await expect(input).toHaveValue('looks good')
    expect(await page.evaluate(() => ed.doc.line(0))).toBe('line 1 text')
    expect(await head(page)).toEqual({ line: 0, col: 4 })
    // A mouse drag inside the block doesn't select editor text.
    const box = (await page.locator('.test-block').boundingBox())!
    await page.mouse.move(box.x + box.width - 20, box.y + 5)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 60, box.y + box.height - 5, { steps: 3 })
    await page.mouse.up()
    expect(await page.evaluate(() => ed.getSelectedText())).toBe('')
  })

  test('blocks follow edits above them, and removing them restores the geometry', async ({ page }) => {
    const before = await tops(page)
    const lh = before.lh
    await addBlock(page, 5, 'above', 2)
    // A new line at the top: the block's line (and the block) move down one row.
    await clickAt(page, 0, 0)
    await page.keyboard.press('Enter')
    await settle(page)
    const blockTop = async () => (await page.locator('.test-block').boundingBox())!.y
    let t = await tops(page)
    expect(Math.abs((await blockTop()) - (t.lines[5]! - 2 * lh))).toBeLessThan(0.5)
    expect(await page.evaluate(() => J.getDecorations(ed, 'review')[0].from.line)).toBe(6)
    // Deleting two lines above it.
    await page.keyboard.press('ControlOrMeta+z')
    await clickAt(page, 1, 0)
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Backspace')
    await settle(page)
    t = await tops(page)
    expect(await page.evaluate(() => J.getDecorations(ed, 'review')[0].from.line)).toBe(3)
    expect(Math.abs((await blockTop()) - (t.lines[5]! - 2 * lh))).toBeLessThan(0.5)
    await page.keyboard.press('ControlOrMeta+z')
    await settle(page)
    // Removing the block: every line back where it was.
    await page.evaluate(() => { J.setDecorations(ed, 'review', []); ed.flush() })
    await settle(page)
    await expect(page.locator('.test-block')).toHaveCount(0)
    const after = await tops(page)
    for (let l = 0; l < 12; l++) expect(Math.abs(after.lines[l]! - before.lines[l]!), `line ${l + 1}`).toBeLessThan(0.5)
    expect(await page.evaluate(() => ed.scrollDOM.scrollHeight)).toBe(await page.evaluate(() => ed.scrollDOM.clientHeight))
  })

  test('blocks from two sets on the same line stack; the scroll height counts them', async ({ page }) => {
    await page.evaluate(() => void mount({ value: Array.from({ length: 40 }, (_, i) => `line ${i + 1} text`).join('\n'), extensions: J.basicSetup() }, { height: '300px' }))
    const h0 = await page.evaluate(() => ed.scrollDOM.scrollHeight)
    await addBlock(page, 10, 'above', 2, 'one')
    await page.evaluate(() => {
      const el = document.createElement('div')
      el.textContent = 'second'
      J.setDecorations(ed, 'two', [{ from: { line: 10, col: 0 }, block: 'above', lines: 1, class: 'second-block', widget: el }])
      ed.flush()
    })
    await settle(page)
    const lh = await page.evaluate(() => ed.lineHeight)
    expect(await page.evaluate(() => ed.scrollDOM.scrollHeight)).toBe(h0 + 3 * lh)
    const [a, b, line] = await page.evaluate(() => [
      document.querySelector('.test-block')!.getBoundingClientRect().top,
      document.querySelector('.second-block')!.getBoundingClientRect().top,
      lineEl(10)!.getBoundingClientRect().top,
    ])
    // Stacked in the gap, set order, right above the line.
    expect(Math.abs(b! - (a! + 2 * lh))).toBeLessThan(0.5)
    expect(Math.abs(line! - (b! + lh))).toBeLessThan(0.5)
  })

  test('2M lines (compressed mode): a block near the end sits right above its line', async ({ page }) => {
    test.slow()
    await page.evaluate(() => void mount({ value: numberedLines(2_000_000), extensions: J.basicSetup() }))
    await page.evaluate(() => {
      const el = document.createElement('div')
      el.textContent = 'near the end'
      J.setDecorations(ed, 'end', [{ from: { line: 1_999_990, col: 0 }, block: 'above', lines: 2, class: 'end-block', widget: el }])
    })
    await expect(page.locator('.jc-editor')).toHaveClass(/jc-compressed/)
    await page.locator('.jc-content').click()
    await page.keyboard.press(keys.docEnd)
    await settle(page)
    expect(await isLineVisible(page, 'const line2000000 = compute(1999999, 3999998) // 2000000')).toBe(true)
    const block = page.locator('.end-block')
    await expect(block).toBeVisible()
    const [b, line, prev] = await page.evaluate(() => [
      document.querySelector('.end-block')!.getBoundingClientRect().toJSON(),
      lineEl(1_999_990)!.getBoundingClientRect().top,
      lineEl(1_999_989)!.getBoundingClientRect().bottom,
    ])
    const lh = await page.evaluate(() => ed.lineHeight)
    expect(Math.abs(b.bottom - line)).toBeLessThan(0.5)
    expect(Math.abs(b.top - prev)).toBeLessThan(0.5)
    expect(Math.abs(b.height - 2 * lh)).toBeLessThan(0.5)
    // The caret and a click under the block still map to the right line.
    const p = await charStart(page, 1_999_995, 6)
    await page.mouse.click(p.x, p.y)
    expect(await head(page)).toEqual({ line: 1_999_995, col: 6 })
  })
})
