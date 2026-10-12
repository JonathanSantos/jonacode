// Inline edit with AI (Mod-k): prompt above the lines, streamed preview, one-step apply, Escape.
import type { Page } from '@playwright/test'
import { clickAt, expect, selection, settle, test, value } from './helpers.ts'

const DOC = 'function double(a) {\n  const x = a\n  return x\n}\ndone()'

/** An editor whose inline-edit source streams `chunks`, one per `window.gate.step()`; requests land on `window.req`. */
async function setup(page: Page, chunks: string[]): Promise<void> {
  await page.evaluate(([doc, chunks]) => {
    const w = window as any
    w.gate = makeGate()
    w.applied = []
    const source = async function* (req: any, signal: AbortSignal) {
      w.req = { instruction: req.instruction, text: req.text, from: req.from, to: req.to, before: req.before, after: req.after, language: req.language }
      w.signal = signal
      for (let i = 0; i < chunks.length; i++) {
        await w.gate.wait(i)
        yield chunks[i]
      }
    }
    mount({ value: doc, language: 'javascript', extensions: [J.basicSetup(), J.inlineEdit(source, { onApply: (_e: any, before: string) => w.applied.push(before) })] })
  }, [DOC, chunks] as const)
}

/** Selects lines 2–3 with the keyboard. */
async function selectBody(page: Page): Promise<void> {
  await clickAt(page, 1, 0)
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+End')
}

const prompt = (page: Page) => page.locator('.jc-ie')
const input = (page: Page) => page.locator('.jc-ie input')

test.describe('inline edit', () => {
  test('Mod-k opens the prompt above the selected lines, focused', async ({ page }) => {
    await setup(page, ['x'])
    await selectBody(page)
    await page.keyboard.press('ControlOrMeta+k')
    await expect(prompt(page)).toBeVisible()
    await expect(input(page)).toBeFocused()
    await expect(input(page)).toHaveAttribute('aria-label', 'Edit with AI')
    await expect(prompt(page).locator('small')).toHaveText('Lines 2–3')
    // The prompt takes two rows right above line 2; the target lines are tinted.
    const lh = await page.evaluate(() => ed.lineHeight)
    const [box, line1, line0] = await page.evaluate(() => [
      document.querySelector('.jc-ie')!.getBoundingClientRect().toJSON(),
      lineEl(1)!.getBoundingClientRect().top,
      lineEl(0)!.getBoundingClientRect().bottom,
    ])
    expect(Math.abs(box.bottom - line1)).toBeLessThan(0.5)
    expect(Math.abs(box.top - line0)).toBeLessThan(0.5)
    expect(Math.abs(box.height - 2 * lh)).toBeLessThan(0.5)
    await expect(page.locator('.jc-line-deco.jc-ie-target')).toHaveCount(2)
    // Typing goes to the prompt, not to the document.
    await page.keyboard.type('double it')
    await expect(input(page)).toHaveValue('double it')
    expect(await value(page)).toBe(DOC)
  })

  test('Enter streams the answer into a preview; the document changes once, at the end, in one undo step', async ({ page }) => {
    await setup(page, ['  return ', 'a * 2', '\n'])
    await selectBody(page)
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('double it')
    await page.keyboard.press('Enter')
    await expect(prompt(page)).toHaveClass(/jc-ie-busy/)
    await expect(input(page)).not.toBeEditable()
    const preview = page.locator('.jc-ie-preview')
    await expect(preview).toHaveText('Generating…')
    expect(await page.evaluate(() => (window as any).req)).toMatchObject({
      instruction: 'double it', text: '  const x = a\n  return x', from: { line: 1, col: 0 }, to: { line: 2, col: 10 },
      before: 'function double(a) {\n', after: '\n}\ndone()', language: 'javascript',
    })
    // Chunks arrive one by one; the preview follows, the document doesn't change.
    await page.evaluate(() => (window as any).gate.step())
    await expect(preview).toHaveText('  return ')
    await page.evaluate(() => (window as any).gate.step())
    await expect(preview).toHaveText('  return a * 2')
    expect(await value(page)).toBe(DOC)
    // Below the target lines, highlighted with the language.
    const [p, line2] = await page.evaluate(() => [document.querySelector('.jc-ie-preview')!.getBoundingClientRect().top, lineEl(2)!.getBoundingClientRect().bottom])
    expect(Math.abs(p! - line2!)).toBeLessThan(0.5)
    await expect(preview.locator('.jc-t-keyword')).toHaveText('return')
    await expect(page.locator('.jc-line-deco.jc-ie-old')).toHaveCount(2)
    // The end of the stream: replaced (the final newline dropped), prompt closed, focus back in the editor.
    await page.evaluate(() => (window as any).gate.step())
    await expect(prompt(page)).toHaveCount(0)
    expect(await value(page)).toBe('function double(a) {\n  return a * 2\n}\ndone()')
    await expect(page.locator('.jc-input')).toBeFocused()
    expect(await page.evaluate(() => ed.getSelectedText())).toBe('  return a * 2')
    expect(await page.evaluate(() => (window as any).applied)).toEqual([DOC])
    await expect(page.locator('.jc-ie-preview')).toHaveCount(0)
    // One undo step.
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe(DOC)
  })

  test('Escape closes the prompt and gives the focus back with the selection intact', async ({ page }) => {
    await setup(page, ['x'])
    await selectBody(page)
    const before = await selection(page)
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('something')
    await page.keyboard.press('Escape')
    await expect(prompt(page)).toHaveCount(0)
    await expect(page.locator('.jc-input')).toBeFocused()
    expect(await selection(page)).toEqual(before)
    await settle(page)
    await expect(page.locator('.jc-line-deco.jc-ie-target')).toHaveCount(0)
    expect(await value(page)).toBe(DOC)
    // The editor gets the keys again.
    await page.keyboard.press('Backspace')
    expect(await value(page)).toBe('function double(a) {\n\n}\ndone()')
  })

  test('Escape while streaming stops it: nothing is replaced, the prompt stays for another try', async ({ page }) => {
    await setup(page, ['  return 0', '\n'])
    await selectBody(page)
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('zero')
    await page.keyboard.press('Enter')
    await page.evaluate(() => (window as any).gate.step())
    await expect(page.locator('.jc-ie-preview')).toHaveText('  return 0')
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => (window as any).signal.aborted)).toBe(true)
    await expect(prompt(page)).not.toHaveClass(/jc-ie-busy/)
    await expect(page.locator('.jc-ie-preview')).toHaveCount(0)
    await expect(input(page)).toBeFocused()
    await page.evaluate(() => (window as any).gate.step())
    await settle(page)
    expect(await value(page)).toBe(DOC)
    // A second Escape closes it.
    await page.keyboard.press('Escape')
    await expect(prompt(page)).toHaveCount(0)
  })
})
