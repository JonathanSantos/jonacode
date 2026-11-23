// The sources import each other with `.ts` extensions (Node runs them as they are). tsc rewrites
// those to `.js` in the emitted JavaScript but leaves the declaration files alone, so a consumer
// would need `allowImportingTsExtensions` just to read our types. This rewrites the relative
// specifiers of every `dist/**/*.d.ts` to `.js`, which resolves to the `.d.ts` next to it.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dist = resolve(import.meta.dirname, '../dist')
// `from './x.ts'`, `import './x.ts'` and `import('./x.ts')`: relative specifiers only, never `.d.ts`.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"\n]*?)(?<!\.d)\.ts\2/g

let files = 0
let rewritten = 0
for (const name of readdirSync(dist, { recursive: true })) {
  if (!name.endsWith('.d.ts')) continue
  const file = join(dist, name)
  const before = readFileSync(file, 'utf8')
  const after = before.replace(SPECIFIER, (_all, lead, quote, path) => {
    rewritten++
    return `${lead}${quote}${path}.js${quote}`
  })
  files++
  if (after !== before) writeFileSync(file, after)
}
const left = readdirSync(dist, { recursive: true })
  .filter((name) => name.endsWith('.d.ts'))
  .filter((name) => /['"]\.{1,2}\/[^'"\n]*(?<!\.d)\.ts['"]/.test(readFileSync(join(dist, name), 'utf8')))
if (left.length) {
  console.error(`✗ .ts specifiers left in: ${left.join(', ')}`)
  process.exit(1)
}
console.log(`✓ ${rewritten} import specifiers rewritten to .js in ${files} declaration files`)
