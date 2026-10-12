// Typing, Enter / Backspace / auto-indent, undo / redo, clipboard, selections and multiple cursors.
import { charCenter, charStart, clickAt, expect, head, ranges, selection, settle, test, value } from './helpers.ts'

test.describe('editing', () => {
  test('typing inserts text, highlights it and moves the caret', async ({ page }) => {
    await page.evaluate(() => void mount({ language: 'javascript', extensions: J.basicSetup() }))
    await page.locator('.jc-content').click()
    await expect(page.locator('.jc-input')).toBeFocused()
    await page.keyboard.type('const answer = f(42)')
    expect(await value(page)).toBe('const answer = f(42)')
    await expect(page.locator('.jc-line')).toHaveText(['const answer = f(42)'])
    // Highlighted with the JavaScript grammar.
    await expect(page.locator('.jc-line span', { hasText: 'const' }).first()).toHaveClass(/jc-t-keyword/)
    await settle(page)
    // The caret sits right after the last char.
    const last = await page.evaluate(() => charRect(0, 19))
    const caret = await page.evaluate(() => caretRect())
    expect(Math.abs(caret.left + caret.width / 2 - last.right)).toBeLessThan(2)
    expect(Math.abs(caret.top - last.top)).toBeLessThan(6)
  })

  test('Enter keeps and increases indentation, Backspace removes an indent unit', async ({ page }) => {
    await page.evaluate(() => void mount({ language: 'javascript', extensions: J.basicSetup() }))
    await page.locator('.jc-content').click()
    await page.keyboard.type('function f() {')
    // closeBrackets added the `}`.
    expect(await value(page)).toBe('function f() {}')
    await page.keyboard.press('Enter')
    expect(await value(page)).toBe('function f() {\n  \n}')
    expect(await head(page)).toEqual({ line: 1, col: 2 })
    await page.keyboard.type('return 1')
    await page.keyboard.press('Enter')
    expect(await value(page)).toBe('function f() {\n  return 1\n  \n}')
    await page.keyboard.press('Backspace')
    expect(await value(page)).toBe('function f() {\n  return 1\n\n}')
    await page.keyboard.press('Backspace')
    expect(await value(page)).toBe('function f() {\n  return 1\n}')
    expect(await head(page)).toEqual({ line: 1, col: 10 })
  })

  test('typing a closing bracket on a blank line outdents it', async ({ page }) => {
    await page.evaluate(() => void mount({ language: 'javascript', extensions: J.basicSetup({ closeBrackets: false }) }))
    await page.locator('.jc-content').click()
    await page.keyboard.type('if (x) {')
    await page.keyboard.press('Enter')
    await page.keyboard.type('y()')
    await page.keyboard.press('Enter')
    await page.keyboard.type('}')
    expect(await value(page)).toBe('if (x) {\n  y()\n}')
  })

  test('undo and redo with the keyboard', async ({ page }) => {
    await page.evaluate(() => void mount({ extensions: J.basicSetup() }))
    // One input event per word (keyboard.type could split a word in several undo steps on a slow machine).
    await page.locator('.jc-content').click()
    await page.keyboard.insertText('hello')
    // A click ends the undo group (typing in quick succession is merged).
    await page.locator('.jc-content').click()
    await page.keyboard.insertText(' world')
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe('hello')
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe('')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    expect(await value(page)).toBe('hello')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    expect(await value(page)).toBe('hello world')
    await expect(page.locator('.jc-line')).toHaveText(['hello world'])
  })

  test('Shift+arrows select, the selection is drawn over the chars', async ({ page }) => {
    await page.evaluate(() => void mount({ value: 'alpha beta gamma\nsecond line', extensions: J.basicSetup() }))
    await clickAt(page, 0, 6)
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight')
    await settle(page)
    expect(await page.evaluate(() => ed.getSelectedText())).toBe('beta')
    const rect = page.locator('.jc-selection-rect')
    await expect(rect).toHaveCount(1)
    const box = (await rect.boundingBox())!
    const b = await page.evaluate(() => charRect(0, 6))
    const a = await page.evaluate(() => charRect(0, 9))
    expect(Math.abs(box.x - b.left)).toBeLessThan(1.5)
    expect(Math.abs(box.x + box.width - a.right)).toBeLessThan(1.5)
    // Shift+Down extends over the line break: two rects.
    await page.keyboard.press('Shift+ArrowDown')
    await settle(page)
    expect(await selection(page)).toEqual({ anchor: { line: 0, col: 6 }, head: { line: 1, col: 10 } })
    await expect(rect).toHaveCount(2)
  })

  test('mouse drag selects, double click selects a word, triple click a line', async ({ page }) => {
    await page.evaluate(() => void mount({ value: 'first line here\nsecond line here\nthird line here', extensions: J.basicSetup() }))
    const from = await charStart(page, 0, 6)
    const to = await charStart(page, 2, 5)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 3 })
    await page.mouse.move(to.x, to.y, { steps: 3 })
    await page.mouse.up()
    expect(await selection(page)).toEqual({ anchor: { line: 0, col: 6 }, head: { line: 2, col: 5 } })
    expect(await page.evaluate(() => ed.getSelectedText())).toBe('line here\nsecond line here\nthird')

    const word = await charCenter(page, 1, 9)
    await page.mouse.dblclick(word.x, word.y)
    expect(await page.evaluate(() => ed.getSelectedText())).toBe('line')

    await page.mouse.click(word.x, word.y, { clickCount: 3 })
    expect(await page.evaluate(() => ed.getSelectedText())).toBe('second line here\n')
  })

  test('Alt+click adds cursors and typing edits at all of them', async ({ page }) => {
    await page.evaluate(() => void mount({ value: 'one\ntwo\nthree', extensions: J.basicSetup() }))
    await clickAt(page, 0, 3)
    const p1 = await charStart(page, 1, 3)
    const p2 = await charStart(page, 2, 5)
    await page.keyboard.down('Alt')
    await page.mouse.click(p1.x, p1.y)
    await page.mouse.click(p2.x, p2.y)
    await page.keyboard.up('Alt')
    await settle(page)
    expect((await ranges(page)).map((r) => r.head)).toEqual([{ line: 0, col: 3 }, { line: 1, col: 3 }, { line: 2, col: 5 }])
    await expect(page.locator('.jc-cursor:visible')).toHaveCount(3)
    await page.keyboard.type('!')
    expect(await value(page)).toBe('one!\ntwo!\nthree!')
    // Escape goes back to one cursor.
    await page.keyboard.press('Escape')
    expect(await ranges(page)).toHaveLength(1)
  })

  test('Mod-d selects the next occurrences', async ({ page }) => {
    await page.evaluate(() => void mount({ value: 'foo bar foo baz foo', extensions: J.basicSetup() }))
    await clickAt(page, 0, 1)
    await page.keyboard.press('ControlOrMeta+d')
    await page.keyboard.press('ControlOrMeta+d')
    await page.keyboard.press('ControlOrMeta+d')
    expect(await ranges(page)).toHaveLength(3)
    await page.keyboard.type('x')
    expect(await value(page)).toBe('x bar x baz x')
  })

  test('copy, cut and paste through the clipboard', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(() => void mount({ value: 'hello world', extensions: J.basicSetup() }))
    await clickAt(page, 0, 6)
    await page.keyboard.press('Shift+End')
    expect(await page.evaluate(() => ed.getSelectedText())).toBe('world')
    await page.keyboard.press('ControlOrMeta+c')
    // Chromium lets the page read the clipboard back: the copy went through the real clipboard.
    if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('world')
    await page.keyboard.press('End')
    await page.keyboard.press('ControlOrMeta+v')
    expect(await value(page)).toBe('hello worldworld')
    // Cut with an empty selection takes the whole line.
    await page.keyboard.press('ControlOrMeta+x')
    expect(await value(page)).toBe('')
    await page.keyboard.press('ControlOrMeta+v')
    expect(await value(page)).toBe('hello worldworld\n')
  })

  test('right click keeps the selection and hands it to the textarea for the native menu', async ({ page }) => {
    await page.evaluate(() => void mount({ value: 'hello world', extensions: J.basicSetup() }))
    const p = await charCenter(page, 0, 8)
    await page.mouse.dblclick(p.x, p.y)
    expect(await page.evaluate(() => ed.getSelectedText())).toBe('world')
    await page.mouse.click(p.x, p.y, { button: 'right' })
    // The native context menu acts on the textarea: it now holds the selected text, selected, under the pointer
    // (a 3em box centered on it).
    const ta = await page.evaluate(() => {
      const t = ed.inputDOM as HTMLTextAreaElement
      const r = t.getBoundingClientRect()
      return { context: t.classList.contains('jc-context'), value: t.value, start: t.selectionStart, end: t.selectionEnd, rect: r.toJSON(), focused: document.activeElement === t }
    })
    expect(ta).toMatchObject({ context: true, value: 'world', start: 0, end: 5, focused: true })
    expect(p.x).toBeGreaterThan(ta.rect.left)
    expect(p.x).toBeLessThan(ta.rect.right)
    expect(p.y).toBeGreaterThan(ta.rect.top)
    expect(p.y).toBeLessThan(ta.rect.bottom)
    expect(Math.abs((ta.rect.left + ta.rect.right) / 2 - p.x)).toBeLessThan(3)
    // The element under the pointer (what the context menu targets) is that textarea.
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y) === ed.inputDOM, [p.x, p.y])).toBe(true)
    expect(await page.evaluate(() => ed.getSelectedText())).toBe('world')
    // The next key goes back to normal editing.
    await page.keyboard.type('X')
    expect(await value(page)).toBe('hello X')
    expect(await page.evaluate(() => ed.inputDOM.classList.contains('jc-context'))).toBe(false)
  })
})

