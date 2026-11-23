/**
 * Compartments (like CodeMirror 6's): a part of the extensions that can be
 * swapped without touching the rest. Everything outside it stays installed,
 * with its state — read-only ranges, diagnostics, an open search panel…
 *
 * ```ts
 * const review = compartment()
 * const editor = createEditor(el, { extensions: [basicSetup(), readOnlyRanges(locked), review.of(null)] })
 * review.reconfigure(editor, diffView({ original }))   // only this part changes
 * review.reconfigure(editor, null)
 * ```
 *
 * What a compartment holds keeps the compartment's place in the list: a gutter
 * it adds goes where it would be in a fresh `[…, diffView(), …]`.
 */
import type { Editor, Extension } from './editor.ts'

export interface Compartment {
  /** The extension to put in the list: it holds `extensions` until `reconfigure` replaces them. */
  of(extensions: Extension): Extension
  /** Replaces what the compartment holds in `editor`. False when the compartment isn't installed there. */
  reconfigure(editor: Editor, extensions: Extension): boolean
  /** What the compartment holds in `editor` now (undefined when it isn't installed there). */
  get(editor: Editor): Extension | undefined
}

export function compartment(): Compartment {
  const slots = new WeakMap<Editor, { set: (extensions: Extension) => void; content: Extension }>()
  return {
    of: (extensions) => (editor) => {
      const entry = { set: editor.slot(), content: extensions }
      slots.set(editor, entry)
      entry.set(extensions)
      return () => {
        if (slots.get(editor) === entry) slots.delete(editor)
      }
    },
    reconfigure(editor, extensions) {
      const entry = slots.get(editor)
      if (!entry) return false
      entry.content = extensions
      entry.set(extensions)
      return true
    },
    get: (editor) => slots.get(editor)?.content,
  }
}
