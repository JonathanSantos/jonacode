/**
 * Style token types with any CSS, per editor and on top of the theme:
 *
 * ```ts
 * tokenStyles({
 *   todo: { color: '#282c34', background: '#e5c07b', fontWeight: 'bold', borderRadius: '3px' },
 *   color: 'box-shadow: inset 0 -3px var(--swatch)',
 *   'comment todo': { fontStyle: 'normal' },   // only TODOs inside comments
 * })
 * ```
 */
import type { Extension } from '../editor.ts'
import { styleToCSS, tokenSelector, type TokenStyle } from '../theme/theme.ts'
import { injectStyle } from '../view/style.ts'

let counter = 0

/**
 * Keys are token types (`todo`, `string.url`, or combined `comment todo`);
 * values are a style object or raw CSS declarations. Styles only apply to the
 * editors that installed the extension and win over the theme.
 */
export function tokenStyles(styles: Record<string, TokenStyle | string>): Extension {
  const cls = `jc-ts-${++counter}`
  let css = ''
  for (const [type, style] of Object.entries(styles)) {
    const body = typeof style === 'string' ? style : styleToCSS(style)
    css += `.${cls}.jc-editor ${tokenSelector(type)}{${body}}`
  }
  return (editor) => {
    injectStyle(editor.dom, cls, css)
    editor.dom.classList.add(cls)
    return () => editor.dom.classList.remove(cls)
  }
}
