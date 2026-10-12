// An invented language, to show how easy it is to add new ones.
// "JonaLang": a tiny Portuguese-flavoured scripting language.
import { defineLanguage, words } from '../dist/index.js'

export const jonalang = defineLanguage({
  name: 'jonalang',
  aliases: ['jona'],
  comments: { line: '#' },
  brackets: [['{', '}'], ['(', ')'], ['[', ']']],
  closePairs: [['{', '}'], ['(', ')'], ['[', ']'], ['"', '"']],
  states: {
    root: [
      [/#.*/, 'comment'],
      [/"/, 'string', '@string'],
      [/\d+(?:,\d+)?/, 'number'],
      // `funcao nome(` → keyword + function name
      [/(funcao)(\s+)([a-zà-ú_]\w*)/i, ['keyword', null, 'function']],
      {
        match: /[a-zà-úA-ZÀ-Ú_][\wà-úÀ-Ú]*/,
        token: words({
          keyword: ['se', 'senao', 'enquanto', 'para', 'retorne', 'var', 'const', 'e', 'ou', 'nao'],
          'constant.language': ['verdadeiro', 'falso', 'nulo'],
          'type.builtin': ['mostre', 'leia'],
        }, 'variable'),
      },
      [/[{}()[\]]/, 'punctuation.bracket'],
      [/[-+*/=<>!]+/, 'operator'],
    ],
    string: [
      [/\{[^}]*\}/, 'punctuation.special'],
      [/[^"{]+/, 'string'],
      [/"/, 'string', '@pop'],
    ],
  },
})

export const jonalangSample = `# JonaLang: uma linguagem inventada 🇧🇷
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
}
`
