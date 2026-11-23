// One editor, many documents: `getState()` / `setState()` bring a file back exactly as it was left (tabs).
import type { Page } from '@playwright/test'
import { expect, firstVisibleLine, head, place, selection, settle, test, value } from './helpers.ts'

const A = Array.from({ length: 60 }, (_, i) => (i % 10 === 0 ? `function a${i}() {` : i % 10 === 9 ? '}' : `  step(${i})`)).join('\n')
const B = 'package main\n\nfunc main() {\n}\n'

/** Mounts file A with everything that should travel with a document, and keeps the saved states on `window.files`. */
async function setup(page: Page): Promise<void> {
  await page.evaluate(([a]) => {
    const w = window as any
    w.events = []
    w.go = J.defineLanguage({ name: 'go', states: { root: [[/\b(package|func)\b/, 'keyword']] }, brackets: [['{', '}']], indent: { useTabs: true, size: 4 } })
    w.files = {}
    mount({
      value: a,
      language: 'javascript',
      extensions: [J.basicSetup(), J.folding(), J.readOnlyRanges([]), J.diagnostics()],
      onChange: (_v: string, e: any) => w.events.push(e.origin),
    }, { height: '240px' })
  }, [A] as const)
  await settle(page)
}

const save = (page: Page, name: string) => page.evaluate((n) => void ((window as any).files[n] = ed.getState()), name)
const show = async (page: Page, name: string) => {
  await page.evaluate((n) => ed.setState((window as any).files[n]), name)
  await settle(page)
}

