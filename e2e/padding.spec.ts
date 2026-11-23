// The space around the text is configurable: `padding`, `lineNumbers({ padding })`, `diagnostics({ gutter, gutterWidth })`.
import type { Page } from '@playwright/test'
import { clickAt, expect, head, settle, test } from './helpers.ts'

const DOC = 'function add(a, b) {\n  return a + b\n}\n\nconst total = add(1, 2)'
const LONG = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')

/** Where the text starts and what's around it, in client px. */
const geometry = (page: Page) => page.evaluate(() => {
  const gutters = ed.dom.querySelector('.jc-gutters')!.getBoundingClientRect()
  return {
    text: charRect(0, 0).left,
    top: lineEl(0)!.getBoundingClientRect().top,
    gutterRight: gutters.right,
    gutterWidth: gutters.width,
    editorTop: ed.dom.getBoundingClientRect().top,
    caret: caretRect().left,
    lh: ed.lineHeight as number,
  }
})

/** Visual rows of line 0 and the right edge of its widest row. */
const wrapped = (page: Page) => page.evaluate(() => {
  const el = lineEl(0)!
  const range = document.createRange()
  range.selectNodeContents(el)
  const right = Math.max(...[...range.getClientRects()].map((r) => r.right))
  const sc = ed.scrollDOM.getBoundingClientRect()
  return { rows: Math.round(el.getBoundingClientRect().height / ed.lineHeight), right, limit: sc.left + ed.scrollDOM.clientWidth }
})

