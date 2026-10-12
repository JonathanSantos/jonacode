// Shared test fixture: every test gets a page on the fixture, plus small helpers that read editor state.
import { test as base, expect, type Page } from '@playwright/test'

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    J: any
    ed: any
    mount: (options?: Record<string, unknown>, host?: { height?: string; width?: string }) => any
    settle: () => Promise<void>
    lineEl: (line: number, editor?: any) => HTMLElement | null
    charRect: (line: number, col: number, editor?: any) => Box
    textRect: (line: number, from: number, to?: number, editor?: any) => Box
    graphemes: (text: string) => number[]
    caretRect: (editor?: any) => Box
    numberedLines: (n: number) => string
    makeGate: () => Gate
    fixtureReady: boolean
  }
  // Page globals, for code inside page.evaluate().
  const J: any
  const ed: any
  const mount: Window['mount']
  const settle: Window['settle']
  const lineEl: Window['lineEl']
  const charRect: Window['charRect']
  const textRect: Window['textRect']
  const graphemes: Window['graphemes']
  const caretRect: Window['caretRect']
  const numberedLines: Window['numberedLines']
  const makeGate: Window['makeGate']
}

/** See `makeGate` in fixture.html. */
export interface Gate {
  step(): void
  wait(i: number): Promise<void>
}

export interface Box { x: number; y: number; left: number; top: number; right: number; bottom: number; width: number; height: number }
export interface Pos { line: number; col: number }

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.goto('/e2e/fixture.html')
    await page.waitForFunction(() => window.fixtureReady)
    await use(page)
  },
})
export { expect }

export const value = (page: Page): Promise<string> => page.evaluate(() => ed.getValue())
export const head = (page: Page): Promise<Pos> => page.evaluate(() => ed.selection.head)
export const selection = (page: Page): Promise<{ anchor: Pos; head: Pos }> =>
  page.evaluate(() => ({ anchor: ed.selection.anchor, head: ed.selection.head }))
export const ranges = (page: Page): Promise<{ anchor: Pos; head: Pos }[]> =>
  page.evaluate(() => ed.ranges.map((r: any) => ({ anchor: r.anchor, head: r.head })))
export const settle = (page: Page): Promise<void> => page.evaluate(() => window.settle())

/** Center of the character at `col` (measured on the rendered DOM). */
export async function charCenter(page: Page, line: number, col: number): Promise<{ x: number; y: number }> {
  const r = await page.evaluate(([l, c]) => charRect(l, c), [line, col])
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/** A point just inside the left edge of the character at `col` (a click there puts the cursor before it). */
export async function charStart(page: Page, line: number, col: number): Promise<{ x: number; y: number }> {
  const r = await page.evaluate(([l, c]) => charRect(l, c), [line, col])
  return { x: r.left + Math.min(2, r.width / 4), y: r.top + r.height / 2 }
}

/** Clicks into the editor at a character boundary and waits for the render. */
export async function clickAt(page: Page, line: number, col: number): Promise<void> {
  const p = await charStart(page, line, col)
  await page.mouse.click(p.x, p.y)
  await settle(page)
}

/** Focuses the editor and puts the cursor somewhere through the API (setup only, not what's under test). */
export async function place(page: Page, line: number, col: number): Promise<void> {
  await page.evaluate(([l, c]) => {
    ed.focus()
    ed.setSelection({ line: l, col: c })
    ed.flush()
  }, [line, col])
}

/** Number of `.jc-line` elements in the DOM (virtualization keeps it small). */
export const renderedLineCount = (page: Page): Promise<number> => page.evaluate(() => ed.dom.querySelectorAll('.jc-line').length)

/** The browsers run on the host OS, so the library's Cmd/Ctrl choice follows it. */
export const isMac = process.platform === 'darwin'
export const keys = {
  docStart: isMac ? 'Meta+ArrowUp' : 'Control+Home',
  docEnd: isMac ? 'Meta+ArrowDown' : 'Control+End',
  fold: isMac ? 'Meta+Alt+BracketLeft' : 'Control+Shift+BracketLeft',
  unfold: isMac ? 'Meta+Alt+BracketRight' : 'Control+Shift+BracketRight',
  replace: isMac ? 'Meta+Alt+f' : 'Control+h',
}

/** Text of the first `.jc-line` fully inside the scroller's viewport (what the user sees at the top). */
export const firstVisibleLine = (page: Page): Promise<string | null> => page.evaluate(() => {
  const sc = ed.scrollDOM.getBoundingClientRect()
  const lines = [...ed.dom.querySelectorAll('.jc-line')]
    .map((el: any) => ({ top: el.getBoundingClientRect().top, text: el.textContent }))
    .filter((l) => l.top >= sc.top - 1 && l.top < sc.bottom)
    .sort((a, b) => a.top - b.top)
  return lines[0]?.text ?? null
})

/** Whether a rendered line with this exact text is inside the scroller's visible box. */
export const isLineVisible = (page: Page, text: string): Promise<boolean> => page.evaluate((t) => {
  const sc = ed.scrollDOM
  const box = sc.getBoundingClientRect()
  const bottom = box.top + sc.clientHeight
  return [...ed.dom.querySelectorAll('.jc-line')].some((el: any) => {
    const r = el.getBoundingClientRect()
    return el.textContent === t && r.top >= box.top - 1 && r.bottom <= bottom + 1
  })
}, text)

/**
 * Marks a test as a known library bug (fixme) when `when` holds. `E2E_SHOW_BUGS=1` runs it anyway,
 * to check whether the bug is still there.
 */
export function knownBug(when: boolean, description: string): void {
  test.fixme(!process.env.E2E_SHOW_BUGS && when, `BUG: ${description}`)
}
