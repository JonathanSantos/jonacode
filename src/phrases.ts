/**
 * Every text the editor and its extensions show, in English: the keys of the
 * `phrases` option. A key is the English text itself, except for long
 * sentences, which have a short one (`inlineEdit.conflict`).
 *
 * ```ts
 * import { ptBR } from 'jonacode/locales/pt-BR'
 * createEditor(el, { phrases: ptBR })                          // a ready-made pack
 * createEditor(el, { phrases: { ...ptBR, Accept: 'Manter' } }) // changing one text
 * ```
 *
 * The editor never imports this table (it would be dead weight in every
 * bundle): call sites pass the English text themselves, and the compiler
 * checks their keys against `PhraseKey`.
 */
export const PHRASES = {
  // Editor (screen readers)
  'Lines {from}–{to} of {total}': 'Lines {from}–{to} of {total}',
  // Search and replace
  Find: 'Find',
  Replace: 'Replace',
  'Replace all': 'Replace all',
  'Toggle replace': 'Toggle replace',
  'Match case': 'Match case',
  'Whole word': 'Whole word',
  'Regular expression': 'Regular expression',
  'Previous match': 'Previous match',
  'Next match': 'Next match',
  'Select all matches': 'Select all matches',
  Close: 'Close',
  Invalid: 'Invalid',
  'No results': 'No results',
  // Go to line
  'Go to line': 'Go to line',
  Line: 'Line',
  // Autocomplete and folding
  Completions: 'Completions',
  Unfold: 'Unfold',
  // Touch toolbar
  Copy: 'Copy',
  Cut: 'Cut',
  Paste: 'Paste',
  'Select all': 'Select all',
  // Diff and merge
  Accept: 'Accept',
  Reject: 'Reject',
  Revert: 'Revert',
  // Syntax validation (tree-sitter)
  syntax: 'syntax',
  'Syntax error': 'Syntax error',
  'Syntax error near {token}': 'Syntax error near {token}',
  'Missing {token}': 'Missing {token}',
  'Insert {token}': 'Insert {token}',
  'Unexpected {token}': 'Unexpected {token}',
  'Remove {token}': 'Remove {token}',
  'Unclosed {token}': 'Unclosed {token}',
  'Unterminated string': 'Unterminated string',
  'Close the string': 'Close the string',
  // Collaboration
  Anonymous: 'Anonymous',
  'People editing': 'People editing',
  'Follow {name}': 'Follow {name}',
  'Stop following {name}': 'Stop following {name}',
  // Forms (<jona-code required>)
  'Please fill out this field.': 'Please fill out this field.',
  // AI: inline edit
  'Edit with AI': 'Edit with AI',
  'Edit with AI… (Enter to send, Esc to cancel)': 'Edit with AI… (Enter to send, Esc to cancel)',
  'Generating…': 'Generating…',
  'Line {line}': 'Line {line}',
  'Lines {from}–{to}': 'Lines {from}–{to}',
  Send: 'Send',
  Stop: 'Stop',
  'The AI request failed': 'The AI request failed',
  'inlineEdit.conflict': 'The code changed while the AI was writing: nothing was replaced. Send again, or copy the result.',
  'inlineEdit.rejected': 'This code can’t be changed here: nothing was replaced. Copy the result if you need it.',
  // AI: inline suggestions (screen readers)
  'Suggestion: {text}. Tab to accept.': 'Suggestion: {text}. Tab to accept.',
} as const

/** A text the editor can show: a key of the `phrases` option. */
export type PhraseKey = keyof typeof PHRASES

/** Translations: some (or all) of the texts in {@link PHRASES}. */
export type Phrases = Partial<Record<PhraseKey, string>>
