/**
 * Tools for LLMs: read, search, edit, see problems and undo — ready for the
 * Anthropic and OpenAI APIs, MCP / WebMCP, and Claude's built-in text editor
 * tool. `run()` never throws: failures come back as messages for the model.
 *
 * ```ts
 * const tools = editorTools(editor)                 // or { 'index.html': a, 'app.js': b }
 * const res = await anthropic.messages.create({ model, tools: tools.anthropic(), messages })
 * for (const block of res.content) if (block.type === 'tool_use') {
 *   const r = await tools.run(block.name, block.input)
 *   results.push({ type: 'tool_result', tool_use_id: block.id, content: r.content, is_error: r.isError })
 * }
 * ```
 */
import type { Editor } from '../editor.ts'
import { getDiagnostics } from '../extensions/diagnostics.ts'
import { cmpPos, type Pos } from '../state/text.ts'
import { lineCount, numberLines, pathFor, problemList, row } from './context.ts'
import { applyEdits, parseEdits, type ApplyEditsOptions, type EditInput, type EditResult } from './edits.ts'
import { markAIEdits } from './marks.ts'

export interface JSONSchemaObject {
  type: 'object'
  properties: Record<string, object>
  required?: string[]
}

/** A tool as MCP / WebMCP describe it. */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JSONSchemaObject
}

export interface ToolResult {
  /** Text for the model. */
  content: string
  isError?: boolean
}

export interface Problem {
  from: Pos
  severity: string
  message: string
  source?: string
}

export interface EditorToolsOptions {
  /** File name the model sees (default derived from the language, e.g. `main.js`, `index.html`, `file.txt`). Ignored when a record of editors is given. */
  path?: string
  /** Only reading tools. */
  readOnly?: boolean
  /** Max lines returned by one read (default 400). */
  maxLines?: number
  /** Max chars returned by one read (default 20000). */
  maxChars?: number
  /** Checks after each edit; problems are appended to the edit result so the model can fix them. Default: the current diagnostics (`getDiagnostics`) after `settle` ms. */
  verify?: (editor: Editor) => readonly Problem[] | Promise<readonly Problem[]>
  /** ms to wait for linters after an edit before reading diagnostics when no `verify` is given (default 700; 0 = don't wait). */
  settle?: number
  /** Highlight what the AI wrote (default true; needs the DOM). */
  markEdits?: boolean
  /** Called after each successful edit. */
  onEdit?: (result: EditResult, path: string) => void
}

export interface EditorTools {
  /** Provider-neutral definitions (JSON Schema). */
  readonly definitions: ToolDefinition[]
  /**
   * Anthropic Messages API `tools` entries. With `textEditor`, Claude's built-in
   * text editor tool replaces read/edit/insert/write (search, selection,
   * problems and undo stay).
   */
  anthropic(options?: { textEditor?: boolean }): object[]
  /** OpenAI-style function tools: `{ type: 'function', function: { name, description, parameters } }`. */
  openai(): object[]
  /** Runs a tool call (input as an object or a JSON string). Handles `str_replace_based_edit_tool` too. Never throws. */
  run(name: string, input: unknown): Promise<ToolResult>
}

type Input = Record<string, unknown>

export const TEXT_EDITOR = 'str_replace_based_edit_tool'
const READ = ['read_file', 'search_file', 'get_selection', 'get_problems']
/** Tools that go along Claude's text editor tool. */
const EXTRA = ['search_file', 'get_selection', 'get_problems', 'undo_last_edit']

