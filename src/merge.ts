/**
 * Side-by-side diff of two editors: deleted lines tinted on the left, inserted
 * ones on the right, changed characters highlighted, unchanged lines kept at
 * the same height (the shorter side of each chunk gets an empty gap), and the
 * two sides scroll together. Arrows between the editors copy a chunk from the
 * left into the right. Both sides stay editable; the diff follows the edits.
 *
 * ```ts
 * const view = mergeView(el, {
 *   a: { value: saved, language: javascript, readOnly: true, extensions: lineNumbers() },
 *   b: { value: current, language: javascript, extensions: basicSetup() },
 * })
 * ```
 *
 * With line wrapping, chunks are aligned by their wrapped rows; unchanged
 * lines only line up when both editors have the same width (the default).
 */
import { createEditor, type ChangeEvent, type Editor, type EditorOptions, type LineGap } from './editor.ts'
import {
  chunkDetail, chunkIndexAt, drawChunks, DIFF_CSS, EDIT_COST, editedLines, revertChanges, sameChunks, updateChunks, type ChunkDetail,
} from './extensions/diff-view.ts'
import { diffLines, type DiffChunk } from './state/diff.ts'
import { escapeHTML } from './util/text.ts'
import { injectStyle } from './view/style.ts'

export interface MergeViewOptions {
  /** Left editor (usually the original; often `readOnly`). */
  a: EditorOptions
  /** Right editor (the new version). */
  b: EditorOptions
  /** Show "revert chunk" arrows that copy a chunk from A to B (default true when B is editable). */
  revertControls?: boolean
}

export interface MergeView {
  a: Editor
  b: Editor
  /** The container (a flex row: A, the arrows, B). */
  dom: HTMLElement
  /** The chunks: `fromA..toA` are lines of A, `fromB..toB` lines of B. */
  chunks(): readonly DiffChunk[]
  destroy(): void
}

