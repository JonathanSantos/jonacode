import type { Editor, Extension } from '../editor.ts'

export interface LineNumbersOptions {
  /** Formats the (1-based) line number. */
  format?: (line: number, editor: Editor) => string
  /** Called on mouse down on a number. Return true to prevent the default line selection. */
  onClick?: (line: number, event: MouseEvent, editor: Editor) => boolean | void
}

/** Line numbers gutter, with the cursor line highlighted. */
export function lineNumbers(options: LineNumbersOptions = {}): Extension {
  const format = options.format ?? ((n: number) => String(n))
  return (editor) => {
    editor.addGutter({
      className: 'jc-gutter-lines',
      // Whole pixels (like the static highlighter's gutter), so both line up in every engine.
      width: (ed) => Math.ceil(Math.max(2, String(ed.doc.lineCount).length) * ed.digitWidth + 26) + 'px',
      cell: (line, ed) => ({
        text: format(line + 1, ed),
        className: ed.activeLines.has(line) ? 'jc-active' : undefined,
      }),
      onMouseDown: options.onClick,
    })
  }
}
