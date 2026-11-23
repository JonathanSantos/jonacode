// Richer zone bars (status, disabled actions, separator, keepFocus) and `lineWidgets()`: zones kept in sync with a provider.
import type { Page } from '@playwright/test'
import { expect, place, settle, test, value } from './helpers.ts'

const DOC = 'package soma\n\nfunc TestSoma(t *testing.T) {\n\tsoma(1, 2)\n}\n\nfunc TestZero(t *testing.T) {\n}\n'

const focusInEditor = (page: Page) => page.evaluate(() => ed.dom.contains(document.activeElement) && document.activeElement === ed.inputDOM)

test.describe('zone actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((doc) => void mount({ value: doc, extensions: J.basicSetup() }, { height: '360px' }), DOC)
    await settle(page)
  })

  test('status, class, a disabled action and the separator', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as any
      w.runs = []
      w.zone = J.addZone(ed, {
        line: 2,
        actions: [
          { label: '▶ Rodar', class: 'run', run: () => w.runs.push('run') },
          { label: 'Depurar', disabled: true, run: () => w.runs.push('debug') },
        ],
        status: { text: 'passou · 0,3 s', class: 'ok' },
      })
    })
    await settle(page)
    const bar = page.locator('.jc-zone-actions')
    await expect(bar.locator('.jc-zone-action')).toHaveText(['▶ Rodar', 'Depurar'])
    await expect(bar.locator('.jc-zone-action.run')).toHaveCount(1)
    await expect(bar.locator('.jc-zone-sep')).toHaveText(['|'])
    await expect(bar.locator('.jc-zone-status.ok')).toHaveText('passou · 0,3 s')
    await expect(bar.locator('.jc-zone-action[aria-disabled=true]')).toHaveText('Depurar')

    // Nothing in the bar takes the focus from the editor: actions, a disabled one, the separator, the status.
    await place(page, 3, 1)
    for (const target of ['.jc-zone-action.run', '.jc-zone-action[aria-disabled=true]', '.jc-zone-sep', '.jc-zone-status']) {
      // `force`: Playwright itself refuses to click what is aria-disabled.
      await bar.locator(target).click({ force: true })
      expect(await focusInEditor(page), target).toBe(true)
    }
    expect(await page.evaluate(() => (window as any).runs)).toEqual(['run'])
    await page.keyboard.type('x')
    expect(await page.evaluate(() => ed.doc.line(3))).toBe('\txsoma(1, 2)')

    // Updating only the status keeps the buttons; another separator, or none.
    const kept = await page.evaluate(() => {
      const w = window as any
      const content = w.zone.dom.firstElementChild
      w.zone.update({ status: { text: 'falhou', class: 'falhou' }, separator: '·' })
      return w.zone.dom.firstElementChild !== content
    })
    expect(kept).toBe(true)
    await expect(bar.locator('.jc-zone-status.falhou')).toHaveText('falhou')
    await expect(bar.locator('.jc-zone-sep')).toHaveText(['·'])
    await page.evaluate(() => (window as any).zone.update({ separator: false, status: null }))
    await expect(bar.locator('.jc-zone-sep')).toHaveCount(0)
    await expect(bar.locator('.jc-zone-status')).toHaveCount(0)
    await expect(bar).toHaveClass(/jc-zone-actions-plain/)
  })

  test('keepFocus: a click on a button inside `content` leaves the focus in the editor; fields still take it', async ({ page }) => {
    const add = (keepFocus: boolean) => page.evaluate((keep) => {
      const w = window as any
      w.zone?.remove()
      const box = document.createElement('div')
      box.innerHTML = '<button type="button" class="own-btn">Rodar</button> <span class="own-text">texto</span> <input class="own-input" aria-label="campo">'
      w.clicks = 0
      box.querySelector('button')!.addEventListener('click', () => w.clicks++)
      w.zone = J.addZone(ed, { line: 2, content: box, keepFocus: keep })
    }, keepFocus)

    await add(true)
    await settle(page)
    await place(page, 3, 1)
    await page.locator('.own-btn').click()
    expect(await page.evaluate(() => (window as any).clicks)).toBe(1)
    expect(await focusInEditor(page)).toBe(true)
    await page.locator('.own-text').click()
    expect(await focusInEditor(page)).toBe(true)
    await page.keyboard.type('x')
    expect(await page.evaluate(() => ed.doc.line(3))).toBe('\txsoma(1, 2)')
    // A field is still usable: it takes the focus and what is typed goes into it.
    await page.locator('.own-input').click()
    await expect(page.locator('.own-input')).toBeFocused()
    await page.keyboard.type('abc')
    await expect(page.locator('.own-input')).toHaveValue('abc')
    expect(await page.evaluate(() => ed.doc.line(3))).toBe('\txsoma(1, 2)')

    // Updating the bar leaves `content` alone: the field keeps the focus (and what was typed).
    const kept = await page.evaluate(() => {
      const w = window as any
      const field = w.zone.dom.querySelector('.own-input')
      w.zone.update({ status: { text: 'rodando…' }, actions: [{ label: 'Parar', run: () => {} }] })
      return { same: w.zone.dom.querySelector('.own-input') === field, focused: document.activeElement === field, value: field.value }
    })
    expect(kept).toEqual({ same: true, focused: true, value: 'abc' })
    await expect(page.locator('.jc-zone-status')).toHaveText('rodando…')

    // Without it (the default), the button takes the focus, as before.
    await add(false)
    await settle(page)
    await place(page, 3, 1)
    await page.locator('.own-btn').click()
    expect(await focusInEditor(page)).toBe(false)
  })
})

