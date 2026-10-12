// Regenerates the README images with a local Chrome (DevTools Protocol, no dependencies).
// usage: node scripts/screenshots.js   (after `npm run build && npm run docs`)
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const port = 9300 + Math.floor(Math.random() * 500)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jc-shots-'))}`, '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' })

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      return (await res.json()).webSocketDebuggerUrl
    } catch {
      await sleep(150)
    }
  }
  throw new Error('Chrome did not start')
}

const ws = new WebSocket(await connect())
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map()
const waiters = []
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : ok(msg.result)
  } else if (msg.method) {
    for (const w of waiters.splice(0)) w(msg)
  }
})
const send = (method, params = {}) => new Promise((ok, reject) => {
  const id = ++seq
  pending.set(id, { resolve: ok, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value

async function open(url, { width = 1400, height = 900, dpr = 2 } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Page.navigate', { url: 'about:blank' })
  await send('Page.navigate', { url })
  await sleep(1800)
  await evaluate('document.fonts.ready.then(() => true)')
  await sleep(400)
}

/** Screenshot of the element matched by `selector` (after running `setup`). */
async function shoot(file, selector, { pad = 0, setup = '' } = {}) {
  if (setup) await evaluate(`(async () => { ${setup} })()`)
  const rect = selector === ':viewport' ? await evaluate('({ x: 0, y: scrollY, width: innerWidth, height: innerHeight })') : await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }
  })()`)
  await sleep(300)
  const clip = { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2, scale: 1 }
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true })
  writeFileSync(resolve(root, file), Buffer.from(data, 'base64'))
  console.log('✓', file)
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  const docs = pathToFileURL(resolve(root, 'docs/index.html')).href
  const shots = process.argv.slice(2)
  const want = (name) => !shots.length || shots.includes(name)

  if (want('banner')) {
    await open(pathToFileURL(resolve(root, 'assets/src/banner.html')).href, { width: 1280, height: 640 })
    await shoot('assets/banner.png', ':viewport')
  }
  if (want('light')) {
    await open(docs + '#comecando/api', { width: 1200, height: 900 })
    await shoot('assets/screenshot-light.png', '[data-page="comecando"] .live', {
      setup: `const btns = [...document.querySelectorAll('#api-buttons button')]; btns.find(b => b.textContent === 'Trocar tema').click(); btns.find(b => b.textContent === 'Selecionar palavra').click(); await new Promise(r => setTimeout(r, 300))`,
    })
  }
  if (want('hero')) {
    await open(docs + '#inicio', { width: 1400, height: 1000 })
    await shoot('assets/screenshot-docs.png', ':viewport', {
      setup: `document.querySelector('#hero-editor .jc-editor').dispatchEvent(new MouseEvent('mousedown')); scrollTo(0, 0); await new Promise(r => setTimeout(r, 400))`,
    })
  }
  if (want('editor')) {
    await open(docs + '#inicio', { width: 1200, height: 900 })
    await shoot('assets/screenshot-editor.png', '.hero .live', {
      pad: 0,
      setup: `document.querySelector('#hero-editor .jc-editor').dispatchEvent(new MouseEvent('mousedown')); await new Promise(r => setTimeout(r, 300))`,
    })
  }
  if (want('themes')) {
    await open(docs + '#temas/criador', { width: 1400, height: 1000 })
    await shoot('assets/screenshot-themes.png', '.builder')
  }
  if (want('virtual')) {
    await open(docs + '#por-dentro/virtualizacao', { width: 1400, height: 1000 })
    await shoot('assets/screenshot-virtual.png', '.virt', {
      setup: `const ed = document.querySelector('#virt-editor .jc-scroller'); ed.scrollTop = ed.scrollHeight * 0.42; await new Promise(r => setTimeout(r, 500))`,
    })
  }
  if (want('stepper')) {
    await open(docs + '#linguagens/passo', { width: 1400, height: 1000 })
    await shoot('assets/screenshot-tokenizer.png', '.stepper', {
      setup: `document.querySelector('#step-reset').click(); for (let i = 0; i < 9; i++) document.querySelector('#step-next').click(); await new Promise(r => setTimeout(r, 700))`,
    })
  }
  if (want('incremental')) {
    await open(docs + '#por-dentro/incremental', { width: 1400, height: 1000 })
    await shoot('assets/screenshot-incremental.png', '#incr-editor', {
      setup: `[...document.querySelectorAll('#incr-buttons button')][1].click(); await new Promise(r => setTimeout(r, 250))`,
    })
  }
  if (want('languages')) {
    await open(docs + '#linguagens/prontas', { width: 1300, height: 1000 })
    await shoot('assets/screenshot-languages.png', '.langs-demo', { pad: 6 })
  }
  if (want('a11y')) {
    await open(docs + '#por-dentro/acessibilidade', { width: 1400, height: 1000 })
    await shoot('assets/screenshot-a11y.png', '.a11y-demo', {
      pad: 6,
      setup: `const ta = document.querySelector('#a11y-editor .jc-input'); ta.focus(); await new Promise(r => setTimeout(r, 100));
        for (const [key, shiftKey] of [['ArrowDown'], ['ArrowDown'], ['ArrowDown'], ['ArrowDown'], ['ArrowDown'], ['End'], ['ArrowLeft', true], ['ArrowLeft', true], ['ArrowLeft', true], ['ArrowLeft', true], ['ArrowLeft', true], ['ArrowLeft', true]]) ta.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
        await new Promise(r => setTimeout(r, 200))`,
    })
  }
  if (want('viewer')) {
    await open(docs + '#extensoes/visualizador', { width: 1300, height: 1000 })
    await shoot('assets/screenshot-viewer.png', '#visualizador ~ .live', {
      pad: 6,
      setup: `document.getElementById('log-million').click(); await new Promise(r => setTimeout(r, 700)); document.getElementById('log-search').click(); await new Promise(r => setTimeout(r, 2500))`,
    })
  }
  if (want('diagnostics')) {
    await open(docs + '#extensoes/diagnosticos', { width: 1300, height: 1000 })
    const at = await evaluate(`(async () => {
      await new Promise(r => setTimeout(r, 900))
      document.getElementById('diagnosticos').scrollIntoView()
      await new Promise(r => setTimeout(r, 200))
      const line = [...document.querySelectorAll('#diag-editor .jc-line')].find((l) => l.textContent.includes('totl'))
      const r = document.createRange(); const t = [...line.querySelectorAll('span')].find((s) => s.textContent === 'totl').firstChild
      r.setStart(t, 1); r.setEnd(t, 2); const b = r.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x - 40, y: at.y })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
    await sleep(700)
    await shoot('assets/screenshot-diagnostics.png', '#diagnosticos ~ .live', { pad: 6 })
  }
  if (want('ai')) {
    await open(docs + '#ia/agente', { width: 1300, height: 1000 })
    await shoot('assets/screenshot-ai-agent.png', '#agente ~ .agent-grid', {
      pad: 6,
      setup: `document.getElementById('agent-run').click(); await new Promise(r => setTimeout(r, 5200)); const log = document.getElementById('agent-log'); log.scrollTop = log.scrollHeight`,
    })
    await shoot('assets/screenshot-ai-review.png', '#revisao ~ .live', {
      pad: 6,
      setup: `document.getElementById('review-ai').click(); await new Promise(r => setTimeout(r, 500))`,
    })
  }
  if (want('treesitter')) {
    await open(docs + '#extensoes/tree-sitter', { width: 1300, height: 1000 })
    // web-tree-sitter and the grammar come from the CDN: wait for the first parse.
    await evaluate(`(async () => { for (let i = 0; i < 60 && !document.getElementById('ts-status').textContent.includes('análise'); i++) await new Promise(r => setTimeout(r, 250)) })()`)
    const at = await evaluate(`(async () => {
      document.querySelector('#tree-sitter ~ .live').scrollIntoView({ block: 'center' })
      await new Promise(r => setTimeout(r, 400))
      const mark = document.querySelector('#ts-editor .jc-diag')
      const b = mark.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x - 40, y: at.y })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
    await sleep(800)
    await shoot('assets/screenshot-tree-sitter.png', '#tree-sitter ~ .live', { pad: 6 })
  }
  if (want('collab')) {
    await open(docs + '#extensoes/colaboracao', { width: 1300, height: 1000 })
    // Yjs comes from the CDN: wait until the two editors are in sync.
    await evaluate(`(async () => { for (let i = 0; i < 60 && document.getElementById('co-status').textContent !== 'sincronizado'; i++) await new Promise(r => setTimeout(r, 250)) })()`)
    await evaluate(`(async () => {
      document.querySelector('#colaboracao ~ .agent-grid').scrollIntoView({ block: 'center' })
      await new Promise(r => setTimeout(r, 300))
    })()`)
    // Carla types a comment while Ana double-clicks a word on another line and types over it.
    await evaluate(`document.getElementById('co-bot').click()`)
    const at = await evaluate(`(() => { const r = document.querySelector('#co-ana .jc-scroller').getBoundingClientRect(); return { x: r.left + 150, y: r.top + 8 + 4 * 22 + 11 } })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 2 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 2 })
    await sleep(1800)
    await shoot('assets/screenshot-collab.png', '#colaboracao ~ .agent-grid', { pad: 6 })
  }
  if (want('zones')) {
    await open(docs + '#extensoes/zonas', { width: 1300, height: 1000 })
    const click = async (x, y, clickCount = 1) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount })
    }
    const center = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
    await evaluate(`(async () => { document.querySelector('#zonas ~ .live').scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 400)) })()`)
    // The cursor on "const m = media(notas)" (the 13th line), then a comment below it and the widget.
    const line = await evaluate(`(() => { const el = [...document.querySelectorAll('#zones-editor .jc-line')].find((l) => l.textContent.includes('const m = media')); const r = el.getBoundingClientRect(); return { x: r.left + 120, y: r.top + r.height / 2 } })()`)
    await click(line.x, line.y)
    for (const id of ['#zone-comment']) {
      const b = await center(id)
      await click(b.x, b.y)
    }
    await send('Input.insertText', { text: 'Sim, vou criar calcularMedia()' })
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await click(line.x, line.y)
    for (const id of ['#zone-widget', '#zone-overlay']) {
      const b = await center(id)
      await click(b.x, b.y)
    }
    await evaluate(`(async () => { const sc = document.querySelector('#zones-editor .jc-scroller'); sc.scrollTop += 70; await new Promise(r => setTimeout(r, 300)) })()`)
    await shoot('assets/screenshot-zones.png', '#zonas ~ .live', { pad: 6 })
  }
  if (want('fonts')) {
    await open(docs + '#por-dentro/fontes', { width: 1300, height: 1000 })
    await evaluate(`(async () => {
      document.querySelector('#fontes ~ .live').scrollIntoView({ block: 'center' })
      const sel = document.getElementById('font-family')
      sel.value = sel.options[3].value
      sel.dispatchEvent(new Event('input'))
      const size = document.getElementById('font-size')
      size.value = '16'
      size.dispatchEvent(new Event('input'))
      await document.fonts.ready
      await new Promise(r => setTimeout(r, 500))
    })()`)
    // Select a word with accents by double-clicking it.
    const at = await evaluate(`(() => { const el = [...document.querySelectorAll('#font-editor .jc-line')].find((l) => l.textContent.includes('preço')); const range = document.createRange(); const walker = document.createTreeWalker(el, 4); let n; while ((n = walker.nextNode())) { const i = n.data.indexOf('preço'); if (i >= 0) { range.setStart(n, i + 2); range.setEnd(n, i + 3); break } } const r = range.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 2 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 2 })
    await sleep(400)
    await shoot('assets/screenshot-fonts.png', '#fontes ~ .live', { pad: 6 })
  }
  if (want('labtool')) {
    await open(docs.replace('index.html', 'lab.html'), { width: 1440, height: 860 })
    await shoot('assets/screenshot-lab.png', ':viewport', {
      setup: `try { localStorage.clear() } catch {}; lab.sampleEd.setSelection({ line: 5, col: 12 }); lab.sampleEd.flush(); await new Promise(r => setTimeout(r, 400))`,
    })
  }
  // Ad-hoc review from a JSON list: [{ url, out, selector?, width?, height?, setup? }]
  if (shots[0] === 'json') {
    const { readFileSync } = await import('node:fs')
    for (const s of JSON.parse(readFileSync(shots[1], 'utf8'))) {
      await open(s.url, { width: s.width ?? 1400, height: s.height ?? 900, dpr: s.dpr ?? 1 })
      await shoot(s.out, s.selector ?? ':viewport', { setup: s.setup ?? '' }).catch((err) => console.log('✗', s.out, err.message))
    }
  }
  // Ad-hoc review: REVIEW_DIR=/tmp/x node scripts/screenshots.js review 'hash@selector' …
  if (shots[0] === 'review') {
    for (const spec of shots.slice(1)) {
      const [hash, selector, width = '1400'] = spec.split('@')
      await open(docs + '#' + hash, { width: +width, height: width === '1400' ? 1000 : 844, dpr: 1 })
      await shoot(join(process.env.REVIEW_DIR ?? tmpdir(), hash.replace(/\W+/g, '-') + (width === '1400' ? '' : '-' + width) + '.png'), selector || ':viewport')
        .catch((err) => console.log('✗', spec, err.message))
    }
  }
  if (want('search')) {
    await open(docs + '#extensoes/busca', { width: 1300, height: 1000 })
    await shoot('assets/screenshot-search.png', '[data-page="extensoes"] #busca + p + .live', {
      setup: `await new Promise(r => setTimeout(r, 500)); document.querySelector('#search-editor .jc-search-input').focus()`,
    })
  }
  if (want('tokens')) {
    await open(docs + '#linguagens/tokens-proprios', { width: 1400, height: 1000 })
    await shoot('assets/screenshot-tokens.png', '#tok-code', {
      setup: `await new Promise(r => setTimeout(r, 600)); const s = document.querySelector('#tok-code .jc-t-color'); const r = s.getBoundingClientRect(); s.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 8, clientY: r.top + 6 }))`,
    })
  }
  if (want('wrap')) {
    await open(docs + '#por-dentro/quebra', { width: 1400, height: 1000 })
    await shoot('assets/screenshot-wrap.png', '.wrapdemo', {
      setup: `const s = document.getElementById('wrap-width'); s.value = 400; s.dispatchEvent(new Event('input')); await new Promise(r => setTimeout(r, 400))`,
    })
  }
  if (want('multicursor')) {
    await open(docs + '#por-dentro/multicursor', { width: 1400, height: 1000 })
    await shoot('assets/screenshot-multicursor.png', '#multicursor ~ .grid2', {
      setup: `[...document.querySelectorAll('#mc-buttons button')][1].click(); await new Promise(r => setTimeout(r, 300))`,
    })
  }
  if (want('mobile')) {
    await open(docs + '#por-dentro/toque', { width: 1400, height: 1000 })
    await shoot('assets/screenshot-mobile.png', '.phone', {
      setup: `const sc = document.querySelector('#phone-editor .jc-scroller'); const span = document.querySelector('#phone-editor .jc-t-function'); const r = span.getBoundingClientRect(); const ev = (t) => sc.dispatchEvent(new PointerEvent(t, { pointerType: 'touch', clientX: r.left + 6, clientY: r.top + 6, bubbles: true })); ev('pointerdown'); await new Promise(res => setTimeout(res, 600)); ev('pointerup'); await new Promise(res => setTimeout(res, 300))`,
    })
  }
  if (want('compare')) {
    await open(docs + '#comparativo/mapa', { width: 1300, height: 1000 })
    await shoot('assets/screenshot-compare.png', '#mapa ~ .chart-card', { setup: `await new Promise(r => setTimeout(r, 1500))` })
    await open(docs + '#comparativo/notas', { width: 1300, height: 1000 })
    await shoot('assets/screenshot-scores.png', '.scores', { setup: `await new Promise(r => setTimeout(r, 900))` })
  }
  if (want('lab')) {
    await open(docs + '#linguagens/lab', { width: 1400, height: 1000 })
    await shoot('assets/screenshot-language-lab.png', '.lab')
  }
} finally {
  ws.close()
  chrome.kill()
}
