// Everything in one file for `<script src>` usage: exposes the `Jonacode` global.
export * from '../src/index.ts'
export { javascript, javascriptSpec } from '../src/languages/javascript.ts'
export { oneLight } from '../src/themes/one-light.ts'
export { defineJonacodeElement } from '../src/adapters/element.ts'
