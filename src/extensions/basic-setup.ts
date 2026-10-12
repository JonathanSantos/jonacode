import { editingKeymap } from '../commands.ts'
import type { Editor, Extension } from '../editor.ts'
import type { KeyBinding } from '../keymap.ts'
import { highlightActiveLine } from './active-line.ts'
import { bracketMatching } from './bracket-matching.ts'
import { closeBrackets } from './close-brackets.ts'
import { gotoLine } from './goto-line.ts'
import { lineNumbers, type LineNumbersOptions } from './line-numbers.ts'
import { multiCursor, type MultiCursorOptions } from './multi-cursor.ts'
import { search, type SearchOptions } from './search.ts'
import { touch, type TouchOptions } from './touch.ts'

/** Adds key bindings. They take precedence over the default ones. */
export function keymap(bindings: readonly KeyBinding[], precedence: 'default' | 'high' = 'default'): Extension {
  return (editor) => {
    editor.addKeymap(bindings, precedence)
  }
}

/** Runs `fn` whenever the document changes (debounce it yourself if it's expensive). */
export function onChange(fn: (value: string, editor: Editor) => void): Extension {
  return (editor) => {
    editor.on('change', () => fn(editor.getValue(), editor))
  }
}

export interface BasicSetupOptions {
  lineNumbers?: boolean | LineNumbersOptions
  highlightActiveLine?: boolean
  bracketMatching?: boolean
  closeBrackets?: boolean
  /** VS Code style shortcuts: toggle comment, move/copy/delete lines… */
  editingKeymap?: boolean
  /** Alt+click, Mod-d, column selection… */
  multiCursor?: boolean | MultiCursorOptions
  /** Find & replace panel (Mod-f). */
  search?: boolean | SearchOptions
  /** "Go to line" panel (Ctrl-g). */
  gotoLine?: boolean
  /** Touch gestures: double tap / long press, selection handles, copy/paste toolbar. */
  touch?: boolean | TouchOptions
}

/**
 * The usual set of extensions. Everything can be turned off:
 * `basicSetup({ lineNumbers: false })`.
 */
export function basicSetup(options: BasicSetupOptions = {}): Extension {
  const on = (flag: unknown) => flag !== false
  return [
    on(options.lineNumbers) && lineNumbers(typeof options.lineNumbers === 'object' ? options.lineNumbers : {}),
    on(options.highlightActiveLine) && highlightActiveLine(),
    on(options.bracketMatching) && bracketMatching(),
    on(options.closeBrackets) && closeBrackets(),
    on(options.editingKeymap) && keymap(editingKeymap),
    on(options.multiCursor) && multiCursor(typeof options.multiCursor === 'object' ? options.multiCursor : {}),
    on(options.search) && search(typeof options.search === 'object' ? options.search : {}),
    on(options.gotoLine) && gotoLine(),
    on(options.touch) && touch(typeof options.touch === 'object' ? options.touch : {}),
  ]
}
