import assert from 'node:assert/strict'
import { test } from 'node:test'
import { log } from '../src/languages/log.ts'
import { expectTokens, tokenizeLines } from '../src/testing.ts'
import { typeOf } from './helpers.ts'

const t = (src: string, text: string) => typeOf(log, src, text)
/** Tokens with a type. */
const typed = (src: string) => tokenizeLines(log, src).map((line) => line.filter((tok) => tok.type !== null).map((tok) => [tok.text, tok.type]))

test('levels: case-insensitive whole words, bracketed, short forms', () => {
  expectTokens(log, `
    ERROR Error error [ERROR] <err> FATAL: panic crit severe
    ^^^^^ deleted log-error
          ^^^^^ deleted log-error
                ^^^^^ deleted log-error
                       ^^^^^ deleted log-error
                               ^^^ deleted log-error
                                    ^^^^^ deleted log-error
                                           ^^^^^ deleted log-error
                                                 ^^^^ deleted log-error
                                                      ^^^^^^ deleted log-error
    WARN Warning [WRN] INFO [INF] notice DEBUG trace VERBOSE fine [DBG]
    ^^^^ constant log-warn
         ^^^^^^^ constant log-warn
                  ^^^ constant log-warn
                       ^^^^ function log-info
                             ^^^ function log-info
                                  ^^^^^^ function log-info
                                         ^^^^^ comment log-debug
                                               ^^^^^ comment log-debug
                                                     ^^^^^^^ comment log-debug
                                                             ^^^^ comment log-debug
                                                                   ^^^ comment log-debug
  `, { strict: true })
  // logrus / log15 / .NET short forms, Laravel's `channel.LEVEL`.
  expectTokens(log, `
    ERRO[0000] dbug: fail: [2024-01-02 03:04:05] production.ERROR: boom
    ^^^^ deleted log-error
               ^^^^ comment log-debug
                     ^^^^ deleted log-error
                                                 ^^^^^^^^^^^^^^^^ deleted log-error
  `)
  // Whole words only.
  assert.deepEqual(typed('ERRORS error_code terror errored infos debugger'), [[]])
})

test('levels: in logfmt and JSON lines', () => {
  expectTokens(log, `
    level=warn msg="slow query" {"level":"error","msg":"boom"}
    ^^^^^ property
          ^^^^ constant log-warn
               ^^^ property
                   ^^^^^^^^^^^^ string
                                 ^^^^^^^ property
                                         ^^^^^^^ deleted log-error
                                                 ^^^^^ property
                                                       ^^^^^^ string
  `, { strict: true })
})

test('dates and times', () => {
  expectTokens(log, `
    2024-01-02T03:04:05Z 2024-01-02T03:04:05.123456+02:00 2024-01-02 03:04:05,123 2024/01/02 03:04:05
    ^^^^^^^^^^^^^^^^^^^^ comment log-time
                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ comment log-time
                                                          ^^^^^^^^^^^^^^^^^^^^^^^ comment log-time
                                                                                  ^^^^^^^^^^^^^^^^^^^ comment log-time
    Jan  2 03:04:05 host [10/Oct/2000:13:55:36 -0700] 01-02 03:04:05.678 at 12:30 or 03:04:05.1
    ^^^^^^^^^^^^^^^ comment log-time
                          ^^^^^^^^^^^^^^^^^^^^^^^^^^ comment log-time
                                                      ^^^^^^^^^^^^^^^^^^ comment log-time
                                                                            ^^^^^ comment log-time
                                                                                     ^^^^^^^^^^ comment log-time
  `, { strict: true })
  // A date alone, a date with a zone after the time.
  assert.equal(t('on 2024-01-02 we', '2024-01-02'), 'comment log-time')
  assert.equal(t('at 2024-01-02 03:04:05 +0000 GMT', '2024-01-02 03:04:05 +0000'), 'comment log-time')
})