const clean = (p: string) => {
  p = p.trim().replace(/^(?:\.?\/)+/, '')
  return p === '.' ? '' : p
}
const int = (v: unknown, name: string): number => {
  const n = Number(v)
  if (v === '' || v == null || !Number.isInteger(n)) throw new Error(`${name} must be an integer.`)
  return n
}
const str = (description: string) => ({ type: 'string', description })
const num = (description: string) => ({ type: 'integer', description })
const bool = (description: string) => ({ type: 'boolean', description })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Tools over one editor or several (a record of file name → editor, like tabs of a playground). */
export function editorTools(editors: Editor | Record<string, Editor>, options: EditorToolsOptions = {}): EditorTools {
  const single = typeof (editors as Editor).dispatch === 'function'
  const files: Record<string, Editor> = {}
  if (single) files[clean(options.path ?? pathFor(editors as Editor))] = editors as Editor
  else for (const [k, v] of Object.entries(editors as Record<string, Editor>)) files[clean(k)] = v
  const names = Object.keys(files)
  if (!names.length) throw new Error('[jonacode] editorTools: no editor given')
  const multi = names.length > 1
  const maxLines = options.maxLines ?? 400
  const maxChars = options.maxChars ?? 20000
  const list = names.join(', ')
  /** Versions before / after each edit made through the tools, per editor (for undo). */
  const done = new Map<Editor, { before: number; after: number }[]>()

  const pick = (path: unknown): [string, Editor] => {
    const p = clean(String(path ?? ''))
    if (!p && !multi) return [names[0]!, files[names[0]!]!]
    if (!p) throw new Error(`Several files are open; pass path (one of: ${list}).`)
    const name = files[p] ? p : names.find((n) => p.endsWith('/' + n))
    if (!name) throw new Error(`Unknown file "${path}". Files: ${list}.`)
    return [name, files[name]!]
  }
  const targets = (path: unknown): [string, Editor][] => (path || !multi ? [pick(path)] : names.map((n) => [n, files[n]!]))

  // --- reading -------------------------------------------------------------

  const read = (path: string, ed: Editor, start?: unknown, end?: unknown): string => {
    const total = lineCount(ed)
    const head = `${path} (${ed.language.name}, ${total} lines)\n`
    if (!total) return head
    const a = start == null ? 1 : Math.max(1, int(start, 'start_line'))
    const b = end == null || +end === -1 ? total : Math.min(total, int(end, 'end_line'))
    if (a > total) throw new Error(`start_line ${a} is past the end of ${path} (${total} lines).`)
    if (b < a) throw new Error('end_line must not be before start_line.')
    // A big file read without a range: its start plus an outline to navigate.
    const big = start == null && end == null && total > maxLines
    const [text, last] = numberLines(ed, a - 1, Math.min(b, a - 1 + (big ? maxLines >> 1 : maxLines)) - 1, big ? maxChars >> 1 : maxChars)
    let out = head + text
    if (last + 1 < b) out += `[Lines ${a}-${last + 1} of ${total} shown. Continue from line ${last + 2}${big ? ', or use search_file' : ''}.]\n`
    if (big) out += outline(ed, maxChars - out.length)
    return out
  }

  const search = (i: Input): string => {
    const q = String(i.query ?? '')
    if (!q) throw new Error('query is empty.')
    let re: RegExp
    try {
      re = new RegExp(i.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), i.case_sensitive ? 'g' : 'gi')
    } catch (e) {
      throw new Error(`Invalid regular expression: ${(e as Error).message}`)
    }
    let out = ''
    let total = 0
    let lines = 0
    for (const [p, ed] of targets(i.path)) {
      ed.doc.lines.forEach((text, n) => {
        const m = text.match(re)
        if (!m) return
        total += m.length
        if (lines++ >= 50) return
        const k = text.search(re)
        const s = text.length > 240 ? Math.max(0, k - 80) : 0
        out += `${multi ? p + ':' : ''}${n + 1}: ${s ? '…' : ''}${text.slice(s, s + 240)}${text.length > s + 240 ? '…' : ''}\n`
      })
    }
    if (!total) return `No matches for ${JSON.stringify(q)}.`
    return `${total} match${total > 1 ? 'es' : ''} in ${lines} line${lines > 1 ? 's' : ''}${lines > 50 ? ' (first 50 shown)' : ''}:\n${out}`
  }

  const selection = ([p, ed]: [string, Editor]): string => {
    let out = `${p}:`
    for (const r of ed.ranges) {
      const [a, b] = cmpPos(r.anchor, r.head) <= 0 ? [r.anchor, r.head] : [r.head, r.anchor]
      const main = ed.ranges.length > 1 && r === ed.selection ? ' (main)' : ''
      if (!cmpPos(a, b)) out += `\nCursor at line ${a.line + 1}, col ${a.col + 1}${main}, nothing selected.`
      else {
        let text = ed.doc.sliceLines(a, b).join('\n')
        if (text.length > maxChars) text = text.slice(0, maxChars) + `\n… [${text.length - maxChars} more chars]`
        out += `\nSelection from line ${a.line + 1}, col ${a.col + 1} to line ${b.line + 1}, col ${b.col + 1}${main}:\n${text}`
      }
    }
    return out
  }

  // The app's own checker when given (it's what edits are verified with), else the editor's diagnostics.
  const problems = async (i: Input): Promise<string> =>
    (await Promise.all(targets(i.path).map(async ([p, ed]) => {
      const l = options.verify ? await options.verify(ed) : getDiagnostics(ed)
      return (multi ? p + ': ' : '') + (l.length ? `${l.length} problem${l.length > 1 ? 's' : ''} (line:col):\n${problemList(l, 50)}` : 'No problems.')
    }))).join('\n')

  // --- editing -------------------------------------------------------------

  /** Numbered lines around the edited ranges (±3), at most 60 lines. */
  const snippet = (ed: Editor, ranges: readonly { from: Pos; to: Pos }[]): string => {
    let out = ''
    let last = -1
    let left = 60
    for (const r of [...ranges].sort((x, y) => x.from.line - y.from.line)) {
      const a = Math.max(last + 1, r.from.line - 3)
      const b = Math.min(lineCount(ed) - 1, r.to.line + 3, a + left - 1)
      if (b < a) continue
      if (last >= 0 && a > last + 1) out += '     …\n'
      out += numberLines(ed, a, b, maxChars >> 2)[0]
      left -= b - a + 1
      last = b
    }
    return left > 0 ? out : out + '     …\n'
  }

  const check = async (ed: Editor): Promise<string> => {
    try {
      let found: readonly Problem[]
      if (options.verify) found = await options.verify(ed)
      else {
        const ms = options.settle ?? 700
        // Without a DOM there can't be a linter (nor diagnostics) to wait for.
        if (ms > 0 && ed.dom) await sleep(ms)
        found = getDiagnostics(ed)
      }
      return found.length ? `Problems after the edit (line:col):\n${problemList(found)}` : 'No problems reported.'
    } catch (e) {
      return `Could not check for problems: ${(e as Error).message}`
    }
  }

  const edit = async (path: string, ed: Editor, input: EditInput, opts: ApplyEditsOptions = {}, note = ''): Promise<string> => {
    const before = ed.version
    const r = applyEdits(ed, input, opts)
    if (!r.ok) throw new Error(r.summary)
    if (ed.version !== before) {
      const stack = done.get(ed) ?? []
      done.set(ed, stack)
      stack.push({ before, after: ed.version })
      if (options.markEdits !== false) markAIEdits(ed, r.ranges)
    }
    options.onEdit?.(r, path)
    const lines = snippet(ed, r.ranges)
    return `${r.summary}${note}\n\n${lines && `${path} after the edit:\n${lines}\n`}${await check(ed)}`
  }

  const undo = ([p, ed]: [string, Editor]): string => {
    const stack = done.get(ed) ?? []
    const last = stack.pop()
    if (!last) throw new Error(`No edit of yours to undo in ${p}.`)
    if (last.after !== ed.version) {
      stack.length = 0
      throw new Error(`${p} changed since your last edit (the user or another tool edited it), so it can't be undone safely. Read the file and fix it with a new edit instead.`)
    }
    if (!ed.undo()) {
      stack.length = 0
      throw new Error(`The editor could not undo the last edit of ${p}.`)
    }
    // The previous edit can be undone next if nothing happened between the two.
    const prev = stack[stack.length - 1]
    if (prev && prev.after === last.before) prev.after = ed.version
    else stack.length = 0
    return `Undid your last edit of ${p} (${lineCount(ed)} lines now).`
  }

  const editFile = (i: Input): Promise<string> => {
    const [p, ed] = pick(i.path)
    const edits = typeof i.edits === 'string' ? JSON.parse(i.edits) : i.edits
    const patch = i.patch ? String(i.patch) : ''
    // Text that is neither blocks nor a diff would be taken for a whole file.
    if (patch && parseEdits(patch).format === 'whole') throw new Error('patch must hold SEARCH/REPLACE blocks or a unified diff. To replace the whole file, use write_file.')
    if (edits == null && !patch) throw new Error('Pass edits (or patch).')
    if (edits != null && !Array.isArray(edits)) throw new Error('edits must be an array of {old, new, all?}.')
    return edit(p, ed, !edits ? patch : patch ? [...edits, ...parseEdits(patch).ops] : edits)
  }

  // --- Claude's text editor tool -------------------------------------------

  const textEditor = async (i: Input): Promise<string> => {
    const cmd = i.command
    if (cmd === 'view') {
      const p = clean(String(i.path ?? ''))
      const inside = names.filter((n) => !p || n.startsWith(p + '/'))
      if (!files[p] && inside.length) return `Files:\n${inside.map((n) => `${n} (${files[n]!.language.name}, ${lineCount(files[n]!)} lines)`).join('\n')}`
      const range = i.view_range
      if (range != null && (!Array.isArray(range) || range.length !== 2)) throw new Error('view_range must be [start_line, end_line].')
      const [name, ed] = pick(i.path)
      return read(name, ed, range?.[0], range?.[1])
    }
    if (options.readOnly) throw new Error('The files are read-only: only view is available.')
    if (cmd === 'str_replace') {
      const [p, ed] = pick(i.path)
      const old = String(i.old_str ?? '')
      if (!old) throw new Error('old_str is empty.')
      const text = ed.doc.lines.join('\n')
      const find = old.replace(/\r\n?/g, '\n')
      const found: number[] = []
      for (let k = text.indexOf(find); k >= 0; k = text.indexOf(find, k + find.length)) found.push(k)
      const n = found.length
      if (n > 1) throw new Error(`No replacement was performed: old_str appears ${n} times in ${p} (lines ${found.slice(0, 5).map((k) => text.slice(0, k).split('\n').length).join(', ')}${n > 5 ? ', …' : ''}). Include more lines around it to make it unique.`)
      // No exact match: a whitespace / indentation tolerant match may still be unique and safe.
      return edit(p, ed, { old, new: String(i.new_str ?? '') }, { fuzzy: !n }, n ? '' : '\n(old_str had no exact match: the text that matches it ignoring whitespace, or nearly, was replaced. Check the lines below.)')
    }
    if (cmd === 'insert') return edit(...pick(i.path), { type: 'insert', line: int(i.insert_line, 'insert_line'), text: String(i.insert_text ?? i.new_str ?? '') })
    if (cmd === 'create') {
      let file: [string, Editor]
      try {
        file = pick(i.path)
      } catch {
        throw new Error(`Can't create new files here; the files are: ${list}. Use create only to rewrite one of them.`)
      }
      return edit(...file, { type: 'write', text: String(i.file_text ?? '') })
    }
    if (cmd === 'undo_edit') return undo(pick(i.path))
    throw new Error(`Unknown command "${String(cmd)}". Use view, str_replace, insert or create.`)
  }

  // --- definitions ---------------------------------------------------------

  const allFiles = multi ? ' Without path, all files.' : ''
  const def = (name: string, description: string, properties: Record<string, object> = {}, required: string[] = []): ToolDefinition => ({
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { path: multi ? { type: 'string', enum: names, description: 'File path.' } : str(`File path (optional: "${names[0]}").`), ...properties },
      required: multi && name !== 'search_file' && name !== 'get_problems' ? ['path', ...required] : required,
    },
  })
  const all: ToolDefinition[] = [
    def('read_file', `Read a file with line numbers (1-based, "line<TAB>code"). Returns up to ${maxLines} lines per call: use start_line / end_line for other parts. Big files start with an outline of their definitions.`, {
      start_line: num('First line to read (1-based).'),
      end_line: num('Last line to read (inclusive; -1 = end of file).'),
    }),
    def('search_file', `Find text or a regular expression in a file, line by line. Returns up to 50 matching lines as "line: text".${allFiles}`, {
      query: str('Text to find.'),
      regex: bool('query is a JavaScript regular expression.'),
      case_sensitive: bool('Match case (default false).'),
    }, ['query']),
    def('edit_file', 'Edit a file by replacing exact text. Each "old" must match the file exactly (whitespace included) and only once unless "all" is true: include enough surrounding lines to make it unique. Instead of edits you can pass "patch" with SEARCH/REPLACE blocks or a unified diff. Edits apply together or not at all. Returns the edited lines and the problems found after the edit.', {
      edits: {
        type: 'array',
        items: { type: 'object', properties: { old: str('Exact text to replace.'), new: str('Replacement text.'), all: bool('Replace every occurrence.') }, required: ['old', 'new'] },
      },
      patch: str('SEARCH/REPLACE blocks or a unified diff (instead of edits).'),
    }),
    def('insert_lines', 'Insert text after a line (1-based; 0 = at the top of the file).', { line: num('Line after which to insert (0 = top).'), text: str('Text to insert.') }, ['line', 'text']),
    def('write_file', 'Replace the whole content of a file. Prefer edit_file for small changes.', { content: str('The new content.') }, ['content']),
    def('get_selection', "Get the user's cursor position(s) and selected text (1-based lines and columns)."),
    def('get_problems', `List the current errors and warnings of a file (1-based lines).${allFiles}`),
    def('undo_last_edit', 'Undo your last edit of a file. Refused if the file changed since (e.g. the user typed).'),
  ]
  const definitions = options.readOnly ? all.filter((d) => READ.includes(d.name)) : all

  const handlers: Record<string, (i: Input) => string | Promise<string>> = {
    read_file: (i) => read(...pick(i.path), i.start_line, i.end_line),
    search_file: search,
    get_selection: (i) => selection(pick(i.path)),
    get_problems: problems,
    [TEXT_EDITOR]: textEditor,
  }
  if (!options.readOnly) {
    Object.assign(handlers, {
      edit_file: editFile,
      insert_lines: (i: Input) => edit(...pick(i.path), { type: 'insert', line: int(i.line, 'line'), text: String(i.text ?? '') }),
      write_file: (i: Input) => edit(...pick(i.path), { type: 'write', text: String(i.content ?? '') }),
      undo_last_edit: (i: Input) => undo(pick(i.path)),
    })
  }

  return {
    definitions,
    anthropic: ({ textEditor = false } = {}) => [
      ...(textEditor ? [{ type: 'text_editor_20250728', name: TEXT_EDITOR }] : []),
      ...definitions.filter((d) => !textEditor || EXTRA.includes(d.name)).map((d) => ({ name: d.name, description: d.description, input_schema: d.inputSchema })),
    ],
    openai: () => definitions.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.inputSchema } })),
    async run(name, input) {
      try {
        if (!Object.hasOwn(handlers, name)) throw new Error(`Unknown tool "${name}". Tools: ${definitions.map((d) => d.name).join(', ')}.`)
        const args = typeof input === 'string' ? JSON.parse(input || '{}') : input
        return { content: await handlers[name]!(args && typeof args === 'object' ? args : {}) }
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true }
      }
    },
  }
}

