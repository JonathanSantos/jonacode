import * as monaco from 'monaco-editor'
self.MonacoEnvironment = { getWorker: () => new Worker(URL.createObjectURL(new Blob(['self.onmessage=()=>{}']))) }
window.mount = (el, text) => { const e = monaco.editor.create(el, { value: text, language: 'javascript', theme: 'vs-dark' }); return { scroller: null, editor: e } }
