/**
 * Development helper: hover any token to see its type and the CSS class to
 * target (like VS Code's "Inspect Tokens"). Leave it out of production builds.
 */
import type { Extension } from '../editor.ts'
import { tokenTypeOfClass } from '../theme/theme.ts'
import { injectStyle } from '../view/style.ts'

export function tokenInspector(): Extension {
  return (editor) => {
    injectStyle(editor.dom, 'token-inspector', INSPECTOR_CSS)
    const tip = editor.dom.ownerDocument.createElement('div')
    tip.className = 'jc-token-tip'
    tip.hidden = true
    editor.dom.appendChild(tip)
    let current: Element | null = null

    const move = (e: MouseEvent) => {
      const span = (e.target as Element).closest?.('.jc-line span[class]')
      if (!span) {
        tip.hidden = true
        current = null
        return
      }
      if (span !== current) {
        current = span
        const type = tokenTypeOfClass(span.className) ?? span.className
        const color = getComputedStyle(span).color
        const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
        tip.innerHTML = `<b>${esc(type)}</b><span>${esc(JSON.stringify(span.textContent))}</span>` +
          `<code>${span.className.split(' ').map((c) => '.' + c).join(' ')}</code><i style="background:${color}"></i>`
      }
      const r = editor.dom.getBoundingClientRect()
      tip.hidden = false
      tip.style.transform = `translate(${Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 8)}px,${e.clientY - r.top + 18}px)`
    }
    const leave = () => {
      tip.hidden = true
      current = null
    }
    editor.scrollDOM.addEventListener('mousemove', move)
    editor.scrollDOM.addEventListener('mouseleave', leave)
    return () => {
      editor.scrollDOM.removeEventListener('mousemove', move)
      editor.scrollDOM.removeEventListener('mouseleave', leave)
      tip.remove()
    }
  }
}

const INSPECTOR_CSS = `
.jc-token-tip{position:absolute;left:0;top:0;z-index:20;display:grid;grid-template-columns:auto auto;gap:4px 10px;align-items:center;
padding:8px 10px;border-radius:8px;background:#1b1e24f2;color:#dfe3ea;border:1px solid #3d4452;font:12px/1.35 ui-monospace,monospace;
pointer-events:none;box-shadow:0 8px 24px #0007;max-width:360px}
.jc-token-tip[hidden]{display:none}
.jc-token-tip b{color:#e5c07b;font-weight:600}
.jc-token-tip span{color:#98c379;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jc-token-tip code{grid-column:1/2;color:#61afef}
.jc-token-tip i{justify-self:end;width:12px;height:12px;border-radius:3px;box-shadow:inset 0 0 0 1px #fff3}
`
