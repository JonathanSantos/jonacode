import { createEditor } from '../../../src/index.ts'
window.mount = (el, text) => { const ed = createEditor(el, { value: text }); return { scroller: ed.scrollDOM } }
