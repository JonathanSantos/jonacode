// The indentation defaults of a language (`indent.useTabs`, `indent.size`), and the editor options that win over them.
import type { Page } from '@playwright/test'
import { expect, place, settle, test, value } from './helpers.ts'

const DOC = 'package main\n\nfunc main() {\n}'

/** Mounts an editor on a tab-indented language (like Go), with the given editor options. */
async function mountGo(page: Page, options: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(([doc, o]) => {
    const w = window as any
    w.go = J.defineLanguage({ name: 'go', extensions: ['.go'], states: { root: [] }, brackets: [['{', '}']], indent: { useTabs: true, size: 4 } })
    mount({ value: doc, language: w.go, extensions: J.basicSetup(), ...o })
  }, [DOC, options] as const)
  await settle(page)
}

const indent = (page: Page) => page.evaluate(() => ({
  ...ed.options,
  unit: ed.indentUnit,
  css: ed.dom.style.getPropertyValue('--jc-tab-size'),
})).then(({ tabSize, insertSpaces, unit, css }) => ({ tabSize, insertSpaces, unit, css }))

test.describe('indentation defaults of the language', () => {
  test('a language indented with tabs: Tab and Enter insert a tab, drawn with the language width', async ({ page }) => {
    await mountGo(page)
    expect(await indent(page)).toEqual({ tabSize: 4, insertSpaces: false, unit: '\t', css: '4' })
    await place(page, 3, 0)
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => ed.doc.line(3))).toBe('\t}')
    await page.keyboard.press('ControlOrMeta+z')
    // Enter after `{` indents the new line with a tab too.
    await place(page, 2, 13)
    await page.keyboard.press('Enter')
    await page.keyboard.type('x')
    expect(await value(page)).toBe('package main\n\nfunc main() {\n\tx\n}')
    // A tab is four columns wide on screen.
    const [tab, x] = await page.evaluate(() => [charRect(3, 0).width, ed.charWidth])
    expect(Math.abs(tab! - 4 * x!)).toBeLessThan(0.5)
  })

  test('options given to the editor win over the language', async ({ page }) => {
    await mountGo(page, { insertSpaces: true })
    expect(await indent(page)).toEqual({ tabSize: 4, insertSpaces: true, unit: '    ', css: '4' })
    await place(page, 3, 0)
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => ed.doc.line(3))).toBe('    }')
    await mountGo(page, { tabSize: 8 })
    expect(await indent(page)).toEqual({ tabSize: 8, insertSpaces: false, unit: '\t', css: '8' })
    await mountGo(page, { tabSize: 2, insertSpaces: true })
    expect(await indent(page)).toEqual({ tabSize: 2, insertSpaces: true, unit: '  ', css: '2' })
  })

  test('setOptions({ language }) resolves the indentation again; what the app set stays', async ({ page }) => {
    await page.evaluate((doc) => void mount({ value: doc, language: 'javascript', extensions: J.basicSetup() }), DOC)
    await settle(page)
    expect(await indent(page)).toEqual({ tabSize: 2, insertSpaces: true, unit: '  ', css: '2' })
    await page.evaluate(() => {
      const w = window as any
      w.go = J.defineLanguage({ name: 'go', states: { root: [] }, indent: { useTabs: true, size: 4 } })
      ed.setOptions({ language: w.go })
    })
    expect(await indent(page)).toEqual({ tabSize: 4, insertSpaces: false, unit: '\t', css: '4' })
    // Back to a language without defaults: the editor's own (2 spaces).
    await page.evaluate(() => ed.setOptions({ language: J.javascript }))
    expect(await indent(page)).toEqual({ tabSize: 2, insertSpaces: true, unit: '  ', css: '2' })
    // Once the app chooses, a language no longer changes it.
    await page.evaluate(() => {
      ed.setOptions({ insertSpaces: true, tabSize: 3 })
      ed.setOptions({ language: (window as any).go })
    })
    expect(await indent(page)).toEqual({ tabSize: 3, insertSpaces: true, unit: '   ', css: '3' })
  })
})
