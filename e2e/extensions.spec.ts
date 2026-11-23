// Swapping extensions: compartments, `setExtensions` keeping what stays in the list, and what survives either.
import type { Page } from '@playwright/test'
import { expect, place, settle, test, value } from './helpers.ts'

const DOC = 'package main\n\nfunc soma(a, b int) int {\n\treturn a + b\n}\n\nfunc main() {}\n'
const ORIGINAL = DOC.replace('a + b', 'a - b')
const problem = { from: { line: 2, col: 5 }, to: { line: 2, col: 9 }, severity: 'warning', message: 'sem teste' }

/** Classes of the gutters, left to right. */
const gutters = (page: Page) => page.evaluate(() => [...ed.dom.querySelectorAll('.jc-gutter')].map((g) => g.className.replace('jc-gutter ', '')))
const locks = (page: Page) => page.evaluate(() => J.getReadOnlyRanges(ed))
const problems = (page: Page) => page.evaluate(() => J.getDiagnostics(ed).map((d: any) => ({ from: d.from, to: d.to, message: d.message })))

test.describe('compartments', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate(([doc, p]) => {
      const w = window as any
      w.rejected = 0
      w.review = J.compartment()
      mount({
        value: doc,
        extensions: [J.basicSetup(), J.readOnlyRanges([], { onReject: () => w.rejected++ }), J.diagnostics(), w.review.of(null)],
      })
      J.setReadOnlyRanges(ed, [J.lineRange(ed, 1, 2)])
      J.setDiagnostics(ed, [p], 'lsp')
    }, [DOC, problem] as const)
    await settle(page)
  })

  test('reconfiguring one part keeps the read-only ranges and the diagnostics of the others', async ({ page }) => {
    const before = { locks: await locks(page), problems: await problems(page) }
    expect(before.locks).toEqual([{ from: { line: 0, col: 0 }, to: { line: 1, col: 0 } }])
    expect(before.problems).toHaveLength(1)

    expect(await page.evaluate((original) => (window as any).review.reconfigure(ed, J.diffView({ original })), ORIGINAL)).toBe(true)
    await settle(page)
    expect(await page.evaluate(() => J.getChunks(ed).length)).toBe(1)
    expect(await locks(page)).toEqual(before.locks)
    expect(await problems(page)).toEqual(before.problems)
    await expect(page.locator('.jc-diag-marker')).toHaveCount(1)

    await page.evaluate(() => (window as any).review.reconfigure(ed, null))
    await settle(page)
    expect(await page.evaluate(() => J.getChunks(ed).length)).toBe(0)
    expect(await locks(page)).toEqual(before.locks)
    expect(await problems(page)).toEqual(before.problems)

    // Still alive, not just remembered: the lock rejects typing, and both follow an edit.
    await place(page, 0, 3)
    await page.keyboard.type('x')
    expect(await value(page)).toBe(DOC)
    expect(await page.evaluate(() => (window as any).rejected)).toBe(1)
    await page.evaluate(() => ed.dispatch({ changes: { from: { line: 2, col: 0 }, insert: '// soma\n' } }))
    expect(await locks(page)).toEqual(before.locks)
    expect((await problems(page))[0]!.from).toEqual({ line: 3, col: 5 })
    await expect(page.locator('.jc-readonly-line')).toHaveCount(2)
  })

  test('get() and reconfigure() report whether the compartment is installed', async ({ page }) => {
    expect(await page.evaluate(() => (window as any).review.get(ed))).toBe(null)
    expect(await page.evaluate(() => {
      const other = J.compartment()
      return [other.get(ed), other.reconfigure(ed, J.search())]
    })).toEqual([undefined, false])
    expect(await page.evaluate(() => {
      const ext = J.search()
      ;(window as any).review.reconfigure(ed, ext)
      return (window as any).review.get(ed) === ext
    })).toBe(true)
  })

  test('what a compartment holds takes its place in the order, like in a fresh install', async ({ page }) => {
    const order = await page.evaluate(([doc]) => {
      const marks = J.compartment()
      const fresh = [J.diagnostics(), J.lineNumbers(), J.folding()]
      mount({ value: doc, extensions: fresh })
      const expected = [...ed.dom.querySelectorAll('.jc-gutter')].map((g) => g.className)
      mount({ value: doc, extensions: [marks.of(null), J.lineNumbers(), J.folding()] })
      marks.reconfigure(ed, J.diagnostics())
      const swapped = [...ed.dom.querySelectorAll('.jc-gutter')].map((g) => g.className)
      marks.reconfigure(ed, null)
      marks.reconfigure(ed, [J.diagnostics()])
      return { expected, swapped, again: [...ed.dom.querySelectorAll('.jc-gutter')].map((g) => g.className) }
    }, [DOC] as const)
    expect(order.expected.map((c) => c.split(' ')[1])).toEqual(['jc-gutter-diag', 'jc-gutter-lines', 'jc-gutter-fold'])
    expect(order.swapped).toEqual(order.expected)
    expect(order.again).toEqual(order.expected)
  })

  test('a key binding inside a compartment keeps its precedence over the extensions after it', async ({ page }) => {
    const hits = await page.evaluate(([doc]) => {
      const w = window as any
      w.hits = []
      const first = J.compartment()
      const key = (name: string) => J.keymap([{ key: 'F9', run: () => (w.hits.push(name), true) }])
      mount({ value: doc, extensions: [first.of(null), key('second')] })
      first.reconfigure(ed, key('first'))
      ed.focus()
      return null
    }, [DOC] as const)
    expect(hits).toBe(null)
    await page.keyboard.press('F9')
    expect(await page.evaluate(() => (window as any).hits)).toEqual(['first'])
  })

  test('destroying the editor disposes what compartments and slots installed', async ({ page }) => {
    const disposed = await page.evaluate(([doc]) => {
      const log: string[] = []
      const part = J.compartment()
      mount({ value: doc, extensions: [part.of(() => () => log.push('initial'))] })
      part.reconfigure(ed, () => () => log.push('swapped'))
      // A slot reserved by the app, outside any extension.
      ed.slot()(() => () => log.push('loose'))
      const afterSwap = log.slice()
      ed.destroy()
      return { afterSwap, log }
    }, [DOC] as const)
    expect(disposed.afterSwap).toEqual(['initial'])
    expect(disposed.log.sort()).toEqual(['initial', 'loose', 'swapped'])
  })
})

