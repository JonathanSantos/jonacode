// Every built-in language for `<script src>` usage. Load it after `jonacode.iife.min.js`:
// it reuses that bundle's core (through the `Jonacode` global) and adds the languages to it.
export { javascript, jsx } from '../src/languages/javascript.ts'
export { typescript, tsx } from '../src/languages/typescript.ts'
export { json } from '../src/languages/json.ts'
export { css } from '../src/languages/css.ts'
export { html, createHtml } from '../src/languages/html.ts'
export { markdown, createMarkdown } from '../src/languages/markdown.ts'
export { sql } from '../src/languages/sql.ts'
export { shell } from '../src/languages/shell.ts'
export { log } from '../src/languages/log.ts'
