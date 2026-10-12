import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shell } from '../src/languages/shell.ts'
import { tokenize, typeOf } from './helpers.ts'

const t = (src: string, text: string) => typeOf(shell, src, text)
const typed = (src: string) => tokenize(shell, src).map((line) => line.filter(([, type]) => type !== null))

test('commands, builtins and flags', () => {
  assert.deepEqual(tokenize(shell, 'git commit -m msg --amend')[0], [
    ['git', 'function'], [' commit ', null], ['-m', 'attribute'], [' msg ', null], ['--amend', 'attribute'],
  ])
  assert.equal(t('echo hi', 'echo'), 'type.builtin')
  assert.equal(t('./configure --prefix=/usr', './configure'), 'function')
  assert.equal(t('./configure --prefix=/usr', '--prefix'), 'attribute')
  // Words after the command are not commands.
  assert.equal(t('echo ls', ' ls'), null)
  assert.equal(t('echo a-b', ' a-b'), null)
})

test('command position after operators and keywords', () => {
  assert.deepEqual(typed('cat file | grep -v x && make; ls & wc || (cd /tmp; pwd)')[0], [
    ['cat', 'function'], ['|', 'operator'], ['grep', 'function'], ['-v', 'attribute'], ['&&', 'operator'],
    ['make', 'function'], [';', 'punctuation'], ['ls', 'function'], ['&', 'operator'], ['wc', 'function'],
    ['||', 'operator'], ['(', 'punctuation.bracket'], ['cd', 'type.builtin'], [';', 'punctuation'],
    ['pwd', 'type.builtin'], [')', 'punctuation.bracket'],
  ])
  // Each line starts in command position; `\` continues the command.
  const lines = typed('echo a \\\n  b\nls')
  assert.deepEqual(lines[1], [])
  assert.deepEqual(lines[2], [['ls', 'function']])
  const cont = typed('make &&\n  make install && \\\n  echo done')
  assert.deepEqual(cont[1]![0], ['make', 'function'])
  assert.deepEqual(cont[2]![0], ['echo', 'type.builtin'])
})

test('keywords and control flow', () => {
  const lines = typed('if [ -f "$f" ]; then\n  echo yes\nelif ! grep -q x f; then exit 1\nfi')
  assert.deepEqual(lines[0], [
    ['if', 'keyword'], ['[', 'punctuation.bracket'], ['-f', 'attribute'], ['"', 'string'], ['$f', 'variable'],
    ['"', 'string'], [']', 'punctuation.bracket'], [';', 'punctuation'], ['then', 'keyword'],
  ])
  assert.deepEqual(lines[2]!.slice(0, 3), [['elif', 'keyword'], ['!', 'operator'], ['grep', 'function']])
  assert.deepEqual(lines[2]!.slice(-3), [['then', 'keyword'], ['exit', 'type.builtin'], ['1', 'number']])
  assert.deepEqual(lines[3], [['fi', 'keyword']])
  const loop = typed('for f in *.txt; do wc -l "$f"; done\nwhile read -r line; do :; done < input')
  assert.deepEqual(loop[0]!.slice(0, 5), [['for', 'keyword'], ['f', 'variable'], ['in', 'keyword'], [';', 'punctuation'], ['do', 'keyword']])
  assert.deepEqual(loop[1]!.slice(-5), [['do', 'keyword'], [':', 'type.builtin'], [';', 'punctuation'], ['done', 'keyword'], ['<', 'operator']])
})

test('[[ ]] tests keep && inside', () => {
  assert.deepEqual(typed('[[ -n $a && $b == x ]] && echo ok')[0], [
    ['[[', 'punctuation.bracket'], ['-n', 'attribute'], ['$a', 'variable'], ['&&', 'operator'], ['$b', 'variable'],
    ['==', 'operator'], [']]', 'punctuation.bracket'], ['&&', 'operator'], ['echo', 'type.builtin'],
  ])
})

