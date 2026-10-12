// Autocomplete: opens while typing, keyboard navigation, accept with Enter / Tab / click, Escape closes.
import type { Page } from '@playwright/test'
import { clickAt, expect, head, settle, test, value } from './helpers.ts'

const DOC = 'const counter = 1\nconsole.log(counter)\nfunction getElementById(id) { return id }\n'

/** Visible labels, selected index and the textarea's ARIA state. */
const state = (page: Page) => page.evaluate(() => {
  const el = ed.dom.querySelector('.jc-ac')
  const lis = [...el.querySelectorAll('li')] as HTMLElement[]
  const ta = ed.inputDOM
  return {
    visible: !el.hidden,
    labels: lis.map((li) => li.querySelector('.jc-ac-label')!.textContent),
    selected: lis.findIndex((li) => li.getAttribute('aria-selected') === 'true'),
    selectedId: lis.find((li) => li.getAttribute('aria-selected') === 'true')?.id ?? null,
    expanded: ta.getAttribute('aria-expanded'),
    activedescendant: ta.getAttribute('aria-activedescendant'),
    controls: ta.getAttribute('aria-controls'),
    listId: el.querySelector('ul').id,
  }
})

test.describe('autocomplete', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((doc) => void mount({ value: doc, language: 'javascript', extensions: [J.basicSetup(), J.autocomplete()] }), DOC)
    await clickAt(page, 3, 0)
  })

  test('typing opens the list with language and document words, ARIA follows', async ({ page }) => {
    await page.keyboard.type('co')
    const list = page.locator('.jc-ac')
    await expect(list).toBeVisible()
    const s = await state(page)
    expect(s.labels).toEqual(expect.arrayContaining(['const', 'counter', 'console']))
    expect(s.selected).toBe(0)
    expect(s.expanded).toBe('true')
    expect(s.controls).toBe(s.listId)
    expect(s.activedescendant).toBe(s.selectedId)
    await expect(page.getByRole('listbox')).toBeVisible()
    await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
    // The list sits below the word, its labels aligned with the typed text.
    const box = (await list.boundingBox())!
    const word = await page.evaluate(() => charRect(3, 0))
    expect(box.y).toBeGreaterThanOrEqual(word.bottom - 1)
    // Fuzzy re-filtering while typing.
    await page.keyboard.type('u')
    expect((await state(page)).labels[0]).toBe('counter')
  })

  test('arrows navigate (wrapping), Enter accepts and undo reverts only the completion', async ({ page }) => {
    await page.keyboard.type('co')
    await page.keyboard.press('ArrowDown')
    let s = await state(page)
    expect(s.selected).toBe(1)
    expect(s.activedescendant).toBe(s.selectedId)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    s = await state(page)
    expect(s.selected).toBe(s.labels.length - 1)
    await page.keyboard.press('ArrowDown')
    s = await state(page)
    const pick = s.labels[s.selected]!
    await page.keyboard.press('Enter')
    await expect(page.locator('.jc-ac')).toBeHidden()
    expect(await page.evaluate(() => ed.doc.line(3))).toBe(pick)
    expect(await head(page)).toEqual({ line: 3, col: pick.length })
    s = await state(page)
    expect(s.expanded).toBeNull()
    expect(s.activedescendant).toBeNull()
    await page.keyboard.press('ControlOrMeta+z')
    expect(await page.evaluate(() => ed.doc.line(3))).toBe('co')
  })

  test('Tab accepts and replaces the rest of the word', async ({ page }) => {
    await page.keyboard.type('getElem')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    // Ctrl-Space inside the word: the query is the part before the cursor.
    await page.keyboard.press('Control+Space')
    await expect(page.locator('.jc-ac')).toBeVisible()
    expect((await state(page)).labels[0]).toBe('getElementById')
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => ed.doc.line(3))).toBe('getElementById')
    expect(await head(page)).toEqual({ line: 3, col: 14 })
  })

  test('Escape closes; Enter then inserts a newline', async ({ page }) => {
    await page.keyboard.type('cons')
    await expect(page.locator('.jc-ac')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.jc-ac')).toBeHidden()
    await page.keyboard.press('Enter')
    expect(await value(page)).toBe(DOC + 'cons\n')
  })

  test('clicking an option accepts it and keeps the focus in the editor', async ({ page }) => {
    await page.keyboard.type('co')
    const option = page.locator('.jc-ac li', { hasText: 'console' })
    await option.hover()
    const s = await state(page)
    expect(s.labels[s.selected]).toBe('console')
    await option.click()
    expect(await page.evaluate(() => ed.doc.line(3))).toBe('console')
    await expect(page.locator('.jc-input')).toBeFocused()
    await expect(page.locator('.jc-ac')).toBeHidden()
  })

  test('no automatic list inside comments, Ctrl-Space still opens it', async ({ page }) => {
    await page.keyboard.type('// co')
    // The list opens synchronously with the edit (sync sources): after a render it would be there.
    await settle(page)
    await expect(page.locator('.jc-ac')).toBeHidden()
    await page.keyboard.press('Control+Space')
    await expect(page.locator('.jc-ac')).toBeVisible()
  })
})
