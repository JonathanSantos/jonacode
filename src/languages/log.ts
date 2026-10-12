import { defineLanguage, type LanguageSpec, type TokenContext, type TokenType } from '../language/language.ts'

/*
 * Token choices (composite types: themes color the first part, and the second
 * one lets users target levels specifically, e.g. `.jc-t-log-error`):
 * - levels → `deleted log-error`, `constant log-warn`, `function log-info`, `comment log-debug`
 * - dates and times → `comment log-time` (dim: they are on every line)
 * - strings → `string`, `"key":` and `key=` → `property`
 * - numbers, durations, sizes, IPs → `number`; UUIDs and hex ids → `constant`
 * - URLs, paths with `:line:col` (`file.js:1:2`) → `link`; HTTP methods → `keyword`
 * - exception classes (`TypeError`, `java.io.IOException`) → `type`
 * - stack frames (`at …`, `File "…", line 3`) → `comment`, with the location as `link`
 *
 * Logs are the huge files: every rule starts with a concrete char (see
 * first-chars.ts) and plain words are taken whole by one rule.
 */

const levels = (groups: Record<string, string>) => {
  const map = new Map<string, string>()
  for (const [type, list] of Object.entries(groups)) for (const w of list.split(' ')) map.set(w, type)
  return map
}
// Lower-case lookups; the short forms are Serilog's, logrus', log15's and .NET's.
const LEVELS = /* @__PURE__ */ levels({
  'deleted log-error': 'error err erro eror fail fatal fata ftl critical crit panic pani severe alert emerg',
  'constant log-warn': 'warn warning wrn',
  'function log-info': 'info inf notice',
  'comment log-debug': 'debug debu dbug dbg trace trac trce verbose vrb fine finer finest',
})
/** HTTP methods, exception classes, hex ids (git SHAs…): one test for the common case (none). */
const SPECIAL = /^(?:(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT)|(?:[A-Z][\w$]*)?(Exception|Error)|[\da-fA-F]{7,})$/

/** Words, dotted names (`java.lang.Foo`), `a/b`, URLs and `file.ext:12:3`. */
function word(w: string, { line, to }: TokenContext): TokenType {
  if (line[to] === '=' && line[to + 1] !== '=') return 'property'
  if (w.includes(':')) return 'link'
  // `production.ERROR`, `java.io.IOException`: the last part decides.
  const dot = w.lastIndexOf('.')
  const last = dot < 0 ? w : w.slice(dot + 1)
  const level = last.length < 10 && LEVELS.get(last.toLowerCase())
  if (level) return level
  const m = SPECIAL.exec(last)
  return !m ? null : m[1] ? 'keyword' : m[2] ? 'type' : /\d/.test(last) ? 'constant' : null
}

/** `"key":` (JSON logs), `"error"` (a level), or a string. */
function string(s: string, { line, to }: TokenContext): TokenType {
  while (line[to] === ' ') to++
  return line[to] === ':' ? 'property' : (LEVELS.get(s.slice(1, -1).toLowerCase()) ?? 'string')
}

const re = (s: string) => new RegExp(s)
const X = '[\\da-fA-F]'
/** A time, with optional fraction and zone: `03:04:05`, `03:04:05.123Z`, `03:04:05 +0200`. */
const TIME = '\\d\\d?:\\d\\d(?::\\d\\d)?(?:[.,]\\d+)?(?:Z|\\s?[+-]\\d\\d:?\\d\\d)?'

export const logSpec: LanguageSpec = {
  name: 'log',
  aliases: ['logs', 'logfile'],
  extensions: ['.log'],
  states: {
    root: [
      // Blanks inside the line are the most common token: one rule.
      [/(?<!^)\s+/],
      // Stack frames: `    at foo (file.js:1:2)`, `\tat a.B.c(B.java:3)`, `  File "x.py", line 3, in f`.
      [/^\s+at (?=\S)/, 'comment', '@frame'],
      [/^(\s+File )("[^"]*"(?:, line \d+)?)(.*)/, ['comment', 'link', 'comment']],
      [/^\s+\.\.\. \d+ .*/, 'comment'],
      [/\s+/],
      // ISO 8601 / `2024/01/02 03:04:05`, Apache `02/Jan/2024:03:04:05 +0000`, syslog `Jan  2 03:04:05`,
      // Android `01-02 03:04:05.678`, times.
      [
        re(
          `\\d{4}[-/]\\d\\d[-/]\\d\\d(?:[T ]${TIME})?|\\d\\d\\/(?:\\d\\d|[A-Z][a-z]{2})\\/\\d{4}(?:[: ]${TIME})?` +
            `|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\\d\\d? ${TIME}|\\d\\d-\\d\\d ${TIME}|${TIME}`,
        ),
        'comment log-time',
      ],
      // UUIDs, IPv6 (`::1`, `fe80::1`).
      [re(`${X}{8}(?:-${X}{4}){3}-${X}{12}\\b|(?:${X}{1,4}:|:)[\\da-fA-F:.]*:[\\da-fA-F.]*(?![\\w:])`), (s) => (s.includes(':') ? 'number' : 'constant')],
      // Numbers, versions, IPv4, durations (`12ms`, `1h2m3s`), sizes (`1.5GiB`), percents.
      [/0x[\da-fA-F]+|\d+(?:\.\d+)*(?:[eE][+-]?\d+)?(?:(?:[nuµμm]?s|[mhd])(?:\d+(?:\.\d+)?(?:[nuµμm]?s|[mh]))*|[kKmMgGtTpP]i?[bB]|[kKMGTP]|[bB]|%)?(?![\w$])/, 'number'],
      // Words; URLs and Windows paths (`C:\x\y.cs:line 3`) start like words: one rule for all.
      [/[A-Za-z_$][\w$]*(?::\/\/[^\s"'<>]*[^\s"'<>.,;:)\]}]|:\\[^\s"'<>|?*:]*(?::(?:line )?\d+)?|(?:[/-][\w$]+)*(?:\.[\w$]+(?:[./-][\w$]+)*(?::\d+(?::\d+)?)?)?)/, word],
      // Git SHAs starting with a digit, `3rd`…
      [/\d[\w$]*/, word],
      // HTTP request line of access logs: `"GET /x HTTP/1.1"`.
      [/(")([A-Z]+) ([^\s"]+)( HTTP\/[\d.]+")/, ['string', 'keyword', 'link', 'string']],
      [/"[^"\\]*(?:\\.[^"\\]*)*"/, string],
      [/(?<!\w)'[^']*'(?!\w)/, 'string'],
      // Paths: `/var/log/x.log`, `./src/a.ts:3:4`, `/api/users?id=3` (not `a/b`, `1/2`).
      [/(?<![\w)\]])(?:\.\.?\/|~\/|\/)[\w~%@+.-]*[\w~%@+-](?:\/[\w~%@+.-]*[\w~%@+-])*\/?(?::\d+(?::\d+)?|\?[^\s"'<>]*)?/, 'link'],
      // ANSI colors (`\x1b[31m`): dim noise.
      [/\x1b\[[\d;]*[A-Za-z]/, 'comment'],
      // Anything else (punctuation, non-ASCII letters) in runs.
      [/[^\w\s"'/.~:]+/],
    ],
    frame: [
      [/[^\s()]+:(?:line )?\d+(?::\d+)?/, 'link'],
      [/[^\s()]+|[\s()]+/, 'comment'],
      [/$/, null, '@pop'],
    ],
  },
}

/** Log files: app logs, access logs, syslog, logfmt / JSON lines, stack traces. */
export const log = /* @__PURE__ */ defineLanguage(logSpec)
