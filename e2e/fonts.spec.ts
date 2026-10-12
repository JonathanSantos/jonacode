// Fonts and sizes: what the editor computes (caret x, clicks, line tops, gutters, wraps) against the glyphs the
// browser drew, for monospace and proportional fonts, several sizes and line heights, and font changes made
// outside the API (CSS, a font loading late, a scaled ancestor).
import type { Page } from '@playwright/test'
import { expect, head, settle, test } from './helpers.ts'

const DOC = [
  'const answer = 42 // plain ascii',
  '\tif (x) {\t\treturn "tab"\t}',
  '/* italic comment */ const after = 1',
  "const s = 'ção ñ é' + \"acentos\"",
  'const 日本語 = "漢字テキスト" // cjk',
  'const emoji = "😀👍🏽🇧🇷" + 1',
  'x'.repeat(40) + ' long ' + 'abcdefghij'.repeat(26),
].join('\n')

// Georgia is proportional; on Linux CI the fallbacks are too.
const MONO = "Menlo, 'DejaVu Sans Mono', monospace"
const PROPORTIONAL = "Georgia, 'DejaVu Serif', serif"

/**
 * Largest gap (px) between where the editor puts each column and where the glyph is, and the columns a click
 * (a quarter into a char at least 5px wide) got wrong. WebKit reports the geometry of non-ASCII text rounded down
 * to whole pixels (so up to 1px off there).
 */
const audit = (page: Page) => page.evaluate(() => {
  let maxX = 0
  let worst = ''
  const wrongClicks: string[] = []
  for (let line = 0; line < ed.doc.lineCount; line++) {
    const text = ed.doc.line(line)
    if (!lineEl(line)) continue
    for (const col of graphemes(text)) {
      const c = ed.coordsAtPos({ line, col })
      const x = ed.contentToClient(c.x, 0).x
      const real = charRect(line, col)
      const err = Math.abs(x - real.left)
      if (err > maxX) { maxX = err; worst = `${line}:${col}` }
      if (col < text.length && real.width >= 5) {
        const p = ed.posAtClient(real.left + real.width * 0.25, real.top + real.height / 2)
        if (p.line !== line || p.col !== col) wrongClicks.push(`${line}:${col}→${p.line}:${p.col}`)
      }
    }
  }
  let maxY = 0
  let maxGutter = 0
  for (let line = 0; line < ed.doc.lineCount; line++) {
    const el = lineEl(line)
    if (!el) continue
    const top = ed.contentToClient(0, ed.lineBlock(line).top).y
    maxY = Math.max(maxY, Math.abs(el.getBoundingClientRect().top - top))
    const cell = [...ed.dom.querySelectorAll('.jc-gutter-lines .jc-gutter-cell')].find((c: any) => c.textContent === String(line + 1)) as HTMLElement | undefined
    if (!cell || !ed.doc.line(line)) continue
    const range = document.createRange()
    range.selectNodeContents(cell)
    const g = range.getBoundingClientRect()
    const t = charRect(line, 0)
    maxGutter = Math.max(maxGutter, Math.abs((g.top + g.bottom) / 2 - (t.top + t.bottom) / 2))
  }
  return { maxX, worst, wrongClicks, maxY, maxGutter, monospace: ed.monospace as boolean }
})

const tolerance = (engine: string) => (engine === 'webkit' ? 1.1 : 0.6)