test('numbers, durations, sizes, IPs', () => {
  expectTokens(log, `
    12ms 1.5s 2h3m4.5s 500µs 1.5GiB 512KB 3k 50% 0x1f 1e-3 1.2.3 -42 3rd 5xx v2
    ^^^^ number
         ^^^^ number
              ^^^^^^^^ number
                       ^^^^^ number
                             ^^^^^^ number
                                    ^^^^^ number
                                          ^^ number
                                             ^^^ number
                                                 ^^^^ number
                                                      ^^^^ number
                                                           ^^^^^ number
                                                                  ^^ number
    10.0.0.1:8080 ::1 fe80::1ff:fe23:4567:890a 2001:db8::1 ::ffff:192.0.2.1 std::io Foo::bar
    ^^^^^^^^ number
             ^^^^ number
                  ^^^ number
                      ^^^^^^^^^^^^^^^^^^^^^^^^ number
                                               ^^^^^^^^^^^ number
                                                           ^^^^^^^^^^^^^^^^ number
  `, { strict: true })
})

test('ids: UUIDs, hex ids and git SHAs', () => {
  expectTokens(log, `
    id=550e8400-e29b-41d4-a716-446655440000 A1B2C3D4-E5F6-7890-ABCD-EF1234567890 7d4f2e1 deadbeef1234 decade
    ^^ property
       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ constant
                                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ constant
                                                                                 ^^^^^^^ constant
                                                                                         ^^^^^^^^^^^^ constant
  `, { strict: true })
})

test('links: URLs, paths, file:line:col', () => {
  // String.raw: backslashes are literal, so markers line up in the source.
  expectTokens(log, String.raw`
    https://example.com/a?b=1&c=2, (http://x.io/y). /var/log/app.log. ./src/a.ts:3:4 ~/x ../lib/y.js
    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ link
                                    ^^^^^^^^^^^^^ link
                                                    ^^^^^^^^^^^^^^^^ link
                                                                      ^^^^^^^^^^^^^^ link
                                                                                     ^^^ link
                                                                                         ^^^^^^^^^^^ link
    src/b.ts:5 App.java:42 main.go:12:3 C:\src\Program.cs:line 12 and/or 1/2 HTTP/1.1 foo.bar
    ^^^^^^^^^^ link
               ^^^^^^^^^^^ link
                           ^^^^^^^^^^^^ link
                                        ^^^^^^^^^^^^^^^^^^^^^^^^^ link
                                                                         ^ number
                                                                           ^ number
  `, { strict: true })
})

test('strings', () => {
  expectTokens(log, String.raw`
    msg="disk \"full\"" 'quoted' it's can't 'a b' "key" : 1 "unterminated
    ^^^ property
        ^^^^^^^^^^^^^^^ string
                        ^^^^^^^^ string
                                            ^^^^^ string
                                                  ^^^^^ property
                                                          ^ number
  `, { strict: true })
})

test('access logs (Apache / nginx combined format)', () => {
  expectTokens(log, `
    127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326 "http://example.com/" "Mozilla/4.08"
    ^^^^^^^^^ number
                       ^^^^^^^^^^^^^^^^^^^^^^^^^^ comment log-time
                                                   ^ string
                                                    ^^^ keyword
                                                        ^^^^^^^^^^^^^^ link
                                                                       ^^^^^^^^^ string
                                                                                 ^^^ number
                                                                                     ^^^^ number
                                                                                          ^^^^^^^^^^^^^^^^^^^^^ string
                                                                                                                ^^^^^^^^^^^^^^ string
    GET /api/users 200 5.123 ms POST
    ^^^ keyword
        ^^^^^^^^^^ link
                   ^^^ number
                       ^^^^^ number
                                ^^^^ keyword
  `, { strict: true })
  // Methods are upper case only.
  assert.deepEqual(typed('Get get'), [[]])
})

