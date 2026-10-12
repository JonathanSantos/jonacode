import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sql } from '../src/languages/sql.ts'
import { tokenize, typeOf } from './helpers.ts'

const t = (src: string, text: string) => typeOf(sql, src, text)
/** Tokens with a type (plain identifiers merge with the surrounding spaces). */
const typed = (src: string) => tokenize(sql, src).map((line) => line.filter(([, type]) => type !== null))

test('keywords are case-insensitive', () => {
  assert.deepEqual(typed('SELECT id, name FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE x IS NOT NULL;')[0], [
    ['SELECT', 'keyword'], [',', 'punctuation'], ['FROM', 'keyword'], ['LEFT', 'keyword'], ['JOIN', 'keyword'],
    ['ON', 'keyword'], ['.', 'punctuation'], ['=', 'operator'], ['.', 'punctuation'], ['WHERE', 'keyword'],
    ['IS', 'keyword'], ['NOT', 'keyword'], ['NULL', 'constant.language'], [';', 'punctuation'],
  ])
  assert.equal(t('SELECT id FROM users', ' users'), null)
  assert.equal(t('select 1', 'select'), 'keyword')
  assert.equal(t('group by a order by b desc limit 10 offset 5', 'offset'), 'keyword')
  assert.equal(t('WHERE ok = true', 'true'), 'constant.language')
})

test('types', () => {
  const src = 'CREATE TABLE IF NOT EXISTS users (\n  id BIGSERIAL PRIMARY KEY,\n  name VARCHAR(255) NOT NULL DEFAULT \'\',\n  at timestamp with time zone\n);'
  const lines = typed(src)
  assert.deepEqual(lines[1], [['BIGSERIAL', 'type'], ['PRIMARY', 'keyword'], ['KEY', 'keyword'], [',', 'punctuation']])
  assert.deepEqual(lines[2]!.slice(0, 2), [['VARCHAR', 'type'], ['(', 'punctuation.bracket']])
  assert.deepEqual(lines[3], [['timestamp', 'type'], ['with', 'keyword'], ['time', 'type'], ['zone', 'type']])
})

test('functions vs tables', () => {
  assert.equal(t('SELECT count(*) FROM t', 'count'), 'function')
  assert.equal(t('SELECT COALESCE(a, 0)', 'COALESCE'), 'function')
  assert.equal(t('SELECT left(name, 3)', 'left'), 'function')
  assert.equal(t('SELECT pg_catalog.now()', 'now'), 'function')
  assert.equal(t('INSERT INTO users(id) VALUES (1)', ' users'), null)
  assert.equal(t('user_id INT REFERENCES users(id)', ' users'), null)
  assert.equal(t('CREATE INDEX idx ON users(email)', ' users'), null)
  assert.equal(t('SELECT * FROM generate_series(1, 3)', 'generate_series'), 'function')
  assert.equal(t('WITH RECURSIVE t(n) AS (SELECT 1)', ' t'), null)
  assert.equal(t('CREATE FUNCTION add(a int)', 'add'), 'function')
  assert.equal(t('ALTER TABLE t ADD COLUMN c int', 'ADD'), 'keyword')
  // Keywords after a dot are plain names.
  assert.deepEqual(typed('SELECT t.date, t.order FROM t')[0], [
    ['SELECT', 'keyword'], ['.', 'punctuation'], [',', 'punctuation'], ['.', 'punctuation'], ['FROM', 'keyword'],
  ])
})

test('strings', () => {
  assert.deepEqual(tokenize(sql, "SELECT 'it''s'")[0], [['SELECT', 'keyword'], ["'it", 'string'], ["''", 'string.escape'], ["s'", 'string']])
  // Strings can span lines.
  const lines = tokenize(sql, "SELECT 'a\n-- not a comment\nb' AS x")
  assert.deepEqual(lines[1], [['-- not a comment', 'string']])
  assert.deepEqual(lines[2], [["b'", 'string'], ['AS', 'keyword'], [' x', null]])
  // Backslashes are plain in standard strings, escapes in E'…'.
  assert.deepEqual(tokenize(sql, "'C:\\' E'a\\nb'")[0], [["'C:\\'", 'string'], ["E'a", 'string'], ['\\n', 'string.escape'], ["b'", 'string']])
})

test('quoted identifiers', () => {
  assert.equal(t('SELECT "Full Name" FROM t', '"Full Name"'), 'variable')
  assert.equal(t('SELECT `order` FROM t', '`order`'), 'variable')
  assert.equal(t('SELECT "a""b"', '"a""b"'), 'variable')
})

test('dollar-quoted strings', () => {
  const lines = tokenize(sql, "CREATE FUNCTION f() RETURNS int AS $$\n  SELECT 'x' -- inside\n$$ LANGUAGE sql;")
  assert.deepEqual(lines[0]!.at(-1), ['$$', 'string'])
  assert.deepEqual(lines[1], [["  SELECT 'x' -- inside", 'string']])
  assert.deepEqual(lines[2]!.slice(0, 2), [['$$', 'string'], ['LANGUAGE', 'keyword']])
  assert.deepEqual(tokenize(sql, 'DO $body$ BEGIN END $body$;')[0], [['DO', 'keyword'], ['$body$ BEGIN END $body$', 'string'], [';', 'punctuation']])
})

test('comments vs minus', () => {
  assert.deepEqual(typed('SELECT a - -1 -- note')[0], [
    ['SELECT', 'keyword'], ['-', 'operator'], ['-', 'operator'], ['1', 'number'], ['-- note', 'comment'],
  ])
  assert.deepEqual(typed('SELECT a--b')[0], [['SELECT', 'keyword'], ['--b', 'comment']])
  const lines = tokenize(sql, '/* multi\n line */ SELECT 1 /* x */')
  assert.deepEqual(lines[0], [['/* multi', 'comment']])
  assert.deepEqual(lines[1], [[' line */', 'comment'], ['SELECT', 'keyword'], ['1', 'number'], ['/* x */', 'comment']])
})

test('parameters, casts and operators', () => {
  assert.equal(t('WHERE id = $1', '$1'), 'variable.parameter')
  assert.equal(t('WHERE id = :id', ':id'), 'variable.parameter')
  assert.equal(t('SET @total = @@max', '@total'), 'variable.parameter')
  assert.equal(t('WHERE id = ?', '?'), 'variable.parameter')
  assert.deepEqual(typed("SELECT '1'::int, data->>'k', a <> b, x || y")[0], [
    ['SELECT', 'keyword'], ["'1'", 'string'], ['::', 'operator'], ['int', 'type'], [',', 'punctuation'],
    ['->>', 'operator'], ["'k'", 'string'], [',', 'punctuation'], ['<>', 'operator'], [',', 'punctuation'], ['||', 'operator'],
  ])
  assert.equal(t('SELECT 1.5e3, 0xFF', '0xFF'), 'number')
})
