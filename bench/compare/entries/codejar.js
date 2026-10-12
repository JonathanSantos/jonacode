import { CodeJar } from 'codejar'
import Prism from 'prismjs'
window.mount = (el, text) => { const pre = document.createElement('div'); pre.className = 'language-js'; pre.style.cssText = 'height:100%;overflow:auto;white-space:pre;font-family:monospace'; el.appendChild(pre); const jar = CodeJar(pre, (e) => Prism.highlightElement(e)); jar.updateCode(text); return { scroller: pre } }
