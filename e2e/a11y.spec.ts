// Accessibility basics: roles and labels, the screen-reader mirror in the textarea, no keyboard trap; IME.
import type { Page } from '@playwright/test'
import { clickAt, expect, head, test, value } from './helpers.ts'

/** What a screen reader gets from the textarea: its value and selection. */
const mirror = (page: Page) => page.evaluate(() => {
  const ta = ed.inputDOM as HTMLTextAreaElement
  return { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd }
})

test.describe('accessibility', () => {
  test('the textarea is a labelled multi-line textbox; decoration is hidden', async ({ page }) => {
    await page.evaluate(() => void mount({ value: 'a\nb', ariaLabel: 'Query editor', extensions: J.basicSetup() }))
    const textbox = page.getByRole('textbox', { name: 'Query editor' })
    await expect(textbox).toHaveCount(1)
    await expect(textbox).toHaveAttribute('aria-multiline', 'true')
    await expect(textbox).toHaveAttribute('aria-roledescription', 'code editor')
    await expect(page.locator('.jc-gutters')).toHaveAttribute('aria-hidden', 'true')
    // The option can be changed later.
    await page.evaluate(() => ed.setOptions({ ariaLabel: 'SQL' }))
    await expect(page.getByRole('textbox', { name: 'SQL' })).toHaveCount(1)
    // Clicking the text focuses the textbox.
    await page.locator('.jc-content').click()
    await expect(page.getByRole('textbox', { name: 'SQL' })).toBeFocused()
  })

  test("the textarea mirrors the cursor's lines and selection, and follows the cursor", async ({ page }) => {
    await page.evaluate(() => void mount({ value: numberedLines(100), extensions: J.basicSetup() }))
    await clickAt(page, 2, 6)
    let m = await mirror(page)
    const lines = await page.evaluate(() => ed.doc.lines.slice(0, 10))
    // A page of 10 lines around the cursor, with the caret at the same place.
    expect(m.value).toBe(lines.join('\n'))
    const offset = lines[0]!.length + 1 + lines[1]!.length + 1 + 6
    expect([m.start, m.end]).toEqual([offset, offset])

    // Moving down past the page: the mirror follows (lines 20–29 for line 24).
    for (let i = 0; i < 22; i++) await page.keyboard.press('ArrowDown')
    expect(await head(page)).toEqual({ line: 24, col: 6 })
    m = await mirror(page)
    const page2 = await page.evaluate(() => ed.doc.lines.slice(20, 30))
    expect(m.value).toBe(page2.join('\n'))
    const lineStart = page2.slice(0, 4).reduce((n: number, l: string) => n + l.length + 1, 0)
    expect(m.value.slice(lineStart, m.start)).toBe('const ')

    // A selection is mirrored too (Shift+End selects to the end of the line).
    await page.keyboard.press('Shift+End')
    m = await mirror(page)
    expect(m.value.slice(m.start, m.end)).toBe(page2[4]!.slice(6))

    // Typing still goes through the mirror.
    await page.keyboard.press('End')
    await page.keyboard.type(' ;')
    expect(await page.evaluate(() => ed.doc.line(24))).toBe(page2[4] + ' ;')
    expect((await mirror(page)).value.split('\n')[4]).toBe(page2[4] + ' ;')
  })

  test('Tab indents; Escape then Tab leaves the editor (no keyboard trap)', async ({ page }) => {
    await page.evaluate(() => void mount({ value: 'x', extensions: J.basicSetup() }))
    await clickAt(page, 0, 0)
    await page.keyboard.press('Tab')
    expect(await value(page)).toBe('  x')
    await expect(page.locator('.jc-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    await expect(page.locator('#after')).toBeFocused()
    expect(await value(page)).toBe('  x')
    // Back with Shift+Tab (from outside, it just focuses the editor).
    await page.keyboard.press('Shift+Tab')
    await expect(page.locator('.jc-input')).toBeFocused()
    expect(await value(page)).toBe('  x')
  })

  test('Escape then Shift+Tab leaves the editor backwards', async ({ page }) => {
    // A real keyboard sends a Shift keydown before Tab: modifier-only keys must not cancel the Escape.
    await page.evaluate(() => void mount({ value: '  x', extensions: J.basicSetup() }))
    await clickAt(page, 0, 2)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+Tab')
    await expect(page.locator('#before')).toBeFocused()
    expect(await value(page)).toBe('  x')
  })

  test('read-only editors never trap Tab', async ({ page }) => {
    await page.evaluate(() => void mount({ value: 'x', readOnly: true, extensions: J.basicSetup() }))
    await page.locator('.jc-content').click()
    await expect(page.locator('.jc-input')).toBeFocused()
    await page.keyboard.type('abc')
    expect(await value(page)).toBe('x')
    await page.keyboard.press('Tab')
    await expect(page.locator('#after')).toBeFocused()
  })
})

test.describe('IME composition', () => {
  test('composed text is previewed, then committed once', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'IME composition can only be driven through CDP (Input.imeSetComposition), Chromium only')
    await page.evaluate(() => void mount({ value: 'const a = 1', language: 'javascript', extensions: J.basicSetup() }))
    await clickAt(page, 0, 6)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
    await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 })
    // While composing: the document is untouched, the text is previewed at the cursor.
    await expect(page.locator('.jc-editor')).toHaveClass(/jc-composing/)
    await expect(page.locator('.jc-composition')).toHaveText('に')
    expect(await value(page)).toBe('const a = 1')
    const [preview, at] = await page.evaluate(() => [document.querySelector('.jc-composition')!.getBoundingClientRect().left, charRect(0, 6).left])
    expect(Math.abs(preview! - at!)).toBeLessThan(1.5)
    await cdp.send('Input.insertText', { text: 'に' })
    await expect(page.locator('.jc-editor')).not.toHaveClass(/jc-composing/)
    await expect(page.locator('.jc-composition')).toBeHidden()
    expect(await value(page)).toBe('const にa = 1')
    expect(await head(page)).toEqual({ line: 0, col: 7 })
    // A dead-key style composition, then plain typing.
    await cdp.send('Input.imeSetComposition', { text: '´', selectionStart: 1, selectionEnd: 1 })
    await cdp.send('Input.insertText', { text: 'é' })
    await page.keyboard.type('x')
    expect(await value(page)).toBe('const にéxa = 1')
    // The mirror is back in sync with the document.
    const m = await mirror(page)
    expect(m.value).toBe('const にéxa = 1')
    expect(m.start).toBe(9)
    // Undo removes what was typed.
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).not.toContain('x')
  })
})
