// The React and Vue adapters with their frameworks, bundled for the adapter specs (see global-setup.ts).
// A bundle of its own: it carries its own copy of the core, exported as `core`, so that editors,
// extensions and languages used together in a test all come from the same copy.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { createApp, h, reactive } from 'vue'
import { CodeEditor as ReactEditor, type CodeEditorProps } from '../src/adapters/react.ts'
import { CodeEditor as VueEditor } from '../src/adapters/vue.ts'
import * as core from '../src/index.ts'

export { core }

/** Renders the React component; `update(props)` renders it again with those props merged in. */
export function mountReact(host: HTMLElement, props: CodeEditorProps) {
  const root = createRoot(host)
  let current = props
  const update = (next: Partial<CodeEditorProps> = {}) => {
    current = { ...current, ...next }
    flushSync(() => root.render(createElement(ReactEditor, current)))
  }
  update()
  return { update, unmount: () => root.unmount() }
}

/** Mounts the Vue component on reactive props: assign to `props` to change them. */
export function mountVue(host: HTMLElement, initial: Record<string, unknown>) {
  const props = reactive({ ...initial })
  const app = createApp({ render: () => h(VueEditor, props) })
  app.mount(host)
  return { props, unmount: () => app.unmount() }
}
