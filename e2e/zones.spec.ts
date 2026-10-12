// Zones (elements between lines that take room of their own), content widgets and overlays: addZone / addWidget / addOverlay.
import type { Page } from '@playwright/test'
import { clickAt, expect, head, keys, place, settle, test } from './helpers.ts'

const DOC = Array.from({ length: 14 }, (_, i) => `line ${i + 1} text`).join('\n')
/** Focusing something in a zone may scroll to it, but never far (a jump to the top would be a bug). */
const MAX_FOCUS_SCROLL = 100

/** Client tops of the rendered lines and of their line-number cells, by line index. */
const tops = (page: Page) => page.evaluate(() => {
  const lines: Record<number, number> = {}
  const cells: Record<number, number> = {}
  for (const el of ed.dom.querySelectorAll('.jc-line')) {
    const n = Number(el.textContent.match(/^line (\d+)/)?.[1]) - 1
    if (n >= 0) lines[n] = el.getBoundingClientRect().top
  }
  for (const el of ed.dom.querySelectorAll('.jc-gutter-lines .jc-gutter-cell')) cells[Number(el.textContent) - 1] = el.getBoundingClientRect().top
  return { lines, cells, lh: ed.lineHeight as number }
})

/** A zone whose content is a block of an exact height in px (not a multiple of the line height). */
const addBox = (page: Page, line: number, side: 'above' | 'below', px: number, extra: Record<string, unknown> = {}) => page.evaluate(([l, s, h, more]) => {
  const box = document.createElement('div')
  box.className = 'box'
  box.style.height = h + 'px'
  box.innerHTML = '<button type="button" class="zone-btn">Resolver</button> <input class="zone-input" aria-label="comentário">'
  const w = window as any
  w.zoneClicks = 0
  box.querySelector('button')!.addEventListener('click', () => w.zoneClicks++)
  w.zone = J.addZone(ed, { line: l, side: s, content: box, class: 'test-zone', ...more })
  ed.flush()
}, [line, side, px, extra] as const)

const zoneBox = (page: Page, selector = '.test-zone') => page.evaluate((sel) => {
  const r = ed.dom.querySelector(sel)!.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }
}, selector)

