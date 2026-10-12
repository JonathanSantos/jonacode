import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
window.mount = (el, text) => { const v = new EditorView({ state: EditorState.create({ doc: text }), parent: el }); return { scroller: v.scrollDOM } }