/** Handles Claude's built-in text editor tool (`str_replace_based_edit_tool`) alone. */
export function textEditorTool(editors: Editor | Record<string, Editor>, options?: EditorToolsOptions): (input: unknown) => Promise<ToolResult> {
  const tools = editorTools(editors, options)
  return (input) => tools.run(TEXT_EDITOR, input)
}

/** Top-level definitions and headings: lines that aren't indented and look like the start of something. */
const OUTLINE = /^(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|func|struct|impl|trait|module|namespace)\b|#{1,6} |[^\s})\]].*\{\s*$)|^\s*<(?:head|body|main|header|footer|nav|section|article|form|template|script|style)\b/

/** Evenly sampled outline lines of a file, within `budget` chars. */
function outline(ed: Editor, budget: number): string {
  const lines = ed.doc.lines
  const hits: number[] = []
  for (let i = 0; i < lines.length; i++) if (OUTLINE.test(lines[i]!)) hits.push(i)
  if (!hits.length) return ''
  const step = Math.ceil(hits.length / 150)
  let out = `Outline (${hits.length} definitions${step > 1 ? `, every ${step}th shown` : ''}):\n`
  for (let k = 0; k < hits.length; k += step) {
    const r = row(hits[k]!, lines[hits[k]!]!.trim(), 120)
    if (out.length + r.length > budget) break
    out += r
  }
  return out
}

