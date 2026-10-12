// Inline diff (diffView) and side-by-side diff (mergeView).
import type { Page } from '@playwright/test'
import { clickAt, expect, head, settle, test, value } from './helpers.ts'

const ORIGINAL = [
  'function greet(name) {',
  '  const msg = "Hello"',
  '  return msg + name',
  '}',
  '',
  'function bye() {',
  '  return "bye"',
  '}',
  'export { greet }',
].join('\n')
// Line 2 changed, `bye` removed, one line added at the end.
const CURRENT = [
  'function greet(name) {',
  '  const msg = "Hi there"',
  '  return msg + name',
  '}',
  '',
  'export { greet }',
  'export default greet',
].join('\n')

const chunks = (page: Page) => page.evaluate(() => J.getChunks(ed).map((c: any) => [c.fromA, c.toA, c.fromB, c.toB]))
const lineTop = (page: Page, line: number) => page.evaluate((l) => lineEl(l)!.getBoundingClientRect().top, line)

test.describe('diffView', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate(([cur, orig]) => void mount({ value: cur, language: 'javascript', extensions: [J.basicSetup(), J.diffView({ original: orig })] }), [CURRENT, ORIGINAL])
    await expect(page.locator('.jc-diff-deleted')).toHaveCount(2)
    await settle(page)
  })

  test('deleted lines are shown in a block right above the changed lines', async ({ page }) => {
    expect(await chunks(page)).toEqual([[1, 2, 1, 2], [5, 8, 5, 5], [9, 9, 6, 7]])
    const lh = await page.evaluate(() => ed.lineHeight)
    const blocks = page.locator('.jc-diff-deleted')
    // The old version of the changed line, above the new one, with the changed chars marked.
    await expect(blocks.nth(0).locator('.jc-diff-row')).toHaveText(['  const msg = "Hello"AcceptReject'])
    await expect(blocks.nth(0).locator('.jc-diff-del-mark').first()).toBeVisible()
    const b0 = (await blocks.nth(0).boundingBox())!
    expect(Math.abs(b0.y + b0.height - (await lineTop(page, 1)))).toBeLessThan(0.5)
    expect(Math.abs(b0.height - lh)).toBeLessThan(0.5)
    // The removed function: three rows, above the line that followed it.
    await expect(blocks.nth(1).locator('.jc-diff-row')).toHaveCount(3)
    const b1 = (await blocks.nth(1).boundingBox())!
    expect(Math.abs(b1.y + b1.height - (await lineTop(page, 5)))).toBeLessThan(0.5)
    expect(Math.abs(b1.height - 3 * lh)).toBeLessThan(0.5)
    // Changed and inserted lines are tinted; the changed chars of the new line are marked.
    const tints = await page.evaluate(() => [...ed.dom.querySelectorAll('.jc-diff-line.jc-diff-ins')].map((e: any) => e.getBoundingClientRect().top))
    expect(tints).toHaveLength(2)
    expect(Math.abs(tints[0]! - (await lineTop(page, 1)))).toBeLessThan(0.5)
    expect(Math.abs(tints[1]! - (await lineTop(page, 6)))).toBeLessThan(0.5)
    // ("Hello" → "Hi there": the common "H" isn't marked.) WebKit reports glyph edges floored to whole pixels
    // (col × 8.43px → 134.88 reads as 134), hence 1px of slack.
    const mark = (await page.locator('.jc-diff-mark.jc-diff-ins').first().boundingBox())!
    const [from, to] = await page.evaluate(() => [charRect(1, 16), charRect(1, 22)])
    expect(Math.abs(mark.x - from!.left)).toBeLessThan(1)
    expect(Math.abs(mark.x + mark.width - to!.right)).toBeLessThan(1)
    expect(Math.abs(mark.y - from!.top)).toBeLessThan(4)
    // Gutter markers: modified, deleted (between lines), inserted.
    await expect(page.locator('.jc-diff-g-mod')).toHaveCount(1)
    await expect(page.locator('.jc-diff-g-del')).toHaveCount(1)
    await expect(page.locator('.jc-diff-g-ins')).toHaveCount(1)
    // Line numbers stay on their lines.
    const cell = await page.evaluate(() => [...ed.dom.querySelectorAll('.jc-gutter-lines .jc-gutter-cell')].find((c: any) => c.textContent === '6')!.getBoundingClientRect().top)
    expect(Math.abs(cell - (await lineTop(page, 5)))).toBeLessThan(0.5)
  })

  test('Reject with the mouse restores the original, in one undo step', async ({ page }) => {
    await clickAt(page, 6, 3)
    await page.locator('.jc-diff-deleted').nth(0).getByRole('button', { name: 'Reject' }).click()
    expect(await page.evaluate(() => ed.doc.line(1))).toBe('  const msg = "Hello"')
    expect(await chunks(page)).toEqual([[5, 8, 5, 5], [9, 9, 6, 7]])
    await expect(page.locator('.jc-diff-deleted')).toHaveCount(1)
    await expect(page.locator('.jc-input')).toBeFocused()
    // Reject the removal of `bye`: its lines come back.
    await page.locator('.jc-diff-deleted').getByRole('button', { name: 'Reject' }).click()
    expect(await value(page)).toBe(ORIGINAL.replace('export { greet }', 'export { greet }\nexport default greet'))
    // Each reject is one undo step.
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe(CURRENT.replace('"Hi there"', '"Hello"'))
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe(CURRENT)
    await expect.poll(() => chunks(page)).toEqual([[1, 2, 1, 2], [5, 8, 5, 5], [9, 9, 6, 7]])
    await expect(page.locator('.jc-diff-deleted')).toHaveCount(2)
  })

  test('Accept with the mouse keeps the change and folds it into the original', async ({ page }) => {
    await page.locator('.jc-diff-deleted').nth(1).getByRole('button', { name: 'Accept' }).click()
    expect(await value(page)).toBe(CURRENT)
    expect(await chunks(page)).toEqual([[1, 2, 1, 2], [6, 6, 6, 7]])
    expect(await page.evaluate(() => J.getOriginal(ed))).not.toContain('bye')
    await expect(page.locator('.jc-diff-deleted')).toHaveCount(1)
    // An insertion has its buttons at the end of the line.
    const inline = page.locator('.jc-diff-inline')
    await expect(inline).toBeVisible()
    const [box, end] = [(await inline.boundingBox())!, await page.evaluate(() => charRect(6, 20))]
    expect(box.x).toBeGreaterThanOrEqual(end.left)
    expect(Math.abs(box.y - end.top)).toBeLessThan(4)
    await inline.getByRole('button', { name: 'Accept' }).click()
    expect(await chunks(page)).toEqual([[1, 2, 1, 2]])
    await expect(page.locator('.jc-diff-g-ins')).toHaveCount(0)
    // Nothing changed in the document: nothing to undo.
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe(CURRENT)
  })

  test('F7 / Shift+F7 go to the next / previous chunk', async ({ page }) => {
    await clickAt(page, 0, 0)
    const lines: number[] = []
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('F7')
      lines.push((await head(page)).line)
    }
    expect(lines).toEqual([1, 5, 6, 1])
    await page.keyboard.press('Shift+F7')
    expect((await head(page)).line).toBe(6)
    await page.keyboard.press('Shift+F7')
    expect((await head(page)).line).toBe(5)
  })

  test('the diff follows typing: restoring the old text removes the chunk', async ({ page }) => {
    await page.evaluate(() => { ed.focus(); ed.setSelection({ line: 1, col: 15 }, { line: 1, col: 23 }); ed.flush() })
    await page.keyboard.type('Hello')
    expect(await page.evaluate(() => ed.doc.line(1))).toBe('  const msg = "Hello"')
    await expect.poll(() => chunks(page)).toEqual([[5, 8, 5, 5], [9, 9, 6, 7]])
    await expect(page.locator('.jc-diff-deleted')).toHaveCount(1)
    // Typing a new line creates an insertion.
    await clickAt(page, 0, 22)
    await page.keyboard.press('Enter')
    await page.keyboard.type('// new')
    await expect.poll(() => chunks(page)).toEqual([[1, 1, 1, 2], [5, 8, 6, 6], [9, 9, 7, 8]])
    await expect(page.locator('.jc-diff-g-ins')).toHaveCount(2)
  })
})

