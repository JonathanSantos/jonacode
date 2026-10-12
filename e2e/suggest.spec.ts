// Inline AI suggestions (ghost text) with fake sources: debounce, streaming, Tab / word accept, Escape, type-through.
import type { Page } from '@playwright/test'
import { clickAt, expect, head, test, value } from './helpers.ts'

/** The inline part of the ghost text (the first line of the suggestion). */
const ghost = (page: Page) => page.locator('.jc-ghost:not(.jc-ghost-block)')

/**
 * Mounts an editor whose suggestion source answers `answer` 30 ms after being asked (a string), or streams
 * `answer` chunk by chunk through `window.gate` (an array). Calls are recorded on `window.calls`.
 */
async function setup(page: Page, answer: string | string[], doc = '', delay = 150): Promise<void> {
  await page.evaluate(([answer, doc, delay]) => {
    const w = window as any
    w.calls = []
    w.lastChange = 0
    w.gate = makeGate()
    const source = (req: any, signal: AbortSignal) => {
      w.calls.push({ prefix: req.prefix, suffix: req.suffix, language: req.language, sinceChange: performance.now() - w.lastChange })
      w.signal = signal
      if (typeof answer === 'string') return new Promise((r) => setTimeout(() => r(answer), 30))
      return (async function* () {
        for (let i = 0; i < answer.length; i++) {
          if (i) await w.gate.wait(i - 1)
          yield answer[i]
        }
      })()
    }
    mount({ value: doc, language: 'javascript', extensions: [J.basicSetup(), J.inlineSuggestion(source, { delay })] })
    ed.on('change', () => { w.lastChange = performance.now() })
  }, [answer, doc, delay] as const)
}

const calls = (page: Page) => page.evaluate(() => (window as any).calls as { prefix: string; suffix: string; language: string; sinceChange: number }[])

