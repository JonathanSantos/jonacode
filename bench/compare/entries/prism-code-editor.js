import { createEditor } from 'prism-code-editor'
import 'prism-code-editor/prism/languages/javascript'
import { matchBrackets } from 'prism-code-editor/match-brackets'
import { defaultCommands } from 'prism-code-editor/commands'
import { searchWidget } from 'prism-code-editor/search'
import 'prism-code-editor/layout.css'
import 'prism-code-editor/search.css'
import 'prism-code-editor/themes/atom-one-dark.css'
window.mount = (el, text) => { const e = createEditor(el, { language: 'javascript', value: text, lineNumbers: true }, matchBrackets(), defaultCommands(), searchWidget()); return { scroller: e.container, editor: e } }