test.describe('horizontal scrolling', () => {
  test('the caret stays visible at the end of a long line and back at its start', async ({ page }) => {
    await page.evaluate(() => void mount({ value: 'x'.repeat(400) + '\nshort', extensions: J.basicSetup() }, { width: '400px' }))
    await clickAt(page, 0, 0)
    await page.keyboard.press('End')
    await settle(page)
    const inView = () => page.evaluate(() => {
      const c = caretRect()
      const sc = ed.scrollDOM.getBoundingClientRect()
      const gutter = ed.dom.querySelector('.jc-gutters').getBoundingClientRect().width
      return c.left >= sc.left + gutter - 1 && c.right <= sc.left + ed.scrollDOM.clientWidth + 1
    })
    expect(await page.evaluate(() => ed.scrollDOM.scrollLeft)).toBeGreaterThan(0)
    expect(await inView()).toBe(true)
    await page.keyboard.type('END')
    await settle(page)
    expect(await inView()).toBe(true)
    await page.keyboard.press('Home')
    await settle(page)
    expect(await page.evaluate(() => ed.scrollDOM.scrollLeft)).toBe(0)
    expect(await inView()).toBe(true)
  })
})

test.describe('scrolling while selecting', () => {
  test('dragging below the editor autoscrolls and extends the selection', async ({ page }) => {
    await page.evaluate(() => void mount({ value: numberedLines(1000), extensions: J.basicSetup() }))
    const from = await charStart(page, 1, 0)
    const box = (await page.locator('.jc-scroller').boundingBox())!
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 40, box.y + box.height + 40, { steps: 4 })
    // Holding the pointer below the editor keeps scrolling.
    await expect.poll(() => page.evaluate(() => ed.scrollDOM.scrollTop), { timeout: 5000 }).toBeGreaterThan(200)
    await page.mouse.up()
    const sel = await selection(page)
    expect(sel.anchor).toEqual({ line: 1, col: 0 })
    expect(sel.head.line).toBeGreaterThan(12)
    // The head is on the line at the bottom edge (at least partly visible): the one the scroll brought in.
    await settle(page)
    const caret = await page.evaluate(() => caretRect())
    expect(caret.top).toBeLessThan(box.y + box.height)
    expect(caret.top).toBeGreaterThan(box.y + box.height - 2 * (await page.evaluate(() => ed.lineHeight)))
    // Scrolling stopped with the mouse up (the autoscroll runs on animation frames).
    const top = await page.evaluate(() => ed.scrollDOM.scrollTop)
    for (let i = 0; i < 3; i++) await settle(page)
    expect(await page.evaluate(() => ed.scrollDOM.scrollTop)).toBe(top)
  })

  test('PageDown / PageUp move the cursor by a page and scroll with it', async ({ page }) => {
    await page.evaluate(() => void mount({ value: numberedLines(1000), extensions: J.basicSetup() }))
    await clickAt(page, 0, 3)
    const lh = await page.evaluate(() => ed.lineHeight)
    const pageLines = await page.evaluate(() => Math.floor(ed.scrollDOM.clientHeight / ed.lineHeight) - 1)
    await page.keyboard.press('PageDown')
    await settle(page)
    expect(await head(page)).toEqual({ line: pageLines, col: 3 })
    expect(Math.abs((await page.evaluate(() => ed.scrollDOM.scrollTop)) - pageLines * lh)).toBeLessThan(lh)
    await page.keyboard.press('PageDown')
    await page.keyboard.press('PageUp')
    await settle(page)
    expect(await head(page)).toEqual({ line: pageLines, col: 3 })
    await page.keyboard.press('Shift+PageUp')
    expect(await selection(page)).toEqual({ anchor: { line: pageLines, col: 3 }, head: { line: 0, col: 3 } })
  })
})