test.describe('zones', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((doc) => void mount({ value: doc, extensions: J.basicSetup() }, { height: '420px' }), DOC)
    await settle(page)
  })

  test('a zone takes the height of its content: the lines below move down by exactly that, gutter numbers follow', async ({ page }) => {
    const before = await tops(page)
    await addBox(page, 3, 'above', 37)
    await settle(page)
    const after = await tops(page)
    for (let l = 0; l < 14; l++) {
      const shift = l >= 3 ? 37 : 0
      expect(Math.abs(after.lines[l]! - before.lines[l]! - shift), `line ${l + 1}`).toBeLessThan(0.5)
      expect(Math.abs(after.cells[l]! - after.lines[l]!), `gutter ${l + 1}`).toBeLessThan(0.5)
    }
    // Between line 3 and line 4, starting at the edge of the text area (after the gutters).
    const z = await zoneBox(page)
    expect(Math.abs(z.top - (after.lines[2]! + after.lh))).toBeLessThan(0.5)
    expect(Math.abs(z.bottom - after.lines[3]!)).toBeLessThan(0.5)
    const gutterRight = await page.evaluate(() => ed.dom.querySelector('.jc-gutters').getBoundingClientRect().right)
    expect(Math.abs(z.left - gutterRight)).toBeLessThan(1)
    expect(await page.evaluate(() => (window as any).zone.height)).toBe(37)
    // Clicks on the lines around it land on their lines; arrows step over it.
    for (const l of [2, 3, 5]) {
      await clickAt(page, l, 3)
      expect(await head(page)).toEqual({ line: l, col: 3 })
    }
    await place(page, 2, 3)
    await page.keyboard.press('ArrowDown')
    expect(await head(page)).toEqual({ line: 3, col: 3 })
    await page.keyboard.press('ArrowUp')
    expect(await head(page)).toEqual({ line: 2, col: 3 })
  })

  test('auto height follows the content as it changes, before the next paint', async ({ page }) => {
    await addBox(page, 5, 'below', 20)
    await settle(page)
    const lh = await page.evaluate(() => ed.lineHeight)
    // Grow the content: the frame that lays it out also moves the lines (the zone is measured after layout, and the
    // editor redraws before the paint). This callback, queued ahead of any render the editor could have scheduled
    // for the next frame, already sees the lines moved.
    const moved = await page.evaluate(() => new Promise<number>((resolve) => {
      const line7 = () => [...ed.dom.querySelectorAll('.jc-line')].find((el: any) => el.textContent === 'line 7 text')!.getBoundingClientRect().top
      const before = line7()
      ;(ed.dom.querySelector('.box') as HTMLElement).style.height = '61px'
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(line7() - before)))
    }))
    expect(moved).toBeCloseTo(41, 0)
    const z = await zoneBox(page)
    const t = await tops(page)
    expect(Math.abs(z.top - (t.lines[5]! + lh))).toBeLessThan(0.5)
    expect(Math.abs(z.bottom - t.lines[6]!)).toBeLessThan(0.5)
  })

  test('fixed heights: px stay, lines follow the font size', async ({ page }) => {
    await page.evaluate(() => {
      J.addZone(ed, { line: 2, content: 'px', height: 30, class: 'z-px' })
      J.addZone(ed, { line: 6, content: 'lines', lines: 2, class: 'z-lines' })
      ed.flush()
    })
    await settle(page)
    let lh = await page.evaluate(() => ed.lineHeight)
    expect((await zoneBox(page, '.z-px')).height).toBeCloseTo(30, 0)
    expect((await zoneBox(page, '.z-lines')).height).toBeCloseTo(2 * lh, 0)
    await page.evaluate(() => ed.setOptions({ fontSize: 20 }))
    await settle(page)
    lh = await page.evaluate(() => ed.lineHeight)
    expect(lh).toBeGreaterThan(26)
    expect((await zoneBox(page, '.z-px')).height).toBeCloseTo(30, 0)
    expect((await zoneBox(page, '.z-lines')).height).toBeCloseTo(2 * lh, 0)
    const t = await tops(page)
    expect(Math.abs((await zoneBox(page, '.z-lines')).bottom - t.lines[6]!)).toBeLessThan(0.5)
    expect(Math.abs((await zoneBox(page, '.z-px')).bottom - t.lines[2]!)).toBeLessThan(0.5)
  })

  test('zones move with their lines: Enter at the start pushes an above-zone down with its line, Enter at the end leaves a below-zone under it', async ({ page }) => {
    await page.evaluate(() => {
      ;(window as any).a = J.addZone(ed, { line: 4, content: 'above 5', class: 'z-a' })
      ;(window as any).b = J.addZone(ed, { line: 8, side: 'below', content: 'below 9', class: 'z-b' })
      ed.flush()
    })
    await place(page, 4, 0)
    await page.keyboard.press('Enter')
    expect(await page.evaluate(() => [(window as any).a.line, (window as any).b.line])).toEqual([5, 9])
    await place(page, 9, 'line 9 text'.length)
    await page.keyboard.press('Enter')
    await page.keyboard.type('new')
    expect(await page.evaluate(() => [(window as any).a.line, (window as any).b.line])).toEqual([5, 9])
    await settle(page)
    // On screen: the zone is right under "line 9 text", the new line comes after it.
    const t = await page.evaluate(() => {
      const top = (text: string) => [...ed.dom.querySelectorAll('.jc-line')].find((el: any) => el.textContent === text)!.getBoundingClientRect()
      const z = ed.dom.querySelector('.z-b')!.getBoundingClientRect()
      return { line9: top('line 9 text').bottom, zoneTop: z.top, zoneBottom: z.bottom, next: top('new').top }
    })
    expect(Math.abs(t.zoneTop - t.line9)).toBeLessThan(0.5)
    expect(Math.abs(t.next - t.zoneBottom)).toBeLessThan(0.5)
    // Deleting the lines above moves them up; deleting the zone's line keeps it on the neighbour.
    await page.evaluate(() => ed.dispatch({ changes: { from: { line: 0, col: 0 }, to: { line: 2, col: 0 } } }))
    expect(await page.evaluate(() => [(window as any).a.line, (window as any).b.line])).toEqual([3, 7])
    await page.evaluate(() => ed.dispatch({ changes: { from: { line: 6, col: ed.doc.line(6).length }, to: { line: 7, col: ed.doc.line(7).length } } }))
    expect(await page.evaluate(() => (window as any).b.line)).toBe(6)
  })

  test('zones stay in view when the text scrolls sideways; `scroll: true` ones scroll with it', async ({ page }) => {
    await page.evaluate(() => {
      ed.setValue(Array.from({ length: 10 }, (_, i) => `line ${i + 1} ` + 'long text '.repeat(30)).join('\n'))
      J.addZone(ed, { line: 3, content: 'stays', class: 'z-fixed' })
      J.addZone(ed, { line: 6, content: 'scrolls', class: 'z-scroll', scroll: true })
      ed.flush()
    })
    await settle(page)
    const before = { fixed: await zoneBox(page, '.z-fixed'), scroll: await zoneBox(page, '.z-scroll') }
    await page.evaluate(() => (ed.scrollDOM.scrollLeft = 250))
    await settle(page)
    const after = { fixed: await zoneBox(page, '.z-fixed'), scroll: await zoneBox(page, '.z-scroll') }
    expect(Math.abs(after.fixed.left - before.fixed.left)).toBeLessThan(1)
    expect(Math.abs(after.fixed.right - before.fixed.right)).toBeLessThan(1)
    expect(Math.abs(after.scroll.left - (before.scroll.left - 250))).toBeLessThan(1)
    // A fixed zone ends at the scroller's visible edge (not at the end of the long lines).
    const view = await page.evaluate(() => {
      const r = ed.scrollDOM.getBoundingClientRect()
      return r.left + ed.scrollDOM.clientWidth
    })
    expect(Math.abs(after.fixed.right - view)).toBeLessThan(1)
  })

  test('clicks and typing inside a zone stay in the zone; action bars run without taking the focus', async ({ page }) => {
    await addBox(page, 3, 'above', 40)
    await page.evaluate(() => {
      ;(window as any).ran = []
      J.addZone(ed, { line: 8, actions: [
        { label: 'Executar', run: (_ed: unknown, z: any) => (window as any).ran.push('run:' + z.line) },
        { label: 'Depurar', run: () => (window as any).ran.push('debug') },
      ] })
      ed.flush()
    })
    await settle(page)
    await place(page, 0, 2)
    await page.click('.zone-btn')
    expect(await page.evaluate(() => (window as any).zoneClicks)).toBe(1)
    expect(await head(page)).toEqual({ line: 0, col: 2 })
    await page.click('.zone-input')
    await page.keyboard.type('olá')
    expect(await page.inputValue('.zone-input')).toBe('olá')
    expect(await page.evaluate(() => ed.getValue())).toBe(DOC)
    // Actions: run with the zone, and the editor keeps the focus (typing goes on in the text).
    await place(page, 1, 4)
    await page.getByRole('button', { name: 'Executar' }).click()
    await page.getByRole('button', { name: 'Depurar' }).click()
    expect(await page.evaluate(() => (window as any).ran)).toEqual(['run:8', 'debug'])
    expect(await page.evaluate(() => ed.hasFocus)).toBe(true)
    await page.keyboard.type('X')
    expect(await page.evaluate(() => ed.doc.line(1))).toBe('lineX 2 text')
    // Keyboard users reach the actions with Tab.
    await page.getByRole('button', { name: 'Depurar' }).focus()
    await page.keyboard.press('Enter')
    expect(await page.evaluate(() => (window as any).ran.length)).toBe(3)
  })

  test('a new zone is in the page and in place right away: an input in it can take the focus at once', async ({ page }) => {
    await page.evaluate(() => {
      ed.setValue(numberedLines(300))
      ed.scrollIntoView({ line: 150, col: 0 }, true)
      ed.flush()
    })
    await settle(page)
    const r = await page.evaluate(() => {
      const before = ed.scrollDOM.scrollTop
      const box = document.createElement('div')
      box.innerHTML = '<input class="now" aria-label="now">'
      const zone = J.addZone(ed, { line: 152, side: 'below', content: box })
      zone.dom.querySelector('input')!.focus()
      const input = zone.dom.querySelector('input')!.getBoundingClientRect()
      const line = lineEl(152)!.getBoundingClientRect()
      return { focused: document.activeElement?.className, jumped: Math.abs(ed.scrollDOM.scrollTop - before), below: input.top - line.bottom }
    })
    expect(r.focused).toBe('now')
    expect(r.jumped).toBeLessThan(MAX_FOCUS_SCROLL)
    expect(r.below).toBeGreaterThanOrEqual(-0.5)
    await page.keyboard.type('ok')
    expect(await page.inputValue('.now')).toBe('ok')
  })

  test('an action bar starts where the code of its line starts', async ({ page }) => {
    await page.evaluate(() => {
      ed.setValue('function f() {\n    return 1\n}')
      J.addZone(ed, { line: 1, actions: [{ label: 'Executar', run: () => {} }] })
      ed.flush()
    })
    await settle(page)
    const x = await page.evaluate(() => ({
      button: ed.dom.querySelector('.jc-zone-action').getBoundingClientRect().left,
      code: charRect(1, 4).left,
    }))
    expect(Math.abs(x.button - x.code)).toBeLessThan(1)
  })

  test('zones inside a fold hide with it and come back', async ({ page }) => {
    await page.evaluate(() => {
      ed.setValue('function f() {\n  a()\n  b()\n}\nafter()')
      J.addZone(ed, { line: 2, content: 'inside', class: 'z-in' })
      ed.flush()
    })
    await settle(page)
    const lh = await page.evaluate(() => ed.lineHeight)
    const afterTop = () => page.evaluate(() => [...ed.dom.querySelectorAll('.jc-line')].find((el: any) => el.textContent === 'after()')!.getBoundingClientRect().top)
    const open = await afterTop()
    await page.evaluate(() => { ed.setFolds([{ from: 1, to: 2 }]); ed.flush() })
    await settle(page)
    expect(await page.locator('.z-in').isVisible()).toBe(false)
    const zh = await page.evaluate(() => J.getZones(ed)[0].height)
    expect(Math.abs(open - (await afterTop()) - (2 * lh + zh))).toBeLessThan(0.5)
    await page.evaluate(() => { ed.setFolds([]); ed.flush() })
    await settle(page)
    expect(await page.locator('.z-in').isVisible()).toBe(true)
    expect(Math.abs((await afterTop()) - open)).toBeLessThan(0.5)
  })

  test('zones far below the view are measured once and counted in the scroll height; scrolling there shows them in place', async ({ page }) => {
    await page.evaluate(() => {
      ed.setValue(numberedLines(5000))
      ed.flush()
    })
    await settle(page)
    const base = await page.evaluate(() => ed.scrollDOM.scrollHeight)
    await page.evaluate(() => {
      const el = document.createElement('div')
      el.style.height = '57px'
      J.addZone(ed, { line: 4000, content: el, class: 'z-far' })
      ed.flush()
    })
    await settle(page)
    await settle(page)
    expect(await page.evaluate(() => ed.scrollDOM.scrollHeight)).toBe(base + 57)
    expect(await page.evaluate(() => (ed.dom.querySelector('.z-far') as HTMLElement).style.display)).toBe('none')
    await page.evaluate(() => { ed.scrollIntoView({ line: 4000, col: 0 }, true); ed.flush() })
    await settle(page)
    const r = await page.evaluate(() => ({ zone: ed.dom.querySelector('.z-far')!.getBoundingClientRect().bottom, line: lineEl(4000)!.getBoundingClientRect().top }))
    expect(Math.abs(r.zone - r.line)).toBeLessThan(0.5)
  })

  test('zones on the same side of a line stack by order; remove() gives the room back', async ({ page }) => {
    const before = await tops(page)
    await page.evaluate(() => {
      const box = (h: number, cls: string, order: number) => {
        const el = document.createElement('div')
        el.style.height = h + 'px'
        ;(window as any)[cls] = J.addZone(ed, { line: 5, content: el, class: cls, order })
      }
      box(24, 'z2', 2)
      box(18, 'z1', 1)
      ed.flush()
    })
    await settle(page)
    const [z1, z2] = [await zoneBox(page, '.z1'), await zoneBox(page, '.z2')]
    const t = await tops(page)
    expect(Math.abs(z1.bottom - z2.top)).toBeLessThan(0.5)
    expect(Math.abs(z2.bottom - t.lines[5]!)).toBeLessThan(0.5)
    expect(Math.abs(t.lines[5]! - before.lines[5]! - 42)).toBeLessThan(0.5)
    await page.evaluate(() => { (window as any).z1.remove(); (window as any).z2.remove(); ed.flush() })
    await settle(page)
    const back = await tops(page)
    expect(Math.abs(back.lines[5]! - before.lines[5]!)).toBeLessThan(0.5)
    expect(await page.locator('.z1').count()).toBe(0)
  })

  test('update(): moves a zone and replaces its content', async ({ page }) => {
    await page.evaluate(() => {
      ;(window as any).z = J.addZone(ed, { line: 2, content: 'first', class: 'z-u' })
      ed.flush()
    })
    await settle(page)
    await page.evaluate(() => { (window as any).z.update({ line: 7, side: 'below', content: 'second' }); ed.flush() })
    await settle(page)
    expect(await page.locator('.z-u').textContent()).toBe('second')
    const t = await tops(page)
    const z = await zoneBox(page, '.z-u')
    expect(Math.abs(z.top - (t.lines[7]! + t.lh))).toBeLessThan(0.5)
    expect(Math.abs(z.bottom - t.lines[8]!)).toBeLessThan(0.5)
  })

  test('a zone above a wrapped line, and a gutter element beside it', async ({ page }) => {
    await page.evaluate(() => {
      ed.setOptions({ lineWrapping: true })
      ed.setValue('short\n' + 'word '.repeat(90) + '\nend')
      J.addZone(ed, { line: 1, content: 'above the wrapped line', class: 'z-w', gutter: '💬' })
      ed.flush()
    })
    await settle(page)
    const r = await page.evaluate(() => {
      const z = ed.dom.querySelector('.z-w')!.getBoundingClientRect()
      const g = ed.dom.querySelector('.jc-zone-gutter')!.getBoundingClientRect()
      const gutters = ed.dom.querySelector('.jc-gutters')!.getBoundingClientRect()
      return { zoneBottom: z.bottom, zoneTop: z.top, line: lineEl(1)!.getBoundingClientRect().top, rows: ed.lineBlock(1).height / ed.lineHeight, g, gutters }
    })
    expect(r.rows).toBeGreaterThan(1)
    expect(Math.abs(r.zoneBottom - r.line)).toBeLessThan(0.5)
    expect(Math.abs(r.g.top - r.zoneTop)).toBeLessThan(0.5)
    expect(r.g.left).toBeGreaterThanOrEqual(r.gutters.left - 0.5)
    expect(r.g.right).toBeLessThanOrEqual(r.gutters.right + 0.5)
    // Clicking the second visual row of the wrapped line still works.
    const p = await page.evaluate(() => {
      const c = ed.coordsAtPos({ line: 1, col: 100 })
      return ed.contentToClient(c.x + 1, (c.top + c.bottom) / 2)
    })
    await page.mouse.click(p.x, p.y)
    expect((await head(page)).line).toBe(1)
    expect(Math.abs((await head(page)).col - 100)).toBeLessThanOrEqual(1)
  })

  test('Ctrl/Cmd+Home scrolls all the way up, showing a zone above line 1', async ({ page }) => {
    await page.evaluate(() => {
      ed.setValue(numberedLines(200))
      J.addZone(ed, { line: 0, content: 'header', class: 'z-top' })
      ed.flush()
    })
    await place(page, 150, 0)
    await settle(page)
    await page.keyboard.press(keys.docStart)
    await settle(page)
    expect(await page.evaluate(() => ed.scrollDOM.scrollTop)).toBe(0)
    expect(await page.locator('.z-top').isVisible()).toBe(true)
  })
})

