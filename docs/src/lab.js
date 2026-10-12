/* Jonacode language lab: write a grammar (Jonacode or Monarch), see it live, test it, export it. */
;(() => {
  const J = window.Jonacode
  const { createEditor, basicSetup, defineLanguage, extendLanguage, words, javascript, oneDark, oneLight, tokenInspector, plainText, fromMonarch, describeTokens, expectTokens, fromVSCodeTheme } = J
  const $ = (s) => document.querySelector(s)
  const $$ = (s) => [...document.querySelectorAll(s)]
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const LANGS = Object.fromEntries(['javascript', 'jsx', 'typescript', 'tsx', 'json', 'css', 'html', 'markdown', 'sql', 'shell', 'log'].filter((k) => J[k]).map((k) => [k, J[k]]))

  // ------------------------------------------------------------------ presets
  const PRESETS = {
    jonacode: {
      jonalang: {
        label: 'JonaLang (inventada)',
        grammar: `// Uma gramática é uma função que retorna defineLanguage({...}).
// Disponíveis aqui: defineLanguage, extendLanguage, words e languages (as prontas).
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
})`,
        sample: `# JonaLang: uma linguagem inventada
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
}`,
      },
      ini: {
        label: 'INI / .env',
        grammar: `return defineLanguage({
  name: 'ini',
  aliases: ['env', 'properties'],
  comments: { line: ';' },
  states: {
    root: [
      [/[;#].*/, 'comment'],
      [/^\\s*\\[[^\\]]*\\]/, 'keyword'],
      [/^(\\s*)([\\w.-]+)(\\s*)(=)/, [null, 'property', null, 'operator'], '@value'],
    ],
    value: [
      [/$/, null, '@pop'],
      [/"/, 'string', '@quoted'],
      [/\\$\\{[^}]*\\}/, 'variable'],
      [/\\b(true|false|yes|no|on|off)\\b/i, 'constant.language'],
      [/-?\\d+(\\.\\d+)?\\b/, 'number'],
      [/[^"$\\s]+|\\s+|\\$/, 'string'],
    ],
    quoted: [
      [/\\\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
      [/[^"\\\\]+/, 'string'],
    ],
  },
})`,
        sample: `; configuração do servidor
[servidor]
porta = 8080
host = "0.0.0.0"
debug = false

[banco]
url = postgres://\${DB_USER}@localhost/app
pool = 10`,
      },
      html: {
        label: 'Estendendo o HTML',
        grammar: `// extendLanguage adiciona regras a uma linguagem pronta.
// Aqui: {{ expressões }} de template dentro do HTML, destacadas como JavaScript.
return extendLanguage(languages.html, {
  name: 'html-template',
  prepend: {
    root: [
      { match: '{{', token: 'punctuation.special', push: 'close',
        embed: { language: languages.javascript, end: '}}' } },
      // O texto comum do HTML ([^<&]+) engoliria o "{{": aqui ele para antes de "{".
      [/[^<&{]+/, null],
      ['{', null],
    ],
  },
  states: {
    close: [['}}', 'punctuation.special', '@pop']],
  },
})`,
        sample: `<ul class="lista">
  <li>Olá, {{ usuario.nome.toUpperCase() }}!</li>
  <li>Total: {{ itens.reduce((s, i) => s + i.valor, 0) }}</li>
</ul>
<script>
  const usuario = { nome: 'Jonathan' }
</script>`,
      },
      vazio: {
        label: 'Em branco',
        grammar: `return defineLanguage({
  name: 'minha',
  states: {
    root: [
      [/\\/\\/.*/, 'comment'],
      [/"[^"]*"/, 'string'],
      [/\\d+/, 'number'],
    ],
  },
})`,
        sample: `// comece aqui
"texto" 42`,
      },
    },
    monarch: {
      exemplo: {
        label: 'Exemplo Monarch',
        grammar: `// Uma gramática Monarch (o formato do Monaco): retorne o objeto \`language\`.
// Dá para colar aqui as de monaco-editor/esm/vs/basic-languages/*.
return {
  defaultToken: '',
  tokenPostfix: '.mini',
  keywords: ['if', 'else', 'while', 'return', 'fn', 'let', 'true', 'false', 'null'],
  typeKeywords: ['int', 'bool', 'text'],
  operators: ['=', '>', '<', '!', '==', '<=', '>=', '!=', '&&', '||', '+', '-', '*', '/'],
  symbols: /[=><!~?:&|+\\-*\\/\\^%]+/,
  escapes: /\\\\(?:[nrt\\\\"']|u[0-9a-fA-F]{4})/,
  tokenizer: {
    root: [
      [/[a-z_$][\\w$]*/, { cases: { '@typeKeywords': 'type', '@keywords': 'keyword', '@default': 'identifier' } }],
      [/[A-Z][\\w$]*/, 'type.identifier'],
      { include: '@whitespace' },
      [/[{}()\\[\\]]/, '@brackets'],
      [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
      [/\\d+\\.\\d+/, 'number.float'],
      [/\\d+/, 'number'],
      [/[;,.]/, 'delimiter'],
      [/"/, { token: 'string.quote', next: '@string' }],
    ],
    string: [
      [/[^\\\\"]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\\\./, 'string.escape.invalid'],
      [/"/, { token: 'string.quote', next: '@pop' }],
    ],
    whitespace: [
      [/[ \\t\\r\\n]+/, 'white'],
      [/\\/\\*/, 'comment', '@comment'],
      [/\\/\\/.*$/, 'comment'],
    ],
    comment: [
      [/[^\\/*]+/, 'comment'],
      [/\\*\\//, 'comment', '@pop'],
      [/[\\/*]/, 'comment'],
    ],
  },
}`,
        sample: `/* Mini: uma linguagem de exemplo em Monarch */
fn media(valores: int) {
  let soma = 0
  while (i < valores.tamanho) {
    soma = soma + valores[i]
  }
  return soma / valores.tamanho // inteiro
}
let texto = "olá\\n" + Nome.completo
if (texto != null && true) { return 1.5 }`,
      },
      vazio: {
        label: 'Em branco (Monarch)',
        grammar: `return {
  tokenizer: {
    root: [
      [/\\/\\/.*$/, 'comment'],
      [/"[^"]*"/, 'string'],
      [/\\d+/, 'number'],
    ],
  },
}`,
        sample: `// comece aqui
"texto" 42`,
      },
    },
  }

  // ------------------------------------------------------------------ state (kept in this browser only)
  const STORE = 'jonacode-lab'
  const load = () => {
    try { return JSON.parse(localStorage.getItem(STORE) ?? 'null') } catch { return null }
  }
  const save = () => {
    try { localStorage.setItem(STORE, JSON.stringify({ format, preset, grammar: grammarEd.getValue(), sample: sampleEd.getValue(), tests: testsEd.getValue() })) } catch {}
  }
  const saved = load()
  let format = saved?.format ?? 'jonacode'
  let preset = saved?.preset ?? 'jonalang'
  let theme = oneDark
  let lang = plainText

  // ------------------------------------------------------------------ editors
  const PHRASES = { Find: 'Buscar', Replace: 'Substituir', 'Go to line': 'Ir para a linha', Line: 'Linha' }
  const grammarEd = createEditor($('#grammar'), { value: saved?.grammar ?? PRESETS[format][preset].grammar, language: javascript, phrases: PHRASES, extensions: basicSetup() })
  const sampleEd = createEditor($('#sample'), { value: saved?.sample ?? PRESETS[format][preset].sample, phrases: PHRASES, extensions: [basicSetup(), tokenInspector()] })
  const testsEd = createEditor($('#tests'), { value: saved?.tests ?? '', phrases: PHRASES, extensions: basicSetup({ closeBrackets: false }), placeholder: 'Clique em “Gerar do exemplo”, ou escreva:\nlet x = 1\n^^^ keyword' })

  // ------------------------------------------------------------------ compile the grammar
  const status = $('#status')
  let perfTimer = 0
  const compile = () => {
    const src = grammarEd.getValue()
    try {
      const out = new Function('defineLanguage', 'extendLanguage', 'words', 'languages', src)(defineLanguage, extendLanguage, words, LANGS)
      if (format === 'monarch') {
        if (!out || !out.tokenizer) throw new Error('a gramática Monarch precisa retornar um objeto com "tokenizer"')
        lang = fromMonarch(out, { name: out.name ?? 'monarch' })
      } else {
        if (!out || typeof out.tokenize !== 'function') throw new Error('a gramática precisa retornar defineLanguage({...}) ou extendLanguage(...)')
        lang = out
      }
      sampleEd.setOptions({ language: lang })
      const states = format === 'monarch' ? Object.keys(out.tokenizer).length : Object.keys(lang.spec?.states ?? {}).length
      status.innerHTML = `<span class="ok">✓ ${esc(lang.name)}</span><span><b>${states}</b> estados</span><span id="perf">medindo…</span>`
      clearTimeout(perfTimer)
      perfTimer = setTimeout(measure, 400)
      inspect()
      save()
    } catch (err) {
      status.innerHTML = `<span class="err">✗ ${esc(err.message)}</span>`
    }
  }
  /** Tokenization speed on the sample repeated to ~20k lines. */
  const measure = () => {
    const lines = sampleEd.doc.lines
    if (!lines.length) return
    const reps = Math.max(1, Math.ceil(20000 / lines.length))
    let state = lang.initialState
    const t0 = performance.now()
    let n = 0
    for (let r = 0; r < reps; r++) for (const line of lines) { state = lang.endState(line, state); n++ }
    const ms = performance.now() - t0
    const el = $('#perf')
    if (el) el.innerHTML = `<b>${Math.round(n / (ms / 1000)).toLocaleString('pt-BR')}</b> linhas/s`
  }

  // ------------------------------------------------------------------ inspection
  const stateAtLine = (line) => {
    let state = lang.initialState
    for (let i = 0; i < line && i < 20000; i++) state = lang.endState(sampleEd.doc.line(i), state)
    return state
  }
  const inspect = () => {
    const { line, col } = sampleEd.selection.head
    const text = sampleEd.doc.line(line)
    const start = stateAtLine(line)
    // Tokens of the cursor line, in the same caret format the tests use.
    const { tokens } = lang.tokenize(text, start)
    let out = esc(text) + '\n'
    for (const t of tokens) {
      if (!t.type) continue
      out += ' '.repeat(t.from) + '^'.repeat(Math.max(1, t.to - t.from)) + ` <span class="t">${esc(t.type)}</span>\n`
    }
    $('#line-tokens').innerHTML = text ? out : '<span class="muted">(linha vazia)</span>'
    const stack = lang.stateAtColumn(text, start, col).stack
    $('#stack').innerHTML = stack.map((s, i) => `${i ? '<i>›</i>' : ''}<span class="${i === stack.length - 1 ? 'top' : ''} ${s.startsWith('@') ? 'lang' : ''}">${esc(s)}</span>`).join('')
    $('#stack-note').textContent = `linha ${line + 1}, coluna ${col + 1} · a pilha continua na próxima linha, e é assim que comentários e strings de várias linhas funcionam.`
  }
  sampleEd.on('selection', inspect)
  sampleEd.on('change', () => {
    inspect()
    save()
  })
  let compileTimer = 0
  grammarEd.on('change', () => {
    clearTimeout(compileTimer)
    compileTimer = setTimeout(compile, 250)
  })
  testsEd.on('change', save)

  // ------------------------------------------------------------------ tests
  const out = $('#tests-out')
  const badge = $('#tests-badge')
  const runTests = () => {
    const src = testsEd.getValue()
    if (!src.trim()) {
      out.className = 'tests-out'
      out.textContent = ''
      badge.className = 'badge'
      badge.textContent = ''
      return
    }
    try {
      expectTokens(lang, src)
      out.className = 'tests-out pass'
      out.textContent = '✓ todos os tokens conferem'
      badge.className = 'badge pass'
      badge.textContent = '✓'
    } catch (err) {
      out.className = 'tests-out fail'
      out.textContent = err.message
      badge.className = 'badge fail'
      badge.textContent = '✗'
    }
  }
  $('#tests-generate').addEventListener('click', () => {
    testsEd.setValue(describeTokens(lang, sampleEd.getValue()))
    runTests()
  })
  $('#tests-run').addEventListener('click', runTests)

  // ------------------------------------------------------------------ tabs, presets, format, theme
  for (const b of $$('.tabs button')) {
    b.addEventListener('click', () => {
      for (const x of $$('.tabs button')) x.setAttribute('aria-selected', String(x === b))
      for (const p of $$('.tab')) p.hidden = p.dataset.panel !== b.dataset.tab
    })
  }
  const fillPresets = () => {
    $('#preset').innerHTML = Object.entries(PRESETS[format]).map(([id, p]) => `<option value="${id}" ${id === preset ? 'selected' : ''}>${esc(p.label)}</option>`).join('')
    $('#grammar-title').textContent = format === 'monarch' ? 'gramatica.monarch.js' : 'gramatica.js'
    $('#grammar-hint').textContent = format === 'monarch' ? 'fromMonarch(objeto)' : 'defineLanguage({ states })'
    for (const b of $$('.seg button')) b.setAttribute('aria-selected', String(b.dataset.format === format))
  }
  const usePreset = (id) => {
    preset = id
    const p = PRESETS[format][id]
    grammarEd.setValue(p.grammar)
    sampleEd.setValue(p.sample)
    testsEd.setValue('')
    compile()
    runTests()
  }
  $('#preset').addEventListener('change', (e) => usePreset(e.target.value))
  for (const b of $$('.seg button')) {
    b.addEventListener('click', () => {
      if (b.dataset.format === format) return
      format = b.dataset.format
      preset = Object.keys(PRESETS[format])[0]
      fillPresets()
      usePreset(preset)
    })
  }
  const applyTheme = (t) => {
    theme = t
    document.documentElement.dataset.theme = t.dark ? 'dark' : 'light'
    for (const ed of [grammarEd, sampleEd, testsEd]) ed.setOptions({ theme: t })
  }
  $('#theme').addEventListener('change', (e) => {
    const v = e.target.value
    if (v === 'dark') applyTheme(oneDark)
    else if (v === 'light') applyTheme(oneLight)
    else $('#vscode-dialog').showModal()
  })
  $('#vscode-dialog').addEventListener('close', () => {
    const dialog = $('#vscode-dialog')
    if (dialog.returnValue !== 'apply') {
      $('#theme').value = theme === oneLight ? 'light' : 'dark'
      return
    }
    try {
      applyTheme(fromVSCodeTheme($('#vscode-json').value))
      $('#vscode-error').textContent = ''
    } catch (err) {
      $('#vscode-error').textContent = err.message
      dialog.showModal()
    }
  })

  // ------------------------------------------------------------------ export
  const ident = () => (lang.name || 'minhaLinguagem').replace(/[^\w$]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^\d/, '_$&')
  const moduleSource = () => {
    const body = grammarEd.getValue().split('\n').map((l) => (l ? '  ' + l : l)).join('\n')
    return format === 'monarch'
      ? `import { fromMonarch } from 'jonacode/monarch'\n\nconst spec = (() => {\n${body}\n})()\n\nexport const ${ident()} = fromMonarch(spec, { name: ${JSON.stringify(lang.name)} })\n`
      : `import { defineLanguage, extendLanguage, words } from 'jonacode'\n${languageImports()}\nexport const ${ident()} = (() => {\n${body}\n})()\n`
  }
  /** Imports for the built-in languages the grammar uses through `languages.x`. */
  const languageImports = () => {
    const FILE = { jsx: 'javascript', tsx: 'typescript' }
    const used = [...new Set([...grammarEd.getValue().matchAll(/languages\.(\w+)/g)].map((m) => m[1]))].filter((n) => LANGS[n])
    if (!used.length) return ''
    return used.map((n) => `import { ${n} } from 'jonacode/languages/${FILE[n] ?? n}'`).join('\n') + `\nconst languages = { ${used.join(', ')} }\n`
  }
  const testSource = () => {
    const annotated = (testsEd.getValue().trim() ? testsEd.getValue() : describeTokens(lang, sampleEd.getValue())).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
    return `import { test } from 'node:test'\nimport { expectTokens } from 'jonacode/testing'\nimport { ${ident()} } from './${lang.name}.js'\n\ntest('${lang.name}: tokens', () => {\n  expectTokens(${ident()}, \`\n${annotated}\n\`)\n})\n`
  }
  const copy = async (btn, text) => {
    try {
      await navigator.clipboard.writeText(text)
      btn.classList.add('ok')
      const label = btn.textContent
      btn.textContent = 'Copiado'
      setTimeout(() => { btn.textContent = label; btn.classList.remove('ok') }, 1300)
    } catch {
      prompt('Copie:', text)
    }
  }
  $('#copy-module').addEventListener('click', (e) => copy(e.currentTarget, moduleSource()))
  $('#copy-tests').addEventListener('click', (e) => copy(e.currentTarget, testSource()))
  $('#download').addEventListener('click', () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([moduleSource()], { type: 'text/javascript' }))
    a.download = `${lang.name || 'linguagem'}.js`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  })

  fillPresets()
  compile()
  runTests()
  window.lab = { grammarEd, sampleEd, testsEd, get language() { return lang } }
})()