test('comments: # only at the start of a word', () => {
  assert.deepEqual(tokenize(shell, '#!/usr/bin/env bash')[0], [['#!/usr/bin/env bash', 'comment']])
  assert.deepEqual(tokenize(shell, 'echo a#b # real')[0], [['echo', 'type.builtin'], [' a#b ', null], ['# real', 'comment']])
  assert.equal(t('echo $# ${#arr[@]}', '$#'), 'variable')
  assert.equal(t('echo "#no"', '"#no"'), 'string')
  assert.equal(t('  # indented', '# indented'), 'comment')
})

test('variables and parameter expansion', () => {
  assert.deepEqual(typed('echo $HOME $1 $@ ${VAR:-default}')[0], [
    ['echo', 'type.builtin'], ['$HOME', 'variable'], ['$1', 'variable'], ['$@', 'variable'], ['${VAR', 'variable'],
    [':-', 'operator'], ['}', 'variable'],
  ])
  assert.deepEqual(typed('FOO=bar BAZ="q" cmd arg')[0], [
    ['FOO', 'variable'], ['=', 'operator'], ['BAZ', 'variable'], ['=', 'operator'], ['"q"', 'string'], ['cmd', 'function'],
  ])
  assert.deepEqual(typed('export PATH="$HOME/bin:$PATH"')[0], [
    ['export', 'type.builtin'], ['PATH', 'variable'], ['=', 'operator'], ['"', 'string'], ['$HOME', 'variable'],
    ['/bin:', 'string'], ['$PATH', 'variable'], ['"', 'string'],
  ])
  assert.deepEqual(typed('arr=(a "b c" $d)')[0], [
    ['arr', 'variable'], ['=', 'operator'], ['(', 'punctuation.bracket'], ['"b c"', 'string'], ['$d', 'variable'], [')', 'punctuation.bracket'],
  ])
})

test('strings span lines', () => {
  const lines = tokenize(shell, "echo 'single\n$not' \"double \\\" $x\nstill\" after")
  assert.deepEqual(lines[1]!.slice(0, 2), [["$not'", 'string'], ['"double ', 'string']])
  assert.deepEqual(lines[1]!.slice(2), [['\\"', 'string.escape'], [' ', 'string'], ['$x', 'variable']])
  assert.deepEqual(lines[2], [['still"', 'string'], [' after', null]])
  assert.deepEqual(typed("printf $'a\\tb\\x41'")[0], [
    ['printf', 'type.builtin'], ["$'a", 'string'], ['\\t', 'string.escape'], ['b', 'string'], ['\\x41', 'string.escape'], ["'", 'string'],
  ])
  // `\n` is not an escape inside double quotes.
  assert.equal(t('echo "a\\nb"', '"a\\nb"'), 'string')
})

test('command substitution and arithmetic', () => {
  assert.deepEqual(typed('x=$(ls -a | wc -l) y')[0], [
    ['x', 'variable'], ['=', 'operator'], ['$', 'punctuation.special'], ['(', 'punctuation.bracket'], ['ls', 'function'],
    ['-a', 'attribute'], ['|', 'operator'], ['wc', 'function'], ['-l', 'attribute'], [')', 'punctuation.bracket'], ['y', 'function'],
  ])
  assert.deepEqual(typed('echo "n: $(date +%s)"')[0]!.slice(1), [
    ['"n: ', 'string'], ['$', 'punctuation.special'], ['(', 'punctuation.bracket'], ['date', 'function'],
    [')', 'punctuation.bracket'], ['"', 'string'],
  ])
  assert.deepEqual(typed('echo `uname -s` done')[0], [
    ['echo', 'type.builtin'], ['`', 'punctuation.special'], ['uname', 'function'], ['-s', 'attribute'], ['`', 'punctuation.special'],
  ])
  assert.deepEqual(typed('echo $(( (a + 1) * $b ))')[0], [
    ['echo', 'type.builtin'], ['$', 'punctuation.special'], ['((', 'punctuation.bracket'], ['(', 'punctuation.bracket'],
    ['a', 'variable'], ['+', 'operator'], ['1', 'number'], [')', 'punctuation.bracket'], ['*', 'operator'], ['$b', 'variable'],
    ['))', 'punctuation.bracket'],
  ])
  // Multi-line substitution: command position inside.
  const lines = typed('out=$(\n  git log |\n  head\n)')
  assert.deepEqual(lines[1], [['git', 'function'], ['|', 'operator']])
  assert.deepEqual(lines[2], [['head', 'function']])
  assert.deepEqual(lines[3], [[')', 'punctuation.bracket']])
  assert.equal(t('diff <(sort a) b', 'sort'), 'function')
})