test.describe('inline suggestions', () => {
  test('typing shows the ghost text after the debounce; Tab accepts it as one undo step', async ({ page }) => {
    await setup(page, 'sum(a, b)')
    await page.locator('.jc-content').click()
    await page.keyboard.type('const total = ')
    await expect(ghost(page)).toHaveText('sum(a, b)')
    // Asked once typing stopped for the debounce delay, with the text around the cursor.
    const c = await calls(page)
    expect(c.at(-1)).toMatchObject({ prefix: 'const total = ', suffix: '', language: 'javascript' })
    expect(c.at(-1)!.sinceChange).toBeGreaterThanOrEqual(145)
    // Drawn right after the cursor, on its line; the document is untouched.
    const [box, end] = await page.evaluate(() => [document.querySelector('.jc-ghost')!.getBoundingClientRect().toJSON(), charRect(0, 14)])
    expect(Math.abs(box.left - end.left)).toBeLessThan(1.5)
    expect(Math.abs(box.top - end.top)).toBeLessThan(4)
    expect(await value(page)).toBe('const total = ')
    await expect(page.locator('.jc-input')).toBeFocused()

    await page.keyboard.press('Tab')
    expect(await value(page)).toBe('const total = sum(a, b)')
    expect(await head(page)).toEqual({ line: 0, col: 23 })
    await expect(ghost(page)).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe('const total = ')
  })

  test('a streamed suggestion grows as chunks arrive; Escape dismisses it and aborts the request', async ({ page }) => {
    await setup(page, ['fooBar', '(1, 2)', ' + 3'])
    await page.locator('.jc-content').click()
    await page.keyboard.type('x = ')
    await expect(ghost(page)).toHaveText('fooBar')
    await page.evaluate(() => (window as any).gate.step())
    await expect(ghost(page)).toHaveText('fooBar(1, 2)')
    await page.keyboard.press('Escape')
    await expect(ghost(page)).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).signal.aborted)).toBe(true)
    // The rest of the stream arrives: nothing comes back.
    await page.evaluate(() => (window as any).gate.step())
    await page.evaluate(() => window.settle())
    await expect(ghost(page)).toHaveCount(0)
    expect(await value(page)).toBe('x = ')
  })

  test('typing the suggested chars keeps the rest; Mod-ArrowRight accepts the next word', async ({ page }) => {
    await setup(page, 'getElementById(id)')
    await page.locator('.jc-content').click()
    await page.keyboard.type('document.')
    await expect(ghost(page)).toHaveText('getElementById(id)')
    await page.keyboard.type('get')
    await expect(ghost(page)).toHaveText('ElementById(id)')
    // Not asked again: the suggestion was typed through.
    expect(await calls(page)).toHaveLength(1)
    await page.keyboard.press('ControlOrMeta+ArrowRight')
    expect(await value(page)).toBe('document.getElementById')
    await expect(ghost(page)).toHaveText('(id)')
    await page.keyboard.press('Tab')
    expect(await value(page)).toBe('document.getElementById(id)')
    await expect(ghost(page)).toHaveCount(0)
    // Each accept is its own undo step.
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe('document.getElementById')
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe('document.get')
  })

  test('moving the cursor or typing something else dismisses it', async ({ page }) => {
    await setup(page, 'value', 'let a = 1\n')
    await clickAt(page, 1, 0)
    await page.keyboard.type('a.')
    await expect(ghost(page)).toHaveText('value')
    await page.keyboard.press('ArrowLeft')
    await expect(ghost(page)).toHaveCount(0)
    await page.keyboard.press('End')
    // Typing goes on: asked again for the new text.
    await page.keyboard.type('x')
    await expect(ghost(page)).toHaveText('value')
    expect((await calls(page)).at(-1)!.prefix).toBe('let a = 1\na.x')
    // ("q" isn't the next char of "value": the suggestion is dropped and asked again for the new text.)
    await page.keyboard.type('q')
    await expect.poll(async () => (await calls(page)).at(-1)!.prefix).toBe('let a = 1\na.xq')
    await expect(ghost(page)).toHaveText('value')
    // A click elsewhere dismisses it too.
    await clickAt(page, 0, 2)
    await expect(ghost(page)).toHaveCount(0)
    expect(await value(page)).toBe('let a = 1\na.xq')
  })

  test('a multi-line suggestion gets rows of its own below the line', async ({ page }) => {
    await setup(page, '{\n  return 1\n}', '\nnext()')
    await clickAt(page, 0, 0)
    await page.keyboard.type('function f() ')
    await expect(ghost(page)).toHaveText('{')
    const block = page.locator('.jc-ghost-block')
    await expect(block).toHaveText('  return 1\n}')
    const lh = await page.evaluate(() => ed.lineHeight)
    const [b, line0, line1] = await page.evaluate(() => [
      document.querySelector('.jc-ghost-block')!.getBoundingClientRect().toJSON(),
      lineEl(0)!.getBoundingClientRect().bottom,
      lineEl(1)!.getBoundingClientRect().top,
    ])
    expect(Math.abs(b.top - line0)).toBeLessThan(0.5)
    expect(Math.abs(b.height - 2 * lh)).toBeLessThan(0.5)
    expect(Math.abs(line1 - (line0 + 2 * lh))).toBeLessThan(0.5)
    await page.keyboard.press('Tab')
    expect(await value(page)).toBe('function f() {\n  return 1\n}\nnext()')
    await expect(block).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe('function f() \nnext()')
  })

  test('Tab indents after Escape dismissed a suggestion (the Escape was used up)', async ({ page }) => {
    await setup(page, 'value')
    await page.locator('.jc-content').click()
    await page.keyboard.type('x.')
    await expect(ghost(page)).toHaveText('value')
    await page.keyboard.press('Escape')
    await expect(ghost(page)).toHaveCount(0)
    await page.keyboard.press('Tab')
    await expect(page.locator('.jc-input')).toBeFocused()
    expect(await value(page)).toBe('x.  ')
  })
})
