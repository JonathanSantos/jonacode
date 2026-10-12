import { defineLanguage, type LanguageSpec, type TokenContext, type TokenType } from '../language/language.ts'

const set = (s: string) => new Set(s.split(' '))

// A generic ANSI set plus the most common PostgreSQL / MySQL / SQLite words.
// Words that are very common column names (`type`, `level`, `action`…) are left out.
const KEYWORDS = set(
  'select from where and or not as on join inner left right full outer cross natural lateral using group by order ' +
  'having limit offset fetch first next rows row only union all intersect except distinct insert into values ' +
  'update set delete returning create alter drop truncate table index view materialized sequence schema database ' +
  'function procedure trigger domain extension if exists replace temporary temp unique primary key foreign ' +
  'references constraint check default collate add column rename to cascade restrict with recursive case when ' +
  'then else end is in like ilike between asc desc nulls begin commit rollback transaction grant revoke over ' +
  'partition window filter within conflict do nothing returns language declare return execute explain analyze ' +
  'vacuum show use auto_increment autoincrement unsigned engine any some escape for lock of no generated always ' +
  'identity merge matched each before after array current_date current_time current_timestamp current_user',
)
const TYPES = set(
  'int integer smallint bigint tinyint serial bigserial real float double precision numeric decimal money char ' +
  'character varchar varying nchar nvarchar text longtext blob bytea binary varbinary bit boolean bool date time ' +
  'timestamp timestamptz interval datetime zone uuid json jsonb xml enum inet tsvector int4 int8 float8',
)
/** After these words a `name(` is a table / index target, not a call. */
const NOT_CALL = set('into table references exists on with recursive view')
/** Keywords that are also common functions: `left(name, 3)`. */
const CALLABLE = set('left right replace if')

function prevWord(line: string, from: number): string {
  let i = from
  while (i > 0 && (line[i - 1] === ' ' || line[i - 1] === '\t')) i--
  let j = i
  while (j > 0 && /\w/.test(line[j - 1]!)) j--
  return line.slice(j, i).toLowerCase()
}

function identifier(word: string, { line, from, to }: TokenContext): TokenType {
  const call = line[to] === '('
  // Qualified names: `t.date`, `schema.fn(`.
  if (line[from - 1] === '.') return call ? 'function' : null
  const w = word.toLowerCase()
  if (w === 'true' || w === 'false' || w === 'null') return 'constant.language'
  if (TYPES.has(w)) return 'type'
  const prev = call ? prevWord(line, from) : ''
  // `left(name, 3)`, `CREATE FUNCTION add(…)`
  if (call && (CALLABLE.has(w) || prev === 'function' || prev === 'procedure')) return 'function'
  if (KEYWORDS.has(w)) return 'keyword'
  return call && !NOT_CALL.has(prev) ? 'function' : null
}

/** SQL: a generic dialect covering the common ANSI, PostgreSQL, MySQL and SQLite syntax. */
export const sqlSpec: LanguageSpec = {
  name: 'sql',
  aliases: ['mysql', 'postgresql', 'postgres', 'sqlite'],
  extensions: ['.sql'],
  comments: { line: '--', block: ['/*', '*/'] },
  brackets: [['(', ')'], ['[', ']']],
  closePairs: [['(', ')'], ['[', ']'], ["'", "'"], ['"', '"'], ['`', '`']],
  indent: { increase: /[([]\s*(?:--.*)?$/, decrease: /^\s*[)\]]/ },
  // Keywords, types and common functions for `autocomplete()`, upper case: an
  // all upper case list follows the case the user types (`sel` → `select`).
  completions: /* @__PURE__ */ [
    KEYWORDS, TYPES,
    'true false null count sum avg min max coalesce nullif cast concat substring lower upper trim length round abs now extract row_number rank lag lead string_agg'.split(' '),
  ].flatMap((s) => [...s].map((w) => w.toUpperCase())),
  states: {
    root: [
      [/\s+/],
      [/--.*/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      // `E'…'`: PostgreSQL string with backslash escapes.
      [/[eE]'/, 'string', '@escapeString'],
      [/[A-Za-z_][\w$]*/, identifier],
      [/0[xX][\da-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/, 'number'],
      ["'", 'string', '@string'],
      // Quoted identifiers: `"col"` (ANSI) and `` `col` `` (MySQL).
      [/"(?:[^"]|"")*"?/, 'variable'],
      [/`(?:[^`]|``)*`?/, 'variable'],
      // PostgreSQL dollar-quoted strings: `$$ … $$`, `$body$ … $body$`.
      [/\$(?:[A-Za-z_]\w*)?\$/, 'string', '@dollarString'],
      // Parameters: `$1`, `:name`, `@var` / `@@global`, `?`.
      [/\$\d+|:[A-Za-z_]\w*|@@?[A-Za-z_][\w$]*|\?/, 'variable.parameter'],
      ['::', 'operator'],
      [/(?:[<>=!|&^~%+*:@#]|\/(?!\*)|-(?!-))+/, 'operator'],
      [/[()[\]]/, 'punctuation.bracket'],
      [/[,;.]/, 'punctuation'],
    ],
    comment: [
      [/[^*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      ['*', 'comment'],
    ],
    // Strings may span lines; a doubled quote is an escaped quote.
    string: [
      [/[^']+/, 'string'],
      ["''", 'string.escape'],
      ["'", 'string', '@pop'],
    ],
    escapeString: [
      [/[^'\\]+/, 'string'],
      [/''|\\./, 'string.escape'],
      ["'", 'string', '@pop'],
      ['\\', 'string'],
    ],
    // Ends on any dollar tag (the exact tag is not tracked).
    dollarString: [
      [/[^$]+/, 'string'],
      [/\$(?:[A-Za-z_]\w*)?\$/, 'string', '@pop'],
      ['$', 'string'],
    ],
  },
}

/** SQL (generic: ANSI + PostgreSQL / MySQL / SQLite). */
export const sql = /* @__PURE__ */ defineLanguage(sqlSpec)
