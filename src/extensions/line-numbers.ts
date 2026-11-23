import type { Editor, Extension } from '../editor.ts'

export interface LineNumbersOptions {
  /** Formats the (1-based) line number. */
  format?: (line: number, editor: Editor) => string
  /** Called on mouse down on a number. Return true to prevent the default line selection. */
  onClick?: (line: number, event: MouseEvent, editor: Editor) => boolean | void
  /** Space around the numbers, in px. A number is the space after them (default 10); `left` defaults to 16. */
  padding?: number | { left?: number; right?: number }
}

/** A class for the number of a line (0-based), or nothing. */
export type LineNumberClassFn = (line: number, editor: Editor) => string | null | undefined | false

const classers = new WeakMap<Editor, Set<LineNumberClassFn>>()

/**
 * Adds classes to the numbers of some lines: a mark drawn on the number itself
 * (a diagnostic, a breakpoint, a changed line…) instead of a gutter of its own.
 * `diagnostics({ gutter: 'line-numbers' })` is built on it.
 */
export function lineNumberClass(fn: LineNumberClassFn): Extension {
  return (editor) => {
    let set = classers.get(editor)
    if (!set) classers.set(editor, (set = new Set()))
    set.add(fn)
    editor.requestRender()
    return () => {
      set.delete(fn)
      editor.requestRender()
    }
  }
}

/** Line numbers gutter, with the cursor line highlighted. */
export function lineNumbers(options: LineNumbersOptions = {}): Extension {
  const format = options.format ?? ((n: number) => String(n))
  const pad = options.padding
  const left = Math.max(0, (typeof pad === 'object' ? pad.left : undefined) ?? 16)
  const right = Math.max(0, (typeof pad === 'object' ? pad.right : pad) ?? 10)
  return (editor) => {
    const style = editor.dom.style
    style.setProperty('--jc-ln-pad-l', left + 'px')
    style.setProperty('--jc-ln-pad-r', right + 'px')
    editor.addGutter({
      className: 'jc-gutter-lines',
      // Whole pixels (like the static highlighter's gutter), so both line up in every engine.
      width: (ed) => Math.ceil(Math.max(2, String(ed.doc.lineCount).length) * ed.digitWidth + left + right) + 'px',
      cell: (line, ed) => {
        let className = ed.activeLines.has(line) ? 'jc-active' : ''
        const extra = classers.get(ed)
        if (extra) for (const fn of extra) className += ' ' + (fn(line, ed) || '')
        return { text: format(line + 1, ed), className: className.trim() }
      },
      onMouseDown: options.onClick,
    })
    return () => {
      style.removeProperty('--jc-ln-pad-l')
      style.removeProperty('--jc-ln-pad-r')
    }
  }
}