// ---------------------------------------------------------------------------

const lines = (n: number, edit: (l: string[]) => void = () => {}) => {
  const out = Array.from({ length: n }, (_, i) => `line ${i + 1}`)
  edit(out)
  return out.join('\n')
}

/** Two editors side by side; `window.ed` is the right one. */
const mountMerge = (page: Page, a: string, b: string, height = '300px') => page.evaluate(([a, b, h]) => {
  const w = window as any
  w.mv?.destroy()
  w.ed?.destroy()
  const app = document.getElementById('app')!
  app.replaceChildren()
  const host = document.createElement('div')
  host.style.cssText = `height:${h};width:900px`
  app.appendChild(host)
  w.mv = J.mergeView(host, { a: { value: a, readOnly: true, extensions: J.lineNumbers() }, b: { value: b, extensions: J.basicSetup() } })
  w.ed = w.mv.b
  w.mv.a.flush()
  w.mv.b.flush()
}, [a, b, height])

/** Client tops of the rendered lines of each side, by text. */
const sideTops = (page: Page) => page.evaluate(() => {
  const read = (e: any) => Object.fromEntries([...e.dom.querySelectorAll('.jc-line')].map((el: any) => [el.textContent, el.getBoundingClientRect().top]))
  const mv = (window as any).mv
  return { a: read(mv.a) as Record<string, number>, b: read(mv.b) as Record<string, number> }
})

