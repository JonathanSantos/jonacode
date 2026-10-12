import { createEditor, basicSetup } from '../../../src/index.ts'
import { javascript } from '../../../src/languages/javascript.ts'
window.mount = (el, text) => { const ed = createEditor(el, { value: text, language: javascript, extensions: basicSetup() }); return { scroller: ed.scrollDOM } }
