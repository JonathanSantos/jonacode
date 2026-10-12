// Text measurement across engines: tabs, CJK, emoji and combining marks (the editor measures these on the DOM).
import type { Page } from '@playwright/test'
import { expect, head, settle, test } from './helpers.ts'

/** Lines whose graphemes are single code points (or surrogate pairs). */
const SIMPLE = [
  'a\tbc\t\td',
  'x = "日本語のテキスト" // ok',
  'emoji 🎉 party ✓ end',
  'naïve Ωmega façade',
  'mixed\t日本\t🎉\tend',
]
/** Graphemes made of several code points: emoji modifiers, combining marks, ZWJ sequences, flags. */
const CLUSTERS = [
  'thumbs 👍🏽 up',
  'café ok',
  'family 👨‍👩‍👧 x',
  'flag 🇧🇷 y',
]
const LINES = [...SIMPLE, ...CLUSTERS]

/** Clicks the left edge of every grapheme of the lines, then past their end; returns the misses. */
async function clickEveryChar(page: Page, lines: number[]): Promise<string[]> {
  const misses: string[] = []
  for (const line of lines) {
    const bounds = await page.evaluate((l) => graphemes(ed.doc.line(l)), line)
    for (const col of bounds.slice(0, -1)) {
      const r = await page.evaluate(([l, c]) => charRect(l, c), [line, col])
      await page.mouse.click(r.left + Math.min(2, r.width / 4), r.top + r.height / 2)
      const h = await head(page)
      if (h.line !== line || h.col !== col) misses.push(`line ${line + 1}: clicked before col ${col}, got ${h.line + 1}:${h.col}`)
    }
    const end = await page.evaluate((l) => charRect(l, ed.doc.line(l).length), line)
    await page.mouse.click(end.right + 30, end.top + end.height / 2)
    const h = await head(page)
    if (h.line !== line || h.col !== bounds.at(-1)) misses.push(`line ${line + 1}: clicked past the end, got ${h.line + 1}:${h.col}`)
  }
  return misses
}

test.describe('text geometry', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((text) => void mount({ value: text, extensions: J.basicSetup() }), LINES.join('\n'))
    await settle(page)
  })

  test('a click on the left edge of each character puts the cursor before it', async ({ page }) => {
    expect(await clickEveryChar(page, SIMPLE.map((_, i) => i))).toEqual([])
  })

  test('a click never lands inside a multi-code-point grapheme', async ({ page }) => {
    // Chromium and Firefox report caret x positions inside clusters: the editor snaps to the nearer grapheme edge.
    expect(await clickEveryChar(page, CLUSTERS.map((_, i) => SIMPLE.length + i))).toEqual([])
  })

  test('ArrowRight moves by grapheme and the caret is drawn at the glyph edge', async ({ page }) => {
    for (let line = 0; line < LINES.length; line++) {
      await page.evaluate((l) => { ed.focus(); ed.setSelection({ line: l, col: 0 }); ed.flush() }, line)
      const bounds = await page.evaluate((t) => graphemes(t), LINES[line]!)
      for (const col of bounds.slice(1)) {
        await page.keyboard.press('ArrowRight')
        const [pos, caret, glyph] = await page.evaluate(async ([l, c]) => {
          await window.settle()
          return [ed.selection.head, caretRect(), charRect(l, c)]
        }, [line, col])
        expect(pos, `line ${line + 1}`).toEqual({ line, col })
        // The caret is 2px wide, centered on the boundary.
        expect(Math.abs(caret!.left + caret!.width / 2 - glyph!.left), `caret x, line ${line + 1} col ${col}`).toBeLessThan(1.5)
        expect(Math.abs(caret!.top - glyph!.top), `caret y, line ${line + 1} col ${col}`).toBeLessThan(5)
      }
    }
  })

  test('selections cover the selected glyphs exactly', async ({ page }) => {
    for (const [line, from, to] of [[1, 5, 10], [2, 6, 8], [3, 6, 11], [4, 5, 9], [0, 1, 5], [5, 7, 11], [7, 7, 15]] as const) {
      await page.evaluate(([l, a, b]) => { ed.setSelection({ line: l, col: a }, { line: l, col: b }); ed.flush() }, [line, from, to])
      await settle(page)
      const [sel, text] = await page.evaluate(([l, a, b]) => {
        const r = ed.dom.querySelector('.jc-selection-rect')!.getBoundingClientRect()
        return [{ left: r.left, right: r.right }, textRect(l, a, b)]
      }, [line, from, to])
      expect(Math.abs(sel!.left - text!.left), `selection start, line ${line + 1}`).toBeLessThan(1.5)
      expect(Math.abs(sel!.right - text!.right), `selection end, line ${line + 1}`).toBeLessThan(1.5)
    }
  })
})
