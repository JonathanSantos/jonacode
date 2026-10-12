// Tree-sitter validation in a real page: web-tree-sitter and the grammars are served from node_modules.
import type { Page } from '@playwright/test'
import { charCenter, clickAt, expect, settle, test, value } from './helpers.ts'

const GRAMMARS: Record<string, string> = {
  javascript: '/node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm',
  css: '/node_modules/tree-sitter-css/tree-sitter-css.wasm',
  html: '/node_modules/tree-sitter-html/tree-sitter-html.wasm',
}

/** Mounts an editor with treeSitter() and waits for the first parse. */
async function mountTS(page: Page, doc: string, language: string, extra: Record<string, unknown> = {}) {
  await page.evaluate(async ([d, lang, g, x]) => {
    mount({
      value: d, language: lang,
      extensions: [J.basicSetup(), J.treeSitter({ load: () => import('/node_modules/web-tree-sitter/web-tree-sitter.js'), grammars: g, delay: 40, ...x })],
    })
    await J.whenParsed(ed)
  }, [doc, language, GRAMMARS, extra] as const)
  await settle(page)
}

const marks = (page: Page) => page.evaluate(() => ed.dom.querySelectorAll('.jc-diag').length)

test.describe('tree-sitter', () => {
  test('a syntax error typed in the editor is underlined; its quick fix corrects it', async ({ page }) => {
    await mountTS(page, 'const total = soma(1, 2)', 'javascript')
    expect(await marks(page)).toBe(0)
    await clickAt(page, 0, 24)
    await page.keyboard.press('Backspace')
    expect(await value(page)).toBe('const total = soma(1, 2')
    await expect.poll(() => marks(page)).toBe(1)
    // The gutter shows it, and the hover tooltip explains it with a fix.
    expect(await page.evaluate(() => ed.dom.querySelectorAll('.jc-diag-marker.jc-diag-error').length)).toBe(1)
    const at = await charCenter(page, 0, 18)
    await page.mouse.move(at.x - 30, at.y)
    await page.mouse.move(at.x, at.y)
    const tip = page.locator('.jc-tooltip')
    await expect(tip).toContainText('Unclosed `(`')
    await tip.getByRole('button', { name: 'Insert `)`' }).click()
    expect(await value(page)).toBe('const total = soma(1, 2)')
    await expect.poll(() => marks(page)).toBe(0)
  })

  test('HTML: code inside <script> and <style> is checked with its own grammar', async ({ page }) => {
    await mountTS(page, '<main>\n  <script>\n    let x = [1, 2\n  </script>\n  <style>a { color: red; } }</style>\n</main>', 'html')
    await expect.poll(() => page.evaluate(async () => (await J.getSyntaxProblems(ed)).map((p: any) => p.message))).toEqual(['Unclosed `[`', 'Unexpected `}`'])
    await expect.poll(() => marks(page)).toBe(2)
  })

  test('typing stays smooth while a 20k-line file is parsed (idle slices)', async ({ page }) => {
    const gaps = await page.evaluate(async (g) => {
      const unit = 'function f(a, b) {\n  const x = a + b * 2\n  if (x > 10) { return x } else { return -x }\n}\n'
      mount({ value: unit.repeat(5000), language: 'javascript', extensions: [J.basicSetup()] })
      await settle()
      // Frames while tree-sitter loads, parses the whole file and re-parses after an edit.
      let last = performance.now()
      let worst = 0
      let running = true
      const tick = () => {
        const now = performance.now()
        worst = Math.max(worst, now - last)
        last = now
        if (running) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      ed.setExtensions([J.basicSetup(), J.treeSitter({ load: () => import('/node_modules/web-tree-sitter/web-tree-sitter.js'), grammars: g, delay: 20 })])
      await J.whenParsed(ed)
      const first = worst
      worst = 0
      ed.dispatch({ changes: { from: { line: 10000, col: 0 }, insert: 'oops(' } })
      const problems = await J.getSyntaxProblems(ed)
      running = false
      return { first, edit: worst, problems: problems.map((p: any) => `${p.from.line}:${p.message}`) }
    }, GRAMMARS)
    console.log(`[frames] ${test.info().project.name}: load+parse worst ${Math.round(gaps.first)} ms, edit worst ${Math.round(gaps.edit)} ms`)
    expect(gaps.problems).toEqual(['10000:Unclosed `(`'])
    // Loading and parsing never blocks a frame for long (the first frame includes compiling the wasm off-thread).
    expect(gaps.edit).toBeLessThan(120)
    expect(gaps.first).toBeLessThan(250)
  })

  test('Alt+Shift+→ / ← expand and shrink the selection by syntax node', async ({ page }) => {
    await mountTS(page, 'const total = soma(a, b * 2)', 'javascript')
    await clickAt(page, 0, 22)
    const expand = process.platform === 'darwin' ? 'Control+Shift+Meta+ArrowRight' : 'Alt+Shift+ArrowRight'
    const shrink = process.platform === 'darwin' ? 'Control+Shift+Meta+ArrowLeft' : 'Alt+Shift+ArrowLeft'
    const selected = () => page.evaluate(() => ed.getSelectedText())
    await page.keyboard.press(expand)
    expect(await selected()).toBe('b')
    await page.keyboard.press(expand)
    expect(await selected()).toBe('b * 2')
    await page.keyboard.press(shrink)
    expect(await selected()).toBe('b')
  })
})