test.describe('line gaps (the core under zones and block widgets)', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((doc) => void mount({ value: doc, extensions: J.basicSetup() }, { height: '420px' }), DOC)
    await settle(page)
  })

  test('gaps in px and in rows; edits move a gap above a line with its start and one below with its end', async ({ page }) => {
    await page.evaluate(() => {
      ed.setLineGaps('t', [{ line: 3, above: 13, px: true }, { line: 3, below: 1 }, { line: 8, above: 2 }])
      ed.flush()
    })
    const gaps = () => page.evaluate(() => ({
      a3: ed.gapBlock(3, 'above').height, b3: ed.gapBlock(3, 'below').height, a8: ed.gapBlock(8, 'above').height,
      a4: ed.gapBlock(4, 'above').height, b4: ed.gapBlock(4, 'below').height, lh: ed.lineHeight,
    }))
    let g = await gaps()
    expect([g.a3, g.b3, g.a8]).toEqual([13, g.lh, 2 * g.lh])
    // Enter in the middle of line 4: the gap above stays on its start, the gap below goes with its end (the new line).
    await place(page, 3, 4)
    await page.keyboard.press('Enter')
    g = await gaps()
    expect([g.a3, g.b3, g.a4, g.b4]).toEqual([13, 0, 0, g.lh])
    expect(await page.evaluate(() => ed.gapBlock(9, 'above').height)).toBe(2 * g.lh)
    // Enter at the very start of the line with the gap above: the gap goes down with the line.
    await place(page, 9, 0)
    await page.keyboard.press('Enter')
    expect(await page.evaluate(() => [ed.gapBlock(9, 'above').height, ed.gapBlock(10, 'above').height])).toEqual([0, 2 * g.lh])
    // A bigger font: rows follow it, px don't.
    await page.evaluate(() => { ed.setOptions({ fontSize: 22 }); ed.flush() })
    const lh = await page.evaluate(() => ed.lineHeight)
    expect(lh).toBeGreaterThan(g.lh)
    expect(await page.evaluate(() => [ed.gapBlock(3, 'above').height, ed.gapBlock(10, 'above').height])).toEqual([13, 2 * lh])
  })
})

