import ace from 'ace-builds'
import 'ace-builds/src-noconflict/mode-javascript'
import 'ace-builds/src-noconflict/theme-one_dark'
import 'ace-builds/src-noconflict/ext-searchbox'
window.mount = (el, text) => { const e = ace.edit(el, { value: text, mode: 'ace/mode/javascript', theme: 'ace/theme/one_dark', useWorker: false }); return { scroller: null, editor: e } }
