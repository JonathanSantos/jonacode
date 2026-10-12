// Find & replace panel (single and multi-line queries) and the "go to line" panel.
import { clickAt, expect, head, isLineVisible, keys, selection, settle, test, value } from './helpers.ts'

const TEXT = `alpha foo
beta
foo gamma
beta
delta foo`

test.describe('search & replace', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((text) => void mount({ value: text, extensions: J.basicSetup() }), TEXT)
    await settle(page)
  })

  test('Mod-f opens the panel, typing finds and counts, Enter / Shift+Enter cycle', async ({ page }) => {
    await clickAt(page, 0, 0)
    await page.keyboard.press('ControlOrMeta+f')
    const panel = page.locator('.jc-search')
    await expect(panel).toBeVisible()
    await expect(page.locator('.jc-search-input')).toBeFocused()
    await page.keyboard.type('foo')
    const count = page.locator('.jc-search-count')
    await expect(count).toHaveText('1 / 3')
    expect(await selection(page)).toEqual({ anchor: { line: 0, col: 6 }, head: { line: 0, col: 9 } })
    await expect(page.locator('.jc-search-match')).toHaveCount(3)
    await expect(page.locator('.jc-search-current')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(count).toHaveText('2 / 3')
    expect(await selection(page)).toEqual({ anchor: { line: 2, col: 0 }, head: { line: 2, col: 3 } })
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect(count).toHaveText('1 / 3')
    await page.keyboard.press('Shift+Enter')
    await expect(count).toHaveText('3 / 3')
    // The highlight sits on the matched chars (read in one go: the layer is redrawn on each frame).
    await settle(page)
    const [current, first] = await page.evaluate(() => [ed.dom.querySelector('.jc-search-current').getBoundingClientRect().left, charRect(4, 6).left])
    expect(Math.abs(current - first)).toBeLessThan(1.5)
    // Escape closes and gives the focus back, keeping the match selected.
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(page.locator('.jc-input')).toBeFocused()
    await expect(page.locator('.jc-search-match')).toHaveCount(0)
    expect(await page.evaluate(() => ed.getSelectedText())).toBe('foo')
  })

  test('options: whole word, case and regular expression', async ({ page }) => {
    await page.evaluate(() => ed.setValue('Foo food foo\nfoo'))
    await clickAt(page, 0, 0)
    await page.keyboard.press('ControlOrMeta+f')
    await page.keyboard.type('foo')
    const count = page.locator('.jc-search-count')
    await expect(count).toHaveText(/\/ 4$/)
    await page.locator('[data-opt="caseSensitive"]').click()
    await expect(page.locator('[data-opt="caseSensitive"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(count).toHaveText(/\/ 3$/)
    await page.locator('[data-opt="wholeWord"]').click()
    await expect(count).toHaveText(/\/ 2$/)
    await page.locator('.jc-search-input').fill('f.o+d')
    await expect(count).toHaveText('No results')
    await page.locator('[data-opt="regexp"]').click()
    await expect(count).toHaveText(/1$/)
    await page.locator('.jc-search-input').fill('f(')
    await expect(count).toHaveText('Invalid')
    await expect(page.locator('.jc-search-input')).toHaveClass(/jc-search-invalid/)
  })

  test('a multi-line query (Mod-Enter types a newline) matches across lines', async ({ page }) => {
    await clickAt(page, 0, 0)
    await page.keyboard.press('ControlOrMeta+f')
    await page.keyboard.type('foo')
    await page.keyboard.press('ControlOrMeta+Enter')
    await page.keyboard.type('beta')
    expect(await page.locator('.jc-search-input').inputValue()).toBe('foo\nbeta')
    const count = page.locator('.jc-search-count')
    await expect(count).toHaveText('1 / 1')
    expect(await selection(page)).toEqual({ anchor: { line: 0, col: 6 }, head: { line: 1, col: 4 } })
    // One highlight rect per row of the match.
    await expect(page.locator('.jc-search-match')).toHaveCount(2)
    // The field grew to two rows.
    const h = await page.locator('.jc-search-input').evaluate((el) => el.getBoundingClientRect().height)
    expect(h).toBeGreaterThan(30)
  })

  test('replace one, then replace all (multi-line)', async ({ page }) => {
    await clickAt(page, 0, 0)
    await page.keyboard.press(keys.replace)
    await expect(page.locator('.jc-search-replace')).toBeVisible()
    await page.keyboard.type('foo')
    await expect(page.locator('.jc-search-count')).toHaveText('1 / 3')
    await page.locator('.jc-replace-input').click()
    await page.keyboard.type('X')
    // Enter in the replace field replaces the current match and moves on.
    await page.keyboard.press('Enter')
    expect(await value(page)).toBe(TEXT.replace('foo', 'X'))
    await expect(page.locator('.jc-search-count')).toHaveText(/\/ 2$/)

    // Multi-line: "beta\n" + something → one line.
    await page.locator('.jc-search-input').click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('beta')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.locator('.jc-search-count')).toHaveText(/\/ 2$/)
    await page.locator('.jc-replace-input').fill('B;')
    await page.getByRole('button', { name: 'Replace all' }).click()
    expect(await value(page)).toBe('alpha X\nB;foo gamma\nB;delta foo')
    await expect(page.locator('.jc-search-count')).toHaveText('No results')
    // Replace all is a single undo step.
    await page.locator('.jc-search-input').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.jc-input')).toBeFocused()
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe(TEXT.replace('foo', 'X'))
  })

  test('Escape closes the panel after clicking one of its buttons', async ({ page }) => {
    await clickAt(page, 0, 0)
    await page.keyboard.press('ControlOrMeta+f')
    await page.keyboard.type('foo')
    await page.locator('[data-opt="caseSensitive"]').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.jc-search')).toBeHidden()
    await expect(page.locator('.jc-input')).toBeFocused()
  })
})

test.describe('go to line', () => {
  test('Ctrl-g jumps to a line (absolute, line:col, relative, percent) and centers it', async ({ page }) => {
    await page.evaluate(() => void mount({ value: numberedLines(1000), extensions: J.basicSetup() }))
    await page.locator('.jc-content').click()
    const panel = page.locator('.jc-goto')
    await page.keyboard.press('Control+g')
    await expect(panel).toBeVisible()
    await expect(panel.locator('input')).toBeFocused()
    await expect(panel.locator('small')).toHaveText('1–1,000')
    await page.keyboard.type('150')
    await page.keyboard.press('Enter')
    await expect(panel).toBeHidden()
    await expect(page.locator('.jc-input')).toBeFocused()
    await settle(page)
    expect(await head(page)).toEqual({ line: 149, col: 0 })
    expect(await isLineVisible(page, 'const line150 = compute(149, 298) // 150')).toBe(true)

    await page.keyboard.press('Control+g')
    await page.keyboard.type('500:7')
    await page.keyboard.press('Enter')
    expect(await head(page)).toEqual({ line: 499, col: 6 })

    await page.keyboard.press('Control+g')
    await page.keyboard.type('-99')
    await page.keyboard.press('Enter')
    expect((await head(page)).line).toBe(400)

    await page.keyboard.press('Control+g')
    await page.keyboard.type('100%')
    await page.keyboard.press('Enter')
    expect((await head(page)).line).toBe(999)

    // Invalid input keeps the panel open and flags it; Escape closes.
    await page.keyboard.press('Control+g')
    await page.keyboard.type('abc')
    await page.keyboard.press('Enter')
    await expect(panel).toBeVisible()
    await expect(panel.locator('input')).toHaveClass(/jc-goto-invalid/)
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(page.locator('.jc-input')).toBeFocused()
  })
})