test.describe('content widgets and overlays', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((doc) => void mount({ value: doc, extensions: J.basicSetup() }, { height: '300px' }), DOC)
    await settle(page)
  })

  test('a widget floats above (or below) its position without moving any line, and follows edits', async ({ page }) => {
    const before = await tops(page)
    await page.evaluate(() => {
      ;(window as any).w = J.addWidget(ed, { pos: { line: 4, col: 5 }, content: 'dica', class: 'w-a' })
      ;(window as any).v = J.addWidget(ed, { pos: { line: 6, col: 0 }, content: 'abaixo', place: 'below', class: 'w-b' })
      ed.flush()
    })
    await settle(page)
    const after = await tops(page)
    expect(after.lines).toEqual(before.lines)
    const r = await page.evaluate(() => ({
      a: ed.dom.querySelector('.w-a').getBoundingClientRect(), b: ed.dom.querySelector('.w-b').getBoundingClientRect(),
      char: charRect(4, 5), line4: lineEl(4)!.getBoundingClientRect(), line6: lineEl(6)!.getBoundingClientRect(),
    }))
    expect(Math.abs(r.a.bottom - r.line4.top)).toBeLessThan(0.5)
    expect(Math.abs(r.a.left - r.char.left)).toBeLessThan(1)
    expect(Math.abs(r.b.top - r.line6.bottom)).toBeLessThan(0.5)
    // Typing before it on its line moves it along.
    await place(page, 4, 0)
    await page.keyboard.type('>> ')
    expect(await page.evaluate(() => (window as any).w.pos)).toEqual({ line: 4, col: 8 })
    // At the top of the view there's no room above: it goes below.
    await page.evaluate(() => { (window as any).w.update({ pos: { line: 0, col: 2 } }); ed.flush() })
    await settle(page)
    const top = await page.evaluate(() => ({ w: ed.dom.querySelector('.w-a').getBoundingClientRect(), line: lineEl(0)!.getBoundingClientRect() }))
    expect(Math.abs(top.w.top - top.line.bottom)).toBeLessThan(0.5)
    // Clicking it doesn't move the cursor.
    await place(page, 3, 1)
    await page.click('.w-a')
    expect(await head(page)).toEqual({ line: 3, col: 1 })
  })

  test('an overlay sits in its corner of the visible text area while the text scrolls', async ({ page }) => {
    await page.evaluate(() => {
      ed.setValue(numberedLines(300))
      J.addOverlay(ed, { content: 'canto', position: 'bottom-right', class: 'ov' })
      J.addOverlay(ed, { content: 'topo', position: 'top-left', class: 'ov2' })
      ed.flush()
    })
    await settle(page)
    const box = () => page.evaluate(() => ({ o: ed.dom.querySelector('.ov').getBoundingClientRect(), o2: ed.dom.querySelector('.ov2').getBoundingClientRect() }))
    const a = await box()
    await page.evaluate(() => (ed.scrollDOM.scrollTop = 900))
    await settle(page)
    const b = await box()
    expect(b.o.top).toBeCloseTo(a.o.top, 0)
    const sc = await page.evaluate(() => {
      const r = ed.scrollDOM.getBoundingClientRect()
      return { right: r.left + ed.scrollDOM.clientWidth, bottom: r.top + ed.scrollDOM.clientHeight, gutter: ed.dom.querySelector('.jc-gutters').getBoundingClientRect().right }
    })
    // Inside the text area: not over the scrollbar, not over the gutters.
    expect(b.o.right).toBeLessThanOrEqual(sc.right)
    expect(b.o.bottom).toBeLessThanOrEqual(sc.bottom)
    expect(b.o2.left).toBeGreaterThanOrEqual(sc.gutter)
  })
})
