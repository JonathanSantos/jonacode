import CodeMirror from 'cm5'
import 'cm5/mode/javascript/javascript'
import 'cm5/addon/edit/matchbrackets'
import 'cm5/addon/edit/closebrackets'
import 'cm5/addon/selection/active-line'
import 'cm5/addon/search/search'
import 'cm5/addon/search/searchcursor'
import 'cm5/addon/dialog/dialog'
import 'cm5/lib/codemirror.css'
import 'cm5/addon/dialog/dialog.css'
import 'cm5/theme/material-darker.css'
window.mount = (el, text) => {
  const cm = CodeMirror(el, { value: text, mode: 'javascript', theme: 'material-darker', lineNumbers: true, matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true })
  cm.setSize('100%', '100%')
  return { scroller: cm.getScrollerElement(), editor: { setScrollTop: (y) => cm.scrollTo(null, y), getScrollHeight: () => cm.getScrollInfo().height } }
}
