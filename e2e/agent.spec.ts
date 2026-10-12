// Agents and automation: filling the textarea, script-set values, the page description; read-only ranges;
// editorTools() against a real editor.
import type { Page } from '@playwright/test'
import { clickAt, expect, head, settle, test, value } from './helpers.ts'

const N = 200
const numbered = (edit: (l: string[]) => void = () => {}) => {
  const l = Array.from({ length: N }, (_, i) => `const line${i + 1} = compute(${i}, ${i * 2}) // ${i + 1}`)
  edit(l)
  return l.join('\n')
}

/** Puts the cursor on 1-based line `n` with the keyboard (go to line). */
async function goToLine(page: Page, n: number): Promise<void> {
  await page.keyboard.press('Control+g')
  await page.keyboard.type(String(n))
  await page.keyboard.press('Enter')
  await settle(page)
}

test.describe('agent-friendly input', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => void mount({ value: numberedLines(200), extensions: J.basicSetup() }))
    await page.locator('.jc-content').click()
    await goToLine(page, 25)
    expect(await head(page)).toEqual({ line: 24, col: 0 })
  })

  test('the textarea says which page of the file it mirrors', async ({ page }) => {
    const textbox = page.getByRole('textbox', { name: 'Code editor' })
    await expect(textbox).toHaveAttribute('aria-description', 'Lines 21–30 of 200')
    await expect(textbox).toHaveAccessibleDescription('Lines 21–30 of 200')
    await goToLine(page, 200)
    await expect(textbox).toHaveAttribute('aria-description', 'Lines 191–200 of 200')
    // A document that fits in the mirror needs no description.
    await page.evaluate(() => ed.setValue('short\nfile'))
    await page.keyboard.press('ArrowDown')
    await expect(textbox).not.toHaveAttribute('aria-description', /./)
  })

  test('locator.fill() replaces the whole document (not just the mirrored page); one undo restores it', async ({ page }) => {
    // fill() selects the whole field (selectionStart = 0, selectionEnd = length), then inserts the text.
    await page.locator('.jc-input').fill('brand new\ndocument')
    expect(await value(page)).toBe('brand new\ndocument')
    await settle(page)
    expect(await page.evaluate(() => [lineEl(0)!.textContent, lineEl(1)!.textContent])).toEqual(['brand new', 'document'])
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe(numbered())
  })

  test('a script setting the mirrored page with one line changed edits only that line', async ({ page }) => {
    const mirror = await page.locator('.jc-input').inputValue()
    expect(mirror.split('\n')).toHaveLength(10)
    await page.evaluate(() => {
      const ta = ed.inputDOM as HTMLTextAreaElement
      const lines = ta.value.split('\n')
      lines[3] = 'const line24 = CHANGED'
      ta.value = lines.join('\n')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(await value(page)).toBe(numbered((l) => { l[23] = 'const line24 = CHANGED' }))
    await expect(page.locator('.jc-line', { hasText: 'CHANGED' })).toHaveCount(1)
    await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe(numbered())
  })

  test('a script setting the whole file with one line changed edits only that line', async ({ page }) => {
    await page.evaluate(() => {
      const ta = ed.inputDOM as HTMLTextAreaElement
      const lines = ed.getValue().split('\n')
      lines[149] = 'const line150 = CHANGED'
      ta.value = lines.join('\n')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(await value(page)).toBe(numbered((l) => { l[149] = 'const line150 = CHANGED' }))
    expect(await head(page)).toEqual({ line: 149, col: 23 })
  })
})

test.describe('read-only ranges', () => {
  const DOC = 'import x from "x"\n// generated: do not edit\nconst id = 42\n// end\nlet free = 1'

  test.beforeEach(async ({ page }) => {
    await page.evaluate((doc) => {
      const w = window as any
      w.rejected = 0
      mount({ value: doc, language: 'javascript', extensions: J.basicSetup() })
      ed.setExtensions([J.basicSetup(), J.readOnlyRanges([J.lineRange(ed, 2, 4)], { onReject: () => w.rejected++ })])
      ed.flush()
    }, DOC)
    await settle(page)
  })

  test('typing, deleting and pasting inside a protected range do nothing; right before and after works', async ({ page }) => {
    await expect(page.locator('.jc-line-deco.jc-readonly-line')).toHaveCount(3)
    await clickAt(page, 2, 6)
    await page.keyboard.type('abc')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Delete')
    await page.keyboard.press('Enter')
    // A paste (clipboard event) inside it too.
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.setData('text/plain', 'PASTED')
      ed.inputDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    expect(await value(page)).toBe(DOC)
    expect(await page.evaluate(() => (window as any).rejected)).toBeGreaterThanOrEqual(6)
    // Select all + Backspace touches the range: nothing is deleted.
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    expect(await value(page)).toBe(DOC)
    // Right before the range (end of line 1) and right after it (end of line 4).
    await clickAt(page, 0, 17)
    await page.keyboard.type(';')
    await page.keyboard.press('Enter')
    await page.keyboard.type('// ok')
    const end = await page.evaluate(() => charRect(4, 6))
    await page.mouse.click(end.right + 20, end.top + end.height / 2)
    expect(await head(page)).toEqual({ line: 4, col: 6 })
    await page.keyboard.type(' (still)')
    expect(await value(page)).toBe('import x from "x";\n// ok\n// generated: do not edit\nconst id = 42\n// end (still)\nlet free = 1')
    // The range followed the edits: it's lines 3–5 now.
    expect(await page.evaluate(() => J.getReadOnlyRanges(ed))).toEqual([{ from: { line: 2, col: 0 }, to: { line: 4, col: 6 } }])
    await clickAt(page, 3, 0)
    await page.keyboard.type('x')
    expect(await page.evaluate(() => ed.doc.line(3))).toBe('const id = 42')
    // Undo still works (typing is grouped by time: however many steps it took).
    for (let i = 0; i < 12 && (await value(page)) !== DOC; i++) await page.keyboard.press('ControlOrMeta+z')
    expect(await value(page)).toBe(DOC)
  })

  test('applyEdits touching a protected range fails with a message; elsewhere it works', async ({ page }) => {
    const bad = await page.evaluate(() => J.applyEdits(ed, [{ old: 'const id = 42', new: 'const id = 0' }]))
    expect(bad.ok).toBe(false)
    expect(bad.summary).toMatch(/protected \(read-only\)/)
    expect(await value(page)).toBe(DOC)
    const good = await page.evaluate(() => J.applyEdits(ed, [{ old: 'let free = 1', new: 'let free = 2' }]))
    expect(good.ok).toBe(true)
    await expect(page.locator('.jc-line', { hasText: 'let free = 2' })).toHaveCount(1)
  })
})

test.describe('editorTools in a page', () => {
  const DOC = 'var a = 1\nlet b = 2\nconsole.log(a + b)'

  test.beforeEach(async ({ page }) => {
    await page.evaluate((doc) => {
      const w = window as any
      // A tiny linter: `var` is a warning.
      const lint = (e: any) => e.doc.lines.flatMap((text: string, line: number) => {
        const col = text.indexOf('var ')
        return col < 0 ? [] : [{ from: { line, col }, to: { line, col: 3 }, severity: 'warning', message: 'Unexpected var', source: 'lint' }]
      })
      mount({ value: doc, language: 'javascript', extensions: [J.basicSetup(), J.linter(lint, { delay: 20 })] })
      w.tools = J.editorTools(ed, { settle: 120 })
    }, DOC)
    await settle(page)
  })

  const run = (page: Page, name: string, input: unknown) =>
    page.evaluate(([n, i]) => (window as any).tools.run(n, i), [name, input] as const) as Promise<{ content: string; isError?: boolean }>

  test('edit_file changes the rendered document and reports it', async ({ page }) => {
    const r = await run(page, 'edit_file', { edits: [{ old: 'let b = 2', new: 'let b = 40' }] })
    expect(r.isError).toBeUndefined()
    expect(r.content).toMatch(/^Applied 1 edit \(line 2\)\./)
    expect(r.content).toContain('main.js after the edit:\n     1\tvar a = 1\n     2\tlet b = 40\n')
    expect(r.content).toContain('Problems after the edit (line:col):\n- 1:1 warning: Unexpected var [lint]')
    await expect(page.locator('.jc-line').nth(1)).toHaveText('let b = 40')
    // What the AI wrote is tinted.
    await expect(page.locator('.jc-mark.jc-ai-edit')).toHaveCount(1)
    // A failed edit is an error for the model, and changes nothing.
    const bad = await run(page, 'edit_file', { edits: [{ old: 'let c = 3', new: 'x' }] })
    expect(bad.isError).toBe(true)
    expect(bad.content).toMatch(/^No edits applied\./)
    // undo_last_edit reverts the tool's edit.
    const undo = await run(page, 'undo_last_edit', {})
    expect(undo.content).toBe('Undid your last edit of main.js (3 lines now).')
    expect(await value(page)).toBe(DOC)
  })

  test("Claude's text editor tool: view and str_replace", async ({ page }) => {
    const view = await run(page, 'str_replace_based_edit_tool', { command: 'view', path: 'main.js' })
    expect(view.content).toBe('main.js (javascript, 3 lines)\n     1\tvar a = 1\n     2\tlet b = 2\n     3\tconsole.log(a + b)\n')
    const range = await run(page, 'str_replace_based_edit_tool', { command: 'view', path: 'main.js', view_range: [2, 3] })
    expect(range.content).toBe('main.js (javascript, 3 lines)\n     2\tlet b = 2\n     3\tconsole.log(a + b)\n')
    const r = await run(page, 'str_replace_based_edit_tool', { command: 'str_replace', path: 'main.js', old_str: 'var a = 1', new_str: 'const a = 1' })
    expect(r.isError).toBeUndefined()
    expect(r.content).toMatch(/^Applied 1 edit \(line 1\)\./)
    expect(r.content).toContain('No problems reported.')
    await expect(page.locator('.jc-line').first()).toHaveText('const a = 1')
    // Ambiguous old_str: refused, with the lines.
    await page.evaluate(() => ed.setValue('x = 1\nx = 1'))
    const dup = await run(page, 'str_replace_based_edit_tool', { command: 'str_replace', path: 'main.js', old_str: 'x = 1', new_str: 'y' })
    expect(dup).toEqual({ isError: true, content: 'No replacement was performed: old_str appears 2 times in main.js (lines 1, 2). Include more lines around it to make it unique.' })
  })

  test('get_problems lists the diagnostics of the linter', async ({ page }) => {
    await expect.poll(async () => (await run(page, 'get_problems', {})).content).toBe('1 problem (line:col):\n- 1:1 warning: Unexpected var [lint]')
    // The same diagnostic is on screen.
    await expect(page.locator('.jc-mark.jc-diag-warning')).toHaveCount(1)
    // Fixing it by typing: the list follows.
    await clickAt(page, 0, 0)
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.type('let')
    await expect.poll(async () => (await run(page, 'get_problems', {})).content).toBe('No problems.')
    const sel = await run(page, 'get_selection', {})
    expect(sel.content).toBe('main.js:\nCursor at line 1, col 4, nothing selected.')
  })
})
