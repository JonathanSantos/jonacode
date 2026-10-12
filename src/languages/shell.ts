import { defineLanguage, type LanguageSpec, type RuleEntry, type TokenType } from '../language/language.ts'

/*
 * Token choices: commands → `function`, builtins (`echo`, `cd`…) → `type.builtin`,
 * reserved words → `keyword`, `-x` / `--flag` → `attribute`, `$VAR` / `${VAR}` →
 * `variable`, `NAME=` → `variable`, `$(` / backtick → `punctuation.special`,
 * control operators and redirections → `operator`.
 *
 * States: "command" states (root, sub, backtick, caseCmd) are where the next word
 * is a command name; after it `args` is pushed, and `args` pops on `;`, `|`,
 * `&&`, `||`, `&` and at the end of the line (unless it ends with `\`).
 */

const words = (s: string) => new Set(s.split(' '))
// Other reserved words (`if`, `for`…) have their own rules in command position.
const KEYWORDS = words('in esac function return break continue')
const BUILTINS = words(
  'echo printf read cd pwd source . export local declare readonly unset set shift exit eval exec trap wait alias ' +
  'test true false let getopts type command builtin pushd popd kill mapfile readarray shopt :',
)

const commandType = (w: string): TokenType => (KEYWORDS.has(w) ? 'keyword' : BUILTINS.has(w) ? 'type.builtin' : 'function')

