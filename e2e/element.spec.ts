// <jona-code> custom element inside a <form>: submission, reset, required validity, disabled, labels.
import type { Page } from '@playwright/test'
import { expect, test } from './helpers.ts'

const FORM = `
<form id="form" method="post" action="/submit">
  <label for="code">Source code</label>
  <jona-code id="code" name="code" language="javascript" required style="height:160px;width:480px">
    const answer = 42
  </jona-code>
  <fieldset id="group">
    <jona-code id="other" name="other" style="height:80px;width:480px">x = 1</jona-code>
  </fieldset>
  <button id="submit" type="submit">Send</button>
  <button id="reset" type="reset">Reset</button>
</form>`

/** Registers the element and renders the form; resolves once both editors exist. */
async function setup(page: Page): Promise<void> {
  await page.evaluate((html) => {
    J.defineJonacodeElement({ languages: [J.javascript], extensions: J.basicSetup() })
    document.getElementById('app')!.innerHTML = html
  }, FORM)
  await page.waitForFunction(() => [...document.querySelectorAll('jona-code')].every((el: any) => el.editor))
}

/** Submits the form with the button and returns the posted fields. */
async function submit(page: Page): Promise<URLSearchParams> {
  const request = page.waitForRequest('**/submit')
  await page.locator('#submit').click()
  return new URLSearchParams((await request).postData() ?? '')
}

test.describe('<jona-code> in a form', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/submit', (route) => route.fulfill({ contentType: 'text/html', body: '<p>ok</p>' }))
    await setup(page)
  })

  test('the value (dedented content) is submitted, edits included', async ({ page }) => {
    expect(await page.locator('#code').evaluate((el: any) => el.value)).toBe('const answer = 42')
    // Real typing into the editor inside the shadow root.
    await page.locator('#code .jc-content').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' // ok')
    expect(await page.locator('#code').evaluate((el: any) => el.value)).toBe('const answer = 42 // ok')
    const posted = await submit(page)
    expect(posted.get('code')).toBe('const answer = 42 // ok')
    expect(posted.get('other')).toBe('x = 1')
  })

  test('form.reset() restores the initial content', async ({ page }) => {
    await page.locator('#code .jc-content').click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('changed')
    expect(await page.locator('#code').evaluate((el: any) => el.value)).toBe('changed')
    await page.locator('#reset').click()
    expect(await page.locator('#code').evaluate((el: any) => el.value)).toBe('const answer = 42')
    await expect(page.locator('#code .jc-line')).toHaveText(['const answer = 42'])
  })

  test('required: an empty editor is invalid and blocks submission', async ({ page }) => {
    let submitted = 0
    page.on('request', (r) => { if (r.url().endsWith('/submit')) submitted++ })
    await page.locator('#code .jc-content').click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    const validity = await page.locator('#code').evaluate((el: any) => ({ valid: el.checkValidity(), missing: el.validity.valueMissing, form: el.form.checkValidity() }))
    expect(validity).toEqual({ valid: false, missing: true, form: false })
    await expect(page.locator('#code')).toHaveJSProperty('willValidate', true)
    expect(await page.locator('#code').evaluate((el) => el.matches(':invalid'))).toBe(true)
    await page.locator('#submit').click()
    // Blocked: the page stays (a submission would navigate away and count a request).
    await expect(page.locator('#code')).toBeVisible()
    await page.locator('#code .jc-content').click()
    await page.keyboard.type('ok')
    expect(await page.locator('#code').evaluate((el: any) => el.checkValidity())).toBe(true)
    expect((await submit(page)).get('code')).toBe('ok')
    expect(submitted).toBe(1)
  })

  test('a disabled fieldset makes it read-only and leaves it out of the submission', async ({ page }) => {
    await page.locator('#group').evaluate((el: HTMLFieldSetElement) => { el.disabled = true })
    await expect(page.locator('#other')).toHaveAttribute('aria-disabled', '')
    await page.locator('#other .jc-content').click()
    await page.keyboard.type('zzz')
    expect(await page.locator('#other').evaluate((el: any) => el.value)).toBe('x = 1')
    await expect(page.locator('#other .jc-editor')).toHaveClass(/jc-readonly/)
    const posted = await submit(page)
    expect(posted.has('other')).toBe(false)
    expect(posted.get('code')).toBe('const answer = 42')
  })

  test('<label for> names the editor and focuses it', async ({ page }) => {
    const textbox = page.getByRole('textbox', { name: 'Source code' })
    await expect(textbox).toHaveCount(1)
    await page.locator('label[for="code"]').click()
    await expect(textbox).toBeFocused()
    await page.keyboard.type('!')
    expect(await page.locator('#code').evaluate((el: any) => el.value)).toBe('!const answer = 42')
  })

  test('change events bubble out of the shadow root with the value', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).changes = []
      document.getElementById('form')!.addEventListener('change', (e: any) => (window as any).changes.push(e.detail?.value))
    })
    await page.locator('#code .jc-content').click()
    await page.keyboard.press('End')
    await page.keyboard.type(';')
    expect(await page.evaluate(() => (window as any).changes)).toEqual(['const answer = 42;'])
  })
})