test.describe('padding', () => {
  test('padding.x moves the text; a click at the start of a line still lands on column 0', async ({ page }) => {
    await page.evaluate((doc) => void mount({ value: doc, extensions: J.basicSetup(), padding: { x: 4 } }), DOC)
    await settle(page)
    let g = await geometry(page)
    expect(Math.abs(g.text - g.gutterRight - 4)).toBeLessThan(0.5)
    expect(await page.evaluate(() => ed.padding)).toEqual({ x: 4, y: 8 })
    for (const line of [0, 1, 4]) {
      await clickAt(page, line, 0)
      expect(await head(page)).toEqual({ line, col: 0 })
    }
    // A click in the padding itself is also column 0, and the caret is drawn on the text's edge.
    await page.mouse.click(g.gutterRight + 1, g.top + g.lh * 1.5)
    await settle(page)
    expect(await head(page)).toEqual({ line: 1, col: 0 })
    g = await geometry(page)
    expect(Math.abs(g.caret - g.text)).toBeLessThan(1.5)
    await clickAt(page, 1, 9)
    expect(await head(page)).toEqual({ line: 1, col: 9 })
  })

  test('setOptions({ padding }) redoes the geometry (x and y)', async ({ page }) => {
    await page.evaluate((doc) => void mount({ value: doc, extensions: J.basicSetup() }), DOC)
    await settle(page)
    const before = await geometry(page)
    expect(Math.abs(before.text - before.gutterRight - 12)).toBeLessThan(0.5)
    expect(Math.abs(before.top - before.editorTop - 8)).toBeLessThan(0.5)
    await page.evaluate(() => {
      ed.setOptions({ padding: { x: 30, y: 20 } })
      ed.flush()
    })
    await settle(page)
    const after = await geometry(page)
    expect(Math.abs(after.text - after.gutterRight - 30)).toBeLessThan(0.5)
    expect(Math.abs(after.top - after.editorTop - 20)).toBeLessThan(0.5)
    await clickAt(page, 4, 0)
    expect(await head(page)).toEqual({ line: 4, col: 0 })
    await clickAt(page, 0, 9)
    expect(await head(page)).toEqual({ line: 0, col: 9 })
    // Only the given axis changes.
    await page.evaluate(() => ed.setOptions({ padding: { x: 0 } }))
    expect(await page.evaluate(() => ed.padding)).toEqual({ x: 0, y: 20 })
  })

  test('the wrap width follows the padding', async ({ page }) => {
    await page.evaluate((doc) => void mount({ value: doc, lineWrapping: true, padding: { x: 4 } }, { width: '420px' }), LONG)
    await settle(page)
    const narrow = await wrapped(page)
    expect(narrow.right).toBeLessThanOrEqual(narrow.limit - 4)
    await page.evaluate(() => {
      ed.setOptions({ padding: { x: 90 } })
      ed.flush()
    })
    await settle(page)
    const wide = await wrapped(page)
    expect(wide.rows).toBeGreaterThan(narrow.rows)
    expect(wide.right).toBeLessThanOrEqual(wide.limit - 90)
    // Exactly the columns that fit: clientWidth - 2 * padding - one char.
    const cols = await page.evaluate(() => Math.floor((ed.scrollDOM.clientWidth - 2 * 90 - ed.charWidth) / ed.charWidth))
    const longest = await page.evaluate(() => Math.max(...lineEl(0)!.innerHTML.split('<br>').map((row) => row.replace(/<[^>]+>/g, '').length)))
    expect(longest).toBeLessThanOrEqual(cols)
    expect(longest).toBeGreaterThan(cols - 8)
  })

  test('lineNumbers({ padding }) sets the space around the numbers', async ({ page }) => {
    const width = async (padding: unknown) => {
      await page.evaluate(([doc, p]) => void mount({ value: doc, extensions: [J.lineNumbers(p === null ? {} : { padding: p })] }), [DOC, padding] as const)
      await settle(page)
      return page.evaluate(() => {
        const cell = ed.dom.querySelector('.jc-gutter-lines .jc-gutter-cell')!
        const cs = getComputedStyle(cell)
        return { gutter: ed.dom.querySelector('.jc-gutter-lines')!.getBoundingClientRect().width, left: cs.paddingLeft, right: cs.paddingRight }
      })
    }
    const base = await width(null)
    expect(base).toMatchObject({ left: '16px', right: '10px' })
    const tight = await width(4)
    expect(tight).toMatchObject({ left: '16px', right: '4px' })
    expect(base.gutter - tight.gutter).toBe(6)
    const both = await width({ left: 2, right: 3 })
    expect(both).toMatchObject({ left: '2px', right: '3px' })
    expect(base.gutter - both.gutter).toBe(21)
  })

  test('lazyEditor() keeps the text in place with a custom padding', async ({ page }) => {
    await page.evaluate((code) => {
      document.getElementById('app')!.innerHTML = '<div id="lazy" style="width:420px;height:220px"></div>'
      J.lazyEditor(document.getElementById('lazy'), { value: code, extensions: J.basicSetup(), padding: { x: 3, y: 15 } }).ready.then((e: any) => { window.ed = e })
    }, DOC)
    const first = () => page.evaluate(() => {
      const range = document.createRange()
      range.selectNodeContents(document.querySelector('.jc-static .jc-l') ?? lineEl(0)!)
      const r = range.getClientRects()[0]!
      return { left: r.left, top: r.top }
    })
    const before = await first()
    await page.locator('.jc-static').focus()
    await page.waitForFunction(() => window.ed)
    await settle(page)
    const after = await first()
    expect(Math.abs(after.left - before.left)).toBeLessThan(1)
    expect(Math.abs(after.top - before.top)).toBeLessThan(0.75)
  })
})

