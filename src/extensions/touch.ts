/**
 * Touch support (included in `basicSetup`): taps place the cursor through the
 * browser's compatibility mouse events, double tap / long press select a
 * word, and a selection gets draggable handles plus a small copy / cut /
 * paste toolbar. Scrolling stays fully native. Translate the toolbar with the
 * editor's `phrases` option (`Copy`, `Cut`, `Paste`, `Select all`).
 */
import type { Editor, Extension } from '../editor.ts'
import { eqSel, isEmpty, selFrom, selTo, type Selection } from '../state/selection.ts'
import { injectStyle } from '../view/style.ts'

export interface TouchOptions {
  /** Long press duration (ms) that selects a word. Default 480. */
  longPress?: number
  /** Show the copy / cut / paste toolbar over touch selections. Default true. */
  toolbar?: boolean
}

const SLOP = 10

export function touch(options: TouchOptions = {}): Extension {
  const longPressMs = options.longPress ?? 480
  return (editor) => {
    injectStyle(editor.dom, 'touch', TOUCH_CSS)
    const doc = editor.dom.ownerDocument
    const cleanups: (() => void)[] = []
    const on = <E extends Event>(target: EventTarget, type: string, fn: (e: E) => void) => {
      target.addEventListener(type, fn as EventListener)
      cleanups.push(() => target.removeEventListener(type, fn as EventListener))
    }

    let start: { x: number; y: number } | null = null
    let moved = false
    let longPressed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastTap = { t: 0, x: 0, y: 0 }
    let ignoreMouseUntil = 0
    // The selection the handles belong to: any other selection change hides them.
    let owned: Selection | null = null

    const select = (anchor: Selection['anchor'], head: Selection['head']) => {
      editor.dispatch({ selection: { anchor, head }, origin: 'select.touch' })
      owned = editor.selection
      editor.flush()
    }
    const selectWordAt = (x: number, y: number) => {
      const [from, to] = editor.wordRange(editor.posAtClient(x, y))
      ignoreMouseUntil = performance.now() + 700
      editor.focus()
      select(from, to)
    }
    const hide = () => {
      if (!owned) return
      owned = null
      editor.requestRender()
    }

    // Compatibility mouse events after a double tap / long press must not move the cursor.
    editor.addMouseHandler(() => performance.now() < ignoreMouseUntil)
    editor.on('change', hide)
    editor.on('selection', (sel) => owned && !eqSel(sel, owned) && hide())

    on<PointerEvent>(editor.scrollDOM, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' || (e.target as Element).closest?.('.jc-handle, .jc-touch-bar, .jc-block, .jc-ui')) return
      editor.enableTouchInput()
      // A new gesture: the mouse events to ignore were those of the previous double tap / long press.
      ignoreMouseUntil = 0
      start = { x: e.clientX, y: e.clientY }
      moved = false
      longPressed = false
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!start || moved) return
        longPressed = true
        ;(navigator as { vibrate?: (ms: number) => boolean }).vibrate?.(8)
        selectWordAt(start.x, start.y)
      }, longPressMs)
    })
    on<PointerEvent>(editor.scrollDOM, 'pointermove', (e) => {
      if (start && !moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) {
        moved = true
        clearTimeout(timer)
      }
    })
    on<PointerEvent>(editor.scrollDOM, 'pointerup', (e) => {
      if (!start || e.pointerType === 'mouse') return
      clearTimeout(timer)
      start = null
      if (moved) return
      if (longPressed) {
        ignoreMouseUntil = performance.now() + 700
        return
      }
      const now = performance.now()
      const double = now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24
      lastTap = { t: double ? 0 : now, x: e.clientX, y: e.clientY }
      if (double) selectWordAt(e.clientX, e.clientY)
    })
    on(editor.scrollDOM, 'pointercancel', () => {
      start = null
      clearTimeout(timer)
    })
    // Keep the cursor visible when the virtual keyboard opens.
    const vv = doc.defaultView?.visualViewport
    if (vv) on(vv, 'resize', () => editor.hasFocus && editor.scrollIntoView())

    // --- handles & toolbar, drawn in a layer above the text
    const layer = doc.createElement('div')
    const handle = (kind: 'start' | 'end') => {
      const el = doc.createElement('div')
      el.className = `jc-handle jc-handle-${kind}`
      layer.appendChild(el)
      on<PointerEvent>(el, 'pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        el.setPointerCapture(e.pointerId)
        const range = editor.selection
        const fixed = kind === 'start' ? selTo(range) : selFrom(range)
        const move = (ev: PointerEvent) => select(fixed, editor.posAtClient(ev.clientX, ev.clientY - editor.lineHeight * 0.9))
        const up = () => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
          el.removeEventListener('pointercancel', up)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
        el.addEventListener('pointercancel', up)
      })
      return el
    }
    const startHandle = handle('start')
    const endHandle = handle('end')

    const bar = doc.createElement('div')
    bar.className = 'jc-touch-bar'
    if (options.toolbar !== false) layer.appendChild(bar)
    const copy = async () => {
      const text = editor.getSelectedText(true)
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        const ta = editor.inputDOM
        ta.value = text
        ta.select()
        doc.execCommand('copy')
      }
    }
    const actions: [string, () => void | Promise<void>][] = [
      ['Copy', copy],
      ['Cut', async () => {
        await copy()
        editor.replaceSelection('', 'delete.cut')
      }],
      ['Paste', async () => {
        const text = await navigator.clipboard.readText().catch(() => '')
        if (text) editor.replaceSelection(text.replace(/\r\n?/g, '\n'), 'input.paste')
      }],
      ['Select all', () => select({ line: 0, col: 0 }, editor.doc.end)],
    ]
    for (const [label, run] of actions) {
      const b = doc.createElement('button')
      b.type = 'button'
      b.dataset.action = label
      on<PointerEvent>(b, 'pointerdown', (e) => e.preventDefault())
      on(b, 'click', async () => {
        await run()
        editor.focus()
        editor.flush()
      })
      bar.appendChild(b)
    }

    editor.addLayer({
      className: 'jc-touch-layer',
      above: true,
      order: 10,
      render(dom, ed) {
        if (layer.parentNode !== dom) dom.appendChild(layer)
        const range = ed.selection
        const show = !!owned && !isEmpty(range)
        layer.style.display = show ? '' : 'none'
        if (!show) return
        const a = ed.coordsAtPos(selFrom(range))
        const b = ed.coordsAtPos(selTo(range))
        startHandle.style.transform = `translate(${a.x}px,${a.bottom}px)`
        endHandle.style.transform = `translate(${b.x}px,${b.bottom}px)`
        for (const btn of bar.children) (btn as HTMLElement).textContent = ed.phrase((btn as HTMLElement).dataset.action!)
        // Above the selection, or below it when there is no room at the top of the viewport.
        const below = a.top - ed.scrollDOM.scrollTop < 52
        bar.classList.toggle('jc-below', below)
        // Keep the toolbar inside the visible width.
        const sr = ed.scrollDOM.getBoundingClientRect()
        const right = ed.clientToContent(sr.left + ed.scrollDOM.clientWidth - 6, 0).x
        const x = Math.max(0, Math.min(a.x - 20, right - bar.offsetWidth))
        bar.style.transform = `translate(${x}px,${below ? b.bottom + 18 : a.top}px)`
      },
    })

    return () => {
      clearTimeout(timer)
      for (const c of cleanups) c()
      layer.remove()
    }
  }
}

const TOUCH_CSS = `
.jc-handle{position:absolute;left:0;top:0;width:28px;height:30px;margin-left:-14px;pointer-events:auto;touch-action:none;z-index:6}
.jc-handle::before{content:'';position:absolute;left:13px;top:-2px;width:2px;height:8px;background:var(--jc-caret)}
.jc-handle::after{content:'';position:absolute;left:7px;top:5px;width:14px;height:14px;border-radius:50%;background:var(--jc-caret);box-shadow:0 1px 4px #0006}
.jc-touch-bar{position:absolute;left:0;top:0;margin-top:-46px;display:flex;gap:2px;padding:4px;border-radius:10px;z-index:7;pointer-events:auto;
background:color-mix(in srgb,var(--jc-bg) 70%,#000);border:1px solid color-mix(in srgb,var(--jc-fg) 18%,transparent);box-shadow:0 8px 24px #0008;white-space:nowrap}
.jc-touch-bar.jc-below{margin-top:12px}
.jc-touch-bar button{font:600 13px/1 system-ui,sans-serif;color:var(--jc-fg);background:transparent;border:0;border-radius:7px;padding:9px 9px}
.jc-touch-bar button:active{background:color-mix(in srgb,var(--jc-fg) 16%,transparent)}
`
