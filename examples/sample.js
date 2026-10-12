// Sample code shown in the playground.
export const sampleCode = `import { createEditor, basicSetup } from 'jonacode'
import { javascript } from 'jonacode/languages/javascript'

/**
 * A tiny event emitter.
 * @param {string} name - the emitter name
 */
export class Emitter {
  #listeners = new Map()
  static MAX_LISTENERS = 10

  constructor(name = 'default') {
    this.name = name
  }

  on(type, fn) {
    const list = this.#listeners.get(type) ?? []
    list.push(fn)
    this.#listeners.set(type, list)
    return () => this.off(type, fn)
  }

  emit(type, ...args) {
    for (const fn of this.#listeners.get(type) ?? []) fn(...args)
  }
}

// TODO: aceitar acentos no slug
const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-')
const total = [1, 2.5, 0x1f, 1_000n].length / 2
const palette = { primary: '#61afef', accent: '#c678dd', warning: '#e5c07b' } // FIXME: vir do tema

async function main() {
  const res = await fetch(\`https://api.example.com/users?limit=\${total * 10}\`)
  const { users = [] } = await res.json()
  console.log(\`Loaded \${users.length} users: \${users.map((u) => slugify(u.name)).join(', ')}\`)
  return users.filter(({ active }) => active !== false && typeof active === 'boolean')
}

main().catch((error) => console.error('Something went wrong\\n', error))
`