test('exceptions and stack traces', () => {
  expectTokens(log, `
    Exception in thread "main" java.lang.NullPointerException: boom
    ^^^^^^^^^ type
                        ^^^^^^ string
                               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ type
    \tat com.example.App.run(App.java:12)
    \t^^^^^^^^^^^^^^^^^^^^^^^ comment
    \t                       ^^^^^^^^^^^ link
    \t                                  ^ comment
    \t... 5 more
    \t^^^^^^^^^^ comment
    Caused by: java.io.IOException: disk full
               ^^^^^^^^^^^^^^^^^^^ type
    TypeError: Cannot read properties of undefined (reading 'x')
    ^^^^^^^^^ type
                                                            ^^^ string
        at Object.<anonymous> (/app/index.js:10:5)
        ^^^^^^^^^^^^^^^^^^^^^^^ comment
                               ^^^^^^^^^^^^^^^^^^ link
                                                 ^ comment
        at node:internal/main/run_main_module:23:47
        ^^ comment
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ link
    Traceback (most recent call last):
      File "app.py", line 10, in <module>
      ^^^^ comment
           ^^^^^^^^^^^^^^^^^ link
                            ^^^^^^^^^^^^^ comment
        raise ValueError("bad")
              ^^^^^^^^^^ type
                         ^^^^^ string
    panic: runtime error: index out of range
    ^^^^^ deleted log-error
                   ^^^^^ deleted log-error
    \t/tmp/sandbox/prog.go:8 +0x1d
    \t^^^^^^^^^^^^^^^^^^^^^^ link
    \t                        ^^^^ number
  `, { strict: true })
  expectTokens(log, String.raw`
    Unhandled exception. System.InvalidOperationException: boom
                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ type
       at MyApp.Program.Main(String[] args) in C:\src\Program.cs:line 12
       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ comment
                                               ^^^^^^^^^^^^^^^^^^^^^^^^^ link
  `, { strict: true })
  // The frame state ends with the line.
  assert.deepEqual(typed('    at f (a.js:1:2)\nnext 1')[1], [['1', 'number']])
})

test('ANSI color codes are dimmed', () => {
  assert.deepEqual(typed('\x1b[31mERROR\x1b[0m done'), [[['\x1b[31m', 'comment'], ['ERROR', 'deleted log-error'], ['\x1b[0m', 'comment']]])
})

test('plain text stays plain (non-ASCII too)', () => {
  assert.deepEqual(typed('The quick brown fox: Conexão recusada, a == b y==z'), [[]])
  assert.deepEqual(tokenizeLines(log, 'Conexão recusada'), [[{ text: 'Conexão recusada', type: null }]])
})

test('language metadata', () => {
  assert.equal(log.name, 'log')
  assert.ok(log.aliases.includes('logs') && log.aliases.includes('logfile'))
  assert.deepEqual(log.extensions, ['.log'])
})

test('tokenizes 50k log lines quickly', () => {
  const templates = [
    (i: number) => `2024-01-02T03:04:${String(i % 60).padStart(2, '0')}.123Z INFO  [http-nio-8080-exec-${i % 10}] c.e.web.UserController - GET /api/users/${i} completed in ${i % 500}ms status=200`,
    (i: number) => `2024-01-02 03:04:05,${i % 1000} [WARN] com.example.db.Pool: connection pool almost exhausted (active=${i % 50}, idle=0) after 1.5s`,
    (i: number) => `192.168.${i % 255}.${i % 200} - - [10/Oct/2024:13:55:36 +0000] "GET /static/app.${i}.js?v=3 HTTP/1.1" 200 ${i * 13} "https://example.com/page" "Mozilla/5.0 (X11; Linux x86_64)"`,
    (i: number) => `Jan  2 03:04:05 web-${i % 3} sshd[${i}]: Failed password for invalid user admin from 10.0.${i % 255}.1 port ${40000 + (i % 1000)} ssh2`,
    (i: number) => `{"level":"error","ts":"2024-01-02T03:04:05Z","msg":"request failed","trace_id":"550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}","duration":${i / 7}}`,
    (i: number) => `time=2024-01-02T03:04:05Z level=debug msg="cache miss for key user:${i}" component=cache hit_ratio=0.93 size=12MB`,
    () => `    at processTicksAndRejections (node:internal/process/task_queues:95:5)`,
    (i: number) => `\tat com.example.service.OrderService.place(OrderService.java:${i % 400})`,
    (i: number) => `ERROR Unhandled exception while processing message ${i}: java.lang.IllegalStateException: Order ${i} is already closed`,
    () => `The quick brown fox jumps over the lazy dog, and then some more ordinary words appear in this message.`,
  ]
  const lines = Array.from({ length: 50_000 }, (_, i) => templates[i % templates.length]!(i))
  const start = performance.now()
  let state = log.initialState
  let tokens = 0
  for (const line of lines) {
    const res = log.tokenize(line, state)
    state = res.state
    tokens += res.tokens.length
  }
  const ms = performance.now() - start
  assert.ok(tokens > 50_000 * 8, `${tokens} tokens`)
  assert.equal(state, log.initialState)
  assert.ok(ms < 2000, `took ${ms}ms`)
})
