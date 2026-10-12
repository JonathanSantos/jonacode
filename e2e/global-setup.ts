// Bundles the library straight from src/ for the fixture page. esbuild only strips
// types (no typecheck), so in-progress type errors elsewhere don't block the e2e run.
import { build } from 'esbuild'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outdir = join(root, 'e2e/.build')

export default async function globalSetup() {
  const languages = readdirSync(join(root, 'src/languages')).filter((f) => f.endsWith('.ts')).sort()
  const themes = readdirSync(join(root, 'src/themes')).filter((f) => f.endsWith('.ts')).sort()
  rmSync(outdir, { recursive: true, force: true })
  const started = performance.now()
  await build({
    absWorkingDir: root,
    entryPoints: [
      'src/index.ts',
      'src/adapters/element.ts',
      ...languages.map((f) => `src/languages/${f}`),
      ...themes.map((f) => `src/themes/${f}`),
    ],
    outbase: 'src',
    outdir,
    bundle: true,
    // One shared copy of the core for every entry (the element and the languages use the same Editor).
    splitting: true,
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    minify: false,
    logLevel: 'warning',
  })
  // Yjs for the collaboration specs (a separate file: the library itself never imports it).
  await build({ absWorkingDir: root, entryPoints: ['e2e/yjs-entry.ts'], outfile: join(outdir, 'yjs.js'), bundle: true, format: 'esm', target: 'es2022', logLevel: 'warning' })
  // `all.js`: every export in one namespace, for `window.J` in the fixture page.
  const modules = ['./index.js', './adapters/element.js', ...languages.map((f) => `./languages/${f.replace(/\.ts$/, '.js')}`),
    ...themes.map((f) => `./themes/${f.replace(/\.ts$/, '.js')}`)]
  writeFileSync(join(outdir, 'all.js'), modules.map((m, i) => `import * as m${i} from '${m}'`).join('\n') +
    `\nexport default Object.assign({}, ${modules.map((_, i) => `m${i}`).join(', ')})\n`)
  console.log(`[e2e] bundled src/ into e2e/.build in ${Math.round(performance.now() - started)} ms`)
}
