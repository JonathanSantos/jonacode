/**
 * Highlights what the AI wrote: a faint tint over the text of its edits that
 * fades in, stays until cleared, and follows later edits (text deleted since
 * loses its mark). Themes can change the color with `--jc-ai-edit`. Needs the
 * DOM (does nothing in a headless editor).
 */
import { getDecorations, setDecorations } from '../decorations.ts'
import type { Editor } from '../editor.ts'
import { cmpPos, type Pos } from '../state/text.ts'
import { injectStyle } from '../view/style.ts'

const SET = 'ai-edits'
const CLS = 'jc-ai-edit'
const timers = new WeakMap<Editor, ReturnType<typeof setTimeout>>()

/** Adds ranges to the AI marks of the editor (merged with the ones already there). */
export function markAIEdits(editor: Editor, ranges: readonly { from: Pos; to: Pos }[]): void {
  if (!editor.dom || !ranges.length) return
  injectStyle(editor.dom, 'ai-marks', AI_MARKS_CSS)
  const list = [
    ...getDecorations(editor, SET).map((d) => ({ from: d.from, to: d.to!, fresh: d.class !== CLS })),
    ...ranges.filter((r) => cmpPos(r.from, r.to) < 0).map((r) => ({ from: r.from, to: r.to, fresh: true })),
  ].sort((a, b) => cmpPos(a.from, b.from))
  // Overlapping or touching marks become one (two layers of tint would look darker).
  const merged: typeof list = []
  for (const r of list) {
    const last = merged[merged.length - 1]
    if (last && cmpPos(r.from, last.to) <= 0) {
      if (cmpPos(r.to, last.to) > 0) last.to = r.to
      last.fresh ||= r.fresh
    } else merged.push({ ...r })
  }
  setDecorations(editor, SET, merged.map((r) => ({ from: r.from, to: r.to, class: r.fresh ? CLS + ' jc-ai-new' : CLS })))
  // Marks are redrawn on every change: only new ones may animate, or they'd flash while typing.
  clearTimeout(timers.get(editor))
  timers.set(editor, setTimeout(() => {
    if (!editor.isDestroyed) setDecorations(editor, SET, getDecorations(editor, SET).map((d) => ({ ...d, class: CLS })))
  }, 400))
}

/** Removes every AI mark. */
export function clearAIMarks(editor: Editor): void {
  if (editor.dom) setDecorations(editor, SET, [])
}

/** The current AI marks, mapped through the edits made since. */
export function getAIMarks(editor: Editor): { from: Pos; to: Pos }[] {
  return getDecorations(editor, SET).map((d) => ({ from: d.from, to: d.to! }))
}

const AI_MARKS_CSS = `
.jc-ai-edit{background:var(--jc-ai-edit,color-mix(in srgb,#a78bfa 18%,transparent))}
.jc-ai-new{animation:jc-ai-in .3s ease-out}
@keyframes jc-ai-in{from{opacity:0}}
@media (prefers-reduced-motion:reduce){.jc-ai-new{animation:none}}
`
