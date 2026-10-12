// Measures the minified + gzipped size of typical imports (tree-shaken with esbuild).
//   node scripts/size.js           the table
//   node scripts/size.js --check   the table against size-budget.json; exits 1 when a scenario is over (or has no) budget
//   node scripts/size.js --update  rewrites size-budget.json from the current sizes (rounded up to the next 0.5 kB)
import { build } from 'esbuild'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const BUDGET_FILE = new URL('../size-budget.json', import.meta.url)
const STEP = 512
const check = process.argv.includes('--check')
const update = process.argv.includes('--update')

const scenarios = {
  'createEditor (core + One Dark)': `import { createEditor } from './src/index.ts'; window.x = createEditor`,
  '+ basicSetup()': `import { createEditor, basicSetup } from './src/index.ts'; window.x = [createEditor, basicSetup]`,
  '+ basicSetup() + JavaScript': `import { createEditor, basicSetup } from './src/index.ts'; import { javascript } from './src/languages/javascript.ts'; window.x = [createEditor, basicSetup, javascript]`,
  'Everything (IIFE bundle)': `export * from './scripts/browser-entry.ts'`,
}
// Optional features, each one on top of the core (`createEditor`).
const extensions = {
  'decorations (setDecorations)': 'setDecorations',
  'zones, widgets and overlays (addZone, addWidget, addOverlay)': 'addZone, addWidget, addOverlay',
  'hoverTooltip()': 'hoverTooltip',
  'linter() + diagnostics': 'linter',
  'autocomplete()': 'autocomplete',
  'folding()': 'folding',
  'search()': 'search',
  'gotoLine()': 'gotoLine',
  'lazyEditor()': 'lazyEditor',
  'highlight()': 'highlight',
  'readOnlyRanges()': 'readOnlyRanges',
  'diffView()': 'diffView',
  'mergeView()': 'mergeView',
  'inlineSuggestion() (AI)': 'inlineSuggestion',
  'inlineEdit() (AI)': 'inlineEdit',
  'editorTools() (AI)': 'editorTools',
  'treeSitter() (+ diagnostics; web-tree-sitter itself not included)': 'treeSitter',
  'collab() + yjs() adapter (Yjs itself not included)': 'collab, yjs',
}
for (const [name, exp] of Object.entries(extensions)) {
  scenarios[`core + ${name}`] = `import { createEditor, ${exp} } from './src/index.ts'; window.x = [createEditor, ${exp}]`
}
// The static highlighter on its own (`jonacode/highlight`, no editor).
scenarios['highlight() alone (jonacode/highlight)'] = `import { highlight } from './src/highlight.ts'; window.x = highlight`

// Languages: what each one adds on top of the core (`defineLanguage` is always there).
const base = `import { defineLanguage } from './src/language/language.ts'; window.b = defineLanguage;`
const languages = {
  javascript: ['javascript', 'javascript'], jsx: ['javascript', 'jsx'], typescript: ['typescript', 'typescript'], tsx: ['typescript', 'tsx'],
  json: ['json', 'json'], css: ['css', 'css'], 'html (+ JS + CSS)': ['html', 'html'], markdown: ['markdown', 'markdown'],
  sql: ['sql', 'sql'], shell: ['shell', 'shell'], log: ['log', 'log'],
}
const measure = async (contents) => {
  const out = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, minify: true, write: false, format: 'esm', target: 'es2022', legalComments: 'none',
  })
  const code = out.outputFiles[0].contents
  return { min: code.length, gzip: gzipSync(code, { level: 9 }).length }
}

/** Budgeted scenarios: name → gzip bytes. */
const measured = {}
const rows = []
for (const [name, contents] of Object.entries(scenarios)) {
  const size = await measure(contents)
  measured[name] = size.gzip
  rows.push({ scenario: name, minified: kb(size.min), gzip: kb(size.gzip) })
}

if (update) {
  const budget = Object.fromEntries(Object.entries(measured).map(([name, gzip]) => [name, Math.ceil(gzip / STEP) * STEP]))
  writeFileSync(BUDGET_FILE, JSON.stringify(budget, null, 2) + '\n')
  console.log(`Wrote size-budget.json (${Object.keys(budget).length} scenarios, gzip bytes rounded up to ${STEP / 1024} kB).`)
}

if (check || update) {
  const budget = existsSync(BUDGET_FILE) ? JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) : {}
  let over = 0
  let missing = 0
  for (const row of rows) {
    const max = budget[row.scenario]
    const gzip = measured[row.scenario]
    row.budget = max ? kb(max) : '—'
    if (!max) {
      row.status = 'NO BUDGET'
      missing++
    } else if (gzip > max) {
      row.status = `OVER by ${kb(gzip - max)}`
      over++
    } else row.status = `ok (${kb(max - gzip)} left)`
  }
  console.table(rows)
  for (const name of Object.keys(budget)) if (!(name in measured)) console.warn(`size-budget.json: unknown scenario "${name}"`)
  if (over || missing) {
    if (over) console.error(`\n✗ ${over} scenario(s) over budget.`)
    if (missing) console.error(`\n✗ ${missing} scenario(s) without a budget in size-budget.json.`)
    console.error('If the change is intended, re-baseline: node scripts/size.js --update (npm run size:update)')
    process.exit(1)
  }
  console.log('\n✓ every scenario is within its budget')
} else {
  const baseSize = await measure(base)
  for (const [name, [file, exp]] of Object.entries(languages)) {
    const size = await measure(`${base} import { ${exp} } from './src/languages/${file}.ts'; window.x = ${exp}`)
    rows.push({ scenario: `language: ${name}`, minified: kb(size.min - baseSize.min), gzip: kb(size.gzip - baseSize.gzip) })
  }
  const all = await measure(`${base} export * from './scripts/languages-entry.ts'`)
  rows.push({ scenario: 'all languages', minified: kb(all.min - baseSize.min), gzip: kb(all.gzip - baseSize.gzip) })
  console.table(rows)
}

function kb(bytes) {
  return (bytes / 1024).toFixed(1) + ' kB'
}
