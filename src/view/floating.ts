/**
 * A floating box anchored to a document position: tooltips, the completion
 * list. It lives inside the editor (so the theme's CSS variables apply) but is
 * drawn in the browser's top layer (Popover API) when available, so no
 * `overflow: hidden` or `z-index` around the editor can clip it; otherwise it
 * falls back to `position: fixed`.
 */
import type { Editor } from '../editor.ts'
import type { Pos } from '../state/text.ts'
import { injectStyle } from './style.ts'

export interface Floating {
  readonly el: HTMLElement
  readonly visible: boolean
  /** Shows the box below (or above, when there's no room) `pos`. False when `pos` is scrolled out of view. */
  show(pos: Pos, prefer?: 'below' | 'above'): boolean
  /** Re-places it at the last position (after scrolling or a size change). */
  update(): void
  hide(): void
  destroy(): void
}

const GAP = 3

export function createFloating(editor: Editor, className: string): Floating {
  injectStyle(editor.dom, 'floating', FLOATING_CSS)
  const el = editor.dom.ownerDocument.createElement('div')
  el.className = 'jc-floating ' + className
  const topLayer = typeof el.showPopover === 'function'
  if (topLayer) el.popover = 'manual'
  el.hidden = true
  editor.dom.appendChild(el)
  let at: Pos | null = null
  let preferred: 'below' | 'above' = 'below'

  const place = (): boolean => {
    if (!at) return false
    const sc = editor.scrollDOM.getBoundingClientRect()
    const c = editor.coordsAtPos(at)
    const { x, y: top } = editor.contentToClient(c.x, c.top)
    const bottom = editor.contentToClient(c.x, c.bottom).y
    // Out of the editor's visible area: nothing to point at.
    if (bottom < sc.top || top > sc.bottom || x < sc.left - 1 || x > sc.right + 1) return false
    const win = editor.dom.ownerDocument.defaultView ?? window
    const vw = win.innerWidth
    const vh = win.innerHeight
    const { offsetWidth: w, offsetHeight: h } = el
    const fitsBelow = bottom + GAP + h <= vh
    const fitsAbove = top - GAP - h >= 0
    const below = preferred === 'below' ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow
    const y = below ? bottom + GAP : top - GAP - h
    el.style.left = Math.max(4, Math.min(x, vw - w - 4)) + 'px'
    el.style.top = Math.max(4, y) + 'px'
    el.classList.toggle('jc-floating-above', !below)
    return true
  }

  const floating: Floating = {
    el,
    get visible() {
      return !el.hidden
    },
    show(pos, prefer = 'below') {
      at = pos
      preferred = prefer
      if (el.hidden) {
        el.hidden = false
        if (topLayer && !el.matches(':popover-open')) el.showPopover()
      }
      if (place()) return true
      floating.hide()
      return false
    },
    update() {
      if (!el.hidden && !place()) floating.hide()
    },
    hide() {
      if (el.hidden) return
      if (topLayer && el.matches(':popover-open')) el.hidePopover()
      el.hidden = true
    },
    destroy() {
      floating.hide()
      el.remove()
    },
  }
  return floating
}

const FLOATING_CSS = `
.jc-floating{position:fixed;inset:auto;left:0;top:0;margin:0;z-index:30;box-sizing:border-box;max-width:min(560px,calc(100vw - 8px));
padding:0;overflow:auto;color:var(--jc-fg);background:color-mix(in srgb,var(--jc-bg) 92%,var(--jc-fg));
border:1px solid color-mix(in srgb,var(--jc-fg) 18%,transparent);border-radius:8px;box-shadow:0 12px 32px -8px #000a;
font:13px/1.45 var(--jc-ui-font,system-ui,-apple-system,sans-serif)}
.jc-floating[hidden]{display:none}
`
