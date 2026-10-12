// Measures Jonacode against other web code editors, in equivalent setups:
// bundle size (esbuild, minified + gzip) and loading a 100,000-line JavaScript
// file in headless Chrome (first paint, DOM nodes, JS heap, scroll jump).
// Writes results.json, which the docs page (npm run docs) turns into charts.
//
//   cd bench/compare && npm install && npm run bench
//   CHROME=/path/to/chrome npm run bench     (defaults to the macOS Chrome path)
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { cpus, platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'

const here = import.meta.dirname
const root = resolve(here, '../..')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const RUNS = Number(process.env.RUNS ?? 3)
// ONLY=jonacode-full,cm6-full measures a subset; OUT=file.json writes elsewhere (e.g. to compare runs).
const ONLY = process.env.ONLY?.split(',')
const OUT = process.env.OUT ?? 'results.json'
const LINES = 100_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** What each entry is, as shown in the docs. */
const EDITORS = {
  'jonacode-full': { name: 'Jonacode', setup: 'basicSetup + JavaScript', pkg: null },
  'jonacode-core': { name: 'Jonacode (núcleo)', setup: 'createEditor, sem linguagem', pkg: null },
  'cm6-full': { name: 'CodeMirror 6', setup: 'basicSetup + JavaScript + One Dark', pkg: '@codemirror/view' },
  'cm6-min': { name: 'CodeMirror 6 (núcleo)', setup: 'EditorView + EditorState', pkg: '@codemirror/view' },
  cm5: { name: 'CodeMirror 5', setup: 'JS + números + colchetes + linha ativa + busca', pkg: 'cm5' },
  'monaco-min': { name: 'Monaco (mínimo)', setup: 'editor + linguagens Monarch', pkg: 'monaco-editor' },
  'monaco-full': { name: 'Monaco', setup: 'pacote completo', pkg: 'monaco-editor' },
  ace: { name: 'Ace', setup: 'JS + tema + busca', pkg: 'ace-builds' },
  'prism-code-editor': { name: 'prism-code-editor', setup: 'JS + colchetes + comandos + busca', pkg: 'prism-code-editor' },
  codejar: { name: 'CodeJar', setup: 'CodeJar + Prism', pkg: 'codejar' },
}
if (ONLY) for (const id of Object.keys(EDITORS)) if (!ONLY.includes(id)) delete EDITORS[id]

// ------------------------------------------------------------------ 1. bundles
const out = resolve(here, 'out')
mkdirSync(out, { recursive: true })
const sizes = {}
for (const id of Object.keys(EDITORS)) {
  await build({
    entryPoints: [resolve(here, 'entries', id + '.js')], bundle: true, minify: true, format: 'iife', outdir: join(out, id),
    loader: { '.ttf': 'dataurl' }, target: 'es2022', logLevel: 'silent', legalComments: 'none',
  })
  const js = readFileSync(join(out, id, id + '.js'))
  const cssFile = join(out, id, id + '.css')
  const css = existsSync(cssFile) ? readFileSync(cssFile) : null
  sizes[id] = { jsMin: js.length, jsGzip: gzipSync(js, { level: 9 }).length, cssGzip: css ? gzipSync(css, { level: 9 }).length : 0 }
  writeFileSync(join(out, id, 'index.html'), '<!doctype html><meta charset=utf-8>' + (css ? `<link rel=stylesheet href="${id}.css">` : '') +
    '<style>html,body{margin:0;background:#1e1e1e}#host{width:1000px;height:700px;position:relative;overflow:hidden}</style>' +
    `<div id=host></div><script src="../doc.js"></script><script src="${id}.js"></script>`)
  console.log('✓ bundle', id, (sizes[id].jsGzip / 1024).toFixed(1) + ' kB gzip')
}

// The same 100k-line document for everyone.
const unit = readFileSync(resolve(root, 'examples/sample.js'), 'utf8').split('\n').slice(1, -2)
const lines = []
while (lines.length < LINES) lines.push(...unit)
writeFileSync(join(out, 'doc.js'), 'window.DOC=' + JSON.stringify(lines.slice(0, LINES).join('\n')))

// ------------------------------------------------------------------ 2. runtime (Chrome DevTools Protocol)
const port = 9500 + Math.floor(Math.random() * 400)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jc-bench-'))}`, '--window-size=1100,800', 'about:blank'], { stdio: 'ignore' })
let wsUrl
for (let i = 0; i < 60 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()).webSocketDebuggerUrl } catch { await sleep(150) }
}
const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
  }
})
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq
  pending.set(id, { res, rej })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
