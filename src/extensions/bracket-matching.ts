import type { Editor, Extension } from '../editor.ts'
import { matchBracket, type BracketMatch } from '../language/brackets.ts'
import { isEmpty } from '../state/selection.ts'
import type { Pos } from '../state/text.ts'

/** Highlights the bracket next to the (main) cursor and its partner. */
export function bracketMatching(): Extension {
  return (editor) => {
    let cacheKey = ''
    let match: BracketMatch | null = null
    editor.addLayer({
      className: 'jc-bracket-layer',
      render(dom, ed) {
        const sel = ed.selection
        const key = isEmpty(sel) ? `${ed.version}:${sel.head.line}:${sel.head.col}` : ''
        if (key !== cacheKey) {
          cacheKey = key
          match = key ? matchBracket(ed, sel.head) : null
        }
        let html = ''
        if (match?.to) html = box(ed, match.from) + box(ed, match.to)
        if (dom.innerHTML !== html) dom.innerHTML = html
      },
    })
  }
}

function box(ed: Editor, pos: Pos): string {
  const r = ed.rangeRects(pos, { line: pos.line, col: pos.col + 1 })[0]
  return r ? `<div class="jc-bracket" style="left:${r.x}px;top:${r.y}px;width:${Math.max(1, r.width)}px"></div>` : ''
}