const ARROW = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2.5 8h10M8.5 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** Creates two editors side by side in `parent`, showing how B differs from A. */
export function mergeView(parent: HTMLElement, options: MergeViewOptions): MergeView {
  const doc = parent.ownerDocument
  const div = (cls: string) => {
    const el = doc.createElement('div')
    el.className = cls
    return el
  }
  const dom = div('jc-merge')
  const paneA = div('jc-merge-pane jc-merge-a')
  const gap = div('jc-merge-gap')
  const paneB = div('jc-merge-pane jc-merge-b')
  dom.append(paneA, gap, paneB)
  parent.appendChild(dom)
  const a = createEditor(paneA, options.a)
  const b = createEditor(paneB, options.b)
  injectStyle(dom, 'diff', DIFF_CSS)
  injectStyle(dom, 'merge', MERGE_CSS)

  let chunks: DiffChunk[] = diffLines(a.doc.lines, b.doc.lines)
  const details = new WeakMap<DiffChunk, ChunkDetail | null>()
  const detail = (c: DiffChunk): ChunkDetail | null => {
    let d = details.get(c)
    if (d === undefined) {
      const big = c.toA - c.fromA > 200 || c.toB - c.fromB > 200
      d = big ? null : chunkDetail(a.doc.lines.slice(c.fromA, c.toA), b.doc.lines.slice(c.fromB, c.toB))
      details.set(c, d)
    }
    return d
  }

  // Alignment: the shorter side of each chunk gets a gap, so both sides have the same height everywhere.
  const rows = (ed: Editor, from: number, to: number) => {
    if (!ed.options.lineWrapping) return to - from
    let n = 0
    for (let l = from; l < to; l++) n += ed.lineBlock(l).height
    return n / ed.lineHeight
  }
  /** Line and side of the gap that pads `[from, to)` of an editor. */
  const gapAt = (ed: Editor, from: number, to: number): { line: number; side: 'above' | 'below' } => {
    const last = ed.doc.lineCount - 1
    return to > from ? { line: to - 1, side: 'below' } : from <= last ? { line: from, side: 'above' } : { line: last, side: 'below' }
  }
  const align = () => {
    const ga: LineGap[] = []
    const gb: LineGap[] = []
    for (const c of chunks) {
      const d = rows(a, c.fromA, c.toA) - rows(b, c.fromB, c.toB)
      if (!d) continue
      const [ed, list, from, to] = d > 0 ? [b, gb, c.fromB, c.toB] as const : [a, ga, c.fromA, c.toA] as const
      const g = gapAt(ed, from, to)
      list.push(g.side === 'above' ? { line: g.line, above: Math.abs(d) } : { line: g.line, below: Math.abs(d) })
    }
    a.setLineGaps('merge', ga)
    b.setLineGaps('merge', gb)
  }

  // Tints, character marks and the hatched fillers in the gaps.
  const layer = (ed: Editor, side: 'a' | 'b') => {
    let last = ''
    return ed.addLayer({
      className: 'jc-diff-layer',
      order: -0.9,
      render: (el) => {
        let html = drawChunks(ed, chunks, side, detail)
        const { from, to } = ed.visibleRange
        for (let i = chunkIndexAt(chunks, from, side); i < chunks.length; i++) {
          const c = chunks[i]!
          const [f, t, fo, to2] = side === 'a' ? [c.fromA, c.toA, c.fromB, c.toB] : [c.fromB, c.toB, c.fromA, c.toA]
          if (f > to + 1) break
          if (t - f >= to2 - fo && !ed.options.lineWrapping) continue
          const g = gapAt(ed, f, t)
          const box = ed.gapBlock(g.line, g.side)
          if (box.height) html += `<div class="jc-merge-filler" style="top:${box.top}px;height:${box.height}px"></div>`
        }
        if (html !== last) el.innerHTML = last = html
      },
    })
  }

  // Arrows between the editors, one per chunk on screen, over a band as tall as the chunk.
  let gapHTML = ''
  let theme = ''
  const drawGap = () => {
    if (b.isDestroyed) return
    // The column takes the colors of B's theme.
    if (theme !== b.theme.className) {
      if (theme) dom.classList.remove(theme)
      dom.classList.add((theme = b.theme.className))
    }
    const show = options.revertControls ?? !b.options.readOnly
    const origin = b.contentDOM.getBoundingClientRect().top - gap.getBoundingClientRect().top
    const { from, to } = b.visibleRange
    const lh = b.lineHeight
    const last = b.doc.lineCount - 1
    let html = ''
    for (let i = chunkIndexAt(chunks, from); i < chunks.length; i++) {
      const c = chunks[i]!
      if (c.fromB > to + 1) break
      const top = c.toB > c.fromB ? b.lineBlock(c.fromB).top : c.fromB <= last ? b.gapBlock(c.fromB, 'above').top : b.gapBlock(last, 'below').top
      const bottom = (ed: Editor, f: number, t: number) => (t > f ? ed.lineBlock(t - 1).top + ed.lineBlock(t - 1).height - ed.lineBlock(f).top : 0)
      const height = Math.max(bottom(a, c.fromA, c.toA), bottom(b, c.fromB, c.toB), 2)
      const kind = c.fromA === c.toA ? 'ins' : c.fromB === c.toB ? 'del' : 'mod'
      const y = Math.round(origin + top)
      html += `<div class="jc-merge-band jc-merge-${kind}" style="top:${y}px;height:${height}px"></div>`
      if (show) {
        const label = escapeHTML(b.phrase('Revert')).replace(/"/g, '&quot;')
        html += `<button type="button" class="jc-merge-revert" data-chunk="${i}" style="top:${y}px;height:${lh}px" title="${label}" aria-label="${label}">${ARROW}</button>`
      }
    }
    if (html !== gapHTML) gap.innerHTML = gapHTML = html
  }
  const onGapDown = (e: MouseEvent) => {
    if ((e.target as Element).closest?.('.jc-merge-revert')) e.preventDefault()
  }
  const onGapClick = (e: MouseEvent) => {
    const btn = (e.target as Element).closest?.('.jc-merge-revert') as HTMLElement | null
    const c = btn && chunks[Number(btn.dataset.chunk)]
    if (!c) return
    b.dispatch({ changes: revertChanges([c], a.doc.lines, b.doc.lines), origin: 'merge.revert' })
    b.focus()
  }
  gap.addEventListener('mousedown', onGapDown)
  gap.addEventListener('click', onGapClick)

  const refresh = () => {
    align()
    a.requestRender()
    b.requestRender()
  }

  // Edits: only the region around them is compared again; everything after a pause.
  let timer: ReturnType<typeof setTimeout> | undefined
  const fullDiff = () => {
    timer = undefined
    if (b.isDestroyed || a.isDestroyed) return
    const next = diffLines(a.doc.lines, b.doc.lines)
    if (sameChunks(next, chunks)) return
    chunks = next
    refresh()
  }
  const onChange = (side: 'a' | 'b') => (e: ChangeEvent) => {
    const edit = editedLines(e.changes)
    if (!edit) return
    const old = chunks
    const u = updateChunks(old, a.doc.lines, b.doc.lines, edit, side, EDIT_COST)
    for (let i = u.to; i < u.chunks.length; i++) {
      const d = details.get(old[i - u.to + u.oldTo]!)
      if (d !== undefined) details.set(u.chunks[i]!, d)
    }
    chunks = u.chunks
    refresh()
    clearTimeout(timer)
    timer = setTimeout(fullDiff, 300 + Math.max(a.doc.lineCount, b.doc.lineCount) / 100)
  }

  // Scrolling: each side follows the other. A position we set is expected back once and ignored.
  const expected = new Map<Editor, { top: number; left: number }>()
  const follow = (src: Editor, dst: Editor) => () => {
    const s = src.scrollDOM
    const e = expected.get(src)
    expected.delete(src)
    if (e && Math.abs(e.top - s.scrollTop) < 1 && Math.abs(e.left - s.scrollLeft) < 1) return
    const d = dst.scrollDOM
    if (d.scrollTop === s.scrollTop && d.scrollLeft === s.scrollLeft) return
    d.scrollTop = s.scrollTop
    d.scrollLeft = s.scrollLeft
    expected.set(dst, { top: d.scrollTop, left: d.scrollLeft })
  }

  // Wrapped rows change with the width: align again after the editors have re-wrapped.
  let rewrap = false
  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => (rewrap = true)) : null
  resize?.observe(dom)
  const onRender = () => {
    if (rewrap && (a.options.lineWrapping || b.options.lineWrapping)) {
      rewrap = false
      align()
    }
    drawGap()
  }

  const disposers = [
    layer(a, 'a'), layer(b, 'b'),
    a.on('change', onChange('a')), b.on('change', onChange('b')),
    a.on('scroll', follow(a, b)), b.on('scroll', follow(b, a)),
    a.on('render', onRender), b.on('render', onRender),
  ]
  align()

  return {
    a,
    b,
    dom,
    chunks: () => chunks,
    destroy() {
      clearTimeout(timer)
      resize?.disconnect()
      for (const d of disposers) d()
      a.destroy()
      b.destroy()
      dom.remove()
    },
  }
}