test.describe('editor state', () => {
  test.beforeEach(async ({ page }) => setup(page))

  test('a file comes back as it was left: text, selection, scroll, folds and its own undo history', async ({ page }) => {
    // Two undo steps in A, a fold, a selection far down and a scroll position.
    await place(page, 1, 9)
    await page.keyboard.type('X')
    await page.evaluate(() => ed.dispatch({ changes: { from: { line: 2, col: 0 }, insert: '// note\n' } }))
    await page.evaluate(() => {
      ed.setFolds([{ from: 12, to: 19 }])
      ed.setSelection({ line: 40, col: 2 }, { line: 40, col: 6 })
      ed.flush()
      ed.scrollDOM.scrollTop = 520
      ed.flush()
    })
    await settle(page)
    const left = {
      value: await value(page),
      selection: await selection(page),
      scroll: await page.evaluate(() => ed.scrollDOM.scrollTop),
      top: await firstVisibleLine(page),
      folds: await page.evaluate(() => ed.folds),
    }
    await save(page, 'a')

    // Another document: a clean slate.
    await page.evaluate(([b]) => ed.setState({ value: b, language: (window as any).go }), [B] as const)
    await settle(page)
    expect(await value(page)).toBe(B)
    expect(await head(page)).toEqual({ line: 0, col: 0 })
    expect(await page.evaluate(() => [ed.scrollDOM.scrollTop, ed.canUndo, ed.folds.length, ed.language.name, ed.options.insertSpaces])).toEqual([0, false, 0, 'go', false])
    await expect(page.locator('.jc-line .jc-t-keyword').first()).toHaveText('package')
    await place(page, 3, 0)
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => ed.doc.line(3))).toBe('\t}')
    await save(page, 'b')

    // Back to A, exactly as it was.
    await show(page, 'a')
    expect(await value(page)).toBe(left.value)
    expect(await selection(page)).toEqual(left.selection)
    expect(await page.evaluate(() => ed.scrollDOM.scrollTop)).toBe(left.scroll)
    expect(await firstVisibleLine(page)).toBe(left.top)
    expect(await page.evaluate(() => ed.folds)).toEqual(left.folds)
    expect(await page.evaluate(() => [ed.language.name, ed.options.insertSpaces, ed.options.tabSize])).toEqual(['javascript', true, 2])
    // Its undo history, not B's: two steps back to the original text, and forward again.
    expect(await page.evaluate(() => [ed.undo(), ed.undo(), ed.undo()])).toEqual([true, true, false])
    expect(await value(page)).toBe(A)
    expect(await page.evaluate(() => [ed.redo(), ed.redo(), ed.redo()])).toEqual([true, true, false])
    expect(await value(page)).toBe(left.value)

    // And B kept its own.
    await show(page, 'b')
    expect(await value(page)).toBe('package main\n\nfunc main() {\n\t}\n')
    expect(await page.evaluate(() => [ed.undo(), ed.undo()])).toEqual([true, false])
    expect(await value(page)).toBe(B)
  })

  test('a saved state is a snapshot: later edits do not change it', async ({ page }) => {
    await place(page, 1, 9)
    await page.keyboard.type('X')
    await save(page, 'a')
    await page.keyboard.type('YZ')
    await page.evaluate(() => ed.dispatch({ changes: { from: { line: 0, col: 0 }, insert: '// more\n' } }))
    await show(page, 'a')
    expect(await page.evaluate(() => ed.doc.line(1))).toBe('  step(1)X')
    expect(await page.evaluate(() => [ed.undo(), ed.undo(), ed.canRedo])).toEqual([true, false, true])
    expect(await value(page)).toBe(A)
  })

  test('read-only ranges and diagnostics travel with their document', async ({ page }) => {
    const problems = () => page.evaluate(() => J.getDiagnostics(ed).map((d: any) => `${d.source ?? ''}@${d.from.line}:${d.message}`).sort())
    await page.evaluate(() => {
      J.setReadOnlyRanges(ed, [J.lineRange(ed, 1, 2, { sticky: true })])
      J.setDiagnostics(ed, [{ from: { line: 5, col: 2 }, to: { line: 5, col: 6 }, severity: 'error', message: 'broken' }], 'lsp')
      J.setDiagnostics(ed, [{ from: { line: 7, col: 2 }, severity: 'warning', message: 'careful' }])
      // An edit above: what is saved is where they are now.
      ed.dispatch({ changes: { from: { line: 3, col: 0 }, insert: '// new\n' } })
    })
    await settle(page)
    const locks = await page.evaluate(() => J.getReadOnlyRanges(ed))
    expect(await problems()).toEqual(['@6:broken', '@8:careful'])
    await save(page, 'a')

    await page.evaluate(([b]) => ed.setState({ value: b }), [B] as const)
    await settle(page)
    expect(await page.evaluate(() => J.getReadOnlyRanges(ed))).toEqual([])
    expect(await problems()).toEqual([])
    await expect(page.locator('.jc-diag-marker')).toHaveCount(0)
    await expect(page.locator('.jc-readonly-line')).toHaveCount(0)
    // Nothing is locked in this one.
    await place(page, 0, 0)
    await page.keyboard.type('// ')
    expect(await page.evaluate(() => ed.doc.line(0))).toBe('// package main')
    await page.evaluate(() => J.setDiagnostics(ed, [{ from: { line: 2, col: 0 }, severity: 'info', message: 'only in B' }], 'lsp'))
    await save(page, 'b')

    await show(page, 'a')
    expect(await page.evaluate(() => J.getReadOnlyRanges(ed))).toEqual(locks)
    expect(await problems()).toEqual(['@6:broken', '@8:careful'])
    await expect(page.locator('.jc-diag-marker')).toHaveCount(2)
    await expect(page.locator('.jc-readonly-line')).toHaveCount(2)
    // The lock is alive, the sticky start included; and both still follow edits.
    await place(page, 0, 0)
    await page.keyboard.type('x')
    await place(page, 1, 3)
    await page.keyboard.type('x')
    expect(await value(page)).toBe(A.replace('  step(3)', '// new\n  step(3)'))
    await page.evaluate(() => ed.dispatch({ changes: { from: { line: 4, col: 0 }, insert: '\n' } }))
    expect(await problems()).toEqual(['@7:broken', '@9:careful'])

    await show(page, 'b')
    expect(await problems()).toEqual(['@2:only in B'])
    expect(await page.evaluate(() => J.getReadOnlyRanges(ed))).toEqual([])
  })

  test('extensions see a swap as setValue; line widgets follow it right away', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as any
      const source = (doc: any) => doc.lines.flatMap((text: string, line: number) => {
        const name = /^func(?:tion)? (\w+)/.exec(text)?.[1]
        return name ? [{ key: name, line, actions: [{ label: '▶ ' + name, run: () => {} }] }] : []
      })
      w.widgets = J.compartment()
      ed.setExtensions([J.basicSetup(), J.lineWidgets(source, { delay: 5000 })])
      w.origins = []
      ed.on('change', (e: any) => w.origins.push(e.origin))
    })
    await settle(page)
    const zones = () => page.evaluate(() => J.getZones(ed).map((z: any) => `${z.line}:${z.dom.textContent}`).sort())
    expect(await zones()).toHaveLength(6)
    await save(page, 'a')
    await page.evaluate(([b]) => ed.setState({ value: b }), [B] as const)
    await settle(page)
    // No five-second wait, and nothing left over from the other file.
    expect(await zones()).toEqual(['2:▶ main'])
    await show(page, 'a')
    expect(await zones()).toEqual(['0:▶ a0', '10:▶ a10', '20:▶ a20', '30:▶ a30', '40:▶ a40', '50:▶ a50'])
    expect(await page.evaluate(() => (window as any).origins)).toEqual(['setValue', 'setValue'])
    expect(await page.evaluate(() => (window as any).events.slice(-2))).toEqual(['setValue', 'setValue'])
  })

  test('addStateField: an extension keeps its own data per document', async ({ page }) => {
    const out = await page.evaluate(([b]) => {
      const w = window as any
      const log: unknown[] = []
      let bookmarks: number[] = [3, 9]
      const off = ed.addStateField('bookmarks', { save: () => bookmarks, restore: (v: number[] | undefined) => (log.push(v ?? null), (bookmarks = v ?? [])) })
      w.files.a = ed.getState()
      ed.setState({ value: b })
      bookmarks = [1]
      w.files.b = ed.getState()
      ed.setState(w.files.a)
      const back = bookmarks.slice()
      off()
      ed.setState(w.files.b)
      return { log, back, fields: Object.keys(w.files.a.fields).sort(), after: bookmarks }
    }, [B] as const)
    expect(out.log).toEqual([null, [3, 9]])
    expect(out.back).toEqual([3, 9])
    expect(out.fields).toEqual(['bookmarks', 'readOnlyRanges'])
    // Removed: no longer restored.
    expect(out.after).toEqual([3, 9])
  })

  test('getState() changes nothing in the editor: typing still merges into one undo step', async ({ page }) => {
    await place(page, 1, 9)
    await page.keyboard.type('ab')
    await save(page, 'a')
    await page.keyboard.type('c')
    expect(await page.evaluate(() => ed.doc.line(1))).toBe('  step(1)abc')
    // One step for the three keys, even with a snapshot taken in the middle.
    expect(await page.evaluate(() => [ed.undo(), ed.canUndo])).toEqual([true, false])
    expect(await value(page)).toBe(A)
    // The snapshot has what was typed until then, and restoring it twice gives the same thing.
    for (let round = 0; round < 2; round++) {
      await show(page, 'a')
      expect(await page.evaluate(() => ed.doc.line(1))).toBe('  step(1)ab')
      await place(page, 1, 11)
      await page.keyboard.type('z')
      // What is typed after coming back is a step of its own.
      expect(await page.evaluate(() => [ed.undo(), ed.doc.line(1), ed.undo(), ed.doc.line(1), ed.canUndo])).toEqual([true, '  step(1)ab', true, '  step(1)', false])
    }
  })

  test('a review in progress travels with its document (the original of diffView)', async ({ page }) => {
    const original = A.replace('  step(3)', '  old(3)')
    await page.evaluate((o) => ed.setExtensions([J.basicSetup(), J.diffView({ original: o })]), original)
    await settle(page)
    const chunks = () => page.evaluate(() => J.getChunks(ed).map((c: any) => [c.fromB, c.toB]))
    expect(await chunks()).toEqual([[3, 4]])
    await save(page, 'a')
    // Another file, never reviewed: nothing pending (it isn't compared with A's original).
    await page.evaluate(([b]) => ed.setState({ value: b }), [B] as const)
    await settle(page)
    expect(await chunks()).toEqual([])
    await expect(page.locator('.jc-diff-accept')).toHaveCount(0)
    await page.evaluate(() => ed.dispatch({ changes: { from: { line: 0, col: 0 }, insert: '// novo\n' } }))
    expect(await chunks()).toEqual([[0, 1]])
    await save(page, 'b')
    // Back to A: the same chunk is waiting, and rejecting it still works.
    await show(page, 'a')
    expect(await chunks()).toEqual([[3, 4]])
    expect(await page.evaluate(() => J.getOriginal(ed))).toBe(original)
    await page.evaluate(() => J.rejectAll(ed))
    expect(await value(page)).toBe(original)
    await show(page, 'b')
    expect(await chunks()).toEqual([[0, 1]])
  })
})