test.describe('lineWidgets', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((doc) => {
      const w = window as any
      w.calls = 0
      w.runs = []
      w.results = {}
      w.running = new Set()
      /** A bar above each test function, keyed by its name. */
      w.source = (text: any) => {
        w.calls++
        const out: any[] = []
        text.lines.forEach((line: string, i: number) => {
          const name = /^func (Test\w+)/.exec(line)?.[1]
          if (!name) return
          out.push({
            key: name,
            line: i,
            actions: [{ label: '▶ Rodar', disabled: w.running.has(name), run: () => w.runs.push(name + '@' + w.calls) }],
            status: w.results[name] && { text: w.results[name] },
          })
        })
        return out
      }
      mount({ value: doc, extensions: [J.basicSetup(), J.lineWidgets(w.source, { delay: 30 })] }, { height: '360px' })
      w.zoneOf = (key: string) => J.getZones(ed).find((z: any) => ed.doc.line(z.line).includes(key))
      w.first = w.zoneOf('TestSoma')
      w.firstButton = w.first.dom.querySelector('button')
    }, DOC)
    await settle(page)
  })

  const state = (page: Page) => page.evaluate(() => {
    const w = window as any
    return {
      zones: J.getZones(ed).map((z: any) => `${z.line}:${z.dom.textContent}`),
      sameZone: w.zoneOf('TestSoma') === w.first,
      sameButton: w.first.dom.querySelector('button') === w.firstButton && w.firstButton.isConnected,
      calls: w.calls,
    }
  })

  test('one zone per widget; lines inserted above move it without recreating anything', async ({ page }) => {
    expect(await state(page)).toEqual({ zones: ['2:▶ Rodar', '6:▶ Rodar'], sameZone: true, sameButton: true, calls: 1 })
    await page.evaluate(() => ed.dispatch({ changes: { from: { line: 0, col: 0 }, insert: '// um\n// dois\n' } }))
    await expect.poll(() => state(page).then((s) => s.calls)).toBe(2)
    expect(await state(page)).toEqual({ zones: ['4:▶ Rodar', '8:▶ Rodar'], sameZone: true, sameButton: true, calls: 2 })
    // Typing inside the function, and several edits in a row: one round, the same elements.
    await place(page, 5, 1)
    await page.keyboard.type('abc')
    await expect.poll(() => state(page).then((s) => s.calls)).toBe(3)
    expect(await state(page)).toMatchObject({ zones: ['4:▶ Rodar', '8:▶ Rodar'], sameZone: true, sameButton: true })
    // The button calls the latest `run`, not the one of the round that built it.
    await page.locator('.jc-zone-action').first().click()
    expect(await page.evaluate(() => (window as any).runs)).toEqual(['TestSoma@3'])
  })

  test('widgets that go away are removed, new ones created, renamed ones replaced', async ({ page }) => {
    await page.evaluate(() => ed.dispatch({ changes: { from: { line: 6, col: 0 }, to: { line: 8, col: 0 } } }))
    await expect.poll(() => state(page).then((s) => s.zones)).toEqual(['2:▶ Rodar'])
    expect(await state(page)).toMatchObject({ sameZone: true, sameButton: true })
    await page.evaluate(() => ed.dispatch({ changes: { from: ed.doc.end, insert: '\nfunc TestNovo(t *testing.T) {}\n' } }))
    await expect.poll(() => state(page).then((s) => s.zones)).toEqual(['2:▶ Rodar', '7:▶ Rodar'])
    // Another key on the same line is another zone.
    await page.evaluate(() => ed.dispatch({ changes: { from: { line: 2, col: 5 }, to: { line: 2, col: 13 }, insert: 'TestSubtrai' } }))
    await expect.poll(() => page.evaluate(() => (window as any).first.dom.isConnected)).toBe(false)
    // getZones() lists them in the order they were added: the renamed one is new.
    expect((await state(page)).zones).toEqual(['7:▶ Rodar', '2:▶ Rodar'])
    await expect(page.locator('.jc-zone')).toHaveCount(2)
  })

  test('refreshLineWidgets() updates only what changed, right away', async ({ page }) => {
    const second = await page.evaluate(() => {
      const w = window as any
      w.second = w.zoneOf('TestZero').dom.querySelector('.jc-zone-actions')
      w.running.add('TestSoma')
      J.refreshLineWidgets(ed)
      return { calls: w.calls, sameSecondBar: w.zoneOf('TestZero').dom.querySelector('.jc-zone-actions') === w.second }
    })
    expect(second).toEqual({ calls: 2, sameSecondBar: true })
    await expect(page.locator('.jc-zone-action[aria-disabled=true]')).toHaveCount(1)
    expect((await state(page)).sameZone).toBe(true)
    await page.evaluate(() => {
      const w = window as any
      w.running.clear()
      w.results.TestSoma = 'passou · 0,3 s'
      J.refreshLineWidgets(ed)
    })
    await expect(page.locator('.jc-zone-status')).toHaveText(['passou · 0,3 s'])
    await expect(page.locator('.jc-zone-action[aria-disabled=true]')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).zoneOf('TestZero').dom.querySelector('.jc-zone-actions') === (window as any).second)).toBe(true)
  })

  test('the zones go away with the extension, and survive a swap when it sits outside the compartment', async ({ page }) => {
    await page.evaluate((doc) => {
      const w = window as any
      w.part = J.compartment()
      w.widgets = J.compartment()
      mount({ value: doc, extensions: [J.basicSetup(), w.widgets.of(J.lineWidgets(w.source, { delay: 30 })), w.part.of(null)] }, { height: '360px' })
      w.first = w.zoneOf('TestSoma')
      w.firstButton = w.first.dom.querySelector('button')
      w.part.reconfigure(ed, J.search())
    }, DOC)
    await settle(page)
    expect(await state(page)).toMatchObject({ zones: ['2:▶ Rodar', '6:▶ Rodar'], sameZone: true, sameButton: true })
    await page.evaluate(() => (window as any).widgets.reconfigure(ed, null))
    await settle(page)
    await expect(page.locator('.jc-zone')).toHaveCount(0)
    expect(await page.evaluate(() => J.getZones(ed).length)).toBe(0)
    expect(await value(page)).toBe(DOC)
  })
})
