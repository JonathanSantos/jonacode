/**
 * Lazy editors: show the static highlight (the one `highlight()` renders, on
 * the server or right here) and only create the editor when it's needed — on
 * the first click, tap or focus, when the block scrolls into view, or when
 * the browser is idle. A page with 30 snippets pays for 30 `<pre>`s until
 * someone actually edits one.
 */
import { Editor, type EditorOptions } from './editor.ts'
import { highlight, highlightStyles } from './highlight.ts'
import { plainText } from './language/language.ts'
import { oneDark } from './themes/one-dark.ts'
import { injectStyle } from './view/style.ts'

export interface LazyEditorOptions extends EditorOptions {
  /** When to create the editor. Default `'interaction'` (pointer down, tap or focus). */
  on?: 'interaction' | 'visible' | 'idle'
  /** Line numbers in the static preview; match your extensions (`basicSetup` has them). Default true. */
  lineNumbers?: boolean
}

export interface LazyEditor {
  /** The editor, once created. */
  readonly editor: Editor | null
  /** Resolves with the editor when it's created. */
  readonly ready: Promise<Editor>
  /** Creates the editor now (no-op if it exists). */
  activate(): Editor
  destroy(): void
}

/**
 * Renders a static preview in `parent` (or reuses the `.jc-static` block
 * already there, e.g. from server rendering) and swaps it for an editor later.
 * The value comes from `options.value` or from the static block's text.
 */
export function lazyEditor(parent: HTMLElement, options: LazyEditorOptions = {}): LazyEditor {
  const { on = 'interaction', lineNumbers = true, ...editorOptions } = options
  const theme = options.theme ?? oneDark
  let pre = parent.querySelector<HTMLElement>(':scope > .jc-static')
  if (!pre) {
    injectStyle(parent, 'static' + theme.className, highlightStyles(theme))
    const tpl = parent.ownerDocument.createElement('template')
    tpl.innerHTML = highlight(options.value ?? '', options.language ?? plainText, { theme, lineNumbers, tabSize: options.tabSize })
    pre = tpl.content.firstElementChild as HTMLElement
    parent.appendChild(pre)
  }
  const value = options.value ?? pre.textContent ?? ''
  // Same box as the editor: fills a parent with a height, grows with the content otherwise.
  pre.style.height = '100%'
  pre.tabIndex = 0
  if (!pre.hasAttribute('aria-label')) pre.setAttribute('aria-label', options.ariaLabel ?? 'Code editor')

  let editor: Editor | null = null
  let resolve!: (e: Editor) => void
  const ready = new Promise<Editor>((r) => (resolve = r))
  const cleanups: (() => void)[] = []
  const listen = (type: string, fn: (e: Event) => void) => {
    pre!.addEventListener(type, fn)
    cleanups.push(() => pre!.removeEventListener(type, fn))
  }

  const activate = (): Editor => {
    if (editor) return editor
    const { scrollTop, scrollLeft } = pre!
    for (const c of cleanups.splice(0)) c()
    editor = new Editor(parent, { ...editorOptions, value })
    pre!.remove()
    editor.scrollDOM.scrollTop = scrollTop
    editor.scrollDOM.scrollLeft = scrollLeft
    resolve(editor)
    return editor
  }
  /** Creates the editor with the cursor where the user pointed, and focuses it. */
  const activateAt = (x: number, y: number) => {
    const ed = activate()
    ed.flush()
    const pos = ed.posAtClient(x, y)
    ed.dispatch({ selection: { anchor: pos, head: pos }, origin: 'select.pointer' })
    ed.focus()
  }

  if (on === 'interaction') {
    let touchStart: { x: number; y: number } | null = null
    listen('pointerdown', (e) => {
      const p = e as PointerEvent
      if (p.button !== 0) return
      // Taps become editors on "click", so a swipe can still scroll the page.
      if (p.pointerType !== 'mouse') touchStart = { x: p.clientX, y: p.clientY }
      else {
        e.preventDefault()
        activateAt(p.clientX, p.clientY)
      }
    })
    listen('pointercancel', () => (touchStart = null))
    listen('click', (e) => {
      const c = e as MouseEvent
      if (touchStart) activateAt(c.clientX, c.clientY)
      touchStart = null
    })
    listen('focus', () => {
      // Keyboard focus (Tab): become an editor and keep the focus. (A tap focuses too: its click places the cursor.)
      if (!editor && !touchStart) activate().focus()
    })
  } else if (on === 'visible' && typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && activate(), { rootMargin: '200px' })
    io.observe(pre)
    cleanups.push(() => io.disconnect())
  } else {
    const win = parent.ownerDocument.defaultView ?? window
    if (win.requestIdleCallback) {
      const id = win.requestIdleCallback(() => activate(), { timeout: 2000 })
      cleanups.push(() => win.cancelIdleCallback(id))
    } else {
      const id = setTimeout(activate, 200)
      cleanups.push(() => clearTimeout(id))
    }
  }

  return {
    get editor() {
      return editor
    },
    ready,
    activate,
    destroy() {
      for (const c of cleanups.splice(0)) c()
      editor?.destroy()
      pre!.remove()
    },
  }
}