test.describe('fonts and sizes', () => {
  for (const [name, fontFamily] of [['monospace', MONO], ['proportional', PROPORTIONAL]] as const) {
    for (const fontSize of [11, 16.5]) {
      for (const lineHeight of [1.6, '26px']) {
        test(`${name} ${fontSize}px / ${lineHeight}: caret, clicks, line tops and gutter match the glyphs`, async ({ page }, info) => {
          await page.evaluate(([doc, f, s, lh]) => void mount({ value: doc, language: 'javascript', extensions: J.basicSetup(), fontFamily: f, fontSize: s, lineHeight: lh }, { height: '360px', width: '900px' }),
            [DOC, fontFamily, fontSize, lineHeight] as const)
          await settle(page)
          const r = await audit(page)
          expect(r.monospace).toBe(name === 'monospace')
          expect(r.maxX, `worst column ${r.worst}`).toBeLessThan(tolerance(info.project.name))
          expect(r.wrongClicks).toEqual([])
          expect(r.maxY).toBeLessThan(0.5)
          expect(r.maxGutter).toBeLessThan(1)
        })
      }
    }
  }

  test('a font change made only in CSS (a variable, a class) is picked up without any API call', async ({ page }, info) => {
    await page.evaluate((doc) => void mount({ value: doc, extensions: J.basicSetup() }, { height: '300px', width: '900px' }), DOC)
    await settle(page)
    const before = await page.evaluate(() => ({ cw: ed.charWidth, lh: ed.lineHeight }))
    await page.evaluate(() => document.getElementById('host')!.style.setProperty('--jc-font-size', '20px'))
    await settle(page)
    const after = await page.evaluate(() => ({ cw: ed.charWidth, lh: ed.lineHeight }))
    expect(after.cw).toBeGreaterThan(before.cw * 1.3)
    expect(after.lh).toBeGreaterThan(before.lh)
    expect((await audit(page)).maxX).toBeLessThan(tolerance(info.project.name))
    // A class on an ancestor switching to a proportional font.
    await page.evaluate((f) => {
      const style = document.createElement('style')
      style.textContent = `.serif .jc-editor{--jc-font-family:${f}}`
      document.head.appendChild(style)
      document.getElementById('host')!.classList.add('serif')
    }, PROPORTIONAL)
    await settle(page)
    const r = await audit(page)
    expect(r.monospace).toBe(false)
    expect(r.maxX).toBeLessThan(tolerance(info.project.name))
    expect(r.wrongClicks).toEqual([])
  })

  test('a web font that finishes loading after the editor was created is measured again', async ({ page }, info) => {
    const loaded = await page.evaluate(async (doc) => {
      mount({ value: doc, fontFamily: "LateFont, 'Courier New', monospace", extensions: J.basicSetup() }, { height: '300px', width: '900px' })
      const face = new FontFace('LateFont', "local('Georgia'), local('DejaVu Serif')")
      try {
        await face.load()
      } catch {
        return false
      }
      document.fonts.add(face)
      return true
    }, DOC)
    test.skip(!loaded, 'no local font to load')
    await settle(page)
    const r = await audit(page)
    expect(r.monospace).toBe(false)
    expect(r.maxX).toBeLessThan(tolerance(info.project.name))
  })

  test('proportional font with wrapping: every row fits in the text area, clicks on later rows land right', async ({ page }) => {
    const prose = 'Wide Words Make Mountains, while little ones fill in. '.repeat(12)
    await page.evaluate(([f, text]) => void mount({ value: `${text}\n${text.toUpperCase()}\nend`, fontFamily: f, fontSize: 15, lineWrapping: true, extensions: J.basicSetup() }, { height: '400px', width: '520px' }),
      [PROPORTIONAL, prose] as const)
    await settle(page)
    const r = await page.evaluate(() => {
      const right = ed.scrollDOM.getBoundingClientRect().left + ed.scrollDOM.clientWidth
      let over = 0
      for (let line = 0; line < 2; line++) {
        const text = ed.doc.line(line)
        const range = document.createRange()
        range.selectNodeContents(lineEl(line)!)
        for (const rect of range.getClientRects()) over = Math.max(over, rect.right - right)
        void text
      }
      return { over, rows: ed.lineBlock(1).height / ed.lineHeight }
    })
    expect(r.rows).toBeGreaterThan(3)
    expect(r.over).toBeLessThanOrEqual(0)
    // Click into the third visual row of the upper-case line.
    const target = await page.evaluate(() => {
      const text = ed.doc.line(1)
      const b = ed.lineBlock(1)
      const y = b.top + ed.lineHeight * 2.5
      const pos = ed.posAtCoords(40, y)
      const col = pos.col + 3
      const c = charRect(1, col)
      return { col, x: c.left + c.width * 0.25, y: c.top + c.height / 2, ok: /[A-Z]/.test(text[col]!) }
    })
    await page.mouse.click(target.x, target.y)
    expect(await head(page)).toEqual({ line: 1, col: target.col })
  })

  test('bold that the browser synthesizes wider (fonts without a bold face) does not shift what follows', async ({ page }, info) => {
    await page.evaluate(() => void mount({
      value: '**negrito aqui** e depois texto normal\n# Título em negrito, depois nada',
      language: 'markdown', fontFamily: "Monaco, 'DejaVu Sans Mono', monospace", extensions: J.basicSetup(),
    }, { height: '200px', width: '900px' }))
    await settle(page)
    const r = await audit(page)
    expect(r.maxX).toBeLessThan(tolerance(info.project.name))
    expect(r.wrongClicks).toEqual([])
  })

  test('line numbers fit with proportional digits', async ({ page }) => {
    await page.evaluate((f) => {
      mount({ value: numberedLines(12000), fontFamily: f, fontSize: 17, extensions: J.basicSetup() }, { height: '300px' })
      ed.scrollIntoView({ line: 11990, col: 0 })
      ed.flush()
    }, PROPORTIONAL)
    await settle(page)
    const clipped = await page.evaluate(() => [...ed.dom.querySelectorAll('.jc-gutter-lines .jc-gutter-cell')].filter((cell: any) => {
      const range = document.createRange()
      range.selectNodeContents(cell)
      const t = range.getBoundingClientRect()
      const c = cell.getBoundingClientRect()
      return t.width > 0 && (t.left < c.left + 8 || t.right > c.right)
    }).map((c: any) => c.textContent))
    expect(clipped).toEqual([])
  })

  test('scaled by a CSS transform on an ancestor: clicks and the caret still match the text', async ({ page }, info) => {
    await page.evaluate((doc) => {
      mount({ value: doc, extensions: J.basicSetup() }, { height: '300px', width: '700px' })
      const host = document.getElementById('host')!
      host.style.transform = 'scale(1.5)'
      host.style.transformOrigin = '0 0'
    }, DOC)
    await settle(page)
    const r = await audit(page)
    expect(r.maxX).toBeLessThan(tolerance(info.project.name) * 1.5)
    expect(r.wrongClicks).toEqual([])
    const target = await page.evaluate(() => {
      const c = charRect(3, 14)
      return { x: c.left + c.width * 0.3, y: c.top + c.height / 2 }
    })
    await page.mouse.click(target.x, target.y)
    expect(await head(page)).toEqual({ line: 3, col: 14 })
    const caret = await page.evaluate(() => ({ caret: caretRect(), char: charRect(3, 14) }))
    expect(Math.abs(caret.caret.left + caret.caret.width / 2 - caret.char.left)).toBeLessThan(2)
  })
})
