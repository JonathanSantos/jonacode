// Builds docs/index.html: a single self-contained file (library bundle, styles
// and demos inlined) that opens straight from the file system.
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = resolve(import.meta.dirname, '..')
const read = (p) => readFileSync(resolve(root, p), 'utf8')

async function bundle(contents, { format = 'esm', external = [] } = {}) {
  const out = await build({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true, minify: true, write: false, format, target: 'es2022', external, legalComments: 'none',
    globalName: format === 'iife' ? 'Jonacode' : undefined,
  })
  return out.outputFiles[0].text
}

const gz = (code) => gzipSync(code, { level: 9 }).length
/** Code inlined in a <script>: a literal "</script" would end the tag early (it's equivalent to "<\/script" in JS). */
const inlineJS = (code) => code.replace(/<\/script/gi, '<\\/script')

// Real, tree-shaken sizes shown in the "tree-shaking" demo.
const core = gz(await bundle(`import { createEditor } from './src/index.ts'; window.x = createEditor`))
const extra = async (imports, from = './src/index.ts') => {
  const names = imports.join(', ')
  const code = await bundle(`import { createEditor } from './src/index.ts'; import { ${names} } from '${from}'; window.x = [createEditor, ${names}]`, { external: ['react', 'vue'] })
  return gz(code) - core
}
const sizes = {
  core,
  parts: {
    lineNumbers: await extra(['lineNumbers']),
    highlightActiveLine: await extra(['highlightActiveLine']),
    bracketMatching: await extra(['bracketMatching']),
    closeBrackets: await extra(['closeBrackets']),
    editingKeymap: await extra(['keymap', 'editingKeymap']),
    multiCursor: await extra(['multiCursor']),
    search: await extra(['search']),
    tokenRule: await extra(['tokenRule']),
    tokenStyles: await extra(['tokenStyles']),
    tokenInspector: await extra(['tokenInspector']),
    touch: await extra(['touch']),
    gotoLine: await extra(['gotoLine']),
    decorations: await extra(['setDecorations']),
    zones: await extra(['addZone', 'addWidget', 'addOverlay']),
    hoverTooltip: await extra(['hoverTooltip']),
    diagnostics: await extra(['diagnostics', 'linter']),
    autocomplete: await extra(['autocomplete']),
    folding: await extra(['folding']),
    readOnlyRanges: await extra(['readOnlyRanges']),
    treeSitter: await extra(['treeSitter']),
    collab: await extra(['collab', 'yjs']),
    diffView: await extra(['diffView']),
    mergeView: await extra(['mergeView']),
    editorTools: await extra(['editorTools']),
    applyEdits: await extra(['applyEdits']),
    inlineSuggestion: await extra(['inlineSuggestion']),
    inlineEdit: await extra(['inlineEdit']),
    lineClass: await extra(['lineClass']),
    lazyEditor: await extra(['lazyEditor']),
    log: await extra(['log'], './src/languages/log.ts'),
    javascript: await extra(['javascript'], './src/languages/javascript.ts'),
    jsx: await extra(['jsx'], './src/languages/javascript.ts'),
    typescript: await extra(['typescript'], './src/languages/typescript.ts'),
    tsx: await extra(['tsx'], './src/languages/typescript.ts'),
    json: await extra(['json'], './src/languages/json.ts'),
    css: await extra(['css'], './src/languages/css.ts'),
    html: await extra(['html'], './src/languages/html.ts'),
    markdown: await extra(['markdown'], './src/languages/markdown.ts'),
    sql: await extra(['sql'], './src/languages/sql.ts'),
    shell: await extra(['shell'], './src/languages/shell.ts'),
    oneLight: await extra(['oneLight'], './src/themes/one-light.ts'),
    element: await extra(['defineJonacodeElement'], './src/adapters/element.ts'),
    react: await extra(['CodeEditor'], './src/adapters/react.ts'),
    vue: await extra(['CodeEditor'], './src/adapters/vue.ts'),
  },
}

// The static highlighter alone (no editor): highlight + JavaScript + One Dark.
sizes.static = gz(await bundle(`import { highlight, highlightStyles } from './src/highlight.ts'; import { javascript } from './src/languages/javascript.ts'; import { oneDark } from './src/themes/one-dark.ts'; window.x = [highlight, highlightStyles, javascript, oneDark]`))

const benchFile = resolve(root, 'bench/compare/results.json')
const benchResults = readFileSync(benchFile, 'utf8')

// Docs and lab use the whole library: core, languages, importers and testing helpers.
const lib = await bundle(`export * from './scripts/browser-entry.ts'; export * from './scripts/languages-entry.ts'
export { fromMonarch } from './src/language/monarch.ts'
export { fromVSCodeTheme } from './src/themes/vscode.ts'
export { describeTokens, expectTokens, tokenizeLines } from './src/testing.ts'`, { format: 'iife' })
const html = read('docs/src/index.html')
  .replace('<!-- @style -->', () => `<style>\n${read('docs/src/styles.css')}</style>`)
  .replace('<!-- @lib -->', () => `<script>${lib.replace(/<\/script/g, '<\\/script')}</script>`)
  .replace('<!-- @app -->', () => `<script>\nwindow.__SIZES__ = ${JSON.stringify(sizes)}\nwindow.__BENCH__ = ${benchResults.trim()}\n${inlineJS(read('docs/src/app.js'))}</script>`)
  .replaceAll('<!-- @logo -->', () => read('assets/logo.svg').replace(/<\?xml[^>]*>/, '').trim())
  .replace('@favicon', () => 'data:image/svg+xml,' + encodeURIComponent(read('assets/logo.svg')))

writeFileSync(resolve(root, 'docs/index.html'), html)

// The language lab: a separate single-file page.
const lab = read('docs/src/lab.html')
  .replace('<!-- @style -->', () => `<style>\n${read('docs/src/lab.css')}</style>`)
  .replace('<!-- @lib -->', () => `<script>${lib.replace(/<\/script/g, '<\\/script')}</script>`)
  .replace('<!-- @app -->', () => `<script>\n${inlineJS(read('docs/src/lab.js'))}</script>`)
  .replaceAll('<!-- @logo -->', () => read('assets/logo.svg').replace(/<\?xml[^>]*>/, '').trim())
  .replace('@favicon', () => 'data:image/svg+xml,' + encodeURIComponent(read('assets/logo.svg')))
writeFileSync(resolve(root, 'docs/lab.html'), lab)
console.log(`✓ docs/lab.html (${(lab.length / 1024).toFixed(0)} kB)`)
console.log(`✓ docs/index.html (${(html.length / 1024).toFixed(0)} kB) — core ${(core / 1024).toFixed(1)} kB gzip`)