test.describe('diagnostics gutter', () => {
  const problems = [
    { from: { line: 1, col: 2 }, to: { line: 1, col: 8 }, severity: 'warning', message: 'careful' },
    { from: { line: 4, col: 0 }, severity: 'error', message: 'broken' },
  ]

  test("gutter: 'line-numbers' marks the number and takes no room, even with a linter installed first", async ({ page }) => {
    await page.evaluate((doc) => void mount({ value: doc, extensions: [J.basicSetup()] }), DOC)
    await settle(page)
    const plain = (await geometry(page)).gutterWidth
    await page.evaluate(([doc]) => {
      // A linter that finds its lines in the text, so its marks are right after every edit.
      const lint = (e: any) => e.doc.lines.flatMap((text: string, line: number) =>
        text.includes('return') ? [{ from: { line, col: 2 }, to: { line, col: 8 }, severity: 'warning', message: 'careful' }]
        : text.startsWith('const total') ? [{ from: { line, col: 0 }, severity: 'error', message: 'broken' }] : [])
      // The linter brings `diagnostics()` with the defaults; the explicit option still wins.
      mount({ value: doc, extensions: [J.basicSetup(), J.linter(lint, { delay: 10 }), J.diagnostics({ gutter: 'line-numbers' })] })
    }, [DOC] as const)
    await expect(page.locator('.jc-gutter-lines .jc-diag-ln')).toHaveCount(2)
    await expect(page.locator('.jc-gutter-diag')).toHaveCount(0)
    expect((await geometry(page)).gutterWidth).toBe(plain)
    await expect(page.locator('.jc-gutter-lines .jc-diag-ln.jc-diag-warning')).toHaveText('2')
    await expect(page.locator('.jc-gutter-lines .jc-diag-ln.jc-diag-error')).toHaveText('5')
    const colors = await page.evaluate(() => {
      const of = (sel: string) => getComputedStyle(ed.dom.querySelector(sel)!).color
      return [of('.jc-diag-ln.jc-diag-error'), of('.jc-gutter-lines .jc-gutter-cell:not(.jc-diag-ln):not(.jc-active)')]
    })
    expect(colors[0]).not.toBe(colors[1])
    // A click on a marked number shows its messages; the marks follow the text.
    await page.locator('.jc-gutter-lines .jc-diag-ln.jc-diag-error').click()
    await expect(page.locator('.jc-tooltip .jc-diag-message')).toHaveText('broken')
    await page.evaluate(() => ed.dispatch({ changes: { from: { line: 0, col: 0 }, insert: '// new\n' } }))
    await expect(page.locator('.jc-gutter-lines .jc-diag-ln.jc-diag-error')).toHaveText('6')
  })

  test('gutterWidth sizes the markers gutter', async ({ page }) => {
    for (const [options, expected] of [[{}, 14], [{ gutterWidth: 8 }, 8]] as const) {
      await page.evaluate(([doc, list, o]) => {
        mount({ value: doc, extensions: [J.basicSetup(), J.diagnostics(o)] })
        J.setDiagnostics(ed, list)
      }, [DOC, problems, options] as const)
      await settle(page)
      expect(await page.evaluate(() => ed.dom.querySelector('.jc-gutter-diag')!.getBoundingClientRect().width)).toBe(expected)
      await expect(page.locator('.jc-diag-marker')).toHaveCount(2)
    }
  })

  test('the shared UI lives while someone uses it', async ({ page }) => {
    await page.evaluate(([doc, list]) => {
      const w = window as any
      w.a = J.compartment()
      w.b = J.compartment()
      mount({ value: doc, extensions: [J.basicSetup(), w.a.of(J.diagnostics()), w.b.of(J.diagnostics())] })
      J.setDiagnostics(ed, list)
    }, [DOC, problems] as const)
    await expect(page.locator('.jc-diag-marker')).toHaveCount(2)
    // The first one to install leaves: the gutter and the diagnostics stay for the other.
    await page.evaluate(() => (window as any).a.reconfigure(ed, null))
    await settle(page)
    await expect(page.locator('.jc-gutter-diag')).toHaveCount(1)
    await expect(page.locator('.jc-diag-marker')).toHaveCount(2)
    expect(await page.evaluate(() => J.getDiagnostics(ed).length)).toBe(2)
    await page.evaluate(() => (window as any).b.reconfigure(ed, null))
    await settle(page)
    await expect(page.locator('.jc-gutter-diag')).toHaveCount(0)
    expect(await page.evaluate(() => J.getDiagnostics(ed).length)).toBe(0)
  })
})
