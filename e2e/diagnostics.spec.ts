// Diagnostics (underlines, gutter markers, hover tooltip, quick fixes, F8), hover tooltips and decorations.
import type { Page } from '@playwright/test'
import { charCenter, clickAt, expect, place, settle, test, value, type Box } from './helpers.ts'

const DOC = 'let a = 1\nlet unused = 2\nconsole.log(a)'

/** Bounding box of a mark (diagnostic or decoration) and of the chars it should cover. */
async function markAndChars(page: Page, selector: string, line: number, from: number, to: number) {
  return page.evaluate(([sel, l, f, t]) => {
    const m = ed.dom.querySelector(sel)!.getBoundingClientRect()
    return { mark: { left: m.left, right: m.right, top: m.top, bottom: m.bottom }, first: charRect(l, f), last: charRect(l, t - 1) }
  }, [selector, line, from, to] as [string, number, number, number]) as Promise<{ mark: Box; first: Box; last: Box }>
}

const expectCovers = (m: { mark: Box; first: Box; last: Box }) => {
  expect(Math.abs(m.mark.left - m.first.left)).toBeLessThan(1.5)
  expect(Math.abs(m.mark.right - m.last.right)).toBeLessThan(1.5)
  expect(Math.abs(m.mark.top - m.first.top)).toBeLessThan(4)
}

test.describe('diagnostics', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((doc) => {
      mount({ value: doc, language: 'javascript', extensions: [J.basicSetup(), J.diagnostics()] })
      J.setDiagnostics(ed, [{
        from: { line: 1, col: 4 }, to: { line: 1, col: 10 }, severity: 'warning', message: "'unused' is never read", source: 'lint',
        actions: [{ name: 'Remove line', apply: (e: any) => e.dispatch({ changes: { from: { line: 1, col: 0 }, to: { line: 2, col: 0 } } }) }],
      }, { from: { line: 2, col: 0 }, severity: 'error', message: 'console is not allowed' }])
    }, DOC)
    await settle(page)
  })

  test('underlines the ranges, marks the gutter', async ({ page }) => {
    await expect(page.locator('.jc-mark.jc-diag.jc-diag-warning')).toHaveCount(1)
    await expect(page.locator('.jc-mark.jc-diag.jc-diag-error')).toHaveCount(1)
    expectCovers(await markAndChars(page, '.jc-mark.jc-diag-warning', 1, 4, 10))
    // Without `to`, the word at `from` is marked.
    expectCovers(await markAndChars(page, '.jc-mark.jc-diag-error', 2, 0, 7))
    const marker = page.locator('.jc-diag-marker.jc-diag-warning')
    await expect(marker).toHaveCount(1)
    const [m, l] = await Promise.all([marker.boundingBox(), page.evaluate(() => lineEl(1)!.getBoundingClientRect().top)])
    expect(Math.abs(m!.y - l)).toBeLessThan(1)
  })

  test('hovering shows the message in a tooltip; a quick fix applies', async ({ page }) => {
    const p = await charCenter(page, 1, 6)
    await page.mouse.move(p.x, p.y)
    const tooltip = page.locator('.jc-tooltip')
    await expect(tooltip).toBeVisible()
    await expect(tooltip.locator('.jc-diag-message')).toHaveText("'unused' is never read")
    await expect(tooltip.locator('.jc-diag-source')).toHaveText('lint')
    await expect(tooltip).toHaveAttribute('role', 'tooltip')
    // Above the text.
    expect((await tooltip.boundingBox())!.y + (await tooltip.boundingBox())!.height).toBeLessThanOrEqual(p.y)
    // The pointer can travel into the tooltip and use its buttons.
    await tooltip.getByRole('button', { name: 'Remove line' }).click()
    expect(await value(page)).toBe('let a = 1\nconsole.log(a)')
    await expect(page.locator('.jc-input')).toBeFocused()
    // Moving far away hides it.
    await page.mouse.move(5, 5)
    await expect(tooltip).toBeHidden()
  })

  test('diagnostics follow edits', async ({ page }) => {
    await clickAt(page, 1, 0)
    await page.keyboard.type('  ')
    await settle(page)
    expectCovers(await markAndChars(page, '.jc-mark.jc-diag-warning', 1, 6, 12))
    await place(page, 0, 0)
    await page.keyboard.press('Enter')
    await settle(page)
    expectCovers(await markAndChars(page, '.jc-mark.jc-diag-warning', 2, 6, 12))
    expect(await page.evaluate(() => J.getDiagnostics(ed).map((d: any) => [d.from, d.to]))).toEqual([
      [{ line: 2, col: 6 }, { line: 2, col: 12 }], [{ line: 3, col: 0 }, { line: 3, col: 7 }],
    ])
    // Deleting the marked text removes the mark.
    await page.evaluate(() => { ed.setSelection({ line: 2, col: 6 }, { line: 2, col: 12 }); ed.flush() })
    await page.keyboard.press('Backspace')
    await expect(page.locator('.jc-mark.jc-diag-warning')).toHaveCount(0)
  })

  test('F8 / Shift+F8 jump between diagnostics', async ({ page }) => {
    await clickAt(page, 0, 0)
    await page.keyboard.press('F8')
    expect(await page.evaluate(() => ed.selection.head)).toEqual({ line: 1, col: 4 })
    await page.keyboard.press('F8')
    expect(await page.evaluate(() => ed.selection.head)).toEqual({ line: 2, col: 0 })
    await page.keyboard.press('F8')
    expect(await page.evaluate(() => ed.selection.head)).toEqual({ line: 1, col: 4 })
    await page.keyboard.press('Shift+F8')
    expect(await page.evaluate(() => ed.selection.head)).toEqual({ line: 2, col: 0 })
  })

  test('F8 shows the message of the diagnostic it jumped to', async ({ page }) => {
    // The key that opens a tooltip (F8, showHover) must not also close it.
    await clickAt(page, 0, 0)
    await page.keyboard.press('F8')
    await expect(page.locator('.jc-tooltip')).toBeVisible()
    await expect(page.locator('.jc-tooltip .jc-diag-message')).toHaveText("'unused' is never read")
  })
})

