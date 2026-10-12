import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
window.mount = (el, text) => { const v = new EditorView({ doc: text, extensions: [basicSetup, javascript(), oneDark], parent: el }); return { scroller: v.scrollDOM } }
