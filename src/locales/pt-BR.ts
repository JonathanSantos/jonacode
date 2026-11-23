/**
 * Português do Brasil.
 *
 * ```ts
 * import { ptBR } from 'jonacode/locales/pt-BR'
 * createEditor(el, { phrases: ptBR })
 * ```
 */
import type { PhraseKey } from '../phrases.ts'

/** Typed as a full record: a text added to `PHRASES` without a translation here doesn't compile. */
export const ptBR: Readonly<Record<PhraseKey, string>> = {
  'Lines {from}–{to} of {total}': 'Linhas {from} a {to} de {total}',
  Find: 'Buscar',
  Replace: 'Substituir',
  'Replace all': 'Substituir tudo',
  'Toggle replace': 'Mostrar ou ocultar a substituição',
  'Match case': 'Diferenciar maiúsculas de minúsculas',
  'Whole word': 'Palavra inteira',
  'Regular expression': 'Expressão regular',
  'Previous match': 'Resultado anterior',
  'Next match': 'Próximo resultado',
  'Select all matches': 'Selecionar todos os resultados',
  Close: 'Fechar',
  Invalid: 'Inválida',
  'No results': 'Nenhum resultado',
  'Go to line': 'Ir para a linha',
  Line: 'Linha',
  Completions: 'Sugestões',
  Unfold: 'Expandir',
  Copy: 'Copiar',
  Cut: 'Recortar',
  Paste: 'Colar',
  'Select all': 'Selecionar tudo',
  Accept: 'Aceitar',
  Reject: 'Rejeitar',
  Revert: 'Reverter',
  syntax: 'sintaxe',
  'Syntax error': 'Erro de sintaxe',
  'Syntax error near {token}': 'Erro de sintaxe perto de {token}',
  'Missing {token}': 'Falta {token}',
  'Insert {token}': 'Inserir {token}',
  'Unexpected {token}': '{token} inesperado',
  'Remove {token}': 'Remover {token}',
  'Unclosed {token}': '{token} não foi fechado',
  'Unterminated string': 'Texto sem aspas de fechamento',
  'Close the string': 'Fechar as aspas',
  Anonymous: 'Anônimo',
  'People editing': 'Pessoas editando',
  'Follow {name}': 'Seguir {name}',
  'Stop following {name}': 'Parar de seguir {name}',
  'Please fill out this field.': 'Preencha este campo.',
  'Edit with AI': 'Editar com IA',
  'Edit with AI… (Enter to send, Esc to cancel)': 'Editar com IA… (Enter envia, Esc cancela)',
  'Generating…': 'Gerando…',
  'Line {line}': 'Linha {line}',
  'Lines {from}–{to}': 'Linhas {from} a {to}',
  Send: 'Enviar',
  Stop: 'Parar',
  'The AI request failed': 'O pedido à IA falhou',
  'inlineEdit.conflict': 'O código mudou enquanto a IA escrevia: nada foi trocado. Envie de novo, ou copie o resultado.',
  'inlineEdit.rejected': 'Este código não pode ser alterado aqui: nada foi trocado. Copie o resultado se precisar dele.',
  'Suggestion: {text}. Tab to accept.': 'Sugestão: {text}. Tab aceita.',
}
