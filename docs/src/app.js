/* Jonacode docs — router, live demos and visualizations. Runs on top of the real library bundle. */
;(() => {
  const J = window.Jonacode
  const {
    createEditor, basicSetup, defineLanguage, defineTheme, words, oneDark, oneLight, javascript, javascriptSpec,
    lineNumbers, bracketMatching, closeBrackets, highlightActiveLine, commands, colorVar, tokenClass, plainText,
    defaultKeymap, editingKeymap, defineJonacodeElement, multiCursorKeymap, searchKeymap, tokenRule, tokenStyles,
    tokenInspector, extendLanguage, openSearch, openReplace, setSearchQuery, firstChars,
    lazyEditor, lineClass, openGotoLine, setDecorations, getDecorations, linter, hoverTooltip, getDiagnostics,
    folding, foldAll, unfoldAll, autocomplete, languageWords, documentWords,
    editorTools, applyEdits, markAIEdits, setReadOnlyRanges, lineRange, inlineSuggestion, inlineEdit,
    diffView, setOriginal, getChunks, acceptAll, rejectAll, mergeView,
    treeSitter, cdnTreeSitter, cdnGrammars, fixAllSyntax, collab, yjs, addZone, addWidget, addOverlay, getZones,
  } = J
  const SIZES = window.__SIZES__
  const $ = (sel, root = document) => root.querySelector(sel)
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const kb = (bytes) => (bytes / 1024).toFixed(1).replace('.', ',') + ' kB'
  const num = (n) => n.toLocaleString('pt-BR')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

  // Theme styles for token samples outside editors.
  const style = document.createElement('style')
  style.textContent = oneDark.css
  document.head.appendChild(style)

  // ------------------------------------------------------------------ languages used by this page
  // The page highlights its own examples with the library's built-in languages.
  const { jsx, typescript, tsx, json, css, html, markdown, createMarkdown, sql, shell, log } = J
  const LANGS = { js: javascript, jsx, ts: typescript, tsx, json, css, html, md: markdown, sql, shell, log, text: plainText }
  const LANG_LABEL = { js: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX', json: 'JSON', html: 'HTML', css: 'CSS', md: 'Markdown', sql: 'SQL', shell: 'shell', log: 'log', text: 'texto' }

  // ------------------------------------------------------------------ helpers
  const PHRASES = {
    Find: 'Buscar', Replace: 'Substituir', 'Replace all': 'Substituir tudo', 'Match case': 'Diferenciar maiúsculas',
    'Whole word': 'Palavra inteira', 'Regular expression': 'Expressão regular', 'Previous match': 'Anterior',
    'Next match': 'Próximo', 'Select all matches': 'Selecionar todas', Close: 'Fechar', 'No results': 'Nenhum resultado',
    Invalid: 'Inválida', 'Toggle replace': 'Mostrar substituir', Copy: 'Copiar', Cut: 'Recortar', Paste: 'Colar',
    'Select all': 'Tudo',
    Accept: 'Aceitar', Reject: 'Rejeitar', Revert: 'Reverter', 'Suggestion: {text}. Tab to accept.': 'Sugestão: {text}. Tab aceita.',
    'Edit with AI… (Enter to send, Esc to cancel)': 'Editar com IA… (Enter envia, Esc cancela)', 'Edit with AI': 'Editar com IA',
    'Generating…': 'Gerando…', 'Line {line}': 'Linha {line}', 'Lines {from}–{to}': 'Linhas {from}–{to}', Stop: 'Parar', Send: 'Enviar',
    'The code changed while the AI was writing: nothing was replaced. Send again, or copy the result.': 'O código mudou enquanto a IA escrevia: nada foi trocado. Envie de novo ou copie o resultado.',
    'The AI request failed': 'O pedido à IA falhou', 'Lines {from}–{to} of {total}': 'Linhas {from}–{to} de {total}',
    'Missing {token}': 'Falta {token}', 'Unexpected {token}': '{token} inesperado', 'Unclosed {token}': '{token} sem fechar',
    'Unterminated string': 'String sem fechar', 'Syntax error': 'Erro de sintaxe', 'Syntax error near {token}': 'Erro de sintaxe perto de {token}',
    'Insert {token}': 'Inserir {token}', 'Remove {token}': 'Remover {token}', 'Close the string': 'Fechar a string', syntax: 'sintaxe',
    Anonymous: 'Anônimo', 'People editing': 'Pessoas editando', 'Follow {name}': 'Seguir {name}', 'Stop following {name}': 'Parar de seguir {name}',
  }
  function frame(host, options) {
    return createEditor(host, { tabSize: 2, phrases: PHRASES, ...options })
  }

  function copyButton(button, getText) {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(getText())
        button.textContent = 'copiado'
        button.classList.add('ok')
      } catch {
        button.textContent = 'erro'
      }
      setTimeout(() => {
        button.textContent = 'copiar'
        button.classList.remove('ok')
      }, 1400)
    })
  }

  /** Turns `<textarea class="snippet">` into read-only Jonacode editors. */
  function mountSnippets(root) {
    for (const ta of $$('textarea.snippet', root)) {
      const lang = ta.dataset.lang ?? 'text'
      const value = ta.value.replace(/^\n/, '').replace(/\s+$/, '')
      const wrap = document.createElement('div')
      wrap.className = 'code'
      wrap.innerHTML = `<div class="code-bar">${ta.dataset.file ? `<span class="file">${esc(ta.dataset.file)}</span>` : ''}<span class="lang">${LANG_LABEL[lang] ?? lang}</span><button class="copy" type="button">copiar</button></div><div class="host"></div>`
      ta.replaceWith(wrap)
      copyButton($('.copy', wrap), () => value)
      frame($('.host', wrap), { value, language: LANGS[lang] ?? plainText, readOnly: true, extensions: [bracketMatching()] })
    }
  }

  function mountTabs(root) {
    for (const tabs of $$('.tabs', root)) {
      const buttons = $$('.tablist [role=tab]', tabs)
      const panels = $$(':scope > .tabpanel', tabs)
      buttons.forEach((b, i) => {
        b.type = 'button'
        b.addEventListener('click', () => {
          buttons.forEach((x, j) => x.setAttribute('aria-selected', String(i === j)))
          panels.forEach((p, j) => (p.hidden = i !== j))
        })
      })
    }
  }

  function colorOf(type, theme = oneDark) {
    for (let t = type; t; t = t.includes('.') ? t.slice(0, t.lastIndexOf('.')) : '') {
      const c = theme.tokens[t]?.color
      if (c) return c
    }
    return theme.colors.foreground
  }

  // ------------------------------------------------------------------ router
  const ORDER = ['inicio', 'comparativo', 'comecando', 'frameworks', 'temas', 'linguagens', 'por-dentro', 'extensoes', 'ia']
  const COLORS = { inicio: 'purple', comparativo: 'caret', comecando: 'blue', frameworks: 'green', temas: 'orange', linguagens: 'red', 'por-dentro': 'cyan', extensoes: 'yellow', ia: 'magenta' }
  const pages = Object.fromEntries($$('.page').map((p) => [p.dataset.page, p]))
  const inited = new Set()
  let current = null

  for (const [i, id] of ORDER.entries()) {
    const pager = $('[data-pager]', pages[id])
    const prev = ORDER[i - 1]
    const next = ORDER[i + 1]
    pager.innerHTML =
      (prev ? `<a class="prev" href="#${prev}" style="--c:var(--${COLORS[prev]})"><small>← anterior</small><span>${pages[prev].dataset.title}</span></a>` : '') +
      (next ? `<a class="next" href="#${next}" style="--c:var(--${COLORS[next]})"><small>próximo →</small><span>${pages[next].dataset.title}</span></a>` : '')
  }

  const jnav = $('.jnav')
  const caret = $('.jcaret', jnav)
  setTimeout(() => jnav.classList.remove('intro'), 1400)
  for (const bar of $$('.bar, .jcaret', jnav)) bar.addEventListener('click', () => (location.hash = bar.dataset.go))

  function route() {
    const [id = 'inicio', anchor] = decodeURIComponent(location.hash.slice(1)).split('/')
    const page = pages[id] ?? pages.inicio
    const pageId = page.dataset.page
    const changed = page !== current
    if (changed) {
      current?.classList.remove('on')
      page.classList.add('on')
      current = page
      if (!inited.has(pageId)) {
        inited.add(pageId)
        INIT[pageId]?.(page)
        mountSnippets(page)
        mountTabs(page)
      }
      document.title = `${page.dataset.title} · Jonacode`
      const index = ORDER.indexOf(pageId)
      const overview = pageId === 'comparativo'
      jnav.classList.toggle('overview', overview)
      for (const bar of $$('.bar', jnav)) {
        const i = ORDER.indexOf(bar.dataset.go)
        bar.classList.toggle('on', !overview && i === index)
        bar.classList.toggle('done', !overview && i < index)
      }
      // The comparison is the big picture: the whole logo lights up, caret back home.
      const bar = $(`.bar[data-go="${pageId}"]`, jnav)
      const x = bar ? +bar.getAttribute('x') + +bar.getAttribute('width') + 7 : 101
      const y = bar ? +bar.getAttribute('y') - 6 : 148
      caret.style.transform = `translate(${x}px, ${y}px)`
      for (const a of $$('#toc > li > a')) {
        const on = a.getAttribute('href') === '#' + pageId
        a.toggleAttribute('aria-current', on)
        a.parentElement.classList.toggle('open', on)
      }
    }
    $('#side').classList.remove('open')
    // A link to a section keeps it marked in the submenu while the page scrolls there (and while it's on screen).
    pinned = anchor ? `${pageId}/${anchor}` : null
    pinnedUntil = performance.now() + 1500
    spyLinks = null
    requestAnimationFrame(() => {
      const target = anchor && document.getElementById(anchor)
      if (target) target.scrollIntoView({ behavior: changed || reduced ? 'auto' : 'smooth' })
      else if (changed) window.scrollTo(0, 0)
      spy()
    })
  }

  // ------------------------------------------------------------------ submenu: the section on screen
  // Sub-links inherit their chapter's color.
  for (const a of $$('#toc > li > a')) a.parentElement.style.setProperty('--c', a.style.getPropertyValue('--c'))
  let pinned = null
  /** Until then (a smooth scroll on its way), the clicked section is marked even off screen. */
  let pinnedUntil = 0
  /** [link, heading] of the current page's sections (headings with a submenu entry). */
  let spyLinks = null
  let spyActive = null
  let spyFrame = 0
  function spy() {
    spyFrame = 0
    if (!current) return
    const pageId = current.dataset.page
    spyLinks ??= $$(`#toc .sub a[href^="#${pageId}/"]`)
      .map((a) => [a, document.getElementById(a.getAttribute('href').slice(pageId.length + 2))])
      .filter(([, h]) => h && current.contains(h))
    // The section whose heading passed the reading line (a third down the screen); at the bottom of the page,
    // the last one on screen (short last sections never reach the line).
    const line = Math.min(innerHeight / 3, 180)
    const onScreen = ([, h]) => { const r = h.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight }
    let active = null
    for (const entry of spyLinks) if (entry[1].getBoundingClientRect().top <= line) active = entry
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) active = spyLinks.filter(onScreen).pop() ?? active
    const pin = pinned && spyLinks.find(([a]) => a.getAttribute('href') === '#' + pinned)
    if (pin && (onScreen(pin) || performance.now() < pinnedUntil)) active = pin
    const link = active?.[0] ?? null
    if (link === spyActive) return
    spyActive?.removeAttribute('aria-current')
    spyActive = link
    if (!link) return
    link.setAttribute('aria-current', 'location')
    // Keep it in view inside the sidebar (it scrolls on its own; the page must not move).
    const side = $('#side')
    const r = link.getBoundingClientRect()
    const s = side.getBoundingClientRect()
    if (r.top < s.top + 48) side.scrollTop -= s.top + 48 - r.top
    else if (r.bottom > s.bottom - 48) side.scrollTop += r.bottom - s.bottom + 48
  }
  addEventListener('scroll', () => (spyFrame ||= requestAnimationFrame(spy)), { passive: true })
  addEventListener('resize', () => (spyFrame ||= requestAnimationFrame(spy)))
  // Demos load and grow the page: the headings move without any scroll.
  new ResizeObserver(() => (spyFrame ||= requestAnimationFrame(spy))).observe($('#main'))
  // Scrolling by hand lets go of the section that was clicked.
  for (const type of ['wheel', 'touchmove']) addEventListener(type, () => (pinned = null), { passive: true })
  addEventListener('keydown', (e) => /^(Arrow|Page|Home|End| )/.test(e.key) && !e.target.closest?.('.jc-editor, input, textarea, select') && (pinned = null))

  $('#menu').addEventListener('click', () => {
    const side = $('#side')
    side.classList.toggle('open')
    $('#menu').setAttribute('aria-expanded', String(side.classList.contains('open')))
  })

  const INIT = {}

  // ------------------------------------------------------------------ 1. início
  INIT.inicio = () => {
    const code = `import { createEditor, basicSetup } from 'jonacode'
import { javascript } from 'jonacode/languages/javascript'

// Um editor completo em poucas linhas
const editor = createEditor(document.querySelector('#app'), {
  value: 'console.log("Olá, Jonacode!")',
  language: javascript,
  extensions: basicSetup(),
})

editor.on('change', () => salvar(editor.getValue()))
`
    const ed = frame($('#hero-editor'), { language: javascript, extensions: basicSetup(), placeholder: 'Digite algo…' })
    const status = $('#hero-status')
    const dom = ed.dom.getElementsByClassName('jc-line')
    const updateStatus = () => {
      const { head } = ed.selection
      status.innerHTML = `<span>Ln <b>${head.line + 1}</b>, Col <b>${head.col + 1}</b></span><span><b>${num(ed.doc.lineCount)}</b> linhas</span><span><b>${dom.length}</b> linhas no DOM</span><span class="accent">JavaScript · One Dark</span>`
    }
    ed.on('render', updateStatus)

    let timer = 0
    const stop = () => {
      clearTimeout(timer)
      timer = 0
    }
    const type = () => {
      stop()
      ed.setValue('')
      if (reduced) return ed.setValue(code)
      let i = 0
      const tick = () => {
        if (i >= code.length) return (timer = 0)
        const ch = code[i++]
        ed.replaceSelection(ch, 'demo')
        timer = setTimeout(tick, ch === '\n' ? 140 : 14 + Math.random() * 34)
      }
      timer = setTimeout(tick, 500)
    }
    // Any interaction takes over: finish the text instantly and let the user edit.
    ed.dom.addEventListener('mousedown', () => {
      if (timer) {
        stop()
        ed.setValue(code)
      }
    }, true)
    $('#hero-replay').addEventListener('click', type)
    type()

    $('#facts').innerHTML = `<span><b>0</b> dependências</span><span><b>${kb(SIZES.core)}</b> gzip no núcleo</span><span><b>${kb(SIZES.core + SIZES.parts.javascript + SIZES.parts.lineNumbers + SIZES.parts.bracketMatching + SIZES.parts.closeBrackets + SIZES.parts.highlightActiveLine + SIZES.parts.editingKeymap)}</b> com JavaScript e basicSetup</span><span><b>ESM</b> + tipos TypeScript</span><span><b>MIT</b></span>`
    $('#card-size').textContent = `import { createEditor } → ${kb(SIZES.core)} gzip`
  }

  // ------------------------------------------------------------------ 2. começando
  INIT.comecando = () => {
    const ed = frame($('#api-editor'), {
      value: `function saudar(nome) {\n  return \`Olá, \${nome}!\`\n}\n\nsaudar('Jonathan') // uma linha bem comprida para mostrar a quebra de linha quando ela estiver ligada no editor\n`,
      language: javascript,
      extensions: basicSetup(),
    })
    const title = $('#api-last')
    const actions = [
      ['Inserir texto', `editor.replaceSelection('🚀 ')`, () => ed.replaceSelection('🚀 ')],
      ['Selecionar palavra', `editor.setSelection({ line: 0, col: 9 }, { line: 0, col: 15 })`, () => ed.setSelection({ line: 0, col: 9 }, { line: 0, col: 15 })],
      ['Comentar linha', `commands.toggleComment(editor)`, () => commands.toggleComment(ed)],
      ['Mover linha ↓', `commands.moveLineDown(editor)`, () => commands.moveLineDown(ed)],
      ['Desfazer', `editor.undo()`, () => ed.undo()],
      ['Trocar tema', `editor.setOptions({ theme: oneLight })`, () => ed.setOptions({ theme: ed.theme === oneDark ? oneLight : oneDark })],
      ['Somente leitura', `editor.setOptions({ readOnly: true })`, () => ed.setOptions({ readOnly: !ed.options.readOnly })],
      ['Contar caracteres', `editor.getValue().length`, () => ed.getValue().length],
      ['Vários cursores', `editor.setSelections([{ anchor: { line: 0, col: 9 }, head: … }, …])`, () => {
        const ranges = [0, 4].map((line) => {
          const col = ed.doc.line(line).indexOf('saudar')
          return { anchor: { line, col }, head: { line, col: col + 6 } }
        }).filter((r) => r.anchor.col >= 0)
        ed.setSelections(ranges)
      }],
      ['Quebra de linha', `editor.setOptions({ lineWrapping: true })`, () => ed.setOptions({ lineWrapping: !ed.options.lineWrapping })],
      ['Buscar', `openSearch(editor)`, () => openSearch(ed)],
    ]
    const box = $('#api-buttons')
    for (const [label, code, run] of actions) {
      const b = document.createElement('button')
      b.className = 'btn small'
      b.type = 'button'
      b.textContent = label
      b.addEventListener('click', () => {
        const result = run()
        let text = code
        if (label === 'Trocar tema') text = `editor.setOptions({ theme: ${ed.theme === oneDark ? 'oneDark' : 'oneLight'} })`
        if (label === 'Somente leitura') text = `editor.setOptions({ readOnly: ${ed.options.readOnly} })`
        if (label === 'Quebra de linha') text = `editor.setOptions({ lineWrapping: ${ed.options.lineWrapping} })`
        if (label === 'Buscar') return (title.textContent = text)
        title.textContent = typeof result === 'number' ? `${text}  // → ${result}` : text
        ed.focus()
      })
      box.appendChild(b)
    }
  }

  // --- static highlight size & lazy editors (appended to "começando")
  const comecandoInit = INIT.comecando
  INIT.comecando = (page) => {
    comecandoInit(page)
    $('#static-size').textContent = kb(SIZES.static)
    const SNIPPETS = [
      'const soma = (a, b) => a + b\nconsole.log(soma(2, 3))',
      'for (const item of lista) {\n  if (item.ativo) total += item.valor\n}',
      "const nomes = usuarios\n  .filter((u) => u.ativo)\n  .map((u) => u.nome)",
      'class Pilha {\n  #itens = []\n  push(x) { this.#itens.push(x) }\n}',
      "fetch('/api/itens')\n  .then((r) => r.json())\n  .then(render)",
      "const re = /^(\\d{3})-(\\d{4})$/\nre.test('123-4567') // true",
    ]
    const grid = $('#lazy-grid')
    let created = 0
    const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const reset = () => {
      for (const el of $$('.jc-editor', grid)) el.remove()
      grid.innerHTML = ''
      created = 0
      $('#lazy-count').textContent = '0'
    }
    const mount = async (lazy) => {
      reset()
      const t0 = performance.now()
      for (let i = 0; i < 24; i++) {
        const box = document.createElement('div')
        grid.appendChild(box)
        const opts = { value: SNIPPETS[i % SNIPPETS.length], language: javascript, extensions: basicSetup(), phrases: PHRASES }
        if (lazy) {
          lazyEditor(box, opts).ready.then(() => {
            box.classList.add('on')
            $('#lazy-count').textContent = String(++created)
            $('#lazy-nodes').textContent = num(grid.getElementsByTagName('*').length)
          })
        } else {
          createEditor(box, opts)
          box.classList.add('on')
          created++
        }
      }
      await raf2()
      $('#lazy-time').textContent = fmtMs(performance.now() - t0)
      $('#lazy-nodes').textContent = num(grid.getElementsByTagName('*').length)
      $('#lazy-count').textContent = String(created)
      $('#lazy-mode').textContent = lazy ? 'sob demanda' : 'editores'
    }
    const fmtMs = (ms) => ms.toFixed(ms < 10 ? 1 : 0).replace('.', ',')
    $('#lazy-eager').addEventListener('click', () => mount(false))
    $('#lazy-lazy').addEventListener('click', () => mount(true))
    mount(true)
  }

  // ------------------------------------------------------------------ 3. frameworks
  INIT.frameworks = () => {
    defineJonacodeElement({ languages: [javascript, jsx, typescript, tsx, json, css, html, markdown, sql, shell], themes: [oneDark, oneLight], extensions: basicSetup(), options: { phrases: { ...PHRASES, 'Please fill out this field.': 'Preencha este campo.' } } })
    // --- forms
    const form = $('#form-demo')
    const flog = $('#form-log')
    const say = (html) => {
      const d = document.createElement('div')
      d.innerHTML = html
      flog.prepend(d)
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      form.classList.add('tried')
      const data = Object.fromEntries(new FormData(form))
      say(`<span class="ok">submit</span> FormData ${esc(JSON.stringify(data))}`)
    })
    form.addEventListener('invalid', (e) => {
      form.classList.add('tried')
      say(`<span class="bad">invalid</span> ${esc(e.target.id)}: ${esc(e.target.validationMessage)}`)
    }, true)
    form.addEventListener('reset', () => setTimeout(() => say(`<span class="k">reset</span> de volta ao conteúdo inicial`)))
    $('#form-disable').addEventListener('change', (e) => {
      $('#form-fieldset').disabled = e.target.checked
      say(`<span class="k">fieldset.disabled</span> = ${e.target.checked} → somente leitura e fora do envio`)
    })
    say('<span class="r">Apague tudo e envie, ou edite e envie.</span>')
    const out = $('#element-out')
    const original = out.innerHTML
    document.querySelector('jona-code.demo').addEventListener('change', (e) => {
      out.innerHTML = `Evento <code>change</code> → <code>e.detail.value.length === ${e.detail.value.length}</code>. ` + original
    })
  }

  // ------------------------------------------------------------------ 4. temas
  INIT.temas = () => {
    // --- VS Code theme importer
    const VSC = `{
  // Um tema no formato do VS Code (comentários e vírgulas sobrando são aceitos)
  "name": "Aurora",
  "type": "dark",
  "colors": {
    "editor.background": "#1b1d2b",
    "editor.foreground": "#c8d3f5",
    "editorCursor.foreground": "#ff966c",
    "editor.selectionBackground": "#2f334d",
    "editor.lineHighlightBackground": "#222436",
    "editorLineNumber.foreground": "#444a73",
    "editorLineNumber.activeForeground": "#828bb8",
  },
  "tokenColors": [
    { "scope": "comment", "settings": { "foreground": "#636da6", "fontStyle": "italic" } },
    { "scope": ["keyword", "storage.type", "storage.modifier"], "settings": { "foreground": "#c099ff" } },
    { "scope": "string", "settings": { "foreground": "#c3e88d" } },
    { "scope": "constant.numeric", "settings": { "foreground": "#ff966c" } },
    { "scope": "constant.language", "settings": { "foreground": "#ff966c", "fontStyle": "bold" } },
    { "scope": ["entity.name.function", "support.function"], "settings": { "foreground": "#82aaff" } },
    { "scope": ["entity.name.type", "entity.name.class", "support.type"], "settings": { "foreground": "#ffc777" } },
    { "scope": "variable.other.property", "settings": { "foreground": "#86e1fc" } },
    { "scope": "keyword.operator", "settings": { "foreground": "#89ddff" } },
  ],
}`
    const VSC_SAMPLE = `interface Pedido { id: number; itens: Item[]; pago?: boolean }

/** Soma os pedidos pagos. */
export function total(pedidos: Pedido[]): number {
  return pedidos
    .filter((p) => p.pago === true)
    .reduce((soma, p) => soma + p.itens.length * 1.5, 0)
}

const aviso = \`Total: \${total([])}\` // ok`
    const vscPreview = frame($('#vsc-preview'), { value: VSC_SAMPLE, language: typescript, extensions: basicSetup() })
    const applyVsc = (src) => {
      try {
        const theme = J.fromVSCodeTheme(src)
        vscPreview.setOptions({ theme })
        $('#vsc-status').innerHTML = `<span class="accent">✓ ${esc(theme.name)}</span>`
      } catch (err) {
        $('#vsc-status').innerHTML = `<span class="lab-error">✗ ${esc(err.message)}</span>`
      }
    }
    let vscTimer = 0
    frame($('#vsc-json'), {
      value: VSC,
      language: json,
      extensions: basicSetup(),
      onChange: (value) => {
        clearTimeout(vscTimer)
        vscTimer = setTimeout(() => applyVsc(value), 250)
      },
    })
    applyVsc(VSC)

    // Cascade visualization
    const samples = ['keyword', 'string.escape', 'function.method', 'type.builtin', 'constant.language', 'comment.tag', 'variable.parameter']
    $('#cascade').innerHTML = samples.map((type, i) => {
      const parts = type.split('.')
      const chips = parts.map((_, j) => {
        const scope = parts.slice(0, j + 1).join('.')
        const defined = !!oneDark.tokens[scope]
        return `<span class="chip ${defined ? '' : 'miss'}" data-lit="${defined}" style="--i:${i}">.${tokenClass(scope).split(' ').pop()}</span>`
      }).join('')
      const c = colorOf(type)
      return `<div class="stepline"><span class="chip" style="color:${c}">${type}</span><span class="arrow">→</span>${chips}<span class="arrow">→</span><span class="chip"><span class="swatch" style="--s:${c}"></span>${c}</span></div>`
    }).join('')
    // Light the winning (deepest defined) class of each row, one row at a time.
    const rows = $$('#cascade .stepline')
    let r = 0
    const lightNext = () => {
      $$('#cascade .lit').forEach((x) => x.classList.remove('lit'))
      const defined = $$('[data-lit="true"]', rows[r % rows.length])
      defined.at(-1)?.classList.add('lit')
      r++
    }
    lightNext()
    if (!reduced) setInterval(lightNext, 1500)

    // Theme builder
    const PRESETS = {
      'One Dark': { base: oneDark, a: '#282c34', b: '#c678dd', colors: {}, tokens: {} },
      'One Light': { base: oneLight, a: '#fafafa', b: '#a626a4', colors: {}, tokens: {} },
      Midnight: {
        base: oneDark, a: '#0d1117', b: '#ff7b72',
        colors: { background: '#0d1117', foreground: '#c9d1d9', caret: '#58a6ff', selection: '#264f78', activeLine: '#161b22', gutterForeground: '#6e7681' },
        tokens: { keyword: '#ff7b72', string: '#a5d6ff', function: '#d2a8ff', comment: '#8b949e', number: '#79c0ff', type: '#ffa657', variable: '#ffa657', property: '#79c0ff', operator: '#ff7b72', constant: '#79c0ff' },
      },
      Canarinho: {
        base: oneDark, a: '#0b2419', b: '#ffdf00',
        colors: { background: '#0b2419', foreground: '#e3efe6', caret: '#ffdf00', selection: '#1f4d36', activeLine: '#10301f', gutterForeground: '#4f7a62' },
        tokens: { keyword: '#ffdf00', string: '#7bd88f', function: '#5aa9ff', comment: '#6a8f7a', number: '#ffb347', type: '#ffdf00', variable: '#e3efe6', property: '#9ad0ff', operator: '#7bd88f', constant: '#ffb347' },
      },
    }
    const UI = ['background', 'foreground', 'caret', 'selection', 'activeLine', 'gutterForeground']
    const TOKENS = ['keyword', 'string', 'function', 'comment', 'number', 'type', 'variable', 'property', 'operator', 'constant']
    let preset = 'One Dark'
    let state = null
    const toHex = (c) => (/^#[\da-f]{6}/i.test(c) ? c.slice(0, 7) : '#888888')
    const load = (name) => {
      preset = name
      const p = PRESETS[name]
      state = { colors: {}, tokens: {} }
      for (const k of UI) state.colors[k] = toHex(p.colors[k] ?? p.base.colors[k])
      for (const k of TOKENS) state.tokens[k] = toHex(p.tokens[k] ?? colorOf(k, p.base))
      $$('.preset').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.name === name)))
      renderPicker()
      apply()
    }
    $('#presets').innerHTML = Object.entries(PRESETS).map(([name, p]) => `<button class="preset" type="button" data-name="${name}" style="--a:${p.a};--b:${p.b}"><i></i>${name}</button>`).join('')
    $$('.preset').forEach((b) => b.addEventListener('click', () => load(b.dataset.name)))

    const picker = $('#picker')
    const renderPicker = () => {
      const field = (group, key) => `<label><input type="color" data-group="${group}" data-key="${key}" value="${state[group][key]}"><span>${key}</span><span class="hex">${state[group][key]}</span></label>`
      picker.innerHTML = `<h4>Interface</h4>${UI.map((k) => field('colors', k)).join('')}<h4>Tokens</h4>${TOKENS.map((k) => field('tokens', k)).join('')}`
    }
    picker.addEventListener('input', (e) => {
      const input = e.target
      state[input.dataset.group][input.dataset.key] = input.value
      input.parentElement.querySelector('.hex').textContent = input.value
      schedule()
    })

    const preview = frame($('#theme-editor'), {
      value: `// Mexa nas cores ao lado ✨\nimport { defineTheme } from 'jonacode'\n\nexport class Paleta extends Map {\n  static PADRAO = 0x282c34\n\n  adicionar(nome, cor = '#61afef') {\n    this.set(nome, cor.replace(/#/, ''))\n    return this // encadeável\n  }\n}\n`,
      language: javascript,
      extensions: basicSetup(),
    })
    const codeView = frame($('#theme-code'), { language: javascript, readOnly: true })
    const generated = () => {
      const base = PRESETS[preset].base === oneLight ? 'oneLight' : 'oneDark'
      const colors = UI.map((k) => `    ${k}: '${state.colors[k]}',`).join('\n')
      const tokens = TOKENS.map((k) => (k === 'comment' ? `    comment: { color: '${state.tokens[k]}', fontStyle: 'italic' },` : `    ${k}: '${state.tokens[k]}',`)).join('\n')
      return `import { defineTheme, ${base} } from 'jonacode'\n\nexport const meuTema = defineTheme({\n  name: 'meu-tema',\n  extends: ${base},\n  colors: {\n${colors}\n  },\n  tokens: {\n${tokens}\n  },\n})`
    }
    copyButton($('#theme-copy'), generated)
    let pending = 0
    const schedule = () => {
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(apply)
    }
    const apply = () => {
      const p = PRESETS[preset]
      const tokens = { ...state.tokens, comment: { color: state.tokens.comment, fontStyle: 'italic' } }
      const theme = defineTheme({ name: 'meu-tema', extends: p.base, colors: { ...state.colors, gutterBackground: state.colors.background }, tokens })
      preview.setOptions({ theme })
      codeView.setValue(generated())
    }
    load('One Dark')

    // Token table
    const TOKEN_SAMPLES = [
      ['keyword', 'const return if'], ['comment', '// nota'], ['string', "'texto'"], ['string.escape', '\\n \\u00e9'],
      ['number', '42 0xff 1e3'], ['constant', 'MAX_SIZE'], ['constant.language', 'true null'], ['operator', '=== && ?.'],
      ['punctuation', '; , .'], ['punctuation.special', '${ }'], ['variable', 'nome'], ['variable.language', 'this super'],
      ['property', 'obj.tamanho'], ['function', 'render()'], ['type', 'Promise Map'], ['regexp', '/\\d+/g'],
      ['meta', '@decorator'], ['tag', '<div>'], ['attribute', 'class='], ['invalid', '???'],
    ]
    $('#token-table tbody').innerHTML = TOKEN_SAMPLES.map(([type, sample]) =>
      `<tr><td><code>${type}</code></td><td class="${oneDark.className}" style="font:14px var(--mono)"><span class="${tokenClass(type)}">${esc(sample)}</span></td><td class="mono" style="font-size:12.5px;color:var(--dim)">${colorOf(type)}</td></tr>`).join('')
    $('#var-table').innerHTML = Object.entries(oneDark.colors).map(([k, v]) =>
      `<tr><td><code>${colorVar(k)}</code></td><td class="mono" style="font-size:13px"><span class="chip"><span class="swatch" style="--s:${v}"></span>${k} · ${esc(v)}</span></td></tr>`).join('') +
      `<tr><td><code>--jc-font-family</code> · <code>--jc-font-size</code> · <code>--jc-line-height</code> · <code>--jc-tab-size</code></td><td class="muted">tipografia (opções <code>fontFamily</code>, <code>fontSize</code>, <code>lineHeight</code>, <code>tabSize</code>)</td></tr>`
  }

  // ------------------------------------------------------------------ 5. linguagens
  function compileSpec(spec) {
    const out = {}
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    const toRule = (e) => {
      if (!Array.isArray(e)) return e
      const [match, token, action] = e
      const r = { match, token }
      if (action === '@pop') r.pop = true
      else if (action?.startsWith('@next:')) r.next = action.slice(6)
      else if (action) r.push = action.replace(/^@(push:)?/, '')
      return r
    }
    const flatten = (name) => spec.states[name].flatMap((e) => (e.include ? flatten(e.include) : [toRule(e)]))
    for (const name of Object.keys(spec.states)) {
      out[name] = flatten(name).map((r) => {
        const src = typeof r.match === 'string' ? escapeRe(r.match) : r.match.source
        const flags = (typeof r.match === 'string' ? '' : r.match.flags.replace(/[gy]/g, '')) + 'y' + (Array.isArray(r.token) ? 'd' : '')
        return { ...r, re: new RegExp(src, flags) }
      })
    }
    return out
  }

  /** Same algorithm as the library tokenizer, recording every step. */
  function trace(spec, compiled, line) {
    const stack = [spec.start ?? 'root']
    const steps = []
    let pos = 0
    let guard = 0
    outer: for (;;) {
      for (const rule of compiled[stack.at(-1)]) {
        rule.re.lastIndex = pos
        const m = rule.re.exec(line)
        if (!m) continue
        const end = pos + m[0].length
        const acts = rule.push || rule.pop || rule.next
        if (end === pos && (!acts || ++guard > 50)) continue
        const before = stack.slice()
        let token = rule.token ?? null
        let tokens
        if (typeof token === 'function') token = token(m[0], { line, from: pos, to: end, state: stack.at(-1), match: m })
        if (Array.isArray(token)) {
          tokens = []
          for (let g = 1; g < m.length; g++) if (m.indices[g] && m[g]) tokens.push([m[g], token[g - 1] ?? null])
          token = null
        }
        if (rule.push) stack.push(rule.push)
        else if (rule.next) stack[stack.length - 1] = rule.next
        else if (rule.pop) for (let n = rule.pop === true ? 1 : rule.pop; n > 0 && stack.length > 1; n--) stack.pop()
        steps.push({ from: pos, to: end, text: m[0], token, tokens: tokens ?? (end > pos ? [[m[0], token]] : []), before, after: stack.slice(), rule })
        pos = end
        continue outer
      }
      if (pos >= line.length) break
      steps.push({ from: pos, to: pos + 1, text: line[pos], token: null, tokens: [[line[pos], null]], before: stack.slice(), after: stack.slice(), rule: null })
      pos++
    }
    return steps
  }

  function describeRule(rule, step) {
    if (!rule) return '// nenhuma regra casou: 1 caractere como texto puro'
    const re = typeof rule.match === 'string' ? `'${rule.match}'` : String(rule.match)
    const short = re.length > 70 ? re.slice(0, 67) + '…/' : re
    let tok
    if (typeof rule.token === 'function') tok = `${rule.token.name || 'fn'}  // → ${step.token === null ? 'null' : `'${step.token}'`}`
    else if (Array.isArray(rule.token)) tok = `[${rule.token.map((t) => (t === null ? 'null' : `'${t}'`)).join(', ')}]`
    else tok = rule.token == null ? 'null' : `'${rule.token}'`
    let out = `{\n  match: ${short},\n  token: ${tok},`
    if (rule.push) out += `\n  push: '${rule.push}',`
    if (rule.next) out += `\n  next: '${rule.next}',`
    if (rule.pop) out += `\n  pop: ${rule.pop},`
    return out + '\n}'
  }

  INIT.linguagens = () => {
    // --- ready-made languages
    const mdLang = createMarkdown({ codeLanguages: [javascript, typescript, jsx, tsx, css, html, json, shell, sql] })
    const READY = [
      ['javascript', 'JavaScript', javascript, 'javascript', 'exemplo.js', '#e5c07b',
        "import { readFile } from 'node:fs/promises'\n\n/** Soma os pedidos pagos. */\nexport async function total(path) {\n  const pedidos = JSON.parse(await readFile(path, 'utf8'))\n  return pedidos\n    .filter((p) => p.status === 'pago' && !/teste/i.test(p.cliente))\n    .reduce((soma, p) => soma + p.valor, 0)\n}\n\nconsole.log(`Total: ${await total('./pedidos.json')}`)"],
      ['jsx', 'JSX', jsx, 'javascript', 'Lista.jsx', '#61afef',
        "export function Lista({ itens, onEscolher }) {\n  const [aberta, setAberta] = useState(true)\n  return (\n    <section className=\"lista\" onClick={() => setAberta(!aberta)}>\n      <h2>{itens.length} itens</h2>\n      {aberta && itens.map((it) => (\n        <Item key={it.id} {...it} onClick={() => onEscolher(it)} />\n      ))}\n      <>&copy; Jonacode</>\n    </section>\n  )\n}"],
      ['typescript', 'TypeScript', typescript, 'typescript', 'repo.ts', '#3178c6',
        "type Id = string | number\n\nexport interface Entidade { id: Id; criadoEm?: Date }\n\nexport abstract class Repositorio<T extends Entidade> {\n  private readonly itens = new Map<Id, T>()\n\n  salvar(item: T): T {\n    this.itens.set(item.id, { ...item, criadoEm: new Date() })\n    return item\n  }\n\n  buscar(id: Id): T | undefined {\n    return this.itens.get(id)\n  }\n}\n\nconst config = { tema: 'escuro' } satisfies Record<string, string>"],
      ['tsx', 'TSX', tsx, 'typescript', 'Botao.tsx', '#56b6c2',
        "interface Props { rotulo: string; tipo?: 'primario' | 'secundario' }\n\nexport function Botao<T>({ rotulo, tipo = 'primario' }: Props) {\n  const [n, setN] = useState<number>(0)\n  return <button className={`btn ${tipo}`} onClick={() => setN(n + 1)}>{rotulo} ({n})</button>\n}"],
      ['json', 'JSON', json, 'json', 'package.json', '#98c379',
        "{\n  \"name\": \"meu-app\",\n  \"version\": \"1.0.0\",\n  \"private\": true,\n  \"scripts\": { \"dev\": \"vite\", \"build\": \"vite build\" },\n  \"dependencies\": { \"jonacode\": \"^0.2.0\" },\n  \"keywords\": [\"editor\", 42, null, 1.5e3]\n}"],
      ['css', 'CSS', css, 'css', 'estilo.css', '#c678dd',
        "@media (max-width: 600px) {\n  .card > h2::before, #principal a[href^=\"http\"] {\n    --espaco: calc(1rem + 2px);\n    color: var(--destaque, #61afef);\n    margin: 0 auto !important;\n\n    &:hover { transform: rotate(3deg) scale(1.02) }\n  }\n}"],
      ['html', 'HTML', html, 'html', 'index.html', '#e06c75',
        "<!doctype html>\n<html lang=\"pt-BR\">\n  <head>\n    <style>\n      .destaque { color: #61afef; }\n    </style>\n  </head>\n  <body>\n    <!-- JavaScript e CSS dentro do HTML -->\n    <button class=\"destaque\" onclick=\"contar()\">Contar &rarr;</button>\n    <script type=\"module\">\n      let n = 0\n      window.contar = () => console.log(`cliques: ${++n}`)\n    </" + "script>\n  </body>\n</html>"],
      ['markdown', 'Markdown', mdLang, 'markdown', 'LEIAME.md', '#abb2bf',
        "---\ntitulo: Jonacode\n---\n# Um editor **leve**\n\nTexto com *ênfase*, `código` e [link](https://jonacode.dev).\n\n- [x] 11 linguagens prontas\n- [x] autocomplete\n- [ ] LSP\n\n> Blocos de código usam a linguagem indicada:\n\n```ts\nconst editor: Editor = createEditor(el)\n```\n\n| Linguagem | Tamanho |\n|-----------|--------:|\n| JSON      | 0,4 kB  |"],
      ['sql', 'SQL', sql, 'sql', 'relatorio.sql', '#d19a66',
        "-- clientes com mais pedidos\nWITH ativos AS (\n  SELECT c.id, c.nome, COUNT(p.id) AS pedidos\n  FROM clientes c\n  LEFT JOIN pedidos p ON p.cliente_id = c.id\n  WHERE c.criado_em > $1 AND c.email LIKE '%@exemplo.com'\n  GROUP BY c.id, c.nome\n)\nSELECT * FROM ativos ORDER BY pedidos DESC LIMIT 10;"],
      ['log', 'Log', log, 'log', 'app.log', '#e06c75',
        "2026-09-26T10:00:01.214Z INFO  [http] GET /api/pedidos status=200 duration=12ms ip=10.0.0.7\n2026-09-26T10:00:01.502Z WARN  [http] Resposta lenta POST /api/busca?q=editor duration=1840ms\n2026-09-26T10:00:02.033Z ERROR [worker-2] Falha ao processar pedido id=3f9a2c7e-1b2d-4c5e-9f00-12ab34cd56ef\nTypeError: Cannot read properties of undefined (reading 'valor')\n    at calcularTotal (src/pedidos.js:42:17)\n    at processar (src/worker.js:88:5)\n127.0.0.1 - - [26/Sep/2026:10:00:03 +0000] \"GET /static/app.js HTTP/1.1\" 304 0\nlevel=debug msg=\"cache hit\" key=usuario:42 took=0.8ms"],
      ['shell', 'Shell', shell, 'shell', 'deploy.sh', '#7f848e',
        "#!/usr/bin/env bash\nset -euo pipefail\n\nfor arquivo in dist/*.js; do\n  if [[ -f \"$arquivo\" && $arquivo != *.map ]]; then\n    gzip -9 -k \"$arquivo\" && echo \"ok ${arquivo##*/}\"\n  fi\ndone\n\ncat <<EOF > versao.txt\npublicado em $(date +%F) por $USER\nEOF"],
    ]
    const langsEd = frame($('#langs-editor'), { value: '', language: javascript, extensions: basicSetup() })
    langsEd.dom.style.height = '330px'
    const importOf = ([id, , , file]) => `import { ${id === 'markdown' ? 'createMarkdown' : id} } from 'jonacode/languages/${file}'`
    const showLang = (i) => {
      const [id, , lang, , filename, , value] = READY[i]
      langsEd.setOptions({ language: lang, value })
      $('#langs-file').textContent = filename
      $('#langs-meta').textContent = `+${kb(SIZES.parts[id])} gzip`
      $$('.preset', $('#langs-tabs')).forEach((b, j) => b.setAttribute('aria-pressed', String(i === j)))
    }
    $('#langs-tabs').innerHTML = READY.map(([id, label, , , , color], i) => `<button class="preset" type="button" role="tab" aria-pressed="${i === 0}" data-i="${i}"><i style="--a:${color}"></i>${esc(label)}</button>`).join('')
    $('#langs-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('.preset')
      if (b) showLang(+b.dataset.i)
    })
    showLang(6)
    $('#langs-table').innerHTML = `<thead><tr><th>Linguagem</th><th>Import</th><th>Nomes aceitos</th><th class="num">gzip</th></tr></thead><tbody>${
      READY.map((r) => {
        const [id, label, lang] = r
        const names = [lang.name, ...lang.aliases, ...lang.extensions].filter((x, i, a) => a.indexOf(x) === i)
        const note = id === 'html' ? ' <small class="muted">com JS e CSS</small>' : id === 'markdown' ? ' <small class="muted">blocos com as linguagens que você passar</small>' : ''
        return `<tr><td>${esc(label)}${note}</td><td><code>${esc(importOf(r))}</code></td><td class="mono" style="font-size:12.5px">${esc(names.join(' · '))}</td><td class="num">${kb(SIZES.parts[id])}</td></tr>`
      }).join('')}</tbody>`

    // --- nested languages: the state stack at the cursor
    const embedSrc = [
      '<!doctype html>', '<html lang="pt-BR">', '<head>', '  <style>', '    .card { color: #61afef; }', '  </style>', '</head>',
      '<body>', '  <!-- mova o cursor por aqui -->', '  <button onclick="abrir(1)">Abrir</button>', '  <script>',
      '    const msg = `Olá, ${nome}!`', '    document.title = msg', '  </' + 'script>', '</body>', '</html>',
    ].join('\n')
    const eed = frame($('#embed-editor'), { value: embedSrc, language: html, extensions: basicSetup() })
    const LABEL = { html: 'HTML', javascript: 'JavaScript', css: 'CSS' }
    const drawEmbed = () => {
      const pos = eed.selection.head
      let st = html.initialState
      for (let i = 0; i < pos.line; i++) st = html.endState(eed.doc.line(i), st)
      st = html.stateAtColumn(eed.doc.line(pos.line), st, pos.col)
      const names = st.stack
      let inner = false
      $('#embed-stack').innerHTML = names.map((n, i) => {
        if (n.startsWith('@')) inner = true
        const cls = [i === 0 ? 'bottom' : '', i === names.length - 1 ? 'top' : '', n.startsWith('@') ? 'lang' : '', inner && !n.startsWith('@') ? 'inner' : ''].join(' ')
        return `<div class="stack-item ${cls}">${esc(n.startsWith('@') ? LABEL[n.slice(1)] ?? n.slice(1) : n)}</div>`
      }).join('')
      const lang = eed.languageAt(pos)
      $('#embed-lang').textContent = LABEL[lang.name] ?? lang.name
      const c = lang.comments
      $('#embed-comment').textContent = c.line ?? (c.block ? c.block.join(' … ') : '—')
    }
    eed.on('selection', drawEmbed)
    eed.on('change', drawEmbed)
    eed.setSelection({ line: 11, col: 16 }, undefined, false)
    drawEmbed()

    const compiled = compileSpec(javascriptSpec)
    const EXAMPLES = [
      'const saudacao = `Olá, ${nome.trim()}!` // oi',
      'if (/^\\d+$/.test(valor)) total = total / 2',
      '/* nota */ fetch(url).then((r) => r.json())',
      'const s = "aspas \\"escapadas\\"\\n"',
      'export default class Fila extends Array {',
    ]
    const select = $('#step-example')
    const input = $('#step-input')
    select.innerHTML = EXAMPLES.map((e, i) => `<option value="${i}">Exemplo ${i + 1}</option>`).join('') + '<option value="-1">Meu código</option>'
    const tape = $('#tape')
    let steps = []
    let at = 0
    let playing = 0
    const charW = () => {
      const probe = document.createElement('span')
      probe.textContent = 'x'.repeat(20)
      tape.appendChild(probe)
      const w = probe.getBoundingClientRect().width / 20
      probe.remove()
      return w
    }
    const load = (line) => {
      input.value = line
      steps = trace(javascriptSpec, compiled, line)
      at = 0
      draw()
    }
    const draw = () => {
      const line = input.value
      const step = steps[at - 1]
      // tape: processed text colored by its tokens
      let html = ''
      for (let i = 0; i < at; i++) {
        for (const [text, type] of steps[i].tokens) html += `<span class="done" style="color:${type ? colorOf(type) : oneDark.colors.foreground}">${esc(text)}</span>`
      }
      const doneLen = at ? steps[at - 1].to : 0
      html += esc(line.slice(doneLen))
      const w = charW()
      const box = step ? `<div class="tape-box" style="left:${step.from * w - 3}px;width:${Math.max(step.to - step.from, 0.35) * w + 6}px"></div><div class="tape-pos" style="left:${step.from * w}px">pos ${step.from}</div>` : ''
      tape.innerHTML = html + box
      // stack
      const stack = step ? step.after : [javascriptSpec.start ?? 'root']
      $('#stack').innerHTML = stack.map((s, i) => `<div class="stack-item ${i === 0 ? 'bottom' : ''}">${s}</div>`).join('')
      $('#rule').textContent = step ? describeRule(step.rule, step) : '// aperte ▶ ou "Avançar"'
      $('#tokens-out').innerHTML = steps.slice(0, at).flatMap((s) => s.tokens).filter(([t, type]) => type || t.trim())
        .map(([t, type]) => `<span class="tok"><b style="color:${type ? colorOf(type) : 'var(--text)'}">${esc(t)}</b><small>${type ?? 'null'}</small></span>`).join('')
      $('#step-count').textContent = `passo ${at} de ${steps.length}`
    }
    const stopPlay = () => {
      clearInterval(playing)
      playing = 0
      $('#step-play').textContent = '▶ Reproduzir'
    }
    $('#step-next').onclick = () => { stopPlay(); if (at < steps.length) at++; draw() }
    $('#step-prev').onclick = () => { stopPlay(); if (at > 0) at--; draw() }
    $('#step-reset').onclick = () => { stopPlay(); at = 0; draw() }
    $('#step-play').onclick = () => {
      if (playing) return stopPlay()
      if (at >= steps.length) at = 0
      $('#step-play').textContent = '❚❚ Pausar'
      playing = setInterval(() => {
        if (at >= steps.length) return stopPlay()
        at++
        draw()
      }, 650)
    }
    select.onchange = () => {
      stopPlay()
      if (select.value !== '-1') load(EXAMPLES[+select.value])
      else input.focus()
    }
    input.oninput = () => {
      stopPlay()
      select.value = '-1'
      steps = trace(javascriptSpec, compiled, input.value)
      at = steps.length
      draw()
    }
    load(EXAMPLES[0])
    // Autoplay once when the stepper scrolls into view.
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !reduced) {
        $('#step-play').click()
        io.disconnect()
      }
    }, { threshold: 0.6 })
    io.observe($('.stepper'))

    // Language lab
    const SPEC = `// A gramática inteira da JonaLang. Edite e veja o lado direito mudar.
return defineLanguage({
  name: 'jonalang',
  comments: { line: '#' },
  brackets: [['{', '}'], ['(', ')']],
  states: {
    root: [
      [/#.*/, 'comment'],
      [/"/, 'string', '@texto'],
      [/\\d+(,\\d+)?/, 'number'],
      // "funcao nome" → palavra-chave + nome de função
      [/(funcao)(\\s+)([\\wà-ú]+)/, ['keyword', null, 'function']],
      {
        match: /[\\wà-úÀ-Ú]+/,
        token: words({
          keyword: ['se', 'senao', 'enquanto', 'retorne', 'var', 'e', 'ou'],
          'constant.language': ['verdadeiro', 'falso', 'nulo'],
          'type.builtin': ['mostre'],
        }, 'variable'),
      },
      [/[{}()]/, 'punctuation.bracket'],
      [/[-+*/=<>!]+/, 'operator'],
    ],
    texto: [
      [/\\{[^}]*\\}/, 'punctuation.special'],  // interpolação {nome}
      [/[^"{]+/, 'string'],
      [/"/, 'string', '@pop'],
    ],
  },
})`
    const SAMPLE = `# JonaLang: uma linguagem inventada 🇧🇷
funcao saudacao(nome) {
  se (nome == nulo) {
    retorne "Olá, mundo!"
  } senao {
    retorne "Olá, {nome}!"
  }
}

var contador = 0
enquanto (contador < 3 e verdadeiro) {
  mostre(saudacao("Jonathan"))
  contador = contador + 1
}`
    const status = $('#lab-status')
    const code = frame($('#lab-code'), { value: SAMPLE, extensions: basicSetup() })
    const applySpec = (src) => {
      try {
        const lang = new Function('defineLanguage', 'words', src)(defineLanguage, words)
        if (!lang || !lang.tokenize) throw new Error('a gramática precisa retornar defineLanguage({...})')
        code.setOptions({ language: lang })
        status.innerHTML = `<span class="accent">✓ gramática aplicada</span><span><b>${Object.keys(lang.spec.states).length}</b> estados</span>`
      } catch (err) {
        status.innerHTML = `<span class="lab-error">✗ ${esc(err.message)}</span>`
      }
    }
    let t = 0
    frame($('#lab-spec'), {
      value: SPEC,
      language: javascript,
      extensions: basicSetup(),
      onChange: (value) => {
        clearTimeout(t)
        t = setTimeout(() => applySpec(value), 250)
      },
    })
    applySpec(SPEC)

    // Custom tokens lab
    const TOK_SPEC = `// Capture tipos novos e estilize como quiser. Edite!
return [
  // TODO / FIXME dentro de comentários
  tokenRule({ match: /\\b(TODO|FIXME)\\b/, token: 'todo', inside: 'comment' }),
  // cores hex dentro de strings, com CSS próprio por token
  tokenRule({
    match: /#[\\da-f]{6}\\b/i, token: 'color', inside: 'string',
    style: (m) => \`--swatch:\${m[0]}\`,
  }),
  // @menções em qualquer lugar
  tokenRule({ match: /@[a-z]+/i, token: 'mention', keepType: false }),
  tokenStyles({
    'comment todo': { background: '#e5c07b', color: '#282c34', fontWeight: 'bold', fontStyle: 'normal', borderRadius: '3px' },
    'string color': 'box-shadow: inset 0 -3px var(--swatch)',
    mention: { color: '#56b6c2', textDecoration: 'underline dotted' },
  }),
]`
    const TOK_CODE = `// TODO: trocar a paleta pelo tema do usuário
const paleta = {
  primaria: '#61afef',
  destaque: '#c678dd',
  aviso: '#e5c07b', // FIXME: contraste baixo no tema claro
}

// Revisado por @jonathan e @maria
export function cor(nome) {
  return paleta[nome] ?? '#abb2bf'
}`
    const tokStatus = $('#tok-status')
    const tokCode = frame($('#tok-code'), { value: TOK_CODE, language: javascript, extensions: [basicSetup(), tokenInspector()] })
    const applyTokens = (src) => {
      try {
        const ext = new Function('tokenRule', 'tokenStyles', 'extendLanguage', src)(tokenRule, tokenStyles, extendLanguage)
        tokCode.setOptions({ extensions: [basicSetup(), tokenInspector(), ext] })
        tokStatus.innerHTML = '<span class="accent">✓ regras aplicadas</span><span>passe o mouse nos tokens</span>'
      } catch (err) {
        tokStatus.innerHTML = `<span class="lab-error">✗ ${esc(err.message)}</span>`
      }
    }
    let tt = 0
    frame($('#tok-spec'), {
      value: TOK_SPEC, language: javascript, extensions: basicSetup(),
      onChange: (v) => { clearTimeout(tt); tt = setTimeout(() => applyTokens(v), 300) },
    })
    applyTokens(TOK_SPEC)
  }

  // ------------------------------------------------------------------ 6. por dentro
  function flowDiagram() {
    const box = (x, y, w, h, title, sub, color) =>
      `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="#282c34" stroke="${color}" stroke-opacity=".55"/>` +
      `<text x="${x + 14}" y="${y + 25}" fill="#eef1f6" font-size="13" font-weight="600">${title}</text>` +
      `<text x="${x + 14}" y="${y + 44}" fill="#808898" font-size="11">${sub}</text></g>`
    const paths = [
      ['M150 140 H190', '#c678dd'], ['M330 140 H370', '#61afef'], ['M510 140 H550', '#98c379'],
      ['M660 140 C690 140 690 55 720 55', '#d19a66'], ['M660 140 H720', '#e06c75'], ['M660 140 C690 140 690 225 720 225', '#56b6c2'],
      ['M860 55 C900 55 900 140 940 140', '#e5c07b'], ['M860 140 H940', '#e5c07b'], ['M860 225 C900 225 900 140 940 140', '#e5c07b'],
    ]
    let svg = `<svg viewBox="0 0 1100 280" role="img" aria-label="Fluxo: entrada, comandos, transação, estado e render">`
    svg += paths.map(([d, c]) => `<path d="${d}" fill="none" stroke="${c}" stroke-opacity=".35" stroke-width="2" stroke-dasharray="4 5"/>`).join('')
    svg += box(10, 108, 140, 64, 'Teclado · mouse', 'clipboard · IME', '#c678dd')
    svg += box(190, 108, 140, 64, '&lt;textarea&gt;', 'invisível, no cursor', '#61afef')
    svg += box(370, 108, 140, 64, 'Keymap', 'input handlers', '#98c379')
    svg += box(550, 108, 110, 64, 'dispatch()', 'transação', '#d19a66')
    svg += box(720, 23, 140, 64, 'Documento', 'array de linhas', '#d19a66')
    svg += box(720, 108, 140, 64, 'Histórico', 'agrupa digitação', '#e06c75')
    svg += box(720, 193, 140, 64, 'Highlighter', 'estado por linha', '#56b6c2')
    svg += box(940, 100, 150, 80, 'Render', 'linhas visíveis', '#e5c07b')
    svg += `<text x="954" y="163" fill="#808898" font-size="11">gutters · camadas</text>`
    if (!reduced) {
      paths.forEach(([d, c], i) => {
        const delay = i < 3 ? i * 0.45 : i < 6 ? 1.35 : 1.9
        svg += `<circle r="4.5" fill="${c}" class="flow-dot" style="color:${c}"><animateMotion dur="0.5s" begin="${delay}s;flowloop.end+${delay}s" path="${d}" fill="freeze"/><animate attributeName="opacity" values="0;1;1;0" dur="0.5s" begin="${delay}s;flowloop.end+${delay}s" fill="freeze"/></circle>`
      })
      svg += `<rect width="0" height="0"><animate id="flowloop" attributeName="x" from="0" to="0" dur="3.2s" begin="0s;flowloop.end"/></rect>`
    }
    return svg + '</svg>'
  }

  function bigDocument() {
    const unit = `// Módulo gerado automaticamente
export class Pedido {
  #itens = []
  constructor(id, cliente = 'anônimo') {
    this.id = id
    this.cliente = cliente
  }
  adicionar(item, qtd = 1) {
    this.#itens.push({ ...item, qtd })
    return this
  }
  get total() {
    return this.#itens.reduce((soma, { preco, qtd }) => soma + preco * qtd, 0)
  }
  /* resumo multi-linha
     com template string abaixo */
  toString() {
    return \`Pedido #\${this.id}: \${this.#itens.length} itens, R$ \${this.total.toFixed(2)}\`
  }
}
`.split('\n')
    const out = new Array(100000)
    for (let i = 0; i < out.length; i++) out[i] = unit[i % unit.length]
    return out.join('\n')
  }

  INIT['por-dentro'] = () => {
    $('#flow').innerHTML = flowDiagram()

    // --- virtualization
    const ved = frame($('#virt-editor'), { value: bigDocument(), language: javascript, extensions: [lineNumbers(), highlightActiveLine()] })
    const linesEl = $('.jc-lines', ved.dom)
    const rebuilt = new Set()
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.target === linesEl) m.addedNodes.forEach((n) => rebuilt.add(n))
        else rebuilt.add(m.target.closest?.('.jc-line') ?? m.target)
      }
    }).observe(linesEl, { childList: true, subtree: true })
    const sc = ved.scrollDOM
    const rail = $('#rail')
    const domcol = $('#domcol')
    let scheduled = false
    const update = () => {
      scheduled = false
      const lh = ved.lineHeight
      const padTop = ved.coordsAtPos({ line: 0, col: 0 }).top
      const els = [...linesEl.children]
      const firstVisible = Math.floor((sc.scrollTop - padTop) / lh)
      const lastVisible = Math.floor((sc.scrollTop + sc.clientHeight - padTop) / lh)
      const rows = els.map((el) => ({ el, line: Math.round((parseFloat(el.style.top) - padTop) / lh) })).sort((a, b) => a.line - b.line)
      let reb = 0
      domcol.innerHTML = rows.slice(0, 40).map(({ el, line }) => {
        const isNew = rebuilt.has(el)
        if (isNew) reb++
        const vis = line >= firstVisible && line <= lastVisible
        return `<div class="node ${isNew ? 'rebuilt' : ''} ${vis ? 'visible' : ''}"><span>L ${num(line + 1)}</span><span>div</span></div>`
      }).join('')
      reb = els.filter((el) => rebuilt.has(el)).length
      rebuilt.clear()
      $('#m-dom').textContent = els.length
      $('#m-rebuilt').textContent = reb
      $('#m-reused').textContent = els.length - reb
      const H = rail.clientHeight
      const total = sc.scrollHeight
      const { from, to } = ved.visibleRange
      Object.assign($('#rail-view').style, { top: (sc.scrollTop / total) * H + 'px', height: Math.max(4, (sc.clientHeight / total) * H) + 'px' })
      Object.assign($('#rail-over').style, { top: ((from * lh) / total) * H + 'px', height: Math.max(6, ((to - from + 1) * lh / total) * H) + 'px' })
    }
    ved.on('render', () => {
      if (!scheduled) {
        scheduled = true
        setTimeout(update, 0)
      }
    })
    rail.addEventListener('mousedown', (e) => {
      const r = rail.getBoundingClientRect()
      const go = (y) => (sc.scrollTop = ((y - r.top) / r.height) * sc.scrollHeight - sc.clientHeight / 2)
      go(e.clientY)
      const move = (ev) => go(ev.clientY)
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up) }
      addEventListener('mousemove', move)
      addEventListener('mouseup', up)
    })
    $('#virt-jump').onclick = () => {
      ved.setSelection({ line: 50000, col: 0 })
      ved.scrollIntoView(undefined, true)
      ved.focus()
    }

    // --- incremental tokenization
    const INCR = `/**
 * Tokenização incremental
 */
const nome = 'Jona'
const msg = \`Olá, \${nome}!
  Esta template string ocupa
  várias linhas\`

function soma(a, b) {
  return a + b // comentário
}

const lista = [1, 2, 3].map((n) => soma(n, 10))
console.log(msg, lista)
`
    const lang = javascript
    const statesOf = (lines) => {
      const out = [lang.initialState]
      for (let i = 0; i < lines.length - 1; i++) out.push(lang.endState(lines[i], out[i]))
      return out
    }
    const LABEL = { comment: 'comment', doubleString: 'string', singleString: 'string', template: 'template', templateExpr: '${…}', templateBlock: '{…}' }
    let states = statesOf(INCR.split('\n'))
    let retok = { lines: [], version: 0 }
    let drawn = -1
    const incrOut = $('#incr-out')
    const ied = frame($('#incr-editor'), {
      value: INCR,
      language: javascript,
      extensions: [
        (editor) => {
          editor.addGutter({
            className: 'state-gutter',
            width: () => '96px',
            cell: (line) => {
              const s = states[line]
              if (!s || !s.parent?.parent) return { text: 'root', className: 'st-root' }
              return { text: s.stack.slice(1).map((n) => LABEL[n] ?? n).join(' › '), className: 'st-' + s.name }
            },
          })
          editor.addLayer({
            className: 'retok-layer',
            render(dom, ed) {
              if (drawn === retok.version) return
              drawn = retok.version
              dom.innerHTML = retok.lines.map((l) => `<div class="retok" style="top:${ed.coordsAtPos({ line: l, col: 0 }).top}px"></div>`).join('')
            },
          })
        },
        lineNumbers(),
        bracketMatching(),
        closeBrackets(),
      ],
    })
    ied.on('change', (ev) => {
      const old = states
      states = statesOf(ied.doc.lines)
      const c = ev.changes[0]
      const from = Math.min(...ev.changes.map((x) => x.from.line))
      const newTo = from + c.inserted.length - 1
      const delta = c.inserted.length - (c.to.line - c.from.line + 1)
      const lines = [from]
      let converged = -1
      for (let j = from + 1; j < states.length; j++) {
        if (j > newTo && old[j - delta] === states[j]) {
          converged = j
          break
        }
        lines.push(j)
      }
      retok = { lines, version: retok.version + 1 }
      incrOut.innerHTML = `Edição na linha <b>${from + 1}</b> → <b>${lines.length}</b> linha${lines.length > 1 ? 's' : ''} re-tokenizada${lines.length > 1 ? 's' : ''}` +
        (converged >= 0 ? `, convergiu na linha <b>${converged + 1}</b> (daqui para baixo, nada muda)` : ', até o fim do documento')
    })
    const incrActions = [
      ['Digitar numa linha', () => ied.dispatch({ changes: { from: { line: 9, col: 13 }, insert: ' + 1' }, origin: 'input' })],
      ['Abrir /* na linha 4', () => ied.dispatch({ changes: { from: { line: 3, col: 0 }, insert: '/* ' }, origin: 'input' })],
      ['Fechar com */', () => {
        const line = ied.doc.lines.findIndex((l) => l.startsWith('/* const nome'))
        if (line >= 0) ied.dispatch({ changes: { from: { line, col: ied.doc.line(line).length }, insert: ' */' }, origin: 'input' })
      }],
      ['Apagar uma crase `', () => {
        const line = ied.doc.lines.findIndex((l) => l.includes('várias linhas`'))
        if (line >= 0) ied.dispatch({ changes: { from: { line, col: ied.doc.line(line).length - 1 }, to: { line, col: ied.doc.line(line).length } }, origin: 'input' })
      }],
      ['Restaurar', () => ied.setValue(INCR)],
    ]
    for (const [label, run] of incrActions) {
      const b = document.createElement('button')
      b.className = 'btn small'
      b.type = 'button'
      b.textContent = label
      b.onclick = () => { run(); ied.focus() }
      $('#incr-buttons').appendChild(b)
    }

    // --- input pipeline log
    const log = $('#input-log')
    const ied2 = frame($('#input-editor'), {
      value: '// Digite, cole, use atalhos (Mod-/, Alt-↑…)\n// e acompanhe os eventos ao lado →\nconst ideia = ',
      language: javascript,
      extensions: basicSetup(),
    })
    ied2.setSelection(ied2.doc.end)
    let lastLine = null
    let lastCount = 1
    const write = (cls, label, detail = '') => {
      const text = `${label.padEnd(12)} ${detail}`
      if (lastLine && lastLine.dataset.text === text) {
        lastCount++
        lastLine.innerHTML = `<span class="${cls}">${esc(label.padEnd(12))}</span> ${esc(detail)} <span class="r">×${lastCount}</span>`
      } else {
        const div = document.createElement('div')
        div.dataset.text = text
        div.innerHTML = `<span class="${cls}">${esc(label.padEnd(12))}</span> ${esc(detail)}`
        log.appendChild(div)
        lastLine = div
        lastCount = 1
        while (log.childElementCount > 150) log.firstElementChild.remove()
      }
      log.scrollTop = log.scrollHeight
    }
    write('r', 'pronto', '— clique no editor e digite')
    const input = ied2.inputDOM
    input.addEventListener('keydown', (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
      const mods = (e.altKey ? 'Alt-' : '') + (e.ctrlKey ? 'Ctrl-' : '') + (e.metaKey ? 'Meta-' : '') + (e.shiftKey ? 'Shift-' : '')
      write('k', 'keydown', mods + (e.key === ' ' ? 'Space' : e.key) + (e.defaultPrevented ? '  → comando' : ''))
    })
    input.addEventListener('input', (e) => { if (e.data) write('i', 'input', JSON.stringify(e.data)) })
    for (const t of ['compositionstart', 'compositionupdate', 'compositionend']) input.addEventListener(t, (e) => write('s', t.replace('composition', 'ime:'), JSON.stringify(e.data ?? '')))
    for (const t of ['copy', 'cut', 'paste']) input.addEventListener(t, () => write('s', t, 'clipboard'))
    ied2.on('change', (ev) => write('t', 'transação', `origin=${ev.origin} · ${ev.changes.length} mudança${ev.changes.length > 1 ? 's' : ''}`))
    ied2.on('selection', (sel) => write('r', 'seleção', `${sel.head.line + 1}:${sel.head.col + 1}`))
    ied2.on('render', (ed) => write('r', 'render', `linhas ${ed.visibleRange.from + 1}–${ed.visibleRange.to + 1}`))

    // --- geometry ruler: a cursor walks each row and shows how its x is computed
    const ruler = $('#ruler')
    const cw = ved.charWidth * (18 / 14)
    const rows = []
    const row = (text, note, measure) => {
      const cells = []
      if (measure) {
        const probe = document.createElement('span')
        probe.style.cssText = 'font:18px var(--mono);white-space:pre;position:absolute;visibility:hidden'
        document.body.appendChild(probe)
        let x = 0
        let col = 0
        for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
          probe.textContent = segment
          const w = probe.getBoundingClientRect().width
          cells.push({ ch: segment, w, x, col, how: `Range no DOM → x = ${x.toFixed(1)}px` + (segment.length > 1 ? ` · 1 grafema = ${segment.length} unidades UTF-16` : '') })
          x += w
          col += segment.length
        }
        probe.remove()
      } else {
        let v = 0
        for (let i = 0; i < text.length; i++) {
          const ch = text[i]
          const width = ch === '\t' ? 4 - (v % 4) : 1
          cells.push({ ch: ch === '\t' ? '⇥' : ch, w: width * cw, x: v * cw, col: i, tab: ch === '\t', how: `coluna visual ${v} × ${cw.toFixed(2)} = ${(v * cw).toFixed(1)}px` + (ch === '\t' ? ' · tab ocupa ' + width + ' colunas' : '') })
          v += width
        }
      }
      rows.push(cells)
      const r = rows.length - 1
      return `<div class="muted mono" style="font-size:12px;margin:0 0 8px">${note}</div><div class="ruler-row" data-row="${r}">` +
        cells.map((c, i) => `<span class="cell ${c.tab ? 'tab' : ''}" data-i="${i}" style="width:${c.w}px">${esc(c.ch)}</span>`).join('') +
        `</div><div class="mono ruler-how" data-how="${r}" style="font-size:12px;color:var(--accent);margin-top:8px;min-height:18px"></div>`
    }
    ruler.innerHTML = row('const x = 1;', 'ASCII: aritmética pura') +
      '<div style="height:18px"></div>' + row('\tif (a)', 'Tab: avança até a próxima parada (tabSize 4)') +
      '<div style="height:18px"></div>' + row('Olá 👍🏽 世界!', 'Emoji / CJK: largura medida com um Range no DOM', true)
    let step = 0
    const tickRuler = () => {
      rows.forEach((cells, r) => {
        const i = step % cells.length
        $$(`[data-row="${r}"] .cell`, ruler).forEach((el, j) => el.classList.toggle('hot', j === i))
        $(`[data-how="${r}"]`, ruler).textContent = `col ${cells[i].col} → ${cells[i].how}`
      })
      step++
    }
    tickRuler()
    if (!reduced) setInterval(tickRuler, 900)

    // --- fonts and sizes
    const fed = frame($('#font-editor'), {
      value: `// Clique no fim das linhas, selecione, troque a fonte e o tamanho.\nconst preço = 'R$ 12,50' // acentos: ç, ã, é\n\tif (ok) {\t// tabs\n\t\treturn "😀👍🏽🇧🇷 emoji"\n\t}\nconst 日本語 = "漢字テキスト" // CJK\n/* comentário em itálico */ const depois = 1\nconst longa = '${'abcdefghij'.repeat(12)}' // fim`,
      language: javascript,
      extensions: basicSetup(),
    })
    addZone(fed, { line: 6, lines: 1, content: '↑ uma zona de 1 linha: cresce junto com a fonte', class: 'zone-note' })
    const showMetrics = () => {
      $('#font-metrics').textContent = `caractere ${fed.charWidth.toFixed(2)}px · linha ${fed.lineHeight}px · ${fed.monospace ? 'monoespaçada' : 'proporcional'}`
    }
    fed.on('render', showMetrics)
    const applyFont = () => {
      const size = Number($('#font-size').value)
      const lh = Number($('#font-lh').value)
      $('#font-size-v').textContent = size + 'px'
      $('#font-lh-v').textContent = lh.toFixed(2).replace(/0$/, '')
      fed.setOptions({ fontFamily: $('#font-family').value, fontSize: size, lineHeight: lh, lineWrapping: $('#font-wrap').checked })
    }
    for (const id of ['#font-family', '#font-size', '#font-lh', '#font-wrap']) $(id).addEventListener('input', applyFont)
    applyFont()

    // --- history
    const hist = $('#hist')
    const done = []
    let undone = []
    let broken = false
    const hed = frame($('#hist-editor'), { value: 'Digite rápido, depois pause.\n', extensions: [lineNumbers()] })
    hed.setSelection(hed.doc.end)
    hed.dom.addEventListener('mousedown', () => (broken = true))
    const describe = (ev) => {
      if (ev.origin.startsWith('delete')) return '⌫'
      const text = ev.changes.map((c) => c.inserted.join('↵')).join('')
      return text
    }
    const drawHist = () => {
      const chip = (e) => `<span class="entry ${e.count > 1 ? 'merged' : ''}" title="${esc(e.origin)}">${esc(e.text || '·')}${e.count > 1 ? ` <small class="muted">×${e.count}</small>` : ''}</span>`
      hist.innerHTML = `<div class="lane"><span>desfazer</span>${done.slice(-14).map(chip).join('')}</div><div class="lane redo"><span>refazer</span>${undone.slice(-14).map(chip).join('')}</div>` +
        `<div class="muted mono" style="font-size:12px">${done.length} passo(s) no histórico · digitação em &lt; 600 ms é mesclada</div>`
    }
    hed.on('change', (ev) => {
      const now = performance.now()
      if (ev.origin === 'undo') { const e = done.pop(); if (e) undone.push(e) }
      else if (ev.origin === 'redo') { const e = undone.pop(); if (e) done.push(e) }
      else if (ev.origin !== 'setValue') {
        undone = []
        const last = done.at(-1)
        const mergeable = ['input', 'delete.backward', 'delete.forward'].includes(ev.origin)
        const text = describe(ev)
        if (last && mergeable && !broken && last.origin === ev.origin && now - last.time < 600) {
          last.text = ev.origin === 'input' ? last.text + text : last.text + text
          last.count++
          last.time = now
        } else done.push({ origin: ev.origin, text, time: now, count: 1 })
        broken = false
      }
      drawHist()
    })
    $('#hist-undo').onclick = () => { hed.undo(); hed.focus() }
    $('#hist-redo').onclick = () => { hed.redo(); hed.focus() }
    drawHist()

    // --- line wrapping + height map
    const WRAP_TEXT = `// Linhas longas quebram na largura do editor, e as curtas ocupam uma linha visual
const mensagem = 'Jonacode calcula as quebras em JavaScript: depois de espaços quando possível e no meio da palavra quando não há outro jeito.'
function pequena() {}
const lista = ['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze']
// Mude a largura com o controle acima e observe o mapa de alturas ao lado.
const url = 'https://exemplo.com/uma/url/muito/longa/sem/espacos/que/precisa/ser/quebrada/no/meio'
`
    const wrapEd = frame($('#wrap-editor'), { value: WRAP_TEXT, language: javascript, lineWrapping: true, extensions: [lineNumbers()] })
    const hm = $('#heightmap')
    const drawHeightMap = () => {
      const n = wrapEd.doc.lineCount
      let total = 0
      let html = ''
      const lh = wrapEd.lineHeight
      for (let i = 0; i < n; i++) {
        const rows = Math.round(wrapEd.lineBlock(i).height / lh)
        total += rows
        html += `<div class="hm-row ${rows > 1 ? 'multi' : ''}"><span>L${i + 1}</span><i class="hm-bar" style="width:${Math.min(100, rows * 22)}%"></i><span>${rows}</span></div>`
      }
      hm.innerHTML = html + `<div class="hm-total">${n} linhas → ${total} linhas visuais</div>`
    }
    wrapEd.on('render', drawHeightMap)
    $('#wrap-width').addEventListener('input', (e) => ($('#wrap-frame').style.width = e.target.value + 'px'))
    $('#wrap-on').addEventListener('change', (e) => wrapEd.setOptions({ lineWrapping: e.target.checked }))

    // --- first-char dispatch visualization
    const rootRules = compileSpec(javascriptSpec).root
    const dispatchInput = $('#dispatch-char')
    const drawDispatch = () => {
      const ch = dispatchInput.value.slice(-1) || ' '
      const code = ch.charCodeAt(0)
      let tried = 0
      const rows = rootRules.map((rule) => {
        const set = firstChars(rule.re.source, rule.re.flags)
        const on = code >= 128 || !set || !!set[code]
        if (on) tried++
        const src = typeof rule.match === 'string' ? `'${rule.match}'` : String(rule.match)
        return `<div class="${on ? 'tried' : ''}"><span>${on ? '✓' : '·'}</span><span>${esc(src.length > 80 ? src.slice(0, 77) + '…' : src)}</span><span>${set ? '' : 'sempre'}</span></div>`
      })
      $('#dispatch-rules').innerHTML = rows.join('')
      $('#dispatch-summary').textContent = `"${ch}": ${tried} de ${rootRules.length} regras testadas`
    }
    dispatchInput.addEventListener('input', drawDispatch)
    drawDispatch()

    // --- paint benchmark (on the 100k-line editor)
    $('#paint-bench').onclick = () => {
      const sc2 = ved.scrollDOM
      const times = []
      for (let i = 0; i < 60; i++) {
        sc2.scrollTop = Math.floor(((i * 7919) % 97) / 97 * (sc2.scrollHeight - sc2.clientHeight))
        const t = performance.now()
        ved.flush()
        ved.requestRender()
        ved.flush()
        document.body.offsetHeight
        times.push(performance.now() - t)
      }
      times.sort((a, b) => a - b)
      $('#paint-out').textContent = `60 saltos aleatórios: mediana ${times[30].toFixed(2)} ms · p90 ${times[54].toFixed(2)} ms por frame (${document.querySelectorAll('#virt-editor .jc-line').length} linhas no DOM)`
    }

    // --- multiple cursors
    const mcEd = frame($('#mc-editor'), {
      value: `const vermelho = cor('red')\nconst verde = cor('green')\nconst azul = cor('blue')\n\n// Alt+clique adiciona cursores, Mod+D seleciona a próxima ocorrência\n// e Alt+Shift+arrastar seleciona em coluna.`,
      language: javascript,
      extensions: basicSetup(),
    })
    const mcState = $('#mc-state')
    const drawMc = () => {
      const lines = mcEd.ranges.map((r, i) => `<div><span class="${i === mcEd.mainIndex ? 'k' : 'r'}">${i === mcEd.mainIndex ? 'main ' : '     '}</span> <span class="t">{ anchor: ${r.anchor.line}:${r.anchor.col}, head: ${r.head.line}:${r.head.col} }</span></div>`)
      mcState.innerHTML = `<div class="r">ranges (${mcEd.ranges.length})</div>` + lines.join('')
    }
    mcEd.on('selection', drawMc)
    mcEd.on('change', drawMc)
    const mcActions = [
      ['3 cursores', () => mcEd.setSelections([0, 1, 2].map((line) => ({ anchor: { line, col: 6 }, head: { line, col: 6 } })))],
      ['Selecionar "cor" (Mod+D ×3)', () => {
        mcEd.setSelection({ line: 0, col: 18 })
        for (let i = 0; i < 3; i++) J.selectNextOccurrence(mcEd)
      }],
      ['Coluna 6–10', () => mcEd.setSelections([0, 1, 2].map((line) => ({ anchor: { line, col: 6 }, head: { line, col: 10 } })))],
      ['Escape (um cursor)', () => commands.collapseSelections(mcEd)],
    ]
    for (const [label, run] of mcActions) {
      const b = document.createElement('button')
      b.className = 'btn small'
      b.type = 'button'
      b.textContent = label
      b.onclick = () => { run(); mcEd.focus() }
      $('#mc-buttons').appendChild(b)
    }
    drawMc()

    // --- grows with the page
    const growValue = Array.from({ length: 3000 }, (_, i) => `const item${i + 1} = { id: ${i + 1}, nome: 'item ${i + 1}' } // cresce com a página`).join('\n')
    const growEd = frame($('#grow-editor'), { value: growValue, language: javascript, extensions: [lineNumbers()] })
    const drawGrow = () => {
      $('#grow-height').textContent = num(Math.round(growEd.dom.offsetHeight))
      $('#grow-dom').textContent = num($$('.jc-line', growEd.dom).length)
      const r = growEd.visibleRange
      $('#grow-range').textContent = `${num(r.from + 1)}–${num(r.to + 1)}`
    }
    growEd.on('render', drawGrow)
    drawGrow()

    // --- screen reader mirror
    const a11yValue = Array.from({ length: 40 }, (_, i) => [
      '// Cada linha que o cursor visita chega ao leitor de tela.',
      'export function soma(a, b) {', '  return a + b', '}', '',
      'const itens = [1, 2, 3].map((n) => soma(n, 10))', 'console.log(itens.join(", "))', '',
    ][i % 8]).join('\n')
    const aed = frame($('#a11y-editor'), { value: a11yValue, language: javascript, ariaLabel: 'Exemplo de código', extensions: basicSetup() })
    const drawA11y = () => {
      const ta = aed.inputDOM
      const v = ta.value
      $('#a11y-role').innerHTML = `papel <b>textbox</b> · multilinha · rótulo <b>“${esc(ta.getAttribute('aria-label'))}”</b>`
      if (!v) {
        $('#a11y-mirror').textContent = 'Clique no editor: o espelho só existe com o foco nele.'
        return
      }
      const a = ta.selectionStart
      const b = ta.selectionEnd
      const head = aed.selection.head.line
      let n = head - (head % 10) + 1
      const ln = () => `<span class="ln">${String(n++).padStart(3)} </span>`
      const body = esc(v.slice(0, a)) + (a === b ? '<span class="caret"></span>' : `<mark>${esc(v.slice(a, b))}</mark>`) + esc(v.slice(b))
      $('#a11y-mirror').innerHTML = ln() + body.replace(/\n/g, () => '\n' + ln())
    }
    aed.on('render', drawA11y)
    drawA11y()

    // --- millions of lines (compressed mode)
    let bigEd = null
    const drawBig = () => {
      if (!bigEd) return
      $('#big-dom').textContent = num($$('.jc-line', bigEd.dom).length)
    }
    $('#big-open').addEventListener('click', async (e) => {
      const btn = e.currentTarget
      btn.disabled = true
      btn.textContent = 'Gerando o texto…'
      await new Promise((r) => setTimeout(r, 30))
      const N = 2_000_000
      const lines = new Array(N)
      for (let i = 0; i < N; i++) lines[i] = `const linha${i + 1} = soma(${i}, ${i * 2}) // linha ${num(i + 1)}`
      const value = lines.join('\n')
      bigEd?.destroy()
      const t0 = performance.now()
      bigEd = frame($('#big-editor'), { value, language: javascript, extensions: basicSetup() })
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      $('#big-open-ms').textContent = num(Math.round(performance.now() - t0))
      $('#big-lines').textContent = num(bigEd.doc.lineCount)
      $('#big-height').textContent = num(bigEd.doc.lineCount * bigEd.lineHeight + 16)
      bigEd.on('render', drawBig)
      drawBig()
      btn.textContent = 'Abrir 2 milhões de linhas'
      btn.disabled = false
    })
    $('#big-end').addEventListener('click', () => {
      if (!bigEd) return
      bigEd.setSelection(bigEd.doc.end)
      bigEd.focus()
    })
    $('#big-mid').addEventListener('click', () => {
      if (!bigEd) return
      bigEd.dispatch({ selection: { anchor: { line: 999999, col: 0 }, head: { line: 999999, col: 0 } }, scrollIntoView: 'center' })
      bigEd.focus()
    })

    // --- phone
    frame($('#phone-editor'), {
      value: `// Abra esta página no celular: toque\n// duplo seleciona, toque longo também,\n// e as alças ajustam a seleção.\nfunction ola(nome) {\n  return \`Olá, \${nome}!\`\n}\n`,
      language: javascript,
      lineWrapping: true,
      fontSize: 13,
      extensions: basicSetup({ lineNumbers: false }),
    })

    // --- tree-shaking: [id, label, gzip, color, locked?, module, imports]
    const GROUPS = [
      ['Núcleo e basicSetup', [
        ['core', 'createEditor + One Dark', SIZES.core, '#61afef', true, 'jonacode', 'createEditor'],
        ['lineNumbers', 'lineNumbers()', SIZES.parts.lineNumbers, '#c678dd', false, 'jonacode', 'lineNumbers'],
        ['highlightActiveLine', 'highlightActiveLine()', SIZES.parts.highlightActiveLine, '#98c379', false, 'jonacode', 'highlightActiveLine'],
        ['bracketMatching', 'bracketMatching()', SIZES.parts.bracketMatching, '#d19a66', false, 'jonacode', 'bracketMatching'],
        ['closeBrackets', 'closeBrackets()', SIZES.parts.closeBrackets, '#e06c75', false, 'jonacode', 'closeBrackets'],
        ['editingKeymap', 'keymap(editingKeymap)', SIZES.parts.editingKeymap, '#56b6c2', false, 'jonacode', 'keymap, editingKeymap'],
        ['multiCursor', 'multiCursor()', SIZES.parts.multiCursor, '#d19a66', false, 'jonacode', 'multiCursor'],
        ['search', 'search()', SIZES.parts.search, '#98c379', false, 'jonacode', 'search'],
        ['gotoLine', 'gotoLine()', SIZES.parts.gotoLine, '#61afef', false, 'jonacode', 'gotoLine'],
        ['touch', 'touch()', SIZES.parts.touch, '#c678dd', false, 'jonacode', 'touch'],
      ]],
      ['Recursos opcionais', [
        ['folding', 'folding()', SIZES.parts.folding, '#e5c07b', false, 'jonacode', 'folding'],
        ['autocomplete', 'autocomplete()', SIZES.parts.autocomplete, '#56b6c2', false, 'jonacode', 'autocomplete'],
        ['diagnostics', 'linter() + diagnósticos', SIZES.parts.diagnostics, '#e06c75', false, 'jonacode', 'linter'],
        ['zones', 'addZone · addWidget · addOverlay', SIZES.parts.zones, '#c678dd', false, 'jonacode', 'addZone, addWidget, addOverlay'],
        ['diffView', 'diffView()', SIZES.parts.diffView, '#98c379', false, 'jonacode', 'diffView'],
        ['tokenRule', 'tokenRule()', SIZES.parts.tokenRule, '#e06c75', false, 'jonacode', 'tokenRule'],
        ['tokenStyles', 'tokenStyles()', SIZES.parts.tokenStyles, '#61afef', false, 'jonacode', 'tokenStyles'],
        ['treeSitter', 'treeSitter() (sem o web-tree-sitter)', SIZES.parts.treeSitter, '#d19a66', false, 'jonacode/tree-sitter', 'treeSitter'],
        ['collab', 'collab() + yjs() (sem o Yjs)', SIZES.parts.collab, '#56b6c2', false, 'jonacode/collab', 'collab, yjs'],
        ['editorTools', 'editorTools() (IA)', SIZES.parts.editorTools, '#ff7ab2', false, 'jonacode/ai', 'editorTools'],
        ['inlineSuggestion', 'inlineSuggestion() (IA)', SIZES.parts.inlineSuggestion, '#ff7ab2', false, 'jonacode/ai', 'inlineSuggestion'],
      ]],
      ['Linguagens, temas e adaptadores', [
        ['javascript', 'languages/javascript', SIZES.parts.javascript, '#e5c07b', false, 'jonacode/languages/javascript', 'javascript'],
        ['typescript', 'languages/typescript', SIZES.parts.typescript, '#3178c6', false, 'jonacode/languages/typescript', 'typescript'],
        ['json', 'languages/json', SIZES.parts.json, '#98c379', false, 'jonacode/languages/json', 'json'],
        ['html', 'languages/html (+ JS e CSS)', SIZES.parts.html, '#e06c75', false, 'jonacode/languages/html', 'html'],
        ['markdown', 'languages/markdown', SIZES.parts.markdown, '#abb2bf', false, 'jonacode/languages/markdown', 'markdown'],
        ['oneLight', 'themes/one-light', SIZES.parts.oneLight, '#abb2bf', false, 'jonacode/themes/one-light', 'oneLight'],
        ['element', 'element (&lt;jona-code&gt;)', SIZES.parts.element, '#7f848e', false, 'jonacode/element', 'defineJonacodeElement'],
        ['react', 'react (sem o React)', SIZES.parts.react, '#4ec9e1', false, 'jonacode/react', 'CodeEditor'],
        ['vue', 'vue (sem o Vue)', SIZES.parts.vue, '#42b883', false, 'jonacode/vue', 'CodeEditor as VueEditor'],
      ]],
    ]
    const PARTS = GROUPS.flatMap(([, parts]) => parts)
    const on = new Set(['core', 'javascript', 'lineNumbers', 'bracketMatching'])
    $('#checks').innerHTML = GROUPS.map(([title, parts]) => `<div class="checks-group">${title}</div>` + parts.map(([id, label, size, , locked]) =>
      `<label class="${locked ? 'locked' : ''}"><input type="checkbox" data-id="${id}" ${on.has(id) ? 'checked' : ''} ${locked ? 'disabled' : ''}>${label}<span class="kb">${locked ? '' : '+'}${kb(size)}</span></label>`).join('')).join('')
    const shakeCode = frame($('#shake-code'), { language: javascript, readOnly: true, lineWrapping: true })
    const drawShake = () => {
      const active = PARTS.filter(([id]) => on.has(id))
      const total = active.reduce((s, p) => s + p[2], 0)
      const max = PARTS.reduce((s, p) => s + p[2], 0)
      $('#bundle-total').textContent = kb(total)
      $('#bundle-bar').innerHTML = active.map(([, , size, c]) => `<i style="width:${(size / max) * 100}%;background:${c}"></i>`).join('')
      $('#legend').innerHTML = active.map(([, label, , c]) => `<span style="--c:${c}"><i></i>${label}</span>`).join('')
      // One import line per module, in the order of the list.
      const modules = new Map()
      for (const [, , , , , from, names] of active) modules.set(from, [...(modules.get(from) ?? []), names])
      shakeCode.setValue([...modules].map(([from, names]) => `import { ${names.join(', ')} } from '${from}'`).join('\n'))
    }
    $('#checks').addEventListener('change', (e) => {
      const id = e.target.dataset.id
      e.target.checked ? on.add(id) : on.delete(id)
      drawShake()
    })
    drawShake()
  }

  // ------------------------------------------------------------------ 7. extensões
  const logDemo = () => {
    const LEVEL = /\b(ERROR|FATAL)\b|\b(WARN)\b/
    const viewer = frame($('#log-editor'), {
      readOnly: true,
      language: J.log ?? plainText,
      extensions: [basicSetup(), lineClass((t) => { const m = LEVEL.exec(t); return m ? (m[1] ? 'lv-error' : 'lv-warn') : null })],
    })
    const paths = ['/api/pedidos', '/api/clientes/42', '/login', '/static/app.js', '/api/busca?q=editor']
    const levels = ['INFO', 'INFO', 'INFO', 'DEBUG', 'WARN', 'ERROR', 'INFO']
    let n = 0
    const base = Date.parse('2026-09-26T10:00:00Z')
    const line = () => {
      const t = new Date(base + n * 37).toISOString()
      const lv = levels[n % levels.length]
      n++
      if (lv === 'ERROR') return `${t} ERROR [worker-${n % 4}] Falha ao processar pedido id=${(n * 2654435761 >>> 0).toString(16)} duration=${(n % 900) + 12}ms`
      if (lv === 'WARN') return `${t} WARN  [http] Resposta lenta GET ${paths[n % paths.length]} status=200 duration=${(n % 4000) + 800}ms`
      return `${t} ${lv.padEnd(5)} [http] ${['GET', 'POST', 'PUT'][n % 3]} ${paths[n % paths.length]} status=${[200, 201, 304, 404][n % 4]} ip=10.0.${n % 255}.${(n * 13) % 255} duration=${n % 90}ms`
    }
    const append = (count) => {
      const chunk = Array.from({ length: count }, line).join('\n')
      const t0 = performance.now()
      const empty = viewer.doc.lineCount === 1 && !viewer.doc.line(0)
      viewer.append((empty ? '' : '\n') + chunk)
      viewer.flush()
      $('#log-last').textContent = (performance.now() - t0).toFixed(1).replace('.', ',')
    }
    const stats = () => {
      $('#log-lines').textContent = num(viewer.doc.lineCount)
      $('#log-dom').textContent = num($$('.jc-line', viewer.dom).length)
      $('#log-follow').textContent = viewer.visibleRange.to >= viewer.doc.lineCount - 1 ? 'sim' : 'não'
    }
    viewer.on('render', stats)
    append(300)
    let timer = 0
    let perSec = 0
    $('#log-stream').addEventListener('click', (e) => {
      const on = !timer
      e.currentTarget.textContent = on ? '⏸ Pausar' : '▶ Transmitir'
      clearInterval(timer)
      timer = on ? setInterval(() => { append(25); perSec += 25 }, 100) : 0
    })
    setInterval(() => {
      $('#log-rate').textContent = perSec ? `${num(perSec)} linhas/s` : ''
      perSec = 0
    }, 1000)
    $('#log-million').addEventListener('click', () => append(1_000_000))
    $('#log-search').addEventListener('click', () => {
      openSearch(viewer)
      setSearchQuery(viewer, { search: 'ERROR' })
    })
    $('#log-goto').addEventListener('click', () => openGotoLine(viewer))
  }

  // --- decorations
  const decoDemo = () => {
    const ed = frame($('#deco-editor'), {
      value: `// Selecione um trecho e clique em "Marcar a seleção".\n// Depois digite antes dele: a marcação acompanha o texto.\nexport function frete(peso, distancia) {\n  const base = 12.5\n  const porKg = 0.8\n  return base + peso * porKg + distancia * 0.05\n}\n\nconst total = frete(3, 120)`,
      language: javascript,
      extensions: basicSetup(),
    })
    let list = []
    const sync = () => {
      setDecorations(ed, 'demo', list)
      const n = getDecorations(ed, 'demo').length
      $('#deco-count').textContent = n ? `${n} marcaç${n > 1 ? 'ões' : 'ão'}` : ''
    }
    const current = () => getDecorations(ed, 'demo').slice()
    ed.setSelection({ line: 5, col: 9 }, { line: 5, col: 13 })
    $('#deco-mark').addEventListener('click', () => {
      const { from, to } = { from: ed.selection.anchor, to: ed.selection.head }
      const [a, b] = J.cmpPos(from, to) <= 0 ? [from, to] : [to, from]
      if (!J.cmpPos(a, b)) return ed.focus()
      list = [...current(), { from: a, to: b, class: 'deco-mark' }]
      sync()
      ed.focus()
    })
    $('#deco-line').addEventListener('click', () => {
      list = [...current(), { from: { line: ed.selection.head.line, col: 0 }, line: true, class: 'deco-line' }]
      sync()
      ed.focus()
    })
    $('#deco-widget').addEventListener('click', () => {
      const line = ed.selection.head.line
      list = [...current(), {
        from: { line, col: ed.doc.line(line).length },
        class: 'deco-badge',
        widget: () => Object.assign(document.createElement('span'), { textContent: 'revisar' }),
      }]
      sync()
      ed.focus()
    })
    $('#deco-clear').addEventListener('click', () => {
      list = []
      sync()
    })
    list = [
      { from: { line: 3, col: 8 }, to: { line: 3, col: 12 }, class: 'deco-mark' },
      { from: { line: 5, col: 0 }, line: true, class: 'deco-line' },
    ]
    sync()
  }

  // --- diagnostics + tooltips (a toy linter)
  const diagDemo = () => {
    const GLOBALS = new Set(['console', 'Math', 'JSON', 'window', 'document', 'fetch', 'Promise', 'Array', 'Object', 'String', 'Number', 'undefined', 'NaN', 'Infinity', 'setTimeout'])
    const DOCS = {
      reduce: 'Array.prototype.reduce(fn, inicial)\nReduz a lista a um valor, chamando fn(acumulado, item) para cada item.',
      fetch: 'fetch(url, opções?) → Promise<Response>\nFaz uma requisição HTTP.',
      max: 'Math.max(...números) → number\nO maior dos números.',
      log: 'console.log(...dados)\nEscreve no console do navegador.',
    }
    const lev = (a, b) => {
      const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
      for (let j = 1; j <= b.length; j++) d[0][j] = j
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      return d[a.length][b.length]
    }
    const replaceWith = (text) => (ed, d) => ed.dispatch({ changes: { from: d.from, to: d.to, insert: text }, origin: 'input.fix' })
    const toyLint = (ed) => {
      const src = ed.getValue()
      const declared = new Set(GLOBALS)
      for (const m of src.matchAll(/\b(?:let|const|var|function|class)\s+([\w$]+)/g)) declared.add(m[1])
      for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) for (const p of m[1].split(',')) { const n = p.trim().split(/\s|=/)[0]; if (n) declared.add(n) }
      const out = []
      for (let line = 0; line < ed.doc.lineCount; line++) {
        const text = ed.doc.line(line)
        for (const t of ed.getTokens(line)) {
          const word = text.slice(t.from, t.to)
          const from = { line, col: t.from }
          const to = { line, col: t.to }
          if (t.type === 'keyword' && word === 'var') out.push({ from, to, severity: 'warning', message: 'Use let ou const em vez de var.', source: 'lint', actions: [{ name: 'Trocar por let', apply: replaceWith('let') }] })
          else if (t.type === 'operator' && (word === '==' || word === '!=')) out.push({ from, to, severity: 'warning', message: `Use ${word}= para comparar sem conversão de tipo.`, source: 'lint', actions: [{ name: `Trocar por ${word}=`, apply: replaceWith(word + '=') }] })
          else if (t.type === 'variable' && !declared.has(word)) {
            const near = [...declared].filter((d) => lev(d, word) <= 2).sort((a, b) => lev(a, word) - lev(b, word))[0]
            out.push({ from, to, severity: 'error', message: `'${word}' não está definido.${near ? ` Você quis dizer '${near}'?` : ''}`, source: 'lint', actions: near ? [{ name: `Trocar por ${near}`, apply: replaceWith(near) }] : [] })
          }
        }
        const log = text.indexOf('console.log')
        if (log >= 0) out.push({ from: { line, col: log }, to: { line, col: log + 11 }, severity: 'info', message: 'Remova o console.log antes de publicar.', source: 'lint' })
      }
      return out
    }
    const ed = frame($('#diag-editor'), {
      value: `var total = 0\nconst itens = [{ valor: 10 }, { valor: 32 }]\n\nfor (const item of itens) {\n  if (item.valor == 10) total += item.valor\n}\n\nconst maior = Math.max(...itens.map((i) => i.valor))\nconst soma = itens.reduce((acc, i) => acc + i.valor, 0)\nconsole.log(totl, maior, soma)\n\nfetch('/api/pedidos').then((r) => r.json())`,
      language: javascript,
      extensions: [
        basicSetup(),
        linter(toyLint, { inline: true, delay: 250 }),
        hoverTooltip((pos, e) => {
          const [a, b] = e.wordRange(pos)
          const doc = DOCS[e.doc.slice(a, b)]
          if (!doc) return null
          const el = document.createElement('div')
          el.className = 'doc-tip'
          const [sig, ...rest] = doc.split('\n')
          el.innerHTML = `<code>${esc(sig)}</code><p>${esc(rest.join(' '))}</p>`
          return el
        }),
      ],
    })
    const count = () => {
      const list = getDiagnostics(ed)
      const by = (s) => list.filter((d) => d.severity === s).length
      $('#diag-count').textContent = `${by('error')} erro(s) · ${by('warning')} aviso(s) · ${by('info')} info`
    }
    ed.on('render', count)
  }

  // --- autocomplete
  const acDemo = () => {
    const PRODUTOS = [
      ['produtoCaneta', 'R$ 3,90', 'Caneta esferográfica azul'], ['produtoCaderno', 'R$ 24,00', 'Caderno universitário 200 folhas'],
      ['produtoMochila', 'R$ 189,90', 'Mochila impermeável para notebook'], ['produtoLapis', 'R$ 1,50', 'Lápis preto nº 2'],
      ['produtoEstojo', 'R$ 32,00', 'Estojo com zíper'], ['produtoRegua', 'R$ 4,20', 'Régua de 30 cm'],
    ]
    const api = ({ word, signal }) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(PRODUTOS.map(([label, detail, info]) => ({ label, type: 'text', detail, info }))), 200)
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) })
    })
    const ed = frame($('#ac-editor'), {
      value: `const lista = document.getElementById('lista')\nconst contador = document.querySelector('#contador')\n\nfunction adicionar(item) {\n  lista.append(item)\n  contador.textContent = String(lista.children.length)\n}\n\n// digite na linha de baixo\n`,
      language: javascript,
      extensions: [basicSetup(), autocomplete({ sources: [languageWords(), documentWords(), api] })],
    })
    ed.setSelection(ed.doc.end, undefined, false)
  }

  // --- folding
  const foldDemo = () => {
    const ed = frame($('#fold-editor'), {
      value: `import { createEditor } from 'jonacode'\n\nexport class Carrinho {\n  #itens = []\n\n  adicionar(produto, quantidade = 1) {\n    const existente = this.#itens.find((i) => i.id === produto.id)\n    if (existente) {\n      existente.quantidade += quantidade\n    } else {\n      this.#itens.push({ ...produto, quantidade })\n    }\n  }\n\n  get total() {\n    return this.#itens.reduce((soma, i) => soma + i.preco * i.quantidade, 0)\n  }\n}\n\nconst config = {\n  moeda: 'BRL',\n  frete: {\n    gratis: 200,\n    padrao: 19.9,\n  },\n}`,
      language: javascript,
      extensions: [basicSetup(), folding()],
    })
    const count = () => {
      const hidden = ed.folds.reduce((n, f) => n + f.to - f.from + 1, 0)
      $('#fold-count').textContent = ed.folds.length ? `${ed.folds.length} dobra(s) · ${hidden} linhas escondidas` : ''
    }
    ed.on('fold', count)
    $('#fold-all').addEventListener('click', () => { foldAll(ed); ed.focus() })
    $('#unfold-all').addEventListener('click', () => { unfoldAll(ed); ed.focus() })
    ed.setFolds([{ from: 6, to: 11 }])
    count()
  }

  // --- tree-sitter validation (downloads web-tree-sitter and the grammars from the CDN)
  const tsDemo = () => {
    const SAMPLES = {
      javascript: ['validacao.js', 'function total(itens) {\n  let soma = 0\n  for (const item of itens {\n    soma += item.preco\n  }\n  return soma\n}\n\nconst lista = [1, 2, 3\nconsole.log(total(lista))\n'],
      typescript: ['validacao.ts', 'interface Item {\n  nome: string\n  preco: number\n}\n\nfunction total(itens: Item[]: number {\n  return itens.reduce((s, i) => s + i.preco, 0)\n}\n'],
      json: ['pacote.json', '{\n  "nome": "jonacode",\n  "versao": "0.1.0"\n  "privado": true,\n  "tags": ["editor", "leve",]\n}\n'],
      css: ['estilo.css', '.botao {\n  color: white;\n  background: #528bff;\n\n.titulo { font-weight: 700 }\n'],
      html: ['pagina.html', '<main>\n  <h1>Olá</h1>\n  <script>\n    const soma = (a, b => a + b\n  </script>\n  <style>\n    h1 { color: tomato; } }\n  </style>\n</main>\n'],
      markdown: ['LEIAME.md', '# Exemplo\n\nOs blocos de código são validados com a linguagem deles:\n\n```js\nconst x = [1, 2\n```\n\n```json\n{ "a": 1, }\n```\n'],
      shell: ['listar.sh', 'for arquivo in *.txt; do\n  if [ -s "$arquivo" ]; then\n    echo "$arquivo"\ndone\n'],
    }
    const select = $('#ts-lang')
    select.innerHTML = Object.keys(SAMPLES).map((k) => `<option value="${k}">${LANG_LABEL[k === 'javascript' ? 'js' : k === 'typescript' ? 'ts' : k === 'markdown' ? 'md' : k] ?? k}</option>`).join('')
    const status = $('#ts-status')
    status.textContent = 'carregando o tree-sitter…'
    const ed = frame($('#ts-editor'), {
      value: SAMPLES.javascript[1],
      language: javascript,
      extensions: [
        basicSetup(),
        treeSitter({
          load: cdnTreeSitter,
          grammars: cdnGrammars(),
          diagnostics: { inline: true },
          onParse: ({ problems, ms }) => {
            status.textContent = `${problems.length ? `${problems.length} problema(s)` : 'nenhum problema'} · análise em ${ms < 1 ? '<1' : Math.round(ms)} ms`
          },
        }),
      ],
    })
    select.addEventListener('change', () => {
      const [file, code] = SAMPLES[select.value]
      $('#ts-title').textContent = file
      status.textContent = 'carregando a gramática…'
      ed.setOptions({ language: LANGS[{ javascript: 'js', typescript: 'ts', markdown: 'md' }[select.value] ?? select.value] })
      ed.setValue(code)
    })
    $('#ts-fix').addEventListener('click', () => { fixAllSyntax(ed); ed.focus() })
    for (const el of $$('[data-size]')) el.textContent = '+' + kb(SIZES.parts[el.dataset.size])
  }

  // --- collaboration: two people on one page, linked by a simulated network (Yjs from the CDN)
  const collabDemo = async () => {
    const status = $('#co-status')
    status.textContent = 'carregando o Yjs…'
    let Y, Awareness, applyAwarenessUpdate, encodeAwarenessUpdate
    try {
      // y-protocols on the CDN imports this exact Yjs build: one copy of Yjs on the page.
      Y = await import('https://cdn.jsdelivr.net/npm/yjs@13.6.27/+esm')
      ;({ Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } = await import('https://cdn.jsdelivr.net/npm/y-protocols@1.0.7/awareness/+esm'))
    } catch {
      status.textContent = 'sem internet: esta demonstração baixa o Yjs da CDN'
      return
    }
    const CODE = `// Digitem nos dois editores ao mesmo tempo.\nfunction total(itens) {\n  let soma = 0\n  for (const item of itens) soma += item.preco\n  return soma\n}\n`
    let latency = 250
    const offline = new Set()
    const inFlight = new Set()
    const held = []
    const people = ['Ana', 'Bruno', 'Carla'].map((name) => {
      const doc = new Y.Doc()
      return { name, doc, text: doc.getText('codigo'), awareness: new Awareness(doc) }
    })
    const refresh = () => {
      const edits = held.filter((h) => h.text).length
      status.textContent = held.length ? `offline: ${edits} edição(ões) esperando` : inFlight.size ? 'a caminho…' : 'sincronizado'
    }
    /** Delivers to `to` after the latency (or holds it while one of the two is offline). */
    const deliver = (from, to, fn, text = false) => {
      if (offline.has(from) || offline.has(to)) {
        held.push({ from, to, fn, text })
        return refresh()
      }
      const t = setTimeout(() => { inFlight.delete(t); fn(); refresh() }, latency)
      inFlight.add(t)
      refresh()
    }
    for (const p of people) {
      p.doc.on('update', (update, origin) => {
        if (origin === 'net') return
        for (const q of people) if (q !== p) deliver(p, q, () => Y.applyUpdate(q.doc, update, 'net'), true)
      })
      p.awareness.on('update', ({ added, updated, removed }, origin) => {
        if (origin === 'net') return
        const update = encodeAwarenessUpdate(p.awareness, [...added, ...updated, ...removed])
        for (const q of people) if (q !== p) deliver(p, q, () => applyAwarenessUpdate(q.awareness, update, 'net'))
      })
    }
    people[0].text.insert(0, CODE)
    const [ana, bruno, carla] = people
    const mountPerson = (p, host) => frame(host, {
      language: javascript,
      extensions: [basicSetup(), collab(yjs({ Y, text: p.text, awareness: p.awareness }), { user: { name: p.name } })],
    })
    mountPerson(ana, $('#co-ana'))
    mountPerson(bruno, $('#co-bruno'))
    refresh()

    $('#co-latency').addEventListener('input', (e) => {
      latency = +e.target.value
      $('#co-latency-v').textContent = latency + ' ms'
    })
    $('#co-offline').addEventListener('click', (e) => {
      if (offline.has(bruno)) {
        offline.delete(bruno)
        e.target.textContent = 'Bruno fica offline'
        $('#co-bruno-state').textContent = ''
        for (const h of held.splice(0)) deliver(h.from, h.to, h.fn, h.text)
      } else {
        offline.add(bruno)
        e.target.textContent = 'Bruno volta'
        $('#co-bruno-state').textContent = 'offline'
      }
      refresh()
    })
    // Carla is simulated: she types a comment somewhere, with her cursor, then stops.
    let typing = null
    carla.awareness.setLocalStateField('user', { name: 'Carla', color: '#e5c07b' })
    $('#co-bot').addEventListener('click', (e) => {
      if (typing) return
      e.target.disabled = true
      // Her place is a relative position: it follows what the others type before it.
      const lines = carla.text.toString().split('\n')
      const line = Math.max(0, lines.findIndex((l) => l.includes('let soma')))
      const end = lines.slice(0, line).join('\n').length + (line ? 1 : 0) + lines[line].length
      let here = Y.createRelativePositionFromTypeIndex(carla.text, end)
      const words = ' // Carla: revisei esta linha ✓'
      let i = 0
      typing = setInterval(() => {
        if (i >= words.length) {
          clearInterval(typing)
          typing = null
          e.target.disabled = false
          return
        }
        const at = Y.createAbsolutePositionFromRelativePosition(here, carla.doc).index
        carla.doc.transact(() => carla.text.insert(at, words[i++]))
        here = Y.createRelativePositionFromTypeIndex(carla.text, at + 1)
        carla.awareness.setLocalStateField('cursor', { anchor: here, head: here })
      }, 90)
    })
  }


  // --- zones, widgets and overlays
  const zonesDemo = () => {
    const ed = frame($('#zones-editor'), {
      value: `// As barras acima das funções são zonas: recalculadas a cada edição.\n// Renomeie uma função ou crie outra e veja as referências mudarem.\nexport function soma(a, b) {\n  return a + b\n}\n\nexport function media(lista) {\n  const total = lista.reduce((acc, n) => soma(acc, n), 0)\n  return total / lista.length\n}\n\nfunction relatorio(notas) {\n  const m = media(notas)\n  console.log(\`média: \${m.toFixed(1)} · soma: \${soma(m, 0)}\`)\n}\n\nrelatorio([7, 8.5, 10])\nrelatorio([5, 6])`,
      language: javascript,
      extensions: basicSetup(),
    })
    const status = (text) => {
      $('#zone-status').textContent = text
      clearTimeout(status.t)
      status.t = setTimeout(() => ($('#zone-status').textContent = ''), 2200)
    }
    const count = () => {
      const n = getZones(ed).length
      $('#zone-count').textContent = `${n} zona${n === 1 ? '' : 's'}`
    }
    // CodeLens: one action bar above each function, with its references.
    const lenses = new Map()
    const refresh = () => {
      const text = ed.getValue()
      const seen = new Set()
      for (let line = 0; line < ed.doc.lineCount; line++) {
        const m = /^\s*(?:export\s+)?function\s+([\w$]+)/.exec(ed.doc.line(line))
        if (!m) continue
        const name = m[1]
        seen.add(name)
        const refs = (text.match(new RegExp(`\\b${name}\\s*\\(`, 'g'))?.length ?? 1) - 1
        const actions = [
          { label: '▶ Executar', run: () => status(`executando ${name}()…`) },
          { label: refs ? `${refs} referência${refs > 1 ? 's' : ''}` : 'sem referências', title: 'Ir para a próxima referência', run: () => {
            const re = new RegExp(`\\b${name}\\s*\\(`, 'g')
            const lines = ed.doc.lines
            const from = ed.selection.head
            const hits = []
            lines.forEach((t, l) => { for (const h of t.matchAll(re)) if (!/function\s+$/.test(t.slice(0, h.index))) hits.push({ line: l, col: h.index }) })
            if (!hits.length) return status('nenhuma referência')
            const next = hits.find((h) => h.line > from.line || (h.line === from.line && h.col > from.col)) ?? hits[0]
            ed.setSelection(next, { line: next.line, col: next.col + name.length })
            ed.focus()
          } },
        ]
        const zone = lenses.get(name)
        if (zone) zone.update({ line, actions })
        else lenses.set(name, addZone(ed, { line, actions }))
      }
      for (const [name, zone] of lenses) if (!seen.has(name)) { zone.remove(); lenses.delete(name) }
      count()
    }
    let timer = 0
    ed.on('change', () => { clearTimeout(timer); timer = setTimeout(refresh, 250) })
    refresh()

    const others = []
    $('#zone-comment').addEventListener('click', () => {
      const box = document.createElement('div')
      box.className = 'zone-comment'
      box.innerHTML = '<div class="who"><b>Ana</b> <span>agora</span></div><div class="msg">Dá para extrair isso numa função?</div>' +
        '<div class="reply"><input aria-label="Responder" placeholder="Responder…"><button type="button" class="send">Enviar</button><button type="button" class="done">Resolver</button></div>'
      const zone = addZone(ed, { line: ed.selection.head.line, side: 'below', content: box, gutter: '💬' })
      const input = box.querySelector('input')
      const send = () => {
        if (!input.value.trim()) return
        const msg = document.createElement('div')
        msg.className = 'msg mine'
        msg.textContent = input.value
        box.insertBefore(msg, box.querySelector('.reply'))
        input.value = ''
      }
      box.querySelector('.send').addEventListener('click', send)
      input.addEventListener('keydown', (e) => e.key === 'Enter' && send())
      box.querySelector('.done').addEventListener('click', () => { zone.remove(); count(); ed.focus() })
      others.push(zone)
      count()
      input.focus()
    })
    $('#zone-text').addEventListener('click', () => {
      others.push(addZone(ed, { line: ed.selection.head.line, content: '// uma zona de texto: não faz parte do código', class: 'zone-note', indent: true }))
      count()
      ed.focus()
    })
    let widget = null
    $('#zone-widget').addEventListener('click', () => {
      widget?.remove()
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'zone-widget'
      b.textContent = '✨ Explicar'
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', () => status(`explicando a linha ${widget.pos.line + 1}…`))
      widget = addWidget(ed, { pos: ed.selection.head, content: b, place: 'above' })
      ed.focus()
    })
    ed.on('selection', (sel) => widget?.update({ pos: sel.head }))
    let overlay = null
    $('#zone-overlay').addEventListener('click', () => {
      if (overlay) { overlay.remove(); overlay = null; return }
      overlay = addOverlay(ed, { content: 'JavaScript · UTF-8 · LF', position: 'bottom-right' })
    })
    $('#zone-clear').addEventListener('click', () => {
      for (const z of others.splice(0)) z.remove()
      widget?.remove()
      widget = null
      overlay?.remove()
      overlay = null
      count()
    })
  }

  INIT.extensoes = () => {
    tsDemo()
    void collabDemo()
    logDemo()
    decoDemo()
    zonesDemo()
    diagDemo()
    acDemo()
    foldDemo()
    const src = $('#ext-src').value
    const SAMPLE = `// Clique à esquerda dos números para marcar breakpoints ●
function calcularFrete(peso, distancia) {
  // TODO: considerar o tamanho da caixa
  const base = 12.5
  return base + peso * 0.8 + distancia * 0.05
}

// TODO: guardar resultados em cache
export const frete = calcularFrete(3, 120)
`
    // Included extensions table
    const EXTS = [
      ['basicSetup()', 'Das de baixo: números, linha ativa, colchetes, pares, atalhos, cursores, busca, ir para a linha e toque; cada uma desligável.', null],
      ['lineNumbers()', 'Gutter com números de linha; destaca as linhas com cursor.', 'lineNumbers'],
      ['highlightActiveLine()', 'Fundo na linha de cada cursor.', 'highlightActiveLine'],
      ['bracketMatching()', 'Destaca o par de ( [ { ignorando strings e comentários.', 'bracketMatching'],
      ['closeBrackets()', 'Fecha pares e aspas, digita por cima do fechamento e envolve seleções.', 'closeBrackets'],
      ['keymap(editingKeymap)', 'Comentar, mover/duplicar/apagar linhas, selecionar linha…', 'editingKeymap'],
      ['multiCursor()', 'Alt+clique, seleção em coluna, Mod+D, Mod+Shift+L, cursor acima/abaixo.', 'multiCursor'],
      ['search()', 'Painel de busca e substituição com regex e destaques; conta em segundo plano.', 'search'],
      ['gotoLine()', 'Ctrl+G: ir para linha, linha:coluna, +/- relativo ou porcentagem.', 'gotoLine'],
      ['lineClass(fn)', 'Uma classe por linha, calculada do texto (níveis de log, diffs…).', 'lineClass'],
      ['setDecorations(…)', 'Marcações: trechos, linhas e widgets em conjuntos com nome, que acompanham as edições.', 'decorations'],
      ['addZone · addWidget · addOverlay', 'Elementos seus entre as linhas (com espaço próprio), flutuando junto a uma posição ou fixos num canto.', 'zones'],
      ['hoverTooltip(fonte)', 'Tooltips ao passar o mouse, de várias fontes (síncronas ou assíncronas).', 'hoverTooltip'],
      ['diagnostics() · linter(fonte)', 'Sublinhado ondulado, margem, mensagens inline, correções rápidas e F8.', 'diagnostics'],
      ['autocomplete()', 'Sugestões da linguagem, do documento e de fontes suas (async), com busca aproximada.', 'autocomplete'],
      ['folding()', 'Dobra por colchetes, indentação e títulos de Markdown.', 'folding'],
      ['treeSitter({ load, grammars })', 'Validação com tree-sitter: erros de sintaxe com correções, código aninhado, árvore sintática.', 'treeSitter'],
      ['collab(yjs({ Y, text, awareness }))', 'Edição colaborativa: cursores com nome, avatares, seguir alguém, desfazer só o seu.', 'collab'],
      ['readOnlyRanges(trechos)', 'Trechos que ninguém edita, nem a pessoa nem a IA.', 'readOnlyRanges'],
      ['diffView({ original })', 'Diff inline com blocos das linhas removidas e Aceitar/Rejeitar por trecho.', 'diffView'],
      ['mergeView(el, { a, b })', 'Dois editores lado a lado, alinhados, com rolagem sincronizada.', 'mergeView'],
      ['editorTools(editor)', 'Ferramentas prontas para modelos (Claude, OpenAI, MCP/WebMCP).', 'editorTools'],
      ['applyEdits(editor, resposta)', 'Aplica blocos SEARCH/REPLACE, diffs ou arquivos inteiros, tolerando deslizes.', 'applyEdits'],
      ['inlineSuggestion(fonte)', 'Texto fantasma estilo Copilot, com streaming.', 'inlineSuggestion'],
      ['inlineEdit(fonte)', 'Ctrl/⌘+K: editar a seleção com IA, com prévia em tempo real.', 'inlineEdit'],
      ['touch()', 'Gestos de toque, alças de seleção e barra copiar/colar.', 'touch'],
      ['tokenRule(spec)', 'Captura tipos de token novos por regex, sem mexer na gramática.', 'tokenRule'],
      ['tokenStyles(styles)', 'Qualquer CSS para qualquer tipo de token, por editor.', 'tokenStyles'],
      ['tokenInspector()', 'Ferramenta de desenvolvimento: mostra o tipo do token sob o mouse.', 'tokenInspector'],
    ]
    $('#ext-table').innerHTML = EXTS.map(([name, desc, size]) =>
      `<tr><td><code>${esc(name)}</code></td><td>${esc(desc)}</td><td class="mono" style="text-align:right;color:var(--dim)">${size ? '+' + kb(SIZES.parts[size]) : '—'}</td></tr>`).join('')

    // Search demo, opened with a regex query
    const sed = frame($('#search-editor'), {
      value: `const usuario1 = buscar('usuario1')\nconst usuario2 = buscar('usuario2')\n\nfunction buscar(id) {\n  return fetch(\`/api/\${id}\`)\n}\n\n// Experimente: substituir usuario(\\d+) por user$1 com regex ligada`,
      language: javascript,
      extensions: basicSetup(),
    })
    requestAnimationFrame(() => {
      openReplace(sed)
      setSearchQuery(sed, { search: 'usuario(\\d+)', regexp: true, replace: 'user$1' })
      sed.dispatch({ selection: { anchor: { line: 0, col: 6 }, head: { line: 0, col: 14 } } })
    })

    $('#search-multiline').addEventListener('click', () => {
      sed.setValue(`function buscar(id) {\n  return fetch(\`/api/\${id}\`)\n}\n\nfunction salvar(item) {\n  return fetch('/api', { method: 'POST' })\n}\n\nconst x = () => {\n  // sem return aqui\n}`)
      openSearch(sed)
      setSearchQuery(sed, { search: '\\{\\n\\s*return', regexp: true, replace: '' })
    })

    const host = $('#ext-editor')
    const create = (h, opts) => frame(h, { ...opts, value: SAMPLE })
    new Function('createEditor', 'host', 'javascript', 'basicSetup', src)(create, host, javascript, basicSetup)

    // Keyboard shortcuts table
    const names = new Map(Object.entries(commands).map(([name, fn]) => [fn, name]))
    const DESC = {
      cursorCharLeft: 'Mover cursor (Shift estende a seleção)', cursorCharRight: 'Mover cursor (Shift estende a seleção)',
      cursorWordLeft: 'Pular palavra', cursorWordRight: 'Pular palavra', cursorLineUp: 'Linha acima', cursorLineDown: 'Linha abaixo',
      cursorLineStart: 'Início da linha (inteligente: indentação ↔ coluna 0)', cursorLineEnd: 'Fim da linha',
      cursorDocStart: 'Início do documento', cursorDocEnd: 'Fim do documento', cursorPageUp: 'Página acima', cursorPageDown: 'Página abaixo',
      selectAll: 'Selecionar tudo', deleteCharBackward: 'Apagar (em indentação, volta até a parada do tab)', deleteCharForward: 'Apagar à frente',
      deleteWordBackward: 'Apagar palavra', deleteWordForward: 'Apagar palavra à frente', deleteToLineStart: 'Apagar até o início da linha',
      deleteToLineEnd: 'Apagar até o fim da linha', insertNewline: 'Nova linha com auto-indentação', indentMore: 'Indentar (Shift: desindentar)',
      undo: 'Desfazer', redo: 'Refazer', toggleComment: 'Comentar / descomentar', moveLineUp: 'Mover linha(s) para cima',
      moveLineDown: 'Mover linha(s) para baixo', copyLineUp: 'Duplicar linha(s) acima', copyLineDown: 'Duplicar linha(s) abaixo',
      deleteLine: 'Apagar linha(s)', insertLineAfter: 'Nova linha abaixo', insertLineBefore: 'Nova linha acima', selectLine: 'Selecionar linha',
      indentSelection: 'Indentar linhas', indentLess: 'Desindentar linhas',
    }
    const DESC2 = new Map([
      [J.selectNextOccurrence, 'Selecionar a próxima ocorrência'], [J.selectAllOccurrences, 'Selecionar todas as ocorrências'],
      [J.addCursorAbove, 'Adicionar cursor acima'], [J.addCursorBelow, 'Adicionar cursor abaixo'],
      [J.openSearch, 'Abrir a busca'], [J.openReplace, 'Buscar e substituir'], [J.findNext, 'Próxima ocorrência (Shift: anterior)'],
      [J.closeSearch, 'Fechar a busca'],
    ])
    const pretty = (key) => key.split(/-(?!$)/).map((k) => {
      const map = isMac
        ? { Mod: '⌘', Cmd: '⌘', Meta: '⌘', Alt: '⌥', Shift: '⇧', Ctrl: '⌃' }
        : { Mod: 'Ctrl', Meta: 'Win', Alt: 'Alt', Shift: 'Shift', Ctrl: 'Ctrl' }
      const arrows = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: '⌫', Enter: '↵', Delete: 'Del' }
      return `<kbd>${esc(map[k] ?? arrows[k] ?? (k.length === 1 ? k.toUpperCase() : k))}</kbd>`
    }).join(' ')
    const rows = []
    const seen = new Set()
    for (const [list, extra] of [[defaultKeymap, false], [editingKeymap, true], [multiCursorKeymap, 'multiCursor'], [searchKeymap, 'search']]) {
      for (const b of list) {
        const key = (isMac ? b.mac : b.win ?? b.linux) ?? b.key
        if (!key || !b.run) continue
        const name = names.get(b.run)
        const id = key + name
        if (seen.has(id)) continue
        seen.add(id)
        const tag = extra === true ? 'extra' : extra || ''
        rows.push(`<tr><td>${pretty(key)}${b.shift && names.get(b.shift) !== name ? ` <span class="muted">(+${pretty('Shift')})</span>` : ''}</td><td>${DESC[name] ?? DESC2.get(b.run) ?? name}${tag ? ` <span class="muted">· ${tag}</span>` : ''}</td></tr>`)
      }
    }
    $('#keys').innerHTML = rows.join('')
    $('#mod-key').textContent = isMac ? '⌘' : 'Ctrl'
  }


  // ------------------------------------------------------------------ 8. IA
  const CARRINHO = `function total(itens) {
  var soma = 0
  for (let i = 0; i <= itens.length; i++) {
    soma += itens[i].preco * itens[i].qtd
  }
  return soma
}

function desconto(total, cupom) {
  if (cupom == 'DEZ') return total * 0.9
  return total
}
`
  /** A toy linter the agent demo verifies its edits with. */
  const cartLint = (ed) => {
    const out = []
    ed.doc.lines.forEach((text, line) => {
      let m
      if ((m = /\bvar\b/.exec(text))) out.push({ from: { line, col: m.index }, to: { line, col: m.index + 3 }, severity: 'warning', message: 'Use let ou const em vez de var.', source: 'lint' })
      if ((m = /[^=!<>]==(?!=)/.exec(text))) out.push({ from: { line, col: m.index + 1 }, to: { line, col: m.index + 3 }, severity: 'warning', message: 'Use === para comparar sem conversão de tipo.', source: 'lint' })
      if ((m = /<=\s*[\w.]+\.length/.exec(text))) out.push({ from: { line, col: m.index }, to: { line, col: m.index + m[0].length }, severity: 'error', message: 'O índice passa do fim do array.', source: 'lint' })
    })
    return out
  }

  const agentDemo = () => {
    const ed = frame($('#agent-editor'), { value: CARRINHO, language: javascript, extensions: [basicSetup(), linter(cartLint, { delay: 120 })] })
    const tools = editorTools(ed, { path: 'carrinho.js', verify: cartLint })
    const TE = 'str_replace_based_edit_tool'
    const OURS = [
      { say: 'Primeiro, os problemas que o linter aponta.', name: 'get_problems', input: {} },
      { say: 'Leio o arquivo com as linhas numeradas.', name: 'read_file', input: { start_line: 1, end_line: 12 } },
      { say: 'Corrijo o laço. (A indentação do bloco veio errada de propósito: 4 espaços em vez de 2.)', name: 'edit_file', input: { patch: '<<<<<<< SEARCH\n    for (let i = 0; i <= itens.length; i++) {\n=======\n    for (let i = 0; i < itens.length; i++) {\n>>>>>>> REPLACE' } },
      { say: 'Os dois avisos que sobraram, numa edição só.', name: 'edit_file', input: { edits: [{ old: 'var soma = 0', new: 'let soma = 0' }, { old: "cupom == 'DEZ'", new: "cupom === 'DEZ'" }] } },
      { say: 'Um comentário no topo.', name: 'insert_lines', input: { line: 0, text: '// Carrinho: total e descontos' } },
    ]
    const CLAUDE = [
      { say: 'Abro o arquivo.', name: TE, input: { command: 'view', path: 'carrinho.js' } },
      { say: 'Vejo os problemas.', name: 'get_problems', input: {} },
      { say: 'Corrijo o laço.', name: TE, input: { command: 'str_replace', path: 'carrinho.js', old_str: 'i <= itens.length', new_str: 'i < itens.length' } },
      { say: 'Troco a comparação… com as aspas erradas.', name: TE, input: { command: 'str_replace', path: 'carrinho.js', old_str: 'if (cupom == "DEZ")', new_str: 'if (cupom === "DEZ")' } },
      { say: 'O erro disse onde está o texto parecido: tento de novo.', name: TE, input: { command: 'str_replace', path: 'carrinho.js', old_str: "if (cupom == 'DEZ')", new_str: "if (cupom === 'DEZ')" } },
      { say: 'E o var.', name: TE, input: { command: 'str_replace', path: 'carrinho.js', old_str: 'var soma', new_str: 'let soma' } },
    ]
    const log = $('#agent-log')
    const status = $('#agent-status')
    let step = 0
    let running = false
    const steps = () => ($('#agent-claude').checked ? CLAUDE : OURS)
    const clip = (s, n) => {
      const lines = s.split('\n')
      return lines.length > n ? lines.slice(0, n).join('\n') + `\n… (+${lines.length - n} linhas)` : s
    }
    const reset = () => {
      running = false
      step = 0
      ed.setValue(CARRINHO)
      log.innerHTML = '<p class="agent-empty">As chamadas de ferramenta e as respostas aparecem aqui.</p>'
      status.textContent = ''
    }
    const next = async () => {
      const list = steps()
      if (step >= list.length) return false
      if (step === 0) log.innerHTML = ''
      const s = list[step++]
      const entry = document.createElement('div')
      entry.className = 'agent-entry'
      entry.innerHTML = `<p class="agent-say">${esc(s.say)}</p><div class="agent-call"><b>${esc(s.name)}</b><code>${esc(JSON.stringify(s.input))}</code></div>`
      log.appendChild(entry)
      const r = await tools.run(s.name, s.input)
      const pre = document.createElement('pre')
      pre.className = 'agent-out' + (r.isError ? ' error' : '')
      pre.textContent = clip(r.content, 16)
      entry.appendChild(pre)
      log.scrollTop = log.scrollHeight
      status.textContent = `${step}/${list.length}`
      return step < list.length
    }
    $('#agent-step').addEventListener('click', () => { if (!running) void next() })
    $('#agent-reset').addEventListener('click', reset)
    $('#agent-claude').addEventListener('change', reset)
    $('#agent-run').addEventListener('click', async () => {
      if (running) return
      if (step >= steps().length) reset()
      running = true
      while (running && (await next())) await new Promise((r) => setTimeout(r, reduced ? 200 : 900))
      running = false
    })
    reset()
  }

  const UTIL = `export function formatar(valor) {
  return valor.toFixed(2)
}

export function somar(a, b) {
  return a + b
}

export function media(lista) {
  let soma = 0
  for (const x of lista) soma += x
  return soma / lista.length
}
`
  const EDIT_SAMPLES = [
    ['Blocos SEARCH/REPLACE com texto em volta', `Claro! Vou formatar em reais e proteger a média contra listas vazias.

\`\`\`js
util.js
<<<<<<< SEARCH
  return valor.toFixed(2)
=======
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
>>>>>>> REPLACE
<<<<<<< SEARCH
  return soma / lista.length
=======
  return lista.length ? soma / lista.length : 0
>>>>>>> REPLACE
\`\`\`

Pronto, as duas funções foram ajustadas.`],
    ['Indentação trocada (4 espaços)', `<<<<<<< SEARCH
function somar(a, b) {
    return a + b
}
=======
function somar(...numeros) {
    return numeros.reduce((a, b) => a + b, 0)
}
>>>>>>> REPLACE`],
    ['Diff com número de linha errado', `--- a/util.js
+++ b/util.js
@@ -40,3 +40,4 @@
 export function formatar(valor) {
-  return valor.toFixed(2)
+  if (typeof valor !== 'number') throw new TypeError('valor precisa ser número')
+  return valor.toFixed(2)
 }`],
    ['O arquivo inteiro num bloco de código', '```js\n' + UTIL.replace('let soma = 0\n  for (const x of lista) soma += x', 'const soma = lista.reduce((a, x) => a + x, 0)') + '```'],
    ['Um trecho que não existe', `<<<<<<< SEARCH
export function subtrair(a, b) {
  return a - b
}
=======
export function subtrair(a, b) {
  return b - a
}
>>>>>>> REPLACE`],
    ['“// ... resto do código” no lugar do código', `<<<<<<< SEARCH
export function media(lista) {
  let soma = 0
  for (const x of lista) soma += x
  return soma / lista.length
}
=======
export function media(lista) {
  // ... resto do código
  return lista.length ? soma / lista.length : 0
}
>>>>>>> REPLACE`],
  ]
  const editsDemo = () => {
    const input = frame($('#edits-input'), { value: EDIT_SAMPLES[0][1], language: markdown, lineWrapping: true, extensions: basicSetup({ lineNumbers: false }) })
    const ed = frame($('#edits-editor'), { value: UTIL, language: javascript, extensions: basicSetup() })
    const select = $('#edits-sample')
    select.innerHTML = EDIT_SAMPLES.map(([label], i) => `<option value="${i}">${esc(label)}</option>`).join('')
    const out = $('#edits-result')
    const show = (html, cls = '') => {
      out.className = 'agent-result mono ' + cls
      out.innerHTML = html
    }
    select.addEventListener('change', () => {
      input.setValue(EDIT_SAMPLES[+select.value][1])
      ed.setValue(UTIL)
      show('')
    })
    $('#edits-apply').addEventListener('click', () => {
      const r = applyEdits(ed, input.getValue(), { select: true })
      show(`<b>${r.ok ? 'ok' : 'erro'}</b> · formato <b>${r.format}</b>\n${esc(r.summary)}`, r.ok ? 'ok' : 'error')
    })
    $('#edits-undo').addEventListener('click', () => { ed.undo(); ed.focus() })
    show('')
  }

  const fillDemo = () => {
    const lines = Array.from({ length: 200 }, (_, i) => `linha ${i + 1}: ${['const', 'let', 'if', 'return', '// nota'][i % 5]} …`)
    const ed = frame($('#fill-editor'), { value: lines.join('\n'), extensions: basicSetup() })
    const desc = $('#fill-desc')
    const update = () => {
      const d = ed.inputDOM.getAttribute('aria-description')
      desc.textContent = d ? `aria-description = "${d}"` : 'clique no editor para ver a aria-description'
    }
    ed.on('render', update)
    update()
    $('#fill-demo').addEventListener('click', () => {
      // What an automation tool does: set the field's value and fire `input`.
      ed.inputDOM.value = '// o agente escreveu o arquivo inteiro\nexport const pronto = true\n'
      ed.inputDOM.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
  }

  const protectDemo = () => {
    const EXERCICIO = `// Exercício: complete a função.
// Não mude a assinatura nem os testes.
export function fatorial(n) {
  // escreva aqui
  return 0
}

console.assert(fatorial(0) === 1)
console.assert(fatorial(5) === 120)
`
    const ed = frame($('#protect-editor'), { value: EXERCICIO, language: javascript, extensions: [basicSetup()] })
    setReadOnlyRanges(ed, [lineRange(ed, 1, 3), lineRange(ed, 6, 9)])
    const out = $('#protect-result')
    $('#protect-ai').addEventListener('click', () => {
      const r = applyEdits(ed, [{ old: 'export function fatorial(n) {', new: 'export function fatorial(n = 1) {' }])
      out.className = 'agent-result mono ' + (r.ok ? 'ok' : 'error')
      out.textContent = r.summary
    })
    $('#protect-ai-ok').addEventListener('click', () => {
      const r = applyEdits(ed, [{ old: '  // escreva aqui\n  return 0', new: '  return n <= 1 ? 1 : n * fatorial(n - 1)' }])
      out.className = 'agent-result mono ' + (r.ok ? 'ok' : 'error')
      out.textContent = r.summary
      if (r.ok) markAIEdits(ed, r.ranges)
    })
  }

  /** Streams `text` in small chunks, like a model would (stops when aborted). */
  async function* fakeStream(text, signal, size = 4, ms = 14) {
    await new Promise((r) => setTimeout(r, 250))
    for (let i = 0; i < text.length && !signal.aborted; i += size) {
      yield text.slice(i, i + size)
      await new Promise((r) => setTimeout(r, ms))
    }
  }

  const suggestDemo = () => {
    const RULES = [
      [/const total = itens\.$/, 'reduce((soma, item) => soma + item.preco * item.qtd, 0)'],
      [/\/\/ ordena$/, ' por preço, do mais barato ao mais caro\nconst ordenados = [...itens].sort((a, b) => a.preco - b.preco)'],
      [/function media\(lista\) \{\n\s*$/, 'if (!lista.length) return 0\n  return lista.reduce((a, b) => a + b, 0) / lista.length'],
      [/function soma\($/, 'a, b'],
    ]
    frame($('#suggest-editor'), {
      value: `const itens = [{ nome: 'Caneta', preco: 3.9, qtd: 2 }, { nome: 'Caderno', preco: 24, qtd: 1 }]\n\n// digite nas linhas de baixo\n`,
      language: javascript,
      extensions: [
        basicSetup(),
        inlineSuggestion(({ prefix }, signal) => {
          const rule = RULES.find(([re]) => re.test(prefix))
          return rule ? fakeStream(rule[1], signal) : null
        }),
      ],
    }).setSelection({ line: 3, col: 0 }, undefined, false)
  }

  const inlineEditDemo = () => {
    const CODE = `function carregar(url) {
  return fetch(url).then((r) => r.json())
}

function somar(lista) {
  let soma = 0
  for (const x of lista) soma += x
  return soma
}
`
    const rewrite = (instruction, text) => {
      const i = instruction.toLowerCase()
      if (/async|await/.test(i)) {
        return text
          .replace(/^(\s*)function /gm, '$1async function ')
          .replace(/return fetch\((\w+)\)\.then\(\(r\) => r\.json\(\)\)/, 'const resposta = await fetch($1)\n  return resposta.json()')
      }
      if (/coment/.test(i)) return text.replace(/^(\s*)(function \w+\([^)]*\))/gm, '$1// $2: explica o que a função faz\n$1$2')
      const to = /para\s+(\w+)/.exec(i)?.[1]
      if (/renome/.test(i) && to) return text.replace(/\bsoma\b/g, to)
      return '// (fonte falsa: tente “async”, “comente” ou “renomeie para total”)\n' + text
    }
    const ed = frame($('#inline-edit-editor'), {
      value: CODE,
      language: javascript,
      extensions: [
        basicSetup(),
        diffView({ original: CODE }),
        inlineEdit(({ instruction, text }, signal) => fakeStream(rewrite(instruction, text), signal, 5, 12), {
          onApply: (e, before) => setOriginal(e, before),
        }),
      ],
    })
    ed.setSelection({ line: 4, col: 0 }, { line: 8, col: 1 }, false)
  }

  const reviewDemo = () => {
    const BEFORE = `export function formatar(valor) {
  return valor.toFixed(2)
}

export function somar(a, b) {
  return a + b
}

export function media(lista) {
  let soma = 0
  for (const x of lista) soma += x
  return soma / lista.length
}
`
    const ed = frame($('#review-editor'), { value: BEFORE, language: javascript, extensions: [basicSetup(), diffView({ original: BEFORE })] })
    const count = () => {
      const n = getChunks(ed).length
      $('#review-count').textContent = n ? `${n} trecho(s) para revisar` : 'nada para revisar'
    }
    ed.on('render', count)
    $('#review-ai').addEventListener('click', () => {
      ed.setValue(BEFORE)
      setOriginal(ed, BEFORE)
      applyEdits(ed, [
        { old: '  return valor.toFixed(2)', new: "  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })" },
        { old: 'export function somar(a, b) {\n  return a + b\n}\n\n', new: '' },
        { old: '  let soma = 0\n  for (const x of lista) soma += x\n  return soma / lista.length', new: '  if (!lista.length) return 0\n  const soma = lista.reduce((a, x) => a + x, 0)\n  return soma / lista.length' },
      ])
    })
    $('#review-accept').addEventListener('click', () => acceptAll(ed))
    $('#review-reject').addEventListener('click', () => rejectAll(ed))
    count()
    const AFTER = BEFORE.replace('  return valor.toFixed(2)', "  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })")
      .replace('export function somar(a, b) {\n  return a + b\n}\n\n', '')
      .replace('  let soma = 0\n  for (const x of lista) soma += x', '  if (!lista.length) return 0\n  const soma = lista.reduce((a, x) => a + x, 0)')
    mergeView($('#merge-host'), {
      a: { value: BEFORE, language: javascript, readOnly: true, phrases: PHRASES, extensions: basicSetup() },
      b: { value: AFTER, language: javascript, phrases: PHRASES, extensions: basicSetup() },
    })
  }

  INIT.ia = () => {
    agentDemo()
    editsDemo()
    reviewDemo()
    suggestDemo()
    inlineEditDemo()
    fillDemo()
    protectDemo()
  }


  // ------------------------------------------------------------------ comparativo
  INIT.comparativo = () => {
    const BENCH = window.__BENCH__
    const E = BENCH.editors
    const fmtNum = (n, d = 0) => n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })
    const gzKB = (id) => E[id].size.jsGzip / 1024
    const LIBS = [
      { id: 'jonacode', bench: 'jonacode-full', name: 'Jonacode', me: true },
      { id: 'cm6', bench: 'cm6-full', name: 'CodeMirror 6' },
      { id: 'cm5', bench: 'cm5', name: 'CodeMirror 5' },
      { id: 'monaco', bench: 'monaco-min', name: 'Monaco' },
      { id: 'ace', bench: 'ace', name: 'Ace' },
      { id: 'pce', bench: 'prism-code-editor', name: 'prism-code-editor' },
      { id: 'codejar', bench: 'codejar', name: 'CodeJar' },
    ]
    const lib = (id) => LIBS.find((l) => l.id === id)
    const paint = (l) => E[l.bench].runtime.firstPaint
    const nodes = (l) => E[l.bench].runtime.domNodes

    // --- tooltip shared by the charts (built with textContent: labels are data)
    const makeTip = (host) => {
      const tip = document.createElement('div')
      tip.className = 'viz-tip'
      tip.setAttribute('role', 'status')
      host.appendChild(tip)
      return {
        show(title, value, rows, x, y, accent) {
          tip.replaceChildren()
          const name = document.createElement('div')
          name.className = 'tip-name'
          const key = document.createElement('i')
          key.style.setProperty('--k', accent ? '#528bff' : '#6b7385')
          name.append(key, document.createTextNode(title))
          const v = document.createElement('span')
          v.className = 'tip-value'
          v.textContent = value
          tip.append(name, v)
          for (const [k, val] of rows) {
            const row = document.createElement('div')
            row.className = 'tip-row'
            const a = document.createElement('span')
            a.textContent = k
            const b = document.createElement('b')
            b.textContent = val
            row.append(a, b)
            tip.append(row)
          }
          const w = host.clientWidth
          tip.style.left = Math.min(Math.max(0, x + 14), w - 240) + 'px'
          tip.style.top = Math.max(0, y - 20) + 'px'
          tip.classList.add('on')
        },
        hide() { tip.classList.remove('on') },
      }
    }
    const tableToggle = (key) => {
      const btn = $(`[data-table-toggle="${key}"]`)
      btn.addEventListener('click', () => {
        const t = $(`#${key}-table`)
        t.hidden = !t.hidden
        btn.textContent = t.hidden ? 'Ver tabela' : 'Ocultar tabela'
      })
    }
    const table = (host, head, rows, meRows) => {
      host.innerHTML = `<div class="table-wrap"><table><thead><tr>${head.map(([h, num]) => `<th class="${num ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r, i) => `<tr class="${meRows[i] ? 'me' : ''}">${r.map((c, j) => `<td class="${head[j][1] ? 'num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    }

    // --- KPIs: where we are good, computed from the measurements
    const me = lib('jonacode')
    const others = LIBS.filter((l) => !l.me)
    const fastest = [...LIBS].sort((a, b) => paint(a) - paint(b))
    const k = [
      ['Tamanho com basicSetup + JavaScript', fmtNum(gzKB('jonacode-full'), 1) + ' kB',
        `${fmtNum(gzKB('cm6-full') / gzKB('jonacode-full'), 1)}× menor que o CodeMirror 6 e ${fmtNum(gzKB('monaco-min') / gzKB('jonacode-full'), 0)}× menor que o Monaco mínimo`],
      ['Primeira pintura com 100 mil linhas', fmtNum(paint(me)) + ' ms',
        fastest[0] === me ? `a mais rápida dos ${LIBS.length} · CodeMirror 6: ${fmtNum(paint(lib('cm6')))} ms · Monaco: ${fmtNum(paint(lib('monaco')))} ms` : `CodeMirror 6: ${fmtNum(paint(lib('cm6')))} ms`],
      ['Nós no DOM com 100 mil linhas', fmtNum(nodes(me)),
        `virtualizado: CodeJar cria ${fmtNum(nodes(lib('codejar')))} e prism-code-editor ${fmtNum(nodes(lib('pce')))}`],
      ['Para criar uma linguagem nova', '~30 linhas', 'estados + regex, sem gerador de parser (veja a JonaLang)'],
    ]
    $('#kpis').innerHTML = k.map(([label, value, sub]) => `<div class="kpi"><span class="kpi-label">${esc(label)}</span><b class="kpi-value">${esc(value)}</b><span class="kpi-sub">${esc(sub)}</span></div>`).join('')
    $('#bench-note').textContent = `Medido em ${BENCH.date.split('-').reverse().join('/')} · ${BENCH.machine.cpu} · ${BENCH.machine.browser} (headless) · documento de ${fmtNum(BENCH.document.lines)} linhas (${fmtNum(BENCH.document.bytes / 1e6, 1)} MB) · ${BENCH.note}`

    // --- scatter: size × first paint (log × log), emphasis on Jonacode.
    // Drawn at the container's real width (1 unit = 1px) so text stays legible on phones.
    const scatterHost = $('#scatter')
    scatterHost.classList.add('viz')
    const X0 = 5, X1 = 2000, Y0 = 10, Y1 = 8000
    const CLUSTER = ['cm5', 'ace', 'cm6']
    const LABEL_POS = { jonacode: [13, -12, 'start'], cm6: [12, -10, 'start'], cm5: [-12, -10, 'end'], monaco: [-10, -12, 'end'], ace: [-6, 22, 'end'], pce: [12, 4, 'start'], codejar: [-12, 4, 'end'] }
    let stip = null
    let drawnWidth = 0
    const drawScatter = (animate) => {
      const W = Math.max(320, Math.min(880, Math.round(scatterHost.clientWidth)))
      if (Math.abs(W - drawnWidth) < 8 && !animate) return
      drawnWidth = W
      const narrow = W < 600
      const H = narrow ? 360 : 430
      const m = narrow ? { l: 64, r: 14, t: 18, b: 50 } : { l: 96, r: 26, t: 18, b: 54 }
      const xs = (v) => m.l + (Math.log10(v / X0) / Math.log10(X1 / X0)) * (W - m.l - m.r)
      const ys = (v) => H - m.b - (Math.log10(v / Y0) / Math.log10(Y1 / Y0)) * (H - m.t - m.b)
      const xticks = narrow ? [10, 100, 1000] : [10, 30, 100, 300, 1000]
      const yticks = narrow ? [10, 100, 1000] : [10, 30, 100, 300, 1000, 3000]
      let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Gráfico de dispersão: tamanho em kB por tempo de primeira pintura em ms">`
      svg += `<rect class="zone" x="${xs(X0)}" y="${ys(100)}" width="${xs(40) - xs(X0)}" height="${ys(Y0) - ys(100)}" rx="8"/>`
      svg += `<text class="zone-label" x="${xs(X0) + 10}" y="${ys(Y0) - 10}">leve e rápido</text>`
      svg += '<g class="grid">'
      for (const t of xticks) svg += `<line x1="${xs(t)}" x2="${xs(t)}" y1="${m.t}" y2="${H - m.b}"/>`
      for (const t of yticks) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${ys(t)}" y2="${ys(t)}"/>`
      svg += '</g>'
      for (const t of xticks) svg += `<text class="tick" x="${xs(t)}" y="${H - m.b + 18}" text-anchor="middle">${fmtNum(t)} kB</text>`
      for (const t of yticks) svg += `<text class="tick" x="${m.l - 8}" y="${ys(t) + 4}" text-anchor="end">${fmtNum(t)} ms</text>`
      svg += `<text class="axis-title" x="${(m.l + W - m.r) / 2}" y="${H - 8}" text-anchor="middle">${narrow ? 'Tamanho (gzip, log) →' : 'Tamanho do JavaScript (gzip, escala log) →'}</text>`
      svg += `<text class="axis-title" transform="translate(14 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle">${narrow ? '1ª pintura (log) →' : '1ª pintura, 100 mil linhas (log) →'}</text>`
      const order = [...LIBS].sort((a) => (a.me ? 1 : -1)) // Jonacode drawn last (on top)
      order.forEach((l, i) => {
        const x = xs(gzKB(l.bench))
        const y = ys(paint(l))
        svg += `<g><circle class="hit" data-id="${l.id}" cx="${x}" cy="${y}" r="15" tabindex="0" aria-label="${esc(l.name)}: ${fmtNum(gzKB(l.bench), 1)} kB, ${fmtNum(paint(l))} ms"/>` +
          `<circle class="dot ${l.me ? 'me' : ''}" cx="${x}" cy="${y}" r="${l.me ? 7 : 5}" style="transition-delay:${reduced || !animate ? 0 : i * 70}ms"/></g>`
        if (narrow && CLUSTER.includes(l.id)) return
        const [dx, dy, anchor] = LABEL_POS[l.id]
        svg += `<text class="dot-label ${l.me ? 'me' : ''}" x="${x + dx}" y="${y + dy}" text-anchor="${anchor}">${esc(l.name)}</text>`
      })
      if (narrow) {
        const cx = CLUSTER.map((id) => xs(gzKB(lib(id).bench)))
        const cy = Math.min(...CLUSTER.map((id) => ys(paint(lib(id)))))
        svg += `<text class="dot-label" x="${(Math.min(...cx) + Math.max(...cx)) / 2}" y="${cy - 14}" text-anchor="middle">CM5 · Ace · CM6</text>`
      }
      scatterHost.querySelector('svg')?.remove()
      scatterHost.insertAdjacentHTML('afterbegin', svg + '</svg>')
      if (animate && !reduced) {
        scatterHost.classList.add('pending')
        requestAnimationFrame(() => requestAnimationFrame(() => scatterHost.classList.remove('pending')))
      }
      stip ??= makeTip(scatterHost)
      const showDot = (el) => {
        const l = lib(el.dataset.id)
        const e = E[l.bench]
        const box = el.getBoundingClientRect()
        const host = scatterHost.getBoundingClientRect()
        stip.show(l.name, `${fmtNum(gzKB(l.bench), 1)} kB · ${fmtNum(paint(l))} ms`, [
          ['configuração', e.setup], ['nós no DOM', fmtNum(nodes(l))], ['versão', e.version],
        ], box.left - host.left + box.width / 2, box.top - host.top, l.me)
      }
      for (const hit of $$('.hit', scatterHost)) {
        hit.addEventListener('pointerenter', () => showDot(hit))
        hit.addEventListener('focus', () => showDot(hit))
        hit.addEventListener('pointerleave', () => stip.hide())
        hit.addEventListener('blur', () => stip.hide())
      }
    }
    drawScatter(true)
    new ResizeObserver(() => drawScatter(false)).observe(scatterHost)
    table($('#scatter-table'), [['Editor'], ['Configuração'], ['Versão'], ['JS gzip', 1], ['1ª pintura', 1], ['Nós no DOM', 1]],
      LIBS.map((l) => [l.name, E[l.bench].setup, E[l.bench].version, fmtNum(gzKB(l.bench), 1) + ' kB', fmtNum(paint(l)) + ' ms', fmtNum(nodes(l))]), LIBS.map((l) => l.me))
    tableToggle('scatter')

    // --- bars per metric (all measured setups, including the bare cores)
    const IDS = Object.keys(E)
    const METRICS = [
      { id: 'size', tab: 'Tamanho', title: 'Tamanho do JavaScript (minificado + gzip)', get: (id) => E[id].size.jsGzip / 1024, fmt: (v) => fmtNum(v, 1) + ' kB' },
      { id: 'paint', tab: 'Primeira pintura', title: 'Primeira pintura de um arquivo de 100 mil linhas', get: (id) => E[id].runtime.firstPaint, fmt: (v) => fmtNum(v) + ' ms' },
      { id: 'nodes', tab: 'Nós no DOM', title: 'Elementos no DOM com 100 mil linhas abertas', get: (id) => E[id].runtime.domNodes, fmt: (v) => fmtNum(v) },
      { id: 'jump', tab: 'Salto de rolagem', title: 'Salto até a linha 50.000 e nova pintura', get: (id) => E[id].runtime.scrollJump, fmt: (v) => fmtNum(v) + ' ms' },
    ]
    const barsHost = $('#bars')
    barsHost.classList.add('viz')
    const ROW = 32
    barsHost.innerHTML = `<div class="hbars" style="height:${IDS.length * ROW}px">${IDS.map((id) =>
      `<div class="hbar ${id.startsWith('jonacode') ? 'me' : ''}" data-id="${id}" tabindex="0"><span class="hbar-name">${esc(E[id].name)}</span><span class="hbar-track"><i class="hbar-fill"></i><b class="hbar-value"></b></span></div>`).join('')}</div><div class="bars-axis"><div class="axis-spacer"></div><div class="axis-ticks" id="bars-ticks"></div></div>`
    const btip = makeTip(barsHost)
    let metric = METRICS[0]
    const niceStep = (max) => {
      const raw = max / 4
      const p = 10 ** Math.floor(Math.log10(raw))
      return [1, 2, 2.5, 5, 10].map((f) => f * p).find((s) => s >= raw)
    }
    const drawBars = () => {
      const vals = IDS.map((id) => metric.get(id))
      const sorted = [...vals].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]
      const normal = sorted.filter((v) => v <= median * 8)
      const capped = normal.length < sorted.length
      const cap = (capped ? normal[normal.length - 1] : sorted[sorted.length - 1]) * 1.1
      const rank = IDS.map((id, i) => [id, vals[i]]).sort((a, b) => a[1] - b[1]).map(([id]) => id)
      $('#bars-title').textContent = metric.title + ' · menos é melhor'
      for (const row of $$('.hbar', barsHost)) {
        const id = row.dataset.id
        const v = metric.get(id)
        const pct = (Math.min(v, cap) / cap) * 80
        row.style.top = rank.indexOf(id) * ROW + 'px'
        row.querySelector('.hbar-fill').style.width = pct + '%'
        const val = row.querySelector('.hbar-value')
        val.style.left = pct + '%'
        val.textContent = metric.fmt(v) + (v > cap ? ' ⟶' : '')
        val.title = v > cap ? 'fora da escala do gráfico' : ''
        const brk = row.querySelector('.hbar-break')
        if (v > cap && !brk) {
          const b = document.createElement('i')
          b.className = 'hbar-break'
          b.style.left = 'calc(' + pct + '% - 18px)'
          row.querySelector('.hbar-track').appendChild(b)
        } else if (v <= cap && brk) brk.remove()
        else if (brk) brk.style.left = 'calc(' + pct + '% - 18px)'
      }
      const step = niceStep(cap)
      let ticks = ''
      for (let t = 0; t <= cap; t += step) ticks += `<span style="left:${(t / cap) * 80}%">${metric.fmt(t).replace(/,0 /, ' ')}</span>`
      $('#bars-ticks').innerHTML = ticks
      table($('#bars-table'), [['Editor'], ['Configuração'], ['JS gzip', 1], ['1ª pintura', 1], ['Nós no DOM', 1], ['Salto', 1], ['Memória JS*', 1]],
        rank.map((id) => [E[id].name, E[id].setup, fmtNum(E[id].size.jsGzip / 1024, 1) + ' kB', fmtNum(E[id].runtime.firstPaint) + ' ms', fmtNum(E[id].runtime.domNodes), fmtNum(E[id].runtime.scrollJump) + ' ms', fmtNum(E[id].runtime.heapMB, 1) + ' MB']),
        rank.map((id) => id.startsWith('jonacode')))
    }
    for (const row of $$('.hbar', barsHost)) {
      const show = () => {
        const id = row.dataset.id
        const box = row.querySelector('.hbar-fill').getBoundingClientRect()
        const host = barsHost.getBoundingClientRect()
        btip.show(E[id].name, metric.fmt(metric.get(id)), METRICS.filter((x) => x !== metric).map((x) => [x.tab.toLowerCase(), x.fmt(x.get(id))]).concat([['configuração', E[id].setup]]),
          box.right - host.left, box.top - host.top, id.startsWith('jonacode'))
      }
      row.addEventListener('pointerenter', show)
      row.addEventListener('focus', show)
      row.addEventListener('pointerleave', () => btip.hide())
      row.addEventListener('blur', () => btip.hide())
    }
    const tabs = $('#metric-tabs')
    tabs.innerHTML = METRICS.map((mm, i) => `<button role="tab" type="button" aria-selected="${i === 0}" data-metric="${mm.id}">${mm.tab}</button>`).join('')
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button')
      if (!btn) return
      metric = METRICS.find((mm) => mm.id === btn.dataset.metric)
      $$('button', tabs).forEach((b) => b.setAttribute('aria-selected', String(b === btn)))
      drawBars()
    })
    drawBars()
    tableToggle('bars')

    // --- feature matrix
    const Y = 'y', P = 'p', N = 'n'
    const FEATURES = [
      ['Núcleo'],
      ['Lista virtualizada', [Y, Y, Y, Y, Y, N, N]],
      ['Múltiplos cursores', [Y, Y, Y, Y, Y, N, N]],
      ['Quebra de linha', [Y, Y, Y, Y, Y, Y, [P, 'via CSS']]],
      ['Busca e substituição', [Y, Y, Y, Y, Y, Y, N]],
      ['Cresce com a página sem perder a virtualização', [[Y, 'minLines/maxLines'], Y, [N, 'viewportMargin: Infinity'], [N, 'altura fixa'], [N, 'maxLines: Infinity'], N, N]],
      ['Mais de 1 milhão de linhas', [[Y, 'modo compacto'], Y, [P, 'limite de altura'], Y, Y, N, N]],
      ['Linguagens e aparência'],
      ['Linguagens prontas', ['11 + ~80 via Monarch', '~25 + 100 legadas', '100+', '~80', '150+', '290+ (Prism)', 'traga o seu']],
      ['Importa gramáticas do Monaco (Monarch)', [[Y, 'fromMonarch'], N, N, [Y, 'nativo'], N, N, N]],
      ['Importa temas do VS Code', [[Y, 'fromVSCodeTheme'], [P, 'comunidade'], N, [P, 'conversão'], N, N, N]],
      ['Linguagem dentro de linguagem (HTML com JS e CSS)', [[Y, 'embed'], Y, [Y, 'mixed modes'], [Y, 'nextEmbedded'], Y, Y, [P, 'do destacador']]],
      ['Criar linguagem com regex e estados', [Y, [P, 'StreamLanguage'], [Y, 'simple mode'], [Y, 'Monarch'], Y, [Y, 'Prism'], [Y, 'Prism/hljs']]],
      ['Tokens novos sem mexer na gramática', [[Y, 'tokenRule'], [Y, 'MatchDecorator'], [Y, 'overlay'], [P, 'decorations'], [P, 'markers'], P, P]],
      ['Tema como objeto, com herança', [Y, Y, [P, 'CSS'], [P, '1 por página'], [P, 'CSS'], [P, 'CSS'], [P, 'CSS']]],
      ['Recursos avançados'],
      ['Autocomplete', [[Y, 'leve, sem LSP'], Y, [Y, 'addon'], Y, Y, Y, N]],
      ['Diagnósticos (lint)', [[Y, 'traga o linter'], Y, [Y, 'addon'], Y, Y, P, N]],
      ['Tooltips', [Y, Y, [P, 'addon'], Y, Y, P, N]],
      ['Folding', [Y, Y, [Y, 'addon'], Y, Y, Y, N]],
      ['Diff e revisão lado a lado', [[Y, 'diffView + mergeView'], [Y, '@codemirror/merge'], [Y, 'addon merge'], [Y, 'diff editor'], [P, 'comunidade'], N, N]],
      ['Trechos somente leitura', [[Y, 'readOnlyRanges'], [Y, 'changeFilter'], [Y, 'markText readOnly'], [P, 'contornos'], [P, 'comunidade'], N, N]],
      ['Texto fantasma (sugestões inline)', [[Y, 'inlineSuggestion'], [P, 'comunidade'], N, [Y, 'inline completions'], [P, 'inline_autocomplete'], N, N]],
      ['Ferramentas prontas para agentes de IA', [[Y, 'editorTools + applyEdits'], N, N, N, N, N, N]],
      ['Elementos entre linhas, com espaço próprio', [[Y, 'addZone'], [Y, 'block widgets'], [Y, 'line widgets'], [Y, 'view zones'], [P, 'line_widgets'], N, N]],
      ['Árvore sintática', [[Y, 'tree-sitter, opcional'], [Y, 'Lezer'], N, [P, 'só TS'], N, N, N]],
      ['Colaboração (Yjs)', [[Y, 'collab + yjs, ou backend seu'], Y, [P, 'comunidade'], [P, 'comunidade'], [P, 'comunidade'], N, N]],
      ['Plataforma'],
      ['Tree-shaking por recurso', [Y, Y, N, P, N, Y, [P, 'módulo único']]],
      ['Web Component oficial', [Y, N, N, N, N, Y, N]],
      ['Campo de formulário nativo (name, reset, required)', [Y, N, [Y, 'fromTextArea'], N, N, [P, 'textarea interno'], N]],
      ['Estático até ser usado, sem deslocar nada', [[Y, 'lazyEditor'], N, N, N, N, N, N]],
      ['React e Vue oficiais', [Y, [P, 'comunidade'], [P, 'comunidade'], [P, 'comunidade'], [P, 'comunidade'], P, N]],
      ['Mobile', [[P, 'Android validado; iOS não'], Y, P, [N, 'não suportado'], P, Y, P]],
      ['Leitor de tela', [[P, 'textarea espelhado; falta teste com NVDA/VoiceOver'], Y, P, Y, P, Y, P]],
      ['RTL / texto bidirecional', [N, Y, Y, P, P, Y, P]],
    ]
    const sym = (v) => {
      const [code, note] = Array.isArray(v) ? v : [v, '']
      const kind = { y: ['yes', '✓', 'sim'], p: ['part', '~', 'parcial'], n: ['no', '✗', 'não'] }[code]
      if (!kind) return `<span class="mono">${esc(code)}</span>`
      return `<span class="sym ${kind[0]}" role="img" aria-label="${kind[2]}">${kind[1]}</span>${note ? `<small>${esc(note)}</small>` : ''}`
    }
    $('#matrix').innerHTML = `<thead><tr><th>Recurso</th>${LIBS.map((l) => `<th class="${l.me ? 'me' : ''}">${esc(l.name)}</th>`).join('')}</tr></thead><tbody>${
      FEATURES.map(([name, vals]) => vals
        ? `<tr><td>${esc(name)}</td>${vals.map((v, i) => `<td class="${LIBS[i].me ? 'me' : ''}">${sym(v)}</td>`).join('')}</tr>`
        : `<tr class="group"><td colspan="${LIBS.length + 1}">${esc(name)}</td></tr>`).join('')}</tbody>`

    // --- scores: measured criteria come from formulas, the rest is judgment
    const clamp = (v) => Math.max(0, Math.min(10, v))
    const sizeScore = (l) => clamp(10 - 4 * Math.log10(gzKB(l.bench) / 10))
    const perfScore = (l) => (clamp(10 - 4 * Math.log10(paint(l) / 25)) + clamp(10 - 2.5 * Math.log10(nodes(l) / 200))) / 2
    const CRITERIA = [
      ['size', 'Tamanho', 'medido'], ['perf', 'Desempenho em arquivo grande', 'medido'], ['api', 'Simplicidade da API'],
      ['langApi', 'Criar linguagens'], ['themes', 'Temas'], ['modular', 'Modularidade'], ['frameworks', 'Frameworks'],
      ['features', 'Recursos de edição'], ['langs', 'Linguagens prontas'], ['robust', 'Robustez e maturidade'],
      ['a11y', 'Acessibilidade'], ['mobile', 'Mobile'], ['eco', 'Ecossistema'],
    ]
    const JUDGED = {
      jonacode: [9, 9, 10, 9, 8, 9, 7, 4, 5, 7, 2],
      cm6: [5, 9, 8, 10, 9, 9, 8, 9, 8, 9, 10],
      cm5: [8, 7, 7, 5, 7, 8, 9, 8, 5, 5, 7],
      monaco: [6, 8, 6, 3, 9, 10, 9, 10, 9, 2, 10],
      ace: [7, 7, 7, 4, 7, 8, 9, 9, 6, 4, 8],
      pce: [8, 7, 8, 8, 7, 6, 9, 6, 6, 8, 4],
      codejar: [9, 7, 7, 8, 6, 2, 9, 6, 5, 6, 4],
    }
    // Jonacode after the roadmap below (reliability, LSP, RTL).
    const PROJECTED = [9, 9, 10, 9, 8, 10, 8, 7, 7, 8, 3]
    const scoresOf = (l, judged = JUDGED[l.id]) => [sizeScore(l), perfScore(l), ...judged]
    const PRESETS = {
      'Propósito do Jonacode': [4, 4, 3, 3, 2, 2, 2, 0, 0, 0, 0, 0, 0],
      'Mercado geral': [1, 2, 0, 0, 0, 0, 0, 5, 2, 4, 2, 2, 2],
      'Site de docs / blog': [5, 2, 4, 0, 4, 0, 1, 0, 3, 0, 2, 3, 0],
      'IDE no navegador': [0, 3, 0, 0, 0, 0, 0, 5, 3, 4, 2, 0, 3],
      'App mobile': [3, 3, 0, 0, 0, 0, 0, 2, 0, 2, 2, 5, 0],
    }
    let weights = [...PRESETS['Propósito do Jonacode']]
    const presetBox = $('#score-presets')
    presetBox.innerHTML = Object.keys(PRESETS).map((name, i) => `<button class="preset" type="button" aria-pressed="${i === 0}" data-preset="${esc(name)}"><i style="--a:#528bff;--b:#6b7385"></i>${esc(name)}</button>`).join('')
    const wBox = $('#weights')
    wBox.innerHTML = CRITERIA.map(([id, label, src], i) => `<label data-i="${i}"><span>${esc(label)}${src ? ' <small class="muted">· medido</small>' : ''}</span><input type="range" min="0" max="5" step="1" value="${weights[i]}" aria-label="Peso de ${esc(label)}"><output>${weights[i]}</output></label>`).join('') +
      '<div class="w-note">peso 0 a 5 · nota = média ponderada</div>'
    const rankHost = $('#ranking')
    rankHost.classList.add('viz')
    const rows = [...LIBS.map((l) => ({ key: l.id, name: l.name, me: !!l.me, scores: scoresOf(l) })),
      { key: 'proj', name: 'Jonacode (projeção)', me: true, proj: true, scores: scoresOf(me, PROJECTED) }]
    rankHost.innerHTML = `<div class="hbars">${rows.map((r) => `<div class="hbar ${r.me ? 'me' : ''} ${r.proj ? 'proj' : ''}" data-key="${r.key}" tabindex="0"><span class="hbar-name">${esc(r.name)}</span><span class="hbar-track"><i class="hbar-fill"></i><b class="hbar-value"></b></span></div>`).join('')}</div>`
    const rtip = makeTip(rankHost)
    const total = (r) => {
      const sw = weights.reduce((a, b) => a + b, 0)
      return sw ? r.scores.reduce((sum, s, i) => sum + s * weights[i], 0) / sw : 0
    }
    const drawRanking = () => {
      const showProj = $('#projection').checked
      const visible = rows.filter((r) => showProj || !r.proj)
      const ranked = [...visible].sort((a, b) => total(b) - total(a))
      $('.hbars', rankHost).style.height = visible.length * ROW + 'px'
      for (const el of $$('.hbar', rankHost)) {
        const r = rows.find((x) => x.key === el.dataset.key)
        const on = visible.includes(r)
        el.style.display = on ? '' : 'none'
        if (!on) continue
        const t = total(r)
        el.style.top = ranked.indexOf(r) * ROW + 'px'
        el.querySelector('.hbar-fill').style.width = t * 8 + '%'
        const v = el.querySelector('.hbar-value')
        v.style.left = t * 8 + '%'
        v.textContent = fmtNum(t, 1) + (ranked.indexOf(r) === 0 ? '  · 1º' : '')
      }
      $$('label', wBox).forEach((lab, i) => {
        lab.classList.toggle('zero', !weights[i])
        lab.querySelector('output').textContent = weights[i]
        lab.querySelector('input').value = weights[i]
      })
      $('#score-table').innerHTML = `<thead><tr><th>Critério (peso)</th>${LIBS.map((l) => `<th class="${l.me ? 'me' : ''}">${esc(l.name)}</th>`).join('')}</tr></thead><tbody>${
        CRITERIA.map(([, label, src], i) => `<tr><td>${esc(label)} <small>${src ? 'medido · ' : ''}peso ${weights[i]}</small></td>${LIBS.map((l) => `<td class="${l.me ? 'me' : ''}">${fmtNum(scoresOf(l)[i], src ? 1 : 0)}</td>`).join('')}</tr>`).join('')
      }<tr><td><b>Nota ponderada</b></td>${LIBS.map((l) => `<td class="${l.me ? 'me' : ''}"><b>${fmtNum(total(rows.find((r) => r.key === l.id)), 1)}</b></td>`).join('')}</tr></tbody>`
    }
    for (const el of $$('.hbar', rankHost)) {
      const show = () => {
        const r = rows.find((x) => x.key === el.dataset.key)
        const contrib = CRITERIA.map(([, label], i) => [label, r.scores[i] * weights[i]]).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 4)
        const box = el.querySelector('.hbar-fill').getBoundingClientRect()
        const host = rankHost.getBoundingClientRect()
        rtip.show(r.name, fmtNum(total(r), 1) + ' / 10', contrib.map(([label]) => [label, fmtNum(r.scores[CRITERIA.findIndex((c) => c[1] === label)], 1)]),
          box.right - host.left, box.top - host.top, r.me)
      }
      el.addEventListener('pointerenter', show)
      el.addEventListener('focus', show)
      el.addEventListener('pointerleave', () => rtip.hide())
      el.addEventListener('blur', () => rtip.hide())
    }
    wBox.addEventListener('input', (e) => {
      const lab = e.target.closest('label')
      if (!lab) return
      weights[+lab.dataset.i] = +e.target.value
      $$('.preset', presetBox).forEach((b) => b.setAttribute('aria-pressed', String(PRESETS[b.dataset.preset].every((w, i) => w === weights[i]))))
      drawRanking()
    })
    presetBox.addEventListener('click', (e) => {
      const btn = e.target.closest('.preset')
      if (!btn) return
      weights = [...PRESETS[btn.dataset.preset]]
      $$('.preset', presetBox).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)))
      drawRanking()
    })
    $('#projection').addEventListener('change', drawRanking)
    drawRanking()

    // --- when to choose each one
    const CHOOSE = [
      ['jonacode', 'Um editor leve em páginas que podem receber arquivos grandes: documentação com muitos trechos (estáticos até alguém editar), visualizadores de logs com milhões de linhas, formulários de CMS e low-code, ensino. Também para produtos com IA (ferramentas prontas para agentes e revisão com diff), edição colaborativa, ou quando você quer criar uma linguagem ou um tema próprio, ou reaproveitar os do Monaco e do VS Code.', 'Hoje, evite se precisar de LSP (IntelliSense de verdade) ou de texto da direita para a esquerda (RTL). O leitor de tela funciona, mas ainda sem teste com NVDA ou VoiceOver, e o iOS não foi validado.'],
      ['cm6', 'A escolha completa e moderna: acessibilidade, mobile, colaboração, árvore sintática e um ecossistema enorme.', 'Custo: uma API mais difícil (estado, facets, transações) e cerca de 4× o tamanho.'],
      ['cm5', 'Manter projetos que já usam CodeMirror 5: é estável e tem mais de 100 modos.', 'Está em modo de manutenção. Para projetos novos, prefira o CodeMirror 6.'],
      ['monaco', 'A experiência do VS Code no desktop: IntelliSense de TypeScript, diff, minimapa e sticky scroll.', 'Custo: ~0,8–1,2 MB gzip, workers, configuração de bundler e nenhum suporte oficial a mobile.'],
      ['ace', 'Projetos que precisam de 150+ modos prontos e de uma API estável e direta.', 'Monolítico: pouco tree-shaking e suporte limitado a mobile.'],
      ['pce', 'Blocos pequenos e médios em docs e blogs, com as 290+ linguagens do Prism em ~11 kB.', 'Renderiza todas as linhas: com 100 mil linhas levou mais de 4 s. Um cursor por vez.'],
      ['codejar', 'O mínimo absoluto para editar trechos curtos, trazendo seu próprio destacador.', 'Sem recursos de editor e sem virtualização: 1,6 s para abrir 100 mil linhas.'],
    ]
    $('#choose').innerHTML = CHOOSE.map(([id, good, avoid]) => {
      const l = lib(id)
      return `<div class="panel ${l.me ? 'me' : ''}"><h3><i></i>${esc(l.name)}</h3><p>${esc(good)}</p><p class="avoid">${esc(avoid)}</p></div>`
    }).join('')
  }

  addEventListener('hashchange', route)
  route()
})()