test.describe('mergeView', () => {
  // A: 60 lines. B: lines 5–7 removed, two lines added after 15, line 20 changed.
  const A = lines(60)
  const B = lines(60, (l) => {
    l[19] = 'line 20 (changed)'
    l.splice(15, 0, 'new A', 'new B')
    l.splice(4, 3)
  })

  test('unchanged lines are at the same height on both sides', async ({ page }) => {
    await mountMerge(page, A, B, '800px')
    await settle(page)
    expect(await page.evaluate(() => (window as any).mv.chunks().length)).toBe(3)
    const t = await sideTops(page)
    let compared = 0
    for (const [text, top] of Object.entries(t.a)) {
      if (!(text in t.b)) continue
      expect(Math.abs(top - t.b[text]!), text).toBeLessThan(0.5)
      compared++
    }
    expect(compared).toBeGreaterThan(20)
    // The shorter side of a chunk gets a hatched filler; both sides have the same scroll height.
    await expect(page.locator('.jc-merge-b .jc-merge-filler')).toHaveCount(1)
    await expect(page.locator('.jc-merge-a .jc-merge-filler')).toHaveCount(1)
    const [ha, hb] = await page.evaluate(() => [(window as any).mv.a.scrollDOM.scrollHeight, (window as any).mv.b.scrollDOM.scrollHeight])
    expect(ha).toBe(hb)
    // Tints: deleted lines on the left, inserted on the right.
    await expect(page.locator('.jc-merge-a .jc-diff-line.jc-diff-del')).toHaveCount(4)
    await expect(page.locator('.jc-merge-b .jc-diff-line.jc-diff-ins')).toHaveCount(3)
  })

  test('scrolling one side scrolls the other and keeps lines aligned', async ({ page }) => {
    await mountMerge(page, lines(300, (l) => l.splice(100, 5)), lines(300, (l) => l.splice(50, 0, 'x1', 'x2', 'x3')))
    const scrollTops = () => page.evaluate(() => [(window as any).mv.a.scrollDOM.scrollTop, (window as any).mv.b.scrollDOM.scrollTop] as [number, number])
    const aligned = async () => {
      const t = await sideTops(page)
      return Object.entries(t.a).filter(([text]) => text in t.b).every(([text, top]) => Math.abs(top - t.b[text]!) < 0.5)
    }
    // Wheel over the right side.
    const b = (await page.locator('.jc-merge-b .jc-scroller').boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.wheel(0, 900)
    await expect.poll(async () => (await scrollTops())[1]).toBeGreaterThan(100)
    await expect.poll(async () => { const [x, y] = await scrollTops(); return Math.abs(x - y) }).toBeLessThan(1)
    await settle(page)
    expect(await aligned()).toBe(true)
    // Wheel over the left (read-only) side.
    const a = (await page.locator('.jc-merge-a .jc-scroller').boundingBox())!
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    const before = (await scrollTops())[0]
    await page.mouse.wheel(0, 1200)
    await expect.poll(async () => (await scrollTops())[0]).toBeGreaterThan(before + 100)
    await expect.poll(async () => { const [x, y] = await scrollTops(); return Math.abs(x - y) }).toBeLessThan(1)
    await settle(page)
    expect(await aligned()).toBe(true)
  })

  test('the arrow between the editors reverts a chunk of B to A, in one undo step', async ({ page }) => {
    await mountMerge(page, A, B, '800px')
    await settle(page)
    const arrows = page.locator('.jc-merge-revert')
    await expect(arrows).toHaveCount(3)
    // The last chunk: line 20 changed.
    await arrows.nth(2).click()
    const bValue = () => page.evaluate(() => (window as any).mv.b.getValue())
    expect(await bValue()).toBe(B.replace('line 20 (changed)', 'line 20'))
    await expect(arrows).toHaveCount(2)
    await expect(page.locator('.jc-merge-b .jc-input')).toBeFocused()
    // The first chunk: the removed lines come back, and the sides line up again.
    await arrows.nth(0).click()
    await settle(page)
    const t = await sideTops(page)
    for (const text of ['line 5', 'line 6', 'line 7', 'line 8']) expect(Math.abs(t.a[text]! - t.b[text]!), text).toBeLessThan(0.5)
    await page.keyboard.press('ControlOrMeta+z')
    await page.keyboard.press('ControlOrMeta+z')
    expect(await bValue()).toBe(B)
    await expect(arrows).toHaveCount(3)
  })
})
