# Changelog

Todas as mudanças relevantes do Jonacode, da mais nova para a mais antiga. As versões seguem o [versionamento semântico](https://semver.org/lang/pt-BR/); enquanto estiver em `0.x`, uma versão menor pode mudar a API.

## 0.2.0

Melhorias que saíram do uso do Jonacode como editor do JCode.

### Novidades

- **Recuo configurável.** `padding: { x, y }` em `createEditor` e `setOptions`: o espaço em volta do texto deixa de ser fixo, e toda a geometria (clique, cursor, seleção, quebra de linha) lê o mesmo valor. `editor.padding` devolve o que está em uso. `highlight()` e `lazyEditor()` aceitam o mesmo `padding`.
- **Calhas.** `lineNumbers({ padding })` ajusta o espaço em volta dos números. `diagnostics({ gutter: 'line-numbers' })` desenha a marca no próprio número, sem calha própria; `gutterWidth` muda a largura da calha quando ela existe. `lineNumberClass(fn)` dá uma classe ao número de qualquer linha.
- **Compartimentos.** `compartment()` guarda uma parte das extensões que pode ser trocada sem tocar nas outras: `parte.of(ext)` na lista, `parte.reconfigure(editor, ext)` depois. O que ele instala fica no lugar dele na ordem. Por baixo, `editor.slot()`.
- **`setExtensions` preserva o que continua.** As extensões que seguem na lista (a mesma função, na mesma ordem relativa) ficam instaladas, com o estado delas; antes tudo era desfeito e refeito.
- **Faixas travadas nas pontas.** `ProtectedRange` ganhou `inclusiveStart` e `inclusiveEnd`, e `lineRange(editor, de, até, { sticky: true })` fecha a borda que encosta no começo ou no fim do documento. `blocksChange(faixa, mudança)` é exportada.
- **`lineWidgets(fonte)`.** Zonas mantidas a partir de um provedor, comparadas por `key` (o "code lens"): cria, move, atualiza e remove sozinho, com `refreshLineWidgets(editor)` para quando algo de fora muda.
- **Ações de zona.** `ZoneAction` aceita `disabled` e `class`; `ZoneSpec` aceita `status` (um texto depois das ações), `separator` e `keepFocus` (cliques em `content` não tiram o foco do editor).
- **`onApplied` na edição com IA.** Chamado depois de a troca entrar no documento, com o documento de antes e a faixa do código novo.
- **Frases tipadas.** `PHRASES` lista todas as chaves da interface; a opção `phrases` é `Partial<Record<PhraseKey, string>>`. Pacote pronto em `jonacode/locales/pt-BR`.
- **`ensureHighlightStyles(raiz, ...temas)`.** Põe na página (ou no shadow root) o CSS do destaque estático, uma vez só.
- **Recuo padrão por linguagem.** `indent: { useTabs, size }` em `defineLanguage`; o editor usa quando o app não passa `insertSpaces` nem `tabSize`.
- **Vários arquivos num editor.** `editor.getState()` e `editor.setState(estado)` guardam e trazem de volta um documento inteiro: texto, linguagem, histórico de desfazer, seleção, rolagem e dobras. As faixas travadas, os diagnósticos e o original do `diffView` vão junto; `addStateField` deixa uma extensão guardar o que é dela por documento.
- **Go.** `jonacode/languages/go`, com o recuo por tab declarado na própria linguagem.
- **`lazyEditor` e `highlight` com `lineNumbers: { padding }`.** O bloco estático espelha o espaço em volta dos números, como já espelhava o `padding` do texto.
- **Pacote.** Entrada `jonacode/locales/*`; os `.d.ts` importam com `.js` (compilam sem `allowImportingTsExtensions`); `npm run check:package` confere o pacote instalado num projeto limpo.

### Mudanças de comportamento

- No Windows e no Linux, Ctrl+G deixou de ser "próxima ocorrência" da busca e passou a abrir "ir para a linha", como a documentação já dizia; a próxima ocorrência é F3. No macOS nada muda (⌘G e Ctrl+G).
- `editor.phrase(chave)` e a opção `phrases` são tipados por `PhraseKey`. Um texto que não está em `PHRASES` (de uma extensão sua) precisa de `as PhraseKey`.
- A frase longa da edição com IA virou a chave `'inlineEdit.conflict'`. Uma tradução feita pela frase antiga em inglês continua funcionando em execução, mas um objeto literal de `phrases` com essa chave antiga não compila mais: troque pela chave nova, ou use o pacote `ptBR`.
- No componente Vue, `insertSpaces` não tem mais o padrão `true`: sem a prop, vale o padrão da linguagem (espaços, a não ser que ela peça tab).
- `highlightAll()` e `lazyEditor()` injetam o CSS com os ids `static` e o do tema (o mesmo que o editor usa), em vez de `static<tema>`.
- Na barra de `actions` de uma zona, nenhum clique tira o foco do editor (antes só os botões; o separador tirava).

### Correções

- **Ctrl+G no Windows e no Linux.** "Ir para a linha" nunca abria: a busca registrava `Mod-g` ("próxima ocorrência"), que fora do macOS é o mesmo Ctrl+G, e ficava com a tecla. Agora `Mod-g` só vale no macOS (⌘G); nos outros sistemas a próxima ocorrência é F3, como no VS Code. Era a causa de 7 dos 8 testes que falhavam no CI.
- `diagnostics()` compartilhado: quem instalou primeiro levava a calha, o tooltip e os diagnósticos de todos ao sair, e as opções dele ganhavam das de quem veio depois. Agora a interface fica enquanto alguém usa, e uma opção passada por alguém ganha dos padrões dos outros.
- `setReadOnlyRanges` chamado de dentro de outra extensão: a proteção saía junto com essa extensão, em silêncio, e as faixas continuavam listadas.
- Edição com IA recusada por um filtro de mudanças (uma faixa travada): a resposta era descartada sem aviso. Agora fica na prévia, com a mensagem `'inlineEdit.rejected'` e o botão de copiar.
- `highlightAll({ root })` com `root` num shadow root punha o CSS no documento, e o bloco saía sem cor.

### Testes e ferramentas

- Testes de ponta a ponta dos componentes React e Vue (`e2e/adapters.spec.ts`); `react` e `react-dom` entraram como dependências de desenvolvimento.
- `npm run typecheck` passou a cobrir os testes e2e.
- `npm run dev` troca os imports dos `.d.ts` para `.js` a cada compilação, como o build.
- Um teste de fontes clicava fora da área visível quando a fonte de reserva do Linux era mais larga.

## 0.1.0

Primeira versão.