test('redirections and heredoc markers', () => {
  assert.deepEqual(typed('cmd 2>&1 >>log <in &>/dev/null')[0], [
    ['cmd', 'function'], ['2>&1', 'operator'], ['>>', 'operator'], ['<', 'operator'], ['&>', 'operator'],
  ])
  assert.deepEqual(typed("cat <<-'EOF'")[0], [['cat', 'function'], ['<<-', 'operator'], ["'EOF'", 'string']])
  assert.deepEqual(typed('cat <<EOF >out')[0], [['cat', 'function'], ['<<', 'operator'], ['EOF', 'string'], ['>', 'operator']])
  assert.deepEqual(typed('grep x <<< "$s"')[0]!.slice(1), [['<<<', 'operator'], ['"', 'string'], ['$s', 'variable'], ['"', 'string']])
})

test('functions and case', () => {
  assert.deepEqual(typed('greet() {\n  echo hi\n}')[0], [['greet', 'function'], ['()', 'punctuation.bracket'], ['{', 'punctuation.bracket']])
  assert.deepEqual(typed('function main {')[0], [['function', 'keyword'], ['main', 'function'], ['{', 'punctuation.bracket']])
  const lines = typed('case "$1" in\n  start|up) run --now ;;\n  *)\n    usage\n    ;;\nesac\nls')
  assert.deepEqual(lines[0], [['case', 'keyword'], ['"', 'string'], ['$1', 'variable'], ['"', 'string'], ['in', 'keyword']])
  assert.deepEqual(lines[1], [
    ['start', 'string'], ['|', 'operator'], ['up', 'string'], [')', 'punctuation.bracket'], ['run', 'function'],
    ['--now', 'attribute'], [';;', 'punctuation'],
  ])
  assert.deepEqual(lines[2], [['*', 'string'], [')', 'punctuation.bracket']])
  assert.deepEqual(lines[3], [['usage', 'function']])
  assert.deepEqual(lines[5], [['esac', 'keyword']])
  assert.deepEqual(lines[6], [['ls', 'function']])
  // Last branch without `;;`.
  assert.deepEqual(typed('case $x in a) b; esac; ls')[0]!.slice(-3), [['esac', 'keyword'], [';', 'punctuation'], ['ls', 'function']])
})

test('heredoc bodies up to the delimiter line', () => {
  const lines = tokenize(shell, 'cat <<EOF > out.txt\nhello $USER\n  EOF not yet\nEOF\necho done')
  assert.deepEqual(lines[0]!.slice(0, 3), [['cat', 'function'], ['<<', 'operator'], ['EOF', 'string']])
  assert.deepEqual(lines[1], [['hello ', 'string'], ['$USER', 'variable']])
  assert.deepEqual(lines[2], [['  EOF not yet', 'string']])
  assert.deepEqual(lines[3], [['EOF', 'string']])
  assert.deepEqual(lines[4]![0], ['echo', 'type.builtin'])
  // Quoted delimiter: no expansion; `<<-` allows tabs before the delimiter.
  const raw = tokenize(shell, "cat <<-'END'\n\t$HOME\n\tEND\nls")
  assert.deepEqual(raw[1], [['\t$HOME', 'string']])
  assert.deepEqual(raw[2], [['\tEND', 'string']])
  assert.deepEqual(raw[3], [['ls', 'function']])
})