test.describe('setExtensions', () => {
  test('extensions that stay in the list keep their state; the others are replaced', async ({ page }) => {
    await page.evaluate(([doc, p]) => {
      const w = window as any
      w.log = []
      const probe = (name: string) => () => {
        w.log.push('+' + name)
        return () => w.log.push('-' + name)
      }
      w.base = [J.basicSetup(), J.readOnlyRanges([]), J.diagnostics(), probe('base')]
      w.probe = probe
      mount({ value: doc, extensions: [w.base, probe('a')] })
      J.setReadOnlyRanges(ed, [J.lineRange(ed, 1, 2)])
      J.setDiagnostics(ed, [p], 'lsp')
    }, [DOC, problem] as const)
    const before = { locks: await locks(page), problems: await problems(page) }
    await page.evaluate((original) => {
      const w = window as any
      ed.setExtensions([w.base, J.diffView({ original }), w.probe('b')])
    }, ORIGINAL)
    await settle(page)
    expect(await page.evaluate(() => (window as any).log)).toEqual(['+base', '+a', '-a', '+b'])
    expect(await locks(page)).toEqual(before.locks)
    expect(await problems(page)).toEqual(before.problems)
    expect(await page.evaluate(() => J.getChunks(ed).length)).toBe(1)
    // A list without them disposes them (and their state goes, as before).
    await page.evaluate(() => ed.setExtensions(J.basicSetup()))
    expect(await page.evaluate(() => (window as any).log)).toEqual(['+base', '+a', '-a', '+b', '-b', '-base'])
    expect(await locks(page)).toEqual([])
    expect(await problems(page)).toEqual([])
  })

  test('a new extension lands in its place among the kept ones', async ({ page }) => {
    const classes = await page.evaluate(([doc]) => {
      const numbers = J.lineNumbers()
      const fold = J.folding()
      mount({ value: doc, extensions: [numbers, fold] })
      ed.setExtensions([J.diagnostics(), numbers, fold])
      return [...ed.dom.querySelectorAll('.jc-gutter')].map((g) => g.className.split(' ')[1])
    }, [DOC] as const)
    expect(classes).toEqual(['jc-gutter-diag', 'jc-gutter-lines', 'jc-gutter-fold'])
    expect(await gutters(page)).toHaveLength(3)
  })

  test('zones survive setExtensions and compartment swaps (same element, same line)', async ({ page }) => {
    await page.evaluate(([doc]) => {
      const w = window as any
      w.part = J.compartment()
      mount({ value: doc, extensions: [J.basicSetup(), w.part.of(null)] })
      w.zone = J.addZone(ed, { line: 2, actions: [{ label: '▶ Rodar', run: () => {} }] })
      w.button = w.zone.dom.querySelector('button')
    }, [DOC] as const)
    await settle(page)
    const check = () => page.evaluate(() => {
      const w = window as any
      const zones = J.getZones(ed)
      return { count: zones.length, same: zones[0] === w.zone && zones[0].dom.querySelector('button') === w.button, connected: w.button.isConnected, line: zones[0].line }
    })
    await page.evaluate((original) => (window as any).part.reconfigure(ed, J.diffView({ original })), ORIGINAL)
    await settle(page)
    expect(await check()).toEqual({ count: 1, same: true, connected: true, line: 2 })
    await page.evaluate(() => ed.setExtensions([J.lineNumbers()]))
    await settle(page)
    expect(await check()).toEqual({ count: 1, same: true, connected: true, line: 2 })
    await page.evaluate(() => ed.dispatch({ changes: { from: { line: 0, col: 0 }, insert: '\n\n' } }))
    await settle(page)
    expect((await check()).line).toBe(4)
  })
})

