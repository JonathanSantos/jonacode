/**
 * Whole-line decorations: a class per line, computed from its text. Handy for
 * log viewers (a background per level), diffs or highlighting lines from
 * outside. Only the rendered lines are decorated, so it scales to any size.
 *
 * ```ts
 * lineClass((text) => /\bERROR\b/.test(text) ? 'log-error' : null)
 * ```
 * ```css
 * .jc-line-deco.log-error { background: #e06c7520 }
 * ```
 */
import type { Editor, Extension } from '../editor.ts'
import { injectStyle } from '../view/style.ts'

export type LineClassFn = (text: string, line: number, editor: Editor) => string | null | undefined | false

export function lineClass(fn: LineClassFn): Extension {
  return (editor) => {
    injectStyle(editor.dom, 'line-class', LINE_CLASS_CSS)
    let last = ''
    return editor.addLayer({
      className: 'jc-line-class-layer',
      order: -1,
      render(dom, ed) {
        const { from, to } = ed.visibleRange
        let html = ''
        for (let line = from; line <= to; line++) {
          const cls = fn(ed.doc.line(line), line, ed)
          if (!cls) continue
          const { top, height } = ed.lineBlock(line)
          html += `<div class="jc-line-deco ${cls}" style="top:${top}px;height:${height}px"></div>`
        }
        if (html !== last) dom.innerHTML = last = html
      },
    })
  }
}

const LINE_CLASS_CSS = `.jc-line-deco{position:absolute;left:calc(-1 * var(--jc-pad-x));right:0}`