/** The word ends here (followed by a separator or the end of the line). */
const END = '(?![^\\s;&|()<>])'
/** At the start of a word. */
const START = '(?<![^\\s;&|()<>])'
/** A redirection operator: `>`, `>>`, `<`, `>&2`, `<&-`, `>|`. */
const REDIR = '[<>](?:&(?:\\d+-?|-)?|[>|])?'
const re = (source: string) => new RegExp(source)
/** A plain word (up to a quote, an expansion or a separator). */
const WORD = /[^\s'"`$\\;&|()<>]+/
/** `;;`, `;&` and `;;&` end a `case` branch. */
const CASE_END = /;;&?|;&/

/** Rules of a command position; `args` is the state pushed after the command name. */
const command = (args: string): RuleEntry[] => [
  [/\s+/],
  [/#.*/, 'comment'],
  [/(function)(\s+)([^\s(){}]+)/, ['keyword', null, 'function']],
  [re('(?:for|select)' + END), 'keyword', '@forHead'],
  [re('case' + END), 'keyword', '@caseHead'],
  [re('(?:if|then|elif|else|fi|while|until|do|done|time|coproc)' + END), 'keyword'],
  [re('[{}]' + END), 'punctuation.bracket'],
  [re('!' + END), 'operator'],
  [re('\\[\\[' + END), 'punctuation.bracket', '@test'],
  [re('\\[' + END), 'punctuation.bracket', '@' + args],
  [/([A-Za-z_]\w*)((?:\[[^\]]*\])?\+?=)/, ['variable', 'operator'], '@assign'],
  // `name() {`
  [/([\w.:@+-]+)(\s*)(\(\s*\))/, ['function', null, 'punctuation.bracket']],
  ['((', 'punctuation.bracket', '@arith'],
  ['(', 'punctuation.bracket', '@sub'],
  [CASE_END, 'punctuation'],
  [';', 'punctuation'],
  [/&&|\|[|&]?|&/, 'operator'],
  // A `\` at the end of the line: the next line is still in command position.
  [/\\$/, 'string.escape'],
  [WORD, commandType, '@' + args],
  // Anything else (a string, `$cmd`, a redirection…) starts the arguments.
  [/(?=\S)/, null, '@' + args],
]

/** Heredoc bodies: after the rest of the opening line (pipes, redirections), every line is a string. */
const heredocStates = (vars: boolean): LanguageSpec['states'] => ({
  rest: [[/$/, null, '@next:body'], [/\s+/], [/\d*[<>]+&?\d*-?|\|\|?|&&?|;/, 'operator'], [/[^\s<>|&;]+/]],
  body: vars ? [[/\$\{[^}]*\}|\$(?:\w+|[@*#?$!0-9])/, 'variable'], [/[^$]+|\$/, 'string']] : [[/.+/, 'string']],
})
// Unquoted delimiters (`<<EOF`) expand `$VAR`; quoted ones (`<<'EOF'`) don't.
const heredoc = /* @__PURE__ */ defineLanguage({ name: 'heredoc', start: 'rest', states: heredocStates(true) })
const heredocRaw = /* @__PURE__ */ defineLanguage({ name: 'heredoc', start: 'rest', states: heredocStates(false) })

export const shellSpec: LanguageSpec = {
  name: 'shell',
  aliases: ['bash', 'sh', 'zsh'],
  extensions: ['.sh', '.bash', '.zsh'],
  comments: { line: '#' },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  closePairs: [['{', '}'], ['[', ']'], ['(', ')'], ['"', '"'], ["'", "'"], ['`', '`']],
  indent: {
    increase: /(?:[{[(]|\b(?:then|do|else|in))\s*$/,
    decrease: /^\s*(?:[}\])]|(?:fi|done|esac|else|elif)\b)/,
  },
  // Reserved words, builtins and a few common commands, for `autocomplete()`.
  completions: /* @__PURE__ */ [
    KEYWORDS, BUILTINS,
    'if then else elif fi for while until do done case select ls cat grep sed awk find xargs sort head tail mkdir rm cp mv chmod curl git tar ssh sudo'.split(' '),
  ].flatMap((s) => [...s].filter((w) => w > '@')), // not `.` and `:`
  states: {
    root: command('args'),
    heredocEnd: [[/^\s*[\w-]+\s*$/, 'string', '@pop']],
    // `$( … )`, `<( … )` and `( … )`.
    sub: [[')', 'punctuation.bracket', '@pop'], ...command('args')],
    backtick: [['`', 'punctuation.special', '@pop'], ...command('btArgs')],
    args: [
      [/\s+/],
      [re(START + '#.*'), 'comment'],
      { match: CASE_END, token: 'punctuation', pop: 2 },
      [/&&|\|[|&]?/, 'operator', '@pop'],
      [';', 'punctuation', '@pop'],
      { match: ')', token: 'punctuation.bracket', pop: 2 },
      [/([<>])(\()/, ['operator', 'punctuation.bracket'], '@sub'],
      ['<<<', 'operator'],
      // Heredoc: the body, up to the line holding only the delimiter, is a string.
      {
        match: /(<<-?)(\s*)((['"]?)([\w-]+)\4)/,
        token: ['operator', null, 'string'],
        push: 'heredocEnd',
        embed: {
          language: (m) => (m[4] ? heredocRaw : heredoc),
          end: (m) => new RegExp(`^${m[1] === '<<-' ? '\\t*' : ''}${m[5]}\\s*$`),
        },
      },
      [re(`(?:\\d+|&)${REDIR}|${REDIR}`), 'operator'],
      ['&', 'operator', '@pop'],
      [/([A-Za-z_]\w*)(\+?=)/, ['variable', 'operator'], '@assign'],
      [re(START + '--?[\\w-]*'), 'attribute'],
      [re(START + '\\d+(?:\\.\\d+)?' + END), 'number'],
      [re('\\]\\]?' + END), 'punctuation.bracket'],
      [re(START + '(?:[!=]=?|=~)' + END), 'operator'],
      { include: 'word' },
      [WORD],
      // The end of the line ends the command, unless it ends with `\`.
      [/(?<!\\)$/, null, '@pop'],
    ],
    // Arguments inside backticks: a backtick closes the substitution.
    btArgs: [{ match: '`', token: 'punctuation.special', pop: 2 }, { include: 'args' }],
    // `[[ … ]]`: `&&` / `||` / `( )` don't end the command.
    test: [
      [re('\\]\\]' + END), 'punctuation.bracket', '@pop'],
      [/&&|\|\|/, 'operator'],
      [/[()]/, 'punctuation.bracket'],
      { include: 'args' },
    ],
    forHead: [
      [re('([A-Za-z_]\\w*)(\\s+)(in)' + END), ['variable', null, 'keyword']],
      ['((', 'punctuation.bracket', '@arith'],
      { include: 'args' },
    ],
    caseHead: [[re('in' + END), 'keyword', '@next:casePatterns'], { include: 'args' }],
    casePatterns: [
      [/\s+/],
      [/#.*/, 'comment'],
      [re('esac' + END), 'keyword', '@pop'],
      [')', 'punctuation.bracket', '@caseCmd'],
      ['(', 'punctuation.bracket'],
      ['|', 'operator'],
      { include: 'word' },
      [/[^\s'"`$\\|()]+/, 'string'],
    ],
    caseCmd: [
      [CASE_END, 'punctuation', '@pop'],
      { match: re('esac' + END), token: 'keyword', pop: 2 },
      ...command('args'),
    ],
    // The value of `NAME=value`.
    assign: [
      ['(', 'punctuation.bracket', '@array'],
      { include: 'word' },
      [WORD],
      [/(?=[\s;&|)<>])|$/, null, '@pop'],
    ],
    array: [
      [')', 'punctuation.bracket', '@pop'],
      [/\s+/],
      [re(START + '#.*'), 'comment'],
      { include: 'word' },
      [/[^\s'"`$\\()]+/],
    ],
    // Parts of a word: quotes, escapes and expansions.
    word: [
      { include: 'expansion' },
      [/\$'/, 'string', '@ansiString'],
      [/"|\$"/, 'string', '@doubleString'],
      ["'", 'string', '@singleString'],
      [/\\[^]?/, 'string.escape'],
    ],
    // Expansions, also active inside double quotes.
    expansion: [
      [/(\$)(\(\()/, ['punctuation.special', 'punctuation.bracket'], '@arith'],
      [/(\$)(\()/, ['punctuation.special', 'punctuation.bracket'], '@sub'],
      [/\$\{[#!]?(?:[A-Za-z_]\w*|\d+|[@*#?$!-])?/, 'variable', '@param'],
      [/\$(?:[A-Za-z_]\w*|[\d@*#?$!-])/, 'variable'],
      ['`', 'punctuation.special', '@backtick'],
    ],
    // `${VAR:-default}`, `${#arr[@]}`, `${x//a/b}`
    param: [
      ['}', 'variable', '@pop'],
      [/[-:=?+#%/^,]+/, 'operator'],
      [/[[\]]/, 'punctuation.bracket'],
      { include: 'word' },
      [/[^}'"`$\\:#%/^,?=+[\]-]+/],
    ],
    arith: [
      ['))', 'punctuation.bracket', '@pop'],
      ['(', 'punctuation.bracket', '@arithParen'],
      [/\s+/],
      [/0[xX][\da-fA-F]+|\d+(?:#\w+)?/, 'number'],
      [/[A-Za-z_]\w*/, 'variable'],
      { include: 'expansion' },
      [/[-+*/%<>=!&|^~?:,]+/, 'operator'],
    ],
    arithParen: [[')', 'punctuation.bracket', '@pop'], { include: 'arith' }],
    singleString: [
      [/[^']+/, 'string'],
      ["'", 'string', '@pop'],
    ],
    // Double quotes span lines and expand `$var`, `${…}`, `$( … )` and backticks.
    doubleString: [
      [/[^"\\$`]+/, 'string'],
      ['"', 'string', '@pop'],
      [/\\(?:[$`"\\]|$)/, 'string.escape'],
      { include: 'expansion' },
      [/[\\$]/, 'string'],
    ],
    // `$'…'` (ANSI-C quoting): backslash escapes.
    ansiString: [
      [/[^'\\]+/, 'string'],
      [/\\(?:x[\da-fA-F]{1,2}|[0-7]{1,3}|[^])?/, 'string.escape'],
      ["'", 'string', '@pop'],
    ],
  },
}

/** Shell scripts (bash / sh / zsh). */
export const shell = /* @__PURE__ */ defineLanguage(shellSpec)
