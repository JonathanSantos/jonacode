/**
 * `jonacode/ai` — pieces for letting a language model use the editor, with
 * any provider: ready-made tools, edits in the formats models write, context
 * for prompts, inline suggestions and "edit with AI". Everything here is also
 * exported from `jonacode`; this entry just groups it.
 */
export {
  editorTools, textEditorTool, exposeTools, TEXT_EDITOR,
  type EditorTools, type EditorToolsOptions, type ToolDefinition, type ToolResult, type JSONSchemaObject, type Problem,
} from './tools.ts'
export {
  applyEdits, parseEdits, planEdits,
  type EditOp, type EditInput, type EditError, type EditResult, type ApplyEditsOptions,
} from './edits.ts'
export { describeEditor, fimContext, type DescribeOptions, type FimContext } from './context.ts'
export { markAIEdits, clearAIMarks, getAIMarks } from './marks.ts'
export {
  inlineSuggestion, acceptSuggestion, acceptSuggestionWord, dismissSuggestion, requestSuggestion, showSuggestion,
  currentSuggestion, suggestionKeymap,
  type SuggestionRequest, type SuggestionSource, type InlineSuggestionOptions,
} from './suggest.ts'
export {
  inlineEdit, openInlineEdit, cancelInlineEdit, inlineEditKeymap,
  type InlineEditRequest, type InlineEditSource, type InlineEditOptions,
} from './inline-edit.ts'
