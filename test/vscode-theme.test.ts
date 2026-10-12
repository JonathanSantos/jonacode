import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defineTheme } from '../src/theme/theme.ts'
import { oneLight } from '../src/themes/one-light.ts'
import { fromVSCodeTheme, parseJSONC, type VSCodeTheme, type VSCodeTokenColor } from '../src/themes/vscode.ts'

/** A theme from token rules only, on a known background/foreground. */
const rules = (tokenColors: VSCodeTokenColor[], extra: VSCodeTheme = {}) =>
  fromVSCodeTheme({ type: 'dark', colors: { 'editor.background': '#000000', 'editor.foreground': '#cccccc' }, tokenColors, ...extra })

test('parseJSONC: comments, trailing commas, BOM', () => {
  const text = `\uFEFF{
    // a line comment
    "a": 1, /* a block
    comment */ "b": [1, 2, 3,],
    "c": { "d": true, }, // trailing
    "e": [
      "x", // comment between the comma and the bracket
    ],
  }`
  assert.deepEqual(parseJSONC(text), { a: 1, b: [1, 2, 3], c: { d: true }, e: ['x'] })
})

test('parseJSONC: comment and comma lookalikes inside strings are kept', () => {
  const text = `{"url": "https://example.com/a//b", "glob": "/* not a comment */", "q": "say \\"//hi\\", ok",
    "list": "a,]", "obj": "b,}", "slash": "\\\\"} // end`
  assert.deepEqual(parseJSONC(text), {
    url: 'https://example.com/a//b',
    glob: '/* not a comment */',
    q: 'say "//hi", ok',
    list: 'a,]',
    obj: 'b,}',
    slash: '\\',
  })
  assert.throws(() => parseJSONC('{"a": }'))
  assert.throws(() => parseJSONC('{"a": 1 /* unterminated'))
})