test.describe('read-only ranges at the ends of the document', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => {
      const w = window as any
      w.rejected = []
      mount({ value: 'head\nYOURS\ntail', extensions: [J.basicSetup(), J.readOnlyRanges([], { onReject: (_e: any, origin: string) => w.rejected.push(origin) })] })
      J.setReadOnlyRanges(ed, [J.lineRange(ed, 1, 1, { sticky: true }), J.lineRange(ed, 3, 3, { sticky: true })])
    })
    await settle(page)
  })

  test('typing before a sticky first line or after a sticky last line is refused, and onReject is called', async ({ page }) => {
    await place(page, 0, 0)
    await page.keyboard.type('x')
    await page.keyboard.press('Enter')
    expect(await value(page)).toBe('head\nYOURS\ntail')
    expect(await page.evaluate(() => (window as any).rejected)).toEqual(['input', 'input'])
    await place(page, 2, 4)
    await page.keyboard.type('y')
    await page.keyboard.press('Enter')
    expect(await value(page)).toBe('head\nYOURS\ntail')
    expect(await page.evaluate(() => (window as any).rejected.length)).toBe(4)
    // The line in between is still yours, from its first column to its last.
    await place(page, 1, 0)
    await page.keyboard.type('> ')
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    expect(await value(page)).toBe('head\n> YOURS!\ntail')
    expect(await page.evaluate(() => (window as any).rejected.length)).toBe(4)
  })

  test('the protection set by setReadOnlyRanges during another extension outlives it', async ({ page }) => {
    await page.evaluate(() => {
      const part = J.compartment()
      mount({ value: 'one\ntwo', extensions: [part.of((editor: any) => J.setReadOnlyRanges(editor, [J.lineRange(editor, 1, 1)]))] })
      part.reconfigure(ed, null)
    })
    await place(page, 0, 1)
    await page.keyboard.type('x')
    expect(await value(page)).toBe('one\ntwo')
    expect(await page.evaluate(() => J.getReadOnlyRanges(ed).length)).toBe(1)
  })
})
