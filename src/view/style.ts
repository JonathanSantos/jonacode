/** Injects a stylesheet once per document / shadow root. */

const injected = new WeakMap<Node, Map<string, HTMLStyleElement>>()
let styleNonce: string | undefined

/** Sets a CSP nonce for the `<style>` tags the editor injects. */
export function setStyleNonce(nonce: string | undefined): void {
  styleNonce = nonce
}

export function injectStyle(target: Node, id: string, css: string): void {
  const root = target.getRootNode()
  const isShadow = typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot
  const host: Node = isShadow ? root : (target.ownerDocument ?? document)
  let map = injected.get(host)
  if (!map) injected.set(host, (map = new Map()))
  if (map.has(id)) return
  const doc = target.ownerDocument ?? document
  const style = doc.createElement('style')
  style.setAttribute('data-jonacode', id)
  if (styleNonce) style.nonce = styleNonce
  style.textContent = css
  if (isShadow) (root as ShadowRoot).prepend(style)
  else doc.head.appendChild(style)
  map.set(id, style)
}

/** Structural styles. Colors come from the theme (CSS variables). */
export const BASE_CSS = /* css */ `
.jc-editor{position:relative;display:flex;flex-direction:column;height:100%;box-sizing:border-box;
background:var(--jc-bg);color:var(--jc-fg);text-align:left;direction:ltr;overflow:hidden;isolation:isolate;
font-family:var(--jc-font-family,'JetBrains Mono','Fira Code','SF Mono',ui-monospace,Menlo,Consolas,'Liberation Mono',monospace);
font-size:var(--jc-font-size,14px);font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0;
-webkit-text-size-adjust:none;text-size-adjust:none}
.jc-editor *,.jc-editor *::before,.jc-editor *::after{box-sizing:border-box}
.jc-scroller{position:relative;flex:1 1 auto;min-height:0;overflow:auto;outline:none;
scrollbar-width:thin;scrollbar-color:var(--jc-scrollbar) transparent}
.jc-scroller::-webkit-scrollbar{width:12px;height:12px}
.jc-scroller::-webkit-scrollbar-corner{background:transparent}
.jc-scroller::-webkit-scrollbar-thumb{background:var(--jc-scrollbar);border-radius:8px;border:3px solid transparent;background-clip:content-box}
.jc-scroller::-webkit-scrollbar-thumb:hover{background:var(--jc-scrollbar-hover);background-clip:content-box}
.jc-sizer{position:relative;display:flex;min-height:100%;min-width:100%}
.jc-gutters{position:sticky;left:0;z-index:3;display:flex;flex:none;background:var(--jc-gutter-background);
border-right:1px solid var(--jc-gutter-border);color:var(--jc-gutter-foreground);user-select:none;-webkit-user-select:none}
.jc-gutter{position:relative;flex:none}
.jc-gutter-cell{position:absolute;left:0;right:0;height:var(--jc-lh);line-height:var(--jc-lh);white-space:nowrap;overflow:hidden}
.jc-gutter-lines .jc-gutter-cell{text-align:right;padding:0 10px 0 16px;color:var(--jc-gutter-foreground);font-variant-numeric:tabular-nums}
.jc-gutter-lines .jc-gutter-cell.jc-active{color:var(--jc-gutter-active-foreground)}
.jc-content{position:relative;flex:1 0 auto;cursor:text;user-select:none;-webkit-user-select:none;touch-action:manipulation;-webkit-touch-callout:none}
.jc-wrap .jc-scroller{overflow-x:hidden;scrollbar-gutter:stable}
.jc-wrap .jc-content{min-width:0}
.jc-view{position:absolute;top:0;bottom:0;left:var(--jc-pad-x);right:0}
.jc-lines,.jc-layer{position:absolute;inset:0}
.jc-layer{pointer-events:none}
.jc-lines{z-index:1}
.jc-fixed{position:sticky;left:0;z-index:4;flex:none;pointer-events:none}
.jc-layer-above{z-index:2}
.jc-line{position:absolute;left:0;height:var(--jc-lh);line-height:var(--jc-lh);white-space:pre;tab-size:var(--jc-tab-size,4);contain:layout style}
.jc-probe-box{position:absolute;top:0;left:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none}
.jc-probe{position:absolute;top:0;left:0;white-space:pre;line-height:var(--jc-line-height,1.6)}
.jc-probe b{font-weight:bold}.jc-probe i{font-style:italic}
.jc-cursor{position:absolute;width:2px;margin-left:-1px;height:var(--jc-lh);background:var(--jc-caret);border-radius:1px;display:none}
.jc-focused .jc-cursor{display:block;animation:jc-blink 1.1s steps(1) infinite}
.jc-focused .jc-cursor.jc-blink-alt{animation-name:jc-blink2}
@keyframes jc-blink{0%{opacity:1}50%{opacity:0}}
@keyframes jc-blink2{0%{opacity:1}50%{opacity:0}}
.jc-selection-rect{position:absolute;background:var(--jc-selection-inactive);border-radius:3px}
.jc-focused .jc-selection-rect{background:var(--jc-selection)}
.jc-active-line{position:absolute;left:calc(-1 * var(--jc-pad-x));right:0;height:var(--jc-lh);background:var(--jc-active-line)}
.jc-bracket{position:absolute;height:var(--jc-lh);background:var(--jc-matching-bracket);box-shadow:inset 0 0 0 1px var(--jc-matching-bracket-border);border-radius:2px}
.jc-placeholder{position:absolute;left:0;height:var(--jc-lh);line-height:var(--jc-lh);white-space:pre;color:var(--jc-placeholder);pointer-events:none}
.jc-input{position:absolute;left:0;top:0;width:1px;height:var(--jc-lh);padding:0;margin:0;border:0;outline:none;resize:none;
overflow:hidden;white-space:pre;opacity:0;background:transparent;color:transparent;caret-color:transparent;
font:inherit;line-height:var(--jc-lh);pointer-events:none;z-index:-1}
.jc-composition{position:absolute;left:0;top:0;height:var(--jc-lh);line-height:var(--jc-lh);white-space:pre;z-index:5;pointer-events:none;
color:var(--jc-fg);background:var(--jc-bg);text-decoration:underline;box-shadow:2px 0 0 var(--jc-caret)}
.jc-composing .jc-cursor{visibility:hidden}
@media (prefers-reduced-motion:reduce){.jc-focused .jc-cursor{animation:none}}
@media (forced-colors:active){
.jc-cursor{forced-color-adjust:none;background:CanvasText}
.jc-selection-rect,.jc-focused .jc-selection-rect{forced-color-adjust:none;background:Highlight;opacity:.5}
.jc-bracket{outline:1px solid CanvasText}
.jc-active-line{background:none}
}
.jc-input.jc-context{pointer-events:auto;z-index:5;width:3em;height:3em;margin:-1.5em 0 0 -1.5em}
.jc-touch .jc-input{font-size:16px}
@media (pointer:coarse){.jc-input{font-size:16px}}
`