interface ModelContextLike {
  registerTool(tool: object, options?: { signal?: AbortSignal }): unknown
  unregisterTool?(name: string): unknown
}

/**
 * Registers the tools with the browser's WebMCP API, so agents in the browser
 * can use the editor. Returns a function that unregisters them; does nothing
 * (and returns a no-op) where WebMCP isn't available.
 *
 * Checked 2026-09-26 against the WebMCP draft (https://webmachinelearning.github.io/webmcp/,
 * https://github.com/webmachinelearning/webmcp): `document.modelContext.registerTool(
 * { name, description, inputSchema, execute, annotations }, { signal })`, unregistered by
 * aborting the signal; `execute(input)` may return any value. The older shape,
 * `navigator.modelContext` + `unregisterTool(name)` (Chrome 146–149, deprecated in
 * Chromium 150), is used as a fallback.
 */
export function exposeTools(tools: EditorTools, options: { prefix?: string } = {}): () => void {
  const g = globalThis as { document?: { modelContext?: ModelContextLike }; navigator?: { modelContext?: ModelContextLike } }
  const mc = g.document?.modelContext ?? g.navigator?.modelContext
  if (typeof mc?.registerTool !== 'function') return () => {}
  const ctrl = new AbortController()
  const names = tools.definitions.map((d) => {
    const name = (options.prefix ?? '') + d.name
    try {
      Promise.resolve(mc.registerTool({
        name,
        description: d.description,
        inputSchema: d.inputSchema,
        annotations: { readOnlyHint: READ.includes(d.name) },
        async execute(input: unknown) {
          const r = await tools.run(d.name, input)
          return { content: [{ type: 'text', text: r.content }], isError: !!r.isError }
        },
      }, { signal: ctrl.signal })).catch(() => {})
    } catch {
      // A name already taken, or an older API that throws: skip that tool.
    }
    return name
  })
  return () => {
    ctrl.abort()
    for (const n of names) {
      try {
        mc.unregisterTool?.(n)
      } catch {
        // Already gone.
      }
    }
  }
}
