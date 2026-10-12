// Collaboration: two editors on one page, each with its own Y.Doc, linked like two browsers would be.
import type { Page } from '@playwright/test'
import { charCenter, expect, test } from './helpers.ts'

/** Mounts Ana (left) and Bia (right) on a shared Yjs text. */
async function twoPeople(page: Page, doc = '', extra: Record<string, unknown> = {}) {
  await page.evaluate(async ([initial, x]) => {
    const { Y, Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } = await import('./.build/yjs.js')
    const app = document.getElementById('app')!
    app.replaceChildren()
    app.style.display = 'flex'
    app.style.gap = '12px'
    const docs = [new Y.Doc(), new Y.Doc()]
    const awareness = docs.map((d) => new Awareness(d))
    docs.forEach((d, i) => d.on('update', (u: Uint8Array, o: unknown) => { if (o !== 'net') Y.applyUpdate(docs[1 - i], u, 'net') }))
    awareness.forEach((a, i) => a.on('update', ({ added, updated, removed }: any, o: unknown) => {
      if (o !== 'net') applyAwarenessUpdate(awareness[1 - i], encodeAwarenessUpdate(a, [...added, ...updated, ...removed]), 'net')
    }))
    docs[0].getText('code').insert(0, initial)
    const names = ['Ana', 'Bia']
    ;(window as any).eds = names.map((name, i) => {
      const host = document.createElement('div')
      host.style.cssText = 'width:420px;height:260px'
      host.id = 'host-' + name
      app.appendChild(host)
      return J.createEditor(host, {
        language: J.javascript,
        extensions: [J.basicSetup(), J.collab(J.yjs({ Y, text: docs[i].getText('code'), awareness: awareness[i] }), { user: { name }, ...x })],
      })
    })
    ;(window as any).ed = (window as any).eds[0]
  }, [doc, extra] as const)
  await page.waitForTimeout(150)
}

const valueOf = (page: Page, i: number) => page.evaluate((n) => (window as any).eds[n].getValue(), i)

test.describe('collaboration', () => {
  test('what one types shows up for the other, with their cursor, name and a flash', async ({ page }) => {
    await twoPeople(page, 'const total = 0\n')
    const at = await charCenter(page, 0, 15)
    await page.mouse.click(at.x + 2, at.y)
    await page.keyboard.type(' + 1')
    expect(await valueOf(page, 1)).toBe('const total = 0 + 1\n')
    const bia = page.locator('#host-Bia')
    await expect(bia.locator('.jc-peer-caret')).toHaveCount(1)
    await expect(bia.locator('.jc-peer-label')).toHaveText('Ana')
    await expect(bia.locator('.jc-peer-caret.jc-peer-show')).toHaveCount(1)
    await expect(bia.locator('.jc-collab-flash').first()).toBeAttached()
    // The caret sits right after what Ana typed (presence is sent in batches: wait for the last one).
    const offset = () => page.evaluate(() => {
      const bia = (window as any).eds[1]
      const caret = bia.dom.querySelector('.jc-peer-caret').getBoundingClientRect()
      const r = bia.contentDOM.getBoundingClientRect()
      const c = bia.coordsAtPos({ line: 0, col: 19 })
      return Math.max(Math.abs(caret.left + caret.width / 2 - (r.left + c.x)), Math.abs(caret.top - (r.top + c.top)))
    })
    await expect.poll(offset).toBeLessThan(2)
  })

  test('a selection shows for the other person; the avatar bar lists who is there', async ({ page }) => {
    await twoPeople(page, 'let a = 1\nlet b = 2\n')
    await page.evaluate(() => (window as any).eds[0].setSelection({ line: 1, col: 4 }, { line: 1, col: 5 }))
    const bia = page.locator('#host-Bia')
    await expect(bia.locator('.jc-peer-sel')).toHaveCount(1)
    await expect(bia.locator('.jc-collab-avatars button')).toHaveText('A')
    await expect(bia.locator('.jc-collab-avatars button')).toHaveAttribute('title', 'Ana')
  })

  test('Mod+Z undoes only your own typing, for both', async ({ page }) => {
    await twoPeople(page, '\n')
    await page.evaluate(() => (window as any).eds[0].setSelection({ line: 0, col: 0 }))
    await page.evaluate(() => (window as any).eds[0].focus())
    await page.keyboard.type('ana')
    await page.evaluate(() => {
      const bia = (window as any).eds[1]
      bia.dispatch({ changes: { from: { line: 1, col: 0 }, insert: 'bia' }, origin: 'input' })
    })
    expect(await valueOf(page, 0)).toBe('ana\nbia')
    await page.keyboard.press('ControlOrMeta+z')
    expect(await valueOf(page, 0)).toBe('\nbia')
    expect(await valueOf(page, 1)).toBe('\nbia')
  })

  test('clicking an avatar follows that person as they move', async ({ page }) => {
    await twoPeople(page, Array.from({ length: 300 }, (_, i) => `// line ${i + 1}`).join('\n'))
    await page.locator('#host-Bia .jc-collab-avatars button').click()
    await expect(page.locator('#host-Bia .jc-collab-avatars button')).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => (window as any).eds[0].setSelection({ line: 250, col: 0 }))
    await expect.poll(() => page.evaluate(() => (window as any).eds[1].scrollDOM.scrollTop)).toBeGreaterThan(3000)
    // Scrolling yourself stops following.
    await page.locator('#host-Bia .jc-scroller').hover()
    await page.mouse.wheel(0, -200)
    await expect(page.locator('#host-Bia .jc-collab-avatars button')).toHaveAttribute('aria-pressed', 'false')
  })
})
