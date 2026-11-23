// Checks the package the way someone who installs it sees it: packs it (`npm pack`), installs the
// tarball in a fresh project and compiles a file that imports the entry points, with stock
// TypeScript settings (no `allowImportingTsExtensions`), under `nodenext` and `bundler`
// resolution, with and without `skipLibCheck`. Then runs the built ESM in Node.
//   npm run build && node scripts/check-package.js
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (!existsSync(join(root, 'dist/index.js'))) {
  console.error('✗ dist/ is missing: run `npm run build` first')
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'jonacode-pack-'))
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
let failed = false
try {
  // 1. The tarball, as `npm publish` would upload it.
  const [{ filename, files }] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], root))
  const names = files.map((f) => f.path)
  const must = ['dist/index.js', 'dist/index.d.ts', 'dist/index.js.map', 'dist/locales/pt-BR.js', 'dist/languages/json.d.ts', 'CHANGELOG.md', 'README.md', 'LICENSE']
  for (const name of must) {
    if (names.includes(name)) continue
    console.error(`✗ ${name} is not in the package`)
    failed = true
  }
  console.log(`✓ ${filename}: ${names.length} files`)

  // 2. A consumer project.
  const app = join(work, 'app')
  mkdirSync(app)
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock', join(work, filename)], app)
  // The declarations must not import `.ts` files: older TypeScript versions refuse that without
  // `allowImportingTsExtensions` (TypeScript 7 lets it pass in declaration files, so compiling isn't proof).
  const installed = join(app, 'node_modules', pkg.name, 'dist')
  const withTs = readdirSync(installed, { recursive: true })
    .filter((name) => name.endsWith('.d.ts'))
    .filter((name) => /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]\.{1,2}\/[^'"\n]*(?<!\.d)\.ts['"]/.test(readFileSync(join(installed, name), 'utf8')))
  if (withTs.length) {
    failed = true
    console.error(`✗ declarations importing .ts files: ${withTs.slice(0, 5).join(', ')}${withTs.length > 5 ? `… (${withTs.length})` : ''}`)
  } else console.log('✓ declarations import .js specifiers only')

  writeFileSync(join(app, 'index.ts'), `
import { basicSetup, compartment, createEditor, highlight, lineRange, readOnlyRanges, PHRASES, type Editor, type PhraseKey, type Phrases } from '${pkg.name}'
import { editorTools, inlineEdit } from '${pkg.name}/ai'
import { highlightAll } from '${pkg.name}/highlight'
import { json } from '${pkg.name}/languages/json'
import { typescript } from '${pkg.name}/languages/typescript'
import { ptBR } from '${pkg.name}/locales/pt-BR'
import { fromMonarch } from '${pkg.name}/monarch'
import { expectTokens } from '${pkg.name}/testing'
import { oneLight } from '${pkg.name}/themes/one-light'

const review = compartment()
const phrases: Phrases = { ...ptBR, Accept: 'Manter' }
const editor: Editor = createEditor(document.body, { language: json, theme: oneLight, phrases, padding: { x: 4 }, extensions: [basicSetup(), readOnlyRanges([]), review.of(null)] })
review.reconfigure(editor, null)
const key: PhraseKey = 'Accept'
export const html: string = highlight('{}', typescript) + PHRASES[key]
export const used = [editorTools, inlineEdit, highlightAll, fromMonarch, expectTokens, lineRange]

// The types are really there (an \`any\` fallback would let these through).
// @ts-expect-error not a phrase key
const typo: PhraseKey = 'Acept'
// @ts-expect-error padding is in px
createEditor(document.body, { padding: { x: '4px' } })
// @ts-expect-error not an editor method
editor.nope()
export { typo }
`)
  const tsc = join(root, 'node_modules/typescript/bin/tsc')
  for (const [module, moduleResolution] of [['nodenext', 'nodenext'], ['esnext', 'bundler']]) {
    for (const skipLibCheck of [true, false]) {
      writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'es2022', module, moduleResolution, lib: ['es2022', 'dom', 'dom.iterable'], strict: true, noEmit: true, skipLibCheck, types: [] },
        include: ['index.ts'],
      }))
      const label = `types: moduleResolution ${moduleResolution}, skipLibCheck ${skipLibCheck}`
      try {
        run(process.execPath, [tsc, '-p', app], app)
        console.log(`✓ ${label}`)
      } catch (err) {
        failed = true
        console.error(`✗ ${label}\n${err.stdout || err.message}`)
      }
    }
  }

  // 3. The JavaScript runs as it is published (Node, no bundler, no DOM).
  writeFileSync(join(app, 'run.mjs'), `
import { highlight, PHRASES } from '${pkg.name}'
import { json } from '${pkg.name}/languages/json'
import { ptBR } from '${pkg.name}/locales/pt-BR'
const html = highlight('{"a": 1}', json)
if (!html.includes('jc-t-')) throw new Error('highlight() produced no tokens')
if (Object.keys(ptBR).length !== Object.keys(PHRASES).length) throw new Error('pt-BR is incomplete')
console.log('ok')
`)
  try {
    run(process.execPath, ['run.mjs'], app)
    console.log('✓ runs in Node from the installed package')
  } catch (err) {
    failed = true
    console.error(`✗ running the installed package\n${err.stderr || err.message}`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
if (failed) process.exit(1)
console.log(`✓ ${pkg.name}@${pkg.version} is ready to be published`)