await send('Page.enable')
await send('Runtime.enable')
await send('HeapProfiler.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false })
const browser = await send('Browser.getVersion')

const MEASURE = `(async () => {
  const host = document.getElementById('host')
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const findScroller = (el) => [el, ...el.querySelectorAll('*')].find((x) => x.scrollHeight > x.clientHeight + 50 && getComputedStyle(x).overflowY !== 'visible')
  const t0 = performance.now()
  const h = window.mount(host, window.DOC)
  await raf2()
  const firstPaint = performance.now() - t0
  const domNodes = host.querySelectorAll('*').length
  const t1 = performance.now()
  if (h.editor && h.editor.setScrollTop && h.editor.getScrollHeight) h.editor.setScrollTop(h.editor.getScrollHeight() / 2)
  else if (h.editor && h.editor.scrollToLine) h.editor.scrollToLine(${LINES / 2}, false, false, () => {})
  else { const sc = h.scroller && h.scroller.scrollHeight > h.scroller.clientHeight + 50 ? h.scroller : findScroller(host); if (sc) sc.scrollTop = sc.scrollHeight / 2 }
  await raf2()
  return { firstPaint, domNodes, scrollJump: performance.now() - t1 }
})()`

const runtime = {}
for (const id of Object.keys(EDITORS)) {
  const runs = []
  for (let i = 0; i < RUNS; i++) {
    await send('Page.navigate', { url: 'file://' + join(out, id, 'index.html') })
    await sleep(1500)
    try {
      const r = await Promise.race([evaluate(MEASURE), sleep(60_000).then(() => null)])
      if (!r) continue
      await sleep(500)
      await send('HeapProfiler.collectGarbage')
      const heap = await send('Runtime.getHeapUsage')
      runs.push({ ...r, heapMB: heap.usedSize / 1048576 })
    } catch (err) {
      console.warn('✗', id, err.message.slice(0, 120))
    }
  }
  // Median of the runs for each metric.
  const med = (key) => {
    const v = runs.map((r) => r[key]).sort((a, b) => a - b)
    return v.length ? v[Math.floor(v.length / 2)] : null
  }
  runtime[id] = { firstPaint: med('firstPaint'), domNodes: med('domNodes'), heapMB: med('heapMB'), scrollJump: med('scrollJump'), runs: runs.length }
  console.log('✓ run', id, runtime[id].firstPaint?.toFixed(0) + ' ms')
}
ws.close()
chrome.kill()

// ------------------------------------------------------------------ 3. results.json
const version = (pkg) => {
  try { return JSON.parse(readFileSync(resolve(here, 'node_modules', pkg, 'package.json'), 'utf8')).version } catch { return null }
}
const results = {
  date: new Date().toISOString().slice(0, 10),
  machine: { cpu: cpus()[0]?.model, platform: platform(), browser: browser.product, node: process.version },
  document: { lines: LINES, bytes: lines.slice(0, LINES).join('\n').length },
  note: 'Tempos incluem a espera pelo próximo quadro (~16 ms). Mediana de ' + RUNS + ' execuções.',
  editors: Object.fromEntries(Object.entries(EDITORS).map(([id, e]) => [id, {
    ...e,
    version: e.pkg ? version(e.pkg) : JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
    size: sizes[id],
    runtime: runtime[id],
  }])),
}
writeFileSync(resolve(here, OUT), JSON.stringify(results, null, 2) + '\n')
console.log('\n✓ ' + OUT)