test.describe('hover tooltips', () => {
  test('sync and async sources share one tooltip; typing closes it', async ({ page }) => {
    await page.evaluate(() => {
      mount({
        value: 'document.body\nwindow',
        extensions: [
          J.basicSetup(),
          J.hoverTooltip((pos: any, e: any) => {
            const [from, to] = e.wordRange(pos)
            return 'word: ' + e.doc.slice(from, to)
          }),
          J.hoverTooltip(() => new Promise((r) => setTimeout(() => r('async info'), 50))),
        ],
      })
    })
    await clickAt(page, 1, 6)
    const p = await charCenter(page, 0, 3)
    await page.mouse.move(p.x, p.y)
    const tooltip = page.locator('.jc-tooltip')
    await expect(tooltip).toBeVisible()
    await expect(tooltip.locator('.jc-tooltip-section')).toHaveText(['word: document', 'async info'])
    // Typing closes it.
    await page.keyboard.type('x')
    await expect(tooltip).toBeHidden()
  })
})

test.describe('decorations', () => {
  test('marks, line decorations and widgets follow edits', async ({ page }) => {
    await page.evaluate(() => {
      mount({ value: 'alpha beta gamma\nsecond\nthird', extensions: J.basicSetup() })
      const badge = document.createElement('span')
      badge.textContent = '★'
      badge.className = 'badge'
      J.setDecorations(ed, 'review', [
        { from: { line: 0, col: 6 }, to: { line: 0, col: 10 }, class: 'hl' },
        { from: { line: 1, col: 0 }, line: true, class: 'changed' },
        { from: { line: 2, col: 5 }, widget: badge },
      ])
    })
    await settle(page)
    expectCovers(await markAndChars(page, '.jc-mark.hl', 0, 6, 10))
    const lineDeco = async (l: number) => page.evaluate((n) => {
      const d = ed.dom.querySelector('.jc-line-deco.changed')!.getBoundingClientRect()
      return Math.abs(d.top - lineEl(n)!.getBoundingClientRect().top) < 1 && Math.abs(d.height - ed.lineHeight) < 1
    }, l)
    expect(await lineDeco(1)).toBe(true)
    const widgetAt = async (l: number, c: number) => page.evaluate(([n, col]) => {
      const w = ed.dom.querySelector('.jc-widget.badge')!.getBoundingClientRect()
      const r = charRect(n, col)
      return Math.abs(w.left - r.left) < 1.5 && Math.abs(w.top - r.top) < 4
    }, [l, c])
    expect(await widgetAt(2, 5)).toBe(true)

    // Type before the mark, add a line at the top.
    await clickAt(page, 0, 0)
    await page.keyboard.type('>> ')
    await settle(page)
    expectCovers(await markAndChars(page, '.jc-mark.hl', 0, 9, 13))
    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    await settle(page)
    expectCovers(await markAndChars(page, '.jc-mark.hl', 1, 9, 13))
    expect(await lineDeco(2)).toBe(true)
    expect(await widgetAt(3, 5)).toBe(true)
    // Undo brings everything back.
    await page.keyboard.press('ControlOrMeta+z')
    await page.keyboard.press('ControlOrMeta+z')
    await settle(page)
    expect(await lineDeco(1)).toBe(true)
  })
})
