/**
 * Context for prompts: a compact description of what the user is looking at
 * (file, cursor, selection, problems, the code around the cursor) and the
 * text around the cursor for fill-in-the-middle completions. Positions shown
 * to models are 1-based; big files are never dumped whole.
 *
 * ```ts
 * const system = `You help edit code.\n\n${describeEditor(editor)}`
 * const { prefix, suffix } = fimContext(editor)
 * ```
 */
import type { Editor } from '../editor.ts'
import { getDiagnostics } from '../extensions/diagnostics.ts'
import { cmpPos, type Pos } from '../state/text.ts'

export interface DescribeOptions {
  /** File name shown to the model (default derived from the language, e.g. `main.js`). */
  path?: string
  /** Max size of the whole block (default 12000). */
  maxChars?: number
  /** Lines shown above and below the cursor (default 40). */
  around?: number
}

export interface FimContext {
  /** Text before the cursor (or before the selection). */
  prefix: string
  /** Text after the cursor (or after the selection). */
  suffix: string
  /** Name of the editor's language. */
  language: string
  /** Cursor line, 0-based like `Pos`. */
  line: number
  /** Cursor column, 0-based like `Pos`. */
  col: number
}

/** @internal A default file name for an editor: `main.js`, `index.html`, `style.css`, `file.txt`… */
export function pathFor(editor: Editor): string {
  const lang = editor.language
  const ext = lang.extensions?.[0]
  return ext ? ((({ html: 'index', css: 'style' }) as Record<string, string>)[lang.name] ?? 'main') + ext : 'file.txt'
}

/** @internal Lines as models count them (like `cat -n`): a final newline doesn't start one more line. */
export function lineCount(editor: Editor): number {
  const { lines } = editor.doc
  const n = lines.length
  return lines[n - 1] ? n : n - 1
}

/** @internal 1-based `line:col`. */
export const at = (p: Pos): string => `${p.line + 1}:${p.col + 1}`

/** @internal One `cat -n` style row, long lines cut with a marker. */
export function row(n: number, text: string, max = 2000): string {
  if (text.length > max) text = text.slice(0, max) + ` … [${text.length - max} more chars]`
  return String(n + 1).padStart(6) + '\t' + text + '\n'
}

/**
 * @internal Lines `from..to` (0-based, inclusive) numbered like `cat -n`,
 * stopping before `maxChars` (at least one line is shown). Returns the text
 * and the last line shown.
 */
export function numberLines(editor: Editor, from: number, to: number, maxChars = Infinity): [string, number] {
  let out = ''
  let i = from
  for (; i <= to; i++) {
    const r = row(i, editor.doc.line(i))
    if (out && out.length + r.length > maxChars) break
    out += r
  }
  return [out, i - 1]
}

/** @internal Problems as `- line:col severity: message`, sorted, at most `max`. */
export function problemList(list: readonly { from: Pos; severity: string; message: string; source?: string }[], max = 20): string {
  const sorted = [...list].sort((a, b) => cmpPos(a.from, b.from))
  let out = sorted.slice(0, max).map((d) => `- ${at(d.from)} ${d.severity}: ${d.message}${d.source ? ` [${d.source}]` : ''}`).join('\n')
  if (sorted.length > max) out += `\n- … and ${sorted.length - max} more`
  return out
}

/**
 * A compact text block describing the editor for a prompt: file, language,
 * size, cursor and selection (1-based) with the selected text, current
 * problems, and numbered lines around the cursor — within `maxChars`.
 */
export function describeEditor(editor: Editor, options: DescribeOptions = {}): string {
  const { doc } = editor
  const max = options.maxChars ?? 12000
  const around = options.around ?? 40
  const main = editor.selection
  const ranges = editor.ranges
  let out = `File: ${options.path ?? pathFor(editor)} (${editor.language.name}, ${lineCount(editor)} lines)\n`
  out += ranges.length > 1
    ? `Cursors (line:col): ${ranges.map((r) => at(r.head) + (r === main ? ' (main)' : '')).join(', ')}\n`
    : `Cursor: line ${main.head.line + 1}, col ${main.head.col + 1}\n`
  const [from, to] = cmpPos(main.anchor, main.head) <= 0 ? [main.anchor, main.head] : [main.head, main.anchor]
  if (cmpPos(from, to) < 0) {
    let text = doc.sliceLines(from, to).join('\n')
    const cap = max >> 2
    if (text.length > cap) text = text.slice(0, cap) + `\n… [${text.length - cap} more chars]`
    out += `Selection: ${at(from)} to ${at(to)}\nSelected text:\n\`\`\`\n${text}\n\`\`\`\n`
  }
  const problems = getDiagnostics(editor)
  if (problems.length) out += `Problems (line:col):\n${problemList(problems)}\n`
  // Grow a window around the cursor line, alternating up and down, while it fits.
  const line = main.head.line
  const first = Math.max(0, line - around)
  const last = Math.min(Math.max(lineCount(editor) - 1, line), line + around)
  let lo = line
  let hi = line
  let size = row(line, doc.line(line), 500).length
  const budget = max - out.length - 40
  for (let grew = true; grew;) {
    grew = false
    for (const n of [lo - 1, hi + 1]) {
      if (n < first || n > last) continue
      const len = row(n, doc.line(n), 500).length
      if (size + len > budget) continue
      size += len
      if (n < lo) lo = n
      else hi = n
      grew = true
    }
  }
  out += `Lines ${lo + 1}-${hi + 1}:\n`
  for (let n = lo; n <= hi; n++) out += row(n, doc.line(n), 500)
  return out.length > max ? out.slice(0, max) : out
}

/**
 * Text before and after the main cursor for fill-in-the-middle / inline
 * completion prompts (defaults: 4000 chars before, 1500 after), cut at line
 * boundaries when possible. With a selection, the selected text is left out
 * (it's what the completion replaces). Lines are joined with `\n`.
 */
export function fimContext(editor: Editor, options: { before?: number; after?: number } = {}): FimContext {
  const before = options.before ?? 4000
  const after = options.after ?? 1500
  const { doc } = editor
  const { anchor, head } = editor.selection
  const [from, to] = cmpPos(anchor, head) <= 0 ? [anchor, head] : [head, anchor]
  let prefix = doc.line(from.line).slice(0, from.col)
  for (let l = from.line - 1; l >= 0 && prefix.length < before; l--) prefix = doc.line(l) + '\n' + prefix
  if (prefix.length > before) {
    const cut = prefix.length - before
    const nl = prefix.indexOf('\n', cut - 1)
    prefix = prefix.slice(nl < 0 ? cut : nl + 1)
  }
  let suffix = doc.line(to.line).slice(to.col)
  for (let l = to.line + 1; l < doc.lineCount && suffix.length < after; l++) suffix += '\n' + doc.line(l)
  if (suffix.length > after) {
    const nl = suffix.lastIndexOf('\n', after)
    suffix = suffix.slice(0, nl > 0 ? nl : after)
  }
  return { prefix, suffix, language: editor.language.name, line: head.line, col: head.col }
}