test('UI colors are mapped, missing ones fall back to the derived defaults', () => {
  const theme = fromVSCodeTheme({
    type: 'dark',
    colors: {
      'editor.background': '#1e1e1e',
      'editor.foreground': '#d4d4d4',
      'editorCursor.foreground': '#aeafad',
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#3a3d41',
      'editor.lineHighlightBackground': '#ffffff0a',
      'editorLineNumber.foreground': '#858585',
      'editorLineNumber.activeForeground': '#c6c6c6',
      'editorGutter.background': '#1e1e1e',
      'editorBracketMatch.background': '#0064001a',
      'editorBracketMatch.border': '#888',
      'scrollbarSlider.background': '#79797966',
      'scrollbarSlider.hoverBackground': '#646464b3',
      'editorGhostText.foreground': '#ffffff56',
      'activityBar.background': '#333333',
    },
  })
  assert.deepEqual(theme.colors, {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    caret: '#aeafad',
    selection: '#264f78',
    selectionInactive: '#3a3d41',
    activeLine: '#ffffff0a',
    gutterBackground: '#1e1e1e',
    gutterForeground: '#858585',
    gutterActiveForeground: '#c6c6c6',
    gutterBorder: 'transparent',
    matchingBracket: '#0064001a',
    matchingBracketBorder: '#888',
    placeholder: '#ffffff56',
    scrollbar: '#79797966',
    scrollbarHover: '#646464b3',
  })
  assert.match(theme.css, /--jc-bg:#1e1e1e;/)
  assert.match(theme.css, /--jc-active-line:#ffffff0a;/)

  // Fallbacks: line highlight border, placeholder of inputs, derived defaults.
  const sparse = fromVSCodeTheme({
    colors: { 'editor.background': '#fff', 'editor.lineHighlightBorder': '#eeeeee', 'input.placeholderForeground': '#767676', 'editorCursor.foreground': null },
  })
  assert.equal(sparse.colors.activeLine, '#eeeeee')
  assert.equal(sparse.colors.placeholder, '#767676')
  assert.equal(sparse.colors.caret, 'var(--jc-fg)')
  assert.equal(sparse.colors.gutterBackground, 'var(--jc-bg)')
  assert.match(sparse.colors.selection, /color-mix/)
})

test('dark or light: from the type, else the background, the foreground, the name', () => {
  const dark = (theme: VSCodeTheme) => fromVSCodeTheme(theme).dark
  assert.equal(dark({ type: 'dark', colors: { 'editor.background': '#ffffff' } }), true)
  assert.equal(dark({ type: 'light' }), false)
  assert.equal(dark({ type: 'hc-black' }), true)
  assert.equal(dark({ type: 'hc-light' }), false)
  assert.equal(dark({ type: 'vs-dark' }), true)
  assert.equal(dark({ type: 'vs' }), false)
  assert.equal(dark({ colors: { 'editor.background': '#1e1e1e' } }), true)
  assert.equal(dark({ colors: { 'editor.background': '#fdf6e3' } }), false)
  assert.equal(dark({ colors: { 'editor.background': '#002b36' } }), true)
  assert.equal(dark({ colors: { 'editor.background': '#F5F5F5' } }), false)
  assert.equal(dark({ colors: { 'editor.background': '#fff' } }), false)
  assert.equal(dark({ colors: { 'editor.background': '#000c' } }), true)
  assert.equal(dark({ colors: { 'editor.background': '#39000080' } }), true)
  assert.equal(dark({ colors: { 'editor.foreground': '#333333' } }), false)
  assert.equal(dark({ colors: { 'editor.foreground': '#eeeeee' } }), true)
  // The global rule of old themes gives the background too.
  assert.equal(dark({ settings: [{ settings: { background: '#FDF6E3', foreground: '#657B83' } }] }), false)
  // Nothing but the name.
  assert.equal(dark({ name: 'Moonlight' }), true)
  assert.equal(dark({}), true)
  const light = fromVSCodeTheme({ name: 'Light High Contrast', tokenColors: [{ scope: 'keyword', settings: { foreground: '#0f4a85' } }] })
  assert.equal(light.dark, false)
  // Our default background is dark: a light theme without one gets white.
  assert.equal(light.colors.background, '#ffffff')
  assert.equal(light.colors.foreground, '#000000')
  // …unless a base theme provides them.
  const based = fromVSCodeTheme({ name: 'Light High Contrast' }, { extends: oneLight })
  assert.equal(based.colors.background, oneLight.colors.background)
  assert.equal(fromVSCodeTheme({}, { extends: oneLight }).dark, false)
})

test('TextMate matching: dot-segment prefixes, the longest selector wins', () => {
  // `keyword.c` is not a prefix of `keyword.control` (segments, not characters).
  const theme = rules([
    { scope: 'keyword.control.flow', settings: { foreground: '#111111' } },
    { scope: 'keyword', settings: { foreground: '#222222' } },
    { scope: 'keyword.c', settings: { foreground: '#333333' } },
    { scope: 'keyword.other.DML', settings: { foreground: '#444444' } },
  ])
  // `keyword` resolves `keyword.other`: `keyword.other.DML` is longer than the scope, `keyword.c` not a prefix.
  assert.deepEqual(theme.tokens.keyword, { color: '#222222' })
  // `keyword.operator` falls back to `keyword`.
  assert.deepEqual(theme.tokens.operator, { color: '#222222' })
  // Character prefixes do not match: nothing styles keywords here.
  const none = rules([{ scope: 'keyword.c', settings: { foreground: '#333333' } }, { scope: 'keyword.contro', settings: { foreground: '#444444' } }])
  assert.equal(none.tokens.keyword, undefined)
  assert.equal(none.tokens.operator, undefined)

  const ordered = rules([
    { scope: 'string.quoted.double', settings: { foreground: '#aa0000' } },
    { scope: 'string', settings: { foreground: '#00aa00' } },
    { scope: 'string.quoted', settings: { foreground: '#0000aa' } },
  ])
  assert.deepEqual(ordered.tokens.string, { color: '#aa0000' }, 'order does not beat specificity')

  const tie = rules([
    { scope: 'string', settings: { foreground: '#aa0000', fontStyle: 'italic' } },
    { scope: ['comment', 'string'], settings: { foreground: '#00AA00' } },
  ])
  assert.deepEqual(tie.tokens.string, { color: '#00aa00', fontStyle: 'italic' }, 'the later rule wins a tie, per property')
})

test('TextMate matching: properties resolve independently, scope lists are split', () => {
  const theme = rules([
    { scope: 'keyword', settings: { foreground: '#c678dd' } },
    { scope: 'keyword.other', settings: { fontStyle: 'italic' } },
    { scope: ' storage.type ,  entity.name.function, ', settings: { foreground: '#61afef' } },
    { scope: ['support.type.property-name, meta.tag entity.name.tag'], settings: { foreground: '#e06c75' } },
  ])
  assert.deepEqual(theme.tokens.keyword, { color: '#c678dd', fontStyle: 'italic' })
  assert.deepEqual(theme.tokens.function, { color: '#61afef' })
  assert.deepEqual(theme.tokens.property, { color: '#e06c75' })
  assert.deepEqual(theme.tokens.tag, { color: '#e06c75' })
})

test('descendant selectors: matched against the scope stacks, never language-specific', () => {
  const theme = rules([
    { scope: 'entity', settings: { foreground: '#111111' } },
    { scope: 'meta.tag entity', settings: { foreground: '#222222' } },
    { scope: 'entity.name.section', settings: { foreground: '#333333' } },
    { scope: 'markup.heading', settings: { foreground: '#444444', fontStyle: 'bold' } },
    { scope: 'markup.heading entity.name', settings: { foreground: '#555555' } },
    { scope: 'source.css variable', settings: { foreground: '#666666' } },
    { scope: 'variable.other.readwrite.js', settings: { foreground: '#777777' } },
    { scope: 'string - string.regexp', settings: { foreground: '#888888' } },
    { scope: 'meta.tag > entity.other.attribute-name', settings: { foreground: '#999999' } },
  ])
  // Same length: the descendant selector beats the plain one when its ancestor is in the stack.
  assert.deepEqual(theme.tokens.tag, { color: '#222222' })
  assert.deepEqual(theme.tokens.attribute, { color: '#222222' })
  // A longer plain selector beats a shorter descendant one; the outer scope still gives `bold`.
  assert.deepEqual(theme.tokens.heading, { color: '#333333', fontWeight: 'bold' })
  // Language roots and suffixes never match, nor do exclusions.
  assert.equal(theme.tokens.variable, undefined)
  assert.equal(theme.tokens.string, undefined)

  const heading = rules([
    { scope: 'entity.name', settings: { foreground: '#ffa657' } },
    { scope: 'markup.heading, markup.heading entity.name', settings: { foreground: '#79c0ff', fontStyle: 'bold' } },
  ])
  assert.deepEqual(heading.tokens.heading, { color: '#79c0ff', fontWeight: 'bold' })
})

test('fontStyle: italic, bold, underline, strikethrough and resets', () => {
  const theme = rules([
    { scope: 'comment', settings: { foreground: '#7f848e', fontStyle: 'italic' } },
    { scope: 'storage.type.class.jsdoc', settings: { fontStyle: '' } },
    { scope: 'markup.bold', settings: { fontStyle: 'bold' } },
    { scope: 'markup.italic', settings: { fontStyle: 'italic underline' } },
    { scope: 'markup.underline.link', settings: { fontStyle: 'underline' } },
    { scope: 'markup.deleted', settings: { fontStyle: 'strikethrough', foreground: '#e06c75' } },
    { scope: 'invalid', settings: { fontStyle: 'bold italic underline strikethrough', foreground: '#FFFFFF', background: '#E05252' } },
    { scope: 'keyword', settings: { fontStyle: '', foreground: '#c678dd' } },
  ])
  assert.deepEqual(theme.tokens.comment, { color: '#7f848e', fontStyle: 'italic' })
  // `''` resets the italic the tag would inherit from `comment`.
  assert.deepEqual(theme.tokens['comment.tag'], { fontStyle: 'normal' })
  assert.deepEqual(theme.tokens.strong, { fontWeight: 'bold' })
  assert.deepEqual(theme.tokens.emphasis, { fontStyle: 'italic', textDecoration: 'underline' })
  assert.deepEqual(theme.tokens.link, { textDecoration: 'underline' })
  assert.deepEqual(theme.tokens.deleted, { color: '#e06c75', textDecoration: 'line-through' })
  assert.deepEqual(theme.tokens.invalid, {
    color: '#ffffff', background: '#E05252', fontStyle: 'italic', fontWeight: 'bold', textDecoration: 'underline line-through',
  })
  // A reset on a top-level type is the plain style: only the color remains.
  assert.deepEqual(theme.tokens.keyword, { color: '#c678dd' })
  assert.match(theme.css, /\.jc-t-deleted\{color:#e06c75;text-decoration:line-through;\}/)
})

test('only styles that differ from the parent or the plain text are emitted', () => {
  const theme = rules([
    { scope: 'variable', settings: { foreground: '#CCCCCC' } }, // = editor.foreground
    { scope: 'string', settings: { foreground: '#98c379' } },
    { scope: 'constant.character.escape', settings: { foreground: '#98c379' } }, // = string
    { scope: 'constant', settings: { foreground: '#d19a66' } },
    { scope: 'constant.language', settings: { foreground: '#56b6c2' } },
    { scope: 'punctuation', settings: { foreground: '#abb2bf' } },
    { scope: 'meta.brace', settings: { foreground: '#cccccc' } }, // back to plain, unlike `punctuation`
  ])
  assert.equal(theme.tokens.variable, undefined)
  assert.equal(theme.tokens['variable.language'], undefined)
  assert.deepEqual(theme.tokens.string, { color: '#98c379' })
  assert.equal(theme.tokens['string.escape'], undefined)
  // `variable.other.constant` resolves through `variable`: the plain color.
  assert.equal(theme.tokens.constant, undefined)
  assert.deepEqual(theme.tokens.number, { color: '#d19a66' })
  assert.deepEqual(theme.tokens['constant.language'], { color: '#56b6c2' })
  assert.deepEqual(theme.tokens.punctuation, { color: '#abb2bf' })
  assert.deepEqual(theme.tokens['punctuation.bracket'], { color: '#cccccc' })
  // Types the theme leaves alone are left out, so they cascade to their parent.
  assert.equal(theme.tokens.function, undefined)
  assert.equal(theme.tokens['type.builtin'], undefined)
  assert.deepEqual(Object.keys(rules([]).tokens), [])
})

test('options: name, token overrides, base theme', () => {
  const vscodeTheme: VSCodeTheme = {
    name: 'Night Sky',
    type: 'dark',
    colors: { 'editor.background': '#0b0e14', 'editor.foreground': '#bfbdb6' },
    tokenColors: [
      { scope: 'keyword', settings: { foreground: '#ff8f40' } },
      { scope: 'string', settings: { foreground: '#aad94c' } },
    ],
  }
  assert.equal(fromVSCodeTheme(vscodeTheme).name, 'Night Sky')
  assert.equal(fromVSCodeTheme({}).name, 'vscode')
  const theme = fromVSCodeTheme(vscodeTheme, {
    name: 'night',
    tokens: { keyword: { color: '#ff0000', fontWeight: 'bold' }, 'string.escape': '#95e6cb' },
  })
  assert.equal(theme.name, 'night')
  assert.match(theme.className, /^jc-theme-night/)
  assert.deepEqual(theme.tokens.keyword, { color: '#ff0000', fontWeight: 'bold' })
  assert.deepEqual(theme.tokens.string, { color: '#aad94c' })
  assert.deepEqual(theme.tokens['string.escape'], { color: '#95e6cb' })

  // A base theme fills in the colors and token types the VS Code theme leaves out.
  const base = defineTheme({ name: 'base', dark: true, colors: { caret: '#ff00ff' }, tokens: { comment: '#123456', string: '#654321' } })
  const extended = fromVSCodeTheme(vscodeTheme, { extends: base })
  assert.equal(extended.colors.caret, '#ff00ff')
  assert.equal(extended.colors.background, '#0b0e14')
  assert.deepEqual(extended.tokens.comment, { color: '#123456' })
  assert.deepEqual(extended.tokens.string, { color: '#aad94c' })
  // The input is left untouched.
  assert.deepEqual(vscodeTheme.colors, { 'editor.background': '#0b0e14', 'editor.foreground': '#bfbdb6' })
})

test('include: resolved through the option, included theme first', () => {
  const files: Record<string, string | VSCodeTheme> = {
    './base.json': `{
      // the base
      "name": "Base", "type": "light",
      "colors": { "editor.background": "#ffffff", "editor.foreground": "#000000", "editorCursor.foreground": "#ff0000", },
      "tokenColors": [
        { "scope": "keyword", "settings": { "foreground": "#0000ff" } },
        { "scope": "string", "settings": { "foreground": "#a31515" } },
      ],
    }`,
    './middle.json': {
      include: './base.json',
      tokenColors: [{ scope: 'entity.name.function', settings: { foreground: '#795e26' } }],
    },
  }
  const top: VSCodeTheme = {
    name: 'Top',
    include: './middle.json',
    colors: { 'editor.background': '#fafafa' },
    tokenColors: [{ scope: 'keyword', settings: { foreground: '#af00db' } }],
  }
  const requested: string[] = []
  const theme = fromVSCodeTheme(top, { include: (path) => (requested.push(path), files[path]) })
  assert.deepEqual(requested, ['./middle.json', './base.json'])
  assert.equal(theme.name, 'Top')
  assert.equal(theme.dark, false)
  assert.equal(theme.colors.background, '#fafafa')
  assert.equal(theme.colors.foreground, '#000000')
  assert.equal(theme.colors.caret, '#ff0000')
  assert.deepEqual(theme.tokens.keyword, { color: '#af00db' })
  assert.deepEqual(theme.tokens.string, { color: '#a31515' })
  assert.deepEqual(theme.tokens.function, { color: '#795e26' })

  // Without a resolver (or when it finds nothing), `include` is ignored.
  assert.equal(fromVSCodeTheme(top).tokens.string, undefined)
  assert.equal(fromVSCodeTheme(top, { include: () => undefined }).colors.background, '#fafafa')
  // A cycle stops.
  const loop: VSCodeTheme = { include: './loop.json', tokenColors: [{ scope: 'string', settings: { foreground: '#00ff00' } }] }
  assert.deepEqual(fromVSCodeTheme(loop, { include: () => loop }).tokens.string, { color: '#00ff00' })
})

test('old .tmTheme-style settings: the global rule gives the editor colors', () => {
  const theme = fromVSCodeTheme({
    name: 'Legacy',
    settings: [
      { settings: { background: '#272822', foreground: '#F8F8F2', caret: '#F8F8F0', selection: '#49483E', lineHighlight: '#3E3D32' } },
      { scope: 'comment', settings: { foreground: '#75715E' } },
      { scope: 'keyword', settings: { foreground: '#F92672' } },
      { scope: 'storage.type', settings: { foreground: '#66D9EF', fontStyle: 'italic' } },
    ],
  })
  assert.equal(theme.dark, true)
  assert.equal(theme.colors.background, '#272822')
  assert.equal(theme.colors.foreground, '#F8F8F2')
  assert.equal(theme.colors.caret, '#F8F8F0')
  assert.equal(theme.colors.selection, '#49483E')
  assert.equal(theme.colors.activeLine, '#3E3D32')
  assert.deepEqual(theme.tokens.comment, { color: '#75715e' })
  assert.deepEqual(theme.tokens.keyword, { color: '#f92672' })
  // `colors` wins over the global rule.
  const both = fromVSCodeTheme({ colors: { 'editor.background': '#000000' }, tokenColors: [{ settings: { background: '#ffffff', foreground: '#111111' } }] })
  assert.equal(both.colors.background, '#000000')
  assert.equal(both.colors.foreground, '#111111')
})

/** A trimmed theme in the spirit of One Dark Pro, written for this test (JSONC, as shipped by extensions). */
const ONE_DARKISH = `{
  "$schema": "vscode://schemas/color-theme",
  "name": "One Darkish",
  "type": "dark",
  "semanticHighlighting": true,
  "colors": {
    "editor.background": "#282c34",
    "editor.foreground": "#abb2bf",
    "editorCursor.foreground": "#528bff",
    "editor.selectionBackground": "#67769660",
    "editor.inactiveSelectionBackground": "#3a3f4b",
    "editor.lineHighlightBackground": "#2c313c",
    "editorLineNumber.foreground": "#495162",
    "editorLineNumber.activeForeground": "#abb2bf",
    "editorBracketMatch.background": "#515a6b",
    "editorBracketMatch.border": "#515a6b",
    "scrollbarSlider.background": "#4e566660",
    "scrollbarSlider.hoverBackground": "#5a637580",
    "editorGhostText.foreground": "#5c6370", // inline suggestions
    "statusBar.background": "#21252b",
  },
  "tokenColors": [
    { "name": "Comments", "scope": "comment, punctuation.definition.comment", "settings": { "foreground": "#7f848e", "fontStyle": "italic" } },
    { "name": "JSDoc tags", "scope": "storage.type.class.jsdoc", "settings": { "foreground": "#c678dd", "fontStyle": "" } },
    { "name": "Keywords", "scope": ["keyword", "storage.type", "storage.modifier"], "settings": { "foreground": "#c678dd" } },
    { "name": "Operators", "scope": "keyword.operator", "settings": { "foreground": "#56b6c2" } },
    { "scope": "punctuation.definition.template-expression", "settings": { "foreground": "#c678dd" } },
    { "scope": "punctuation.definition.tag", "settings": { "foreground": "#abb2bf" } },
    { "scope": "meta.brace.round, meta.brace.square", "settings": { "foreground": "#abb2bf" } },
    { "name": "Strings", "scope": "string", "settings": { "foreground": "#98c379" } },
    { "scope": "constant.character.escape", "settings": { "foreground": "#56b6c2" } },
    { "scope": "string.regexp", "settings": { "foreground": "#56b6c2" } },
    { "name": "Numbers, constants", "scope": "constant.numeric, constant.language, variable.other.constant, support.constant", "settings": { "foreground": "#d19a66" } },
    { "name": "Variables", "scope": "variable, support.variable", "settings": { "foreground": "#e06c75" } },
    { "scope": "variable.language", "settings": { "foreground": "#e5c07b", "fontStyle": "italic" } },
    { "scope": "variable.parameter", "settings": { "foreground": "#d19a66" } },
    { "scope": "support.type.property-name, variable.other.property", "settings": { "foreground": "#e06c75" } },
    { "name": "Functions", "scope": "entity.name.function, support.function, meta.function-call", "settings": { "foreground": "#61afef" } },
    { "name": "Types", "scope": "entity.name.type, entity.name.class, support.class, support.type", "settings": { "foreground": "#e5c07b" } },
    { "scope": "entity.name.tag", "settings": { "foreground": "#e06c75" } },
    { "scope": "entity.name.tag.css", "settings": { "foreground": "#d19a66" } },
    { "scope": "source.css variable", "settings": { "foreground": "#abb2bf" } },
    { "scope": "entity.other.attribute-name", "settings": { "foreground": "#d19a66" } },
    { "scope": "markup.heading", "settings": { "foreground": "#e06c75", "fontStyle": "bold" } },
    { "scope": "markup.italic", "settings": { "foreground": "#c678dd", "fontStyle": "italic" } },
    { "scope": "markup.bold", "settings": { "foreground": "#d19a66", "fontStyle": "bold" } },
    { "scope": "string.other.link", "settings": { "foreground": "#61afef" } },
    { "scope": "markup.underline.link", "settings": { "foreground": "#56b6c2", "fontStyle": "underline" } },
    { "scope": "markup.inserted", "settings": { "foreground": "#98c379" } },
    { "scope": "markup.deleted", "settings": { "foreground": "#e06c75" } },
    { "scope": "invalid.illegal", "settings": { "foreground": "#ffffff", "background": "#e05252" } },
  ],
  "semanticTokenColors": { "enumMember": { "foreground": "#56b6c2" } },
}`

test('a realistic theme (One Dark-ish, JSONC text)', () => {
  const theme = fromVSCodeTheme(ONE_DARKISH)
  assert.equal(theme.name, 'One Darkish')
  assert.equal(theme.dark, true)
  assert.deepEqual(theme.colors, {
    background: '#282c34',
    foreground: '#abb2bf',
    caret: '#528bff',
    selection: '#67769660',
    selectionInactive: '#3a3f4b',
    activeLine: '#2c313c',
    gutterBackground: 'var(--jc-bg)',
    gutterForeground: '#495162',
    gutterActiveForeground: '#abb2bf',
    gutterBorder: 'transparent',
    matchingBracket: '#515a6b',
    matchingBracketBorder: '#515a6b',
    placeholder: '#5c6370',
    scrollbar: '#4e566660',
    scrollbarHover: '#5a637580',
  })
  assert.deepEqual(theme.tokens, {
    comment: { color: '#7f848e', fontStyle: 'italic' },
    'comment.tag': { color: '#c678dd', fontStyle: 'normal' },
    keyword: { color: '#c678dd' },
    operator: { color: '#56b6c2' },
    'punctuation.special': { color: '#c678dd' },
    string: { color: '#98c379' },
    'string.escape': { color: '#56b6c2' },
    regexp: { color: '#56b6c2' },
    number: { color: '#d19a66' },
    constant: { color: '#d19a66' },
    variable: { color: '#e06c75' },
    'variable.language': { color: '#e5c07b', fontStyle: 'italic' },
    'variable.parameter': { color: '#d19a66' },
    property: { color: '#e06c75' },
    function: { color: '#61afef' },
    type: { color: '#e5c07b' },
    meta: { color: '#61afef' },
    tag: { color: '#e06c75' },
    attribute: { color: '#d19a66' },
    heading: { color: '#e06c75', fontWeight: 'bold' },
    emphasis: { color: '#c678dd', fontStyle: 'italic' },
    strong: { color: '#d19a66', fontWeight: 'bold' },
    link: { color: '#61afef' },
    inserted: { color: '#98c379' },
    deleted: { color: '#e06c75' },
    invalid: { color: '#ffffff', background: '#e05252' },
  })
  // Keywords, strings, comments, numbers, functions and types are all told apart.
  const main = ['keyword', 'string', 'comment', 'number', 'function', 'type'].map((t) => theme.tokens[t]!.color)
  assert.equal(new Set(main).size, main.length)
  // It is a regular theme: CSS variables and token rules.
  assert.match(theme.className, /^jc-theme-one-darkish/)
  assert.match(theme.css, /color-scheme:dark;--jc-bg:#282c34;--jc-fg:#abb2bf;/)
  assert.ok(theme.css.includes(`.${theme.className} .jc-t-keyword{color:#c678dd;}`))
  assert.ok(theme.css.includes(`.${theme.className} .jc-t-comment-tag{color:#c678dd;font-style:normal;}`))
  // The same theme from the parsed object.
  assert.deepEqual(fromVSCodeTheme(parseJSONC(ONE_DARKISH) as VSCodeTheme).tokens, theme.tokens)
})
