import type { Extension } from '../editor.ts'
import { isEmpty } from '../state/selection.ts'

/** Highlights the background of every line with a cursor (when nothing is selected there). */
export function highlightActiveLine(): Extension {
  return (editor) => {
    let last = ''
    editor.addLayer({
      className: 'jc-active-line-layer',
      order: -1,
      render(dom, ed) {
        const { from, to } = ed.visibleRange
        const lines = new Set<number>()
        for (const r of ed.ranges) if (isEmpty(r) && r.head.line >= from && r.head.line <= to) lines.add(r.head.line)
        let html = ''
        for (const line of lines) {
          const b = ed.lineBlock(line)
          html += `<div class="jc-active-line" style="top:${b.top}px;height:${b.height}px"></div>`
        }
        if (html !== last) dom.innerHTML = last = html
      },
    })
  }
}