const MERGE_CSS = `
.jc-merge{display:flex;height:100%;overflow:hidden;background:var(--jc-bg)}
.jc-merge-pane{position:relative;flex:1 1 0;min-width:0;height:100%}
.jc-merge-gap{position:relative;flex:none;width:22px;overflow:hidden;background:var(--jc-gutter-background);
border-left:1px solid color-mix(in srgb,var(--jc-fg) 12%,transparent);border-right:1px solid color-mix(in srgb,var(--jc-fg) 12%,transparent)}
.jc-merge-band{position:absolute;left:0;right:0;pointer-events:none}
.jc-merge-ins{background:var(--jc-diff-inserted)}
.jc-merge-del{background:var(--jc-diff-deleted)}
.jc-merge-mod{background:color-mix(in srgb,var(--jc-diff-modified) 16%,transparent)}
.jc-merge-revert{position:absolute;left:2px;right:2px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:4px;
cursor:pointer;color:var(--jc-fg);opacity:.65;background:transparent}
.jc-merge-revert:hover,.jc-merge-revert:focus-visible{opacity:1;background:color-mix(in srgb,var(--jc-caret) 30%,transparent);outline:none}
.jc-merge-filler{position:absolute;left:calc(-1 * var(--jc-pad-x));right:0;
background:repeating-linear-gradient(-45deg,transparent 0 5px,color-mix(in srgb,var(--jc-fg) 9%,transparent) 5px 6px)}
`
