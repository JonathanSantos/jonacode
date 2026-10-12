// Builds the single-file browser bundle (IIFE, global `Jonacode`).
import { build } from 'esbuild'

await build({
  entryPoints: ['scripts/browser-entry.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'iife',
  globalName: 'Jonacode',
  target: 'es2022',
  outfile: 'dist/jonacode.iife.min.js',
  legalComments: 'none',
})
console.log('✓ dist/jonacode.iife.min.js')

// The languages bundle takes `defineLanguage` & co. from the global instead of bundling the core again.
const useGlobalCore = {
  name: 'global-core',
  setup(b) {
    b.onResolve({ filter: /language\/language\.ts$/ }, () => ({ path: 'jonacode-core', namespace: 'global' }))
    b.onLoad({ filter: /.*/, namespace: 'global' }, () => ({
      contents: `const J = globalThis.Jonacode
if (!J) throw new Error('[jonacode] load jonacode.iife.min.js before jonacode.languages.iife.min.js')
export const { defineLanguage, findLanguage, words, State } = J`,
      loader: 'js',
    }))
  },
}
await build({
  // Adds the languages to the existing `Jonacode` global (keeping what it already has).
  stdin: {
    contents: `import * as languages from './scripts/languages-entry.ts'
const J = globalThis.Jonacode
for (const [name, value] of Object.entries(languages)) if (!(name in J)) J[name] = value`,
    resolveDir: process.cwd(),
    loader: 'ts',
    sourcefile: 'languages-global.ts',
  },
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'iife',
  target: 'es2022',
  outfile: 'dist/jonacode.languages.iife.min.js',
  legalComments: 'none',
  plugins: [useGlobalCore],
})
console.log('✓ dist/jonacode.languages.iife.min.js')
