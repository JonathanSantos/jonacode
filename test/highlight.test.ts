import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlight, highlightStyles, STATIC_CSS } from '../src/highlight.ts'
import { plainText } from '../src/language/language.ts'
import { html } from '../src/languages/html.ts'
import { javascript } from '../src/languages/javascript.ts'
import { spliceArray } from '../src/state/text.ts'
import { oneDark } from '../src/themes/one-dark.ts'

test('highlight renders token spans without a DOM', () => {
  const out = highlight('const a = "<b>" // &', javascript)
  assert.match(out, /^<pre class="jc-static" data-language="javascript"><code><span class="jc-l">/)
  assert.match(out, /<span class="jc-t-keyword">const<\/span>/)
  // Text is escaped.
  assert.match(out, /<span class="jc-t-string">&quot;&lt;b&gt;&quot;<\/span>/)
  assert.match(out, /<span class="jc-t-comment">\/\/ &amp;<\/span>/)
  assert.ok(out.endsWith('</span></code></pre>'))
})

test('one span per line, state carried across lines', () => {
  const out = highlight('/* a\nb */ x\n', javascript)
  const lines = out.slice(out.indexOf('<code>') + 6, out.lastIndexOf('</code>')).split('\n')
  assert.equal(lines.length, 3)
  assert.match(lines[1]!, /<span class="jc-t-comment">b \*\/<\/span>/)
  assert.equal(lines[2], '<span class="jc-l"></span>')
  // CRLF input
  assert.equal(highlight('a\r\nb', plainText).split('\n').length, 2)
})

test('options: theme class, line numbers, first line, tab size', () => {
  const out = highlight(Array.from({ length: 120 }, (_, i) => `x${i}`).join('\n'), plainText, { theme: oneDark, lineNumbers: true, firstLine: 5, tabSize: 2 })
  assert.match(out, new RegExp(`^<pre class="jc-static ${oneDark.className} jc-static-ln"`))
  assert.match(out, /style="--jc-tab-size:2;--jc-ln-chars:3;counter-reset:jc-line 4;"/)
  assert.ok(highlightStyles(oneDark).startsWith(STATIC_CSS) && highlightStyles(oneDark).includes(oneDark.css))
})

test('embedded languages work statically too', () => {
  const out = highlight('<script>let x = 1</script>', html)
  assert.match(out, /<span class="jc-t-keyword">let<\/span>/)
  assert.match(out, /<span class="jc-t-tag">script<\/span>/)
})

test('spliceArray appends in place', () => {
  const arr = ['a', 'b']
  const big = Array.from({ length: 6000 }, (_, i) => String(i))
  const out = spliceArray(arr, 1, 1, big)
  assert.equal(out, arr)
  assert.equal(out.length, 6001)
  assert.equal(out[6000], '5999')
})
