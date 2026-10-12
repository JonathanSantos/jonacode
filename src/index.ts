/**
 * Jonacode — a tiny, modular, virtualized code editor.
 *
 * Everything here is tree-shakable: import only what you use. Languages and
 * themes live in their own entry points (`jonacode/languages/*`, `jonacode/themes/*`).
 */

export { Editor, createEditor } from './editor.ts'
export type {
  ChangeEvent, ChangeFilter, Coords, CursorModifier, EditorEvents, EditorOptions, Extension, FoldRange, GutterCell, GutterSpec, InputHandler,
  LayerSpec, LineGap, MouseHandler, UndoProvider, RangeChange, Rect, ResolvedOptions, TokenTransform, Transaction,
} from './editor.ts'

// Languages API
export { defineLanguage, extendLanguage, findLanguage, innerLanguage, plainText, words, State } from './language/language.ts'
export type {
  EmbedFrame, EmbedSpec, IncludeRule, Language, LanguageExtension, LanguageSpec, Rule, RuleEntry, RuleTuple, Token, TokenContext,
  TokenFunction, TokenSpec, TokenType,
} from './language/language.ts'
export { matchBracket, type BracketMatch } from './language/brackets.ts'
export { firstChars } from './language/first-chars.ts'

// Themes API
export { defineTheme, tokenClass, tokenSelector, tokenTypeOfClass, styleToCSS, colorVar } from './theme/theme.ts'
export type { Theme, ThemeColors, ThemeSpec, TokenStyle } from './theme/theme.ts'
export { oneDark } from './themes/one-dark.ts'

// Static highlighting & lazy editors
export { highlight, highlightAll, highlightStyles, STATIC_CSS, type HighlightOptions, type HighlightAllOptions } from './highlight.ts'
export { lazyEditor, type LazyEditor, type LazyEditorOptions } from './lazy.ts'

// Decorations (marks, line classes, widgets)
export { setDecorations, getDecorations, decorationsAt, type Decoration, type DecorationHit } from './decorations.ts'
export {
  addZone, getZones, addWidget, addOverlay,
  type Zone, type ZoneSpec, type ZoneAction, type Widget, type WidgetSpec, type WidgetContent, type Overlay, type OverlaySpec, type OverlayPosition,
} from './widgets.ts'
export { createFloating, type Floating } from './view/floating.ts'

// Extensions
export { lineNumbers, type LineNumbersOptions } from './extensions/line-numbers.ts'
export { highlightActiveLine } from './extensions/active-line.ts'
export { bracketMatching } from './extensions/bracket-matching.ts'
export { closeBrackets } from './extensions/close-brackets.ts'
export { basicSetup, keymap, onChange, type BasicSetupOptions } from './extensions/basic-setup.ts'
export {
  multiCursor, multiCursorKeymap, selectNextOccurrence, selectAllOccurrences, addCursorAbove, addCursorBelow,
  type MultiCursorOptions,
} from './extensions/multi-cursor.ts'
export {
  search, searchKeymap, openSearch, openReplace, findNext, findPrevious, closeSearch, replaceAll, selectAllMatches,
  setSearchQuery, searchRegExp, type SearchOptions, type SearchQuery,
} from './extensions/search.ts'
export { tokenRule, createTokenRule, type TokenRuleSpec } from './extensions/token-rule.ts'
export { tokenStyles } from './extensions/token-styles.ts'
export { tokenInspector } from './extensions/token-inspector.ts'
export { touch, type TouchOptions } from './extensions/touch.ts'
export { gotoLine, gotoLineKeymap, openGotoLine, parseLineTarget } from './extensions/goto-line.ts'
export { lineClass, type LineClassFn } from './extensions/line-class.ts'
export { hoverTooltip, showTooltip, showHover, type HoverSource, type HoverOptions, type TooltipContent } from './extensions/tooltip.ts'
export {
  diagnostics, setDiagnostics, getDiagnostics, linter, nextDiagnostic, previousDiagnostic, diagnosticsKeymap,
  type Diagnostic, type DiagnosticAction, type DiagnosticsOptions, type LinterOptions, type Severity,
} from './extensions/diagnostics.ts'
export {
  autocomplete, completeFromList, documentWords, languageWords, startCompletion, closeCompletion, acceptCompletion,
  completionKeymap, fuzzyMatch, filterCompletions,
  type Completion, type CompletionContext, type CompletionSource, type AutocompleteOptions,
} from './extensions/autocomplete.ts'
export {
  folding, foldCode, unfoldCode, toggleFold, foldAll, unfoldAll, foldKeymap, foldableRange, type FoldingOptions,
} from './extensions/folding.ts'
export {
  readOnlyRanges, setReadOnlyRanges, getReadOnlyRanges, lineRange, type ProtectedRange, type ReadOnlyRangesOptions,
} from './extensions/read-only-ranges.ts'

export {
  diffView, setOriginal, getOriginal, getChunks, acceptChunk, rejectChunk, acceptAll, rejectAll, nextChunk, previousChunk,
  diffKeymap, type DiffViewOptions,
} from './extensions/diff-view.ts'
export { mergeView, type MergeView, type MergeViewOptions } from './merge.ts'

// Tree-sitter validation (also `jonacode/tree-sitter`): you bring web-tree-sitter and the grammars
export {
  treeSitter, syntaxTree, whenParsed, getSyntaxProblems, nodeAt, fixAllSyntax, selectSyntaxParent, selectSyntaxChild, syntaxKeymap,
  createSyntaxChecker, findSyntaxProblems, combineFixes, GRAMMARS, grammarsFrom, cdnGrammars, cdnTreeSitter, CDN_TREE_SITTER,
  type TreeSitterOptions, type ParseResult, type SyntaxProblem, type SyntaxFix, type Grammars, type GrammarSource, type GrammarInfo,
  type TreeSitterModule, type TSTree, type TSNode,
} from './tree-sitter/index.ts'

// Collaboration (also `jonacode/collab`): any backend through an adapter; Yjs is ready
export {
  collab, yjs, getPeers, followPeer, followedPeer, setCollabUser, peerColor, PEER_COLORS, OwnHistory,
  type CollabOptions, type CollabUser, type Peer, type CollabAdapter, type PeerState, type LocalPresence, type TextOp, type TextDelta,
  type RemoteOrigin, type YjsOptions,
} from './collab/index.ts'
export { LineOffsets } from './state/offsets.ts'

// AI (also grouped in `jonacode/ai`)
export * from './ai/index.ts'
export { diffLines, diffChars, diffToChanges, type DiffChunk, type DiffOptions } from './state/diff.ts'

// Commands & keymaps
export * as commands from './commands.ts'
export { defaultKeymap, editingKeymap } from './commands.ts'
export { normalizeKey, type Command, type KeyBinding } from './keymap.ts'

// State
export { TextDocument, cmpPos, eqPos, mapPos, type Change, type ChangeSpec, type Pos } from './state/text.ts'
export {
  cursor, isEmpty, selFrom, selTo, normalizeSelection, type EditorSelection, type Selection, type SelectionInput,
} from './state/selection.ts'

export { setStyleNonce, injectStyle } from './view/style.ts'
export { wrapLine, type Advances } from './view/layout.ts'
