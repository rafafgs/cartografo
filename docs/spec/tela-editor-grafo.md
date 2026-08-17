# Especificação: tela de configuração de grafo

**Pacote:** [`packages/tela`](../../packages/tela) · **Porta:** `4318` ·
**Página:** `/graph-editor.html`
**Decisões de origem:** [D11](../../DECISOES.md) — "a tela é cliente comum da API
pública, sem privilégio" · [D15](../../DECISOES.md) — "diff semântico, operação
com inversa, versionamento append-only" · princípio 5 do
[README](../../README.md) — "escada de segurança"

A D11 fixou a ordem: observabilidade primeiro, inbox depois, edição de grafo por
último. As duas primeiras chegaram (`t107`, `t111`); esta é a terceira. É a
página onde uma pessoa mexe na topologia de um grafo — acrescenta um nó, tira uma
aresta, corrige o contrato de um portão — sem escrever JSON na mão e sem que
exista, em lugar nenhum, um segundo jeito de mudar um grafo.

Uma frase resume a fronteira, e é a mesma do inbox: **a tela não sabe nada que a
API pública não conte, e não escreve nada que a API pública não escreva**. Salvar
aqui são três chamadas que qualquer script faria — criar proposta, aprovar,
aplicar — na ordem, parando na primeira que falhar. Nenhuma rota nova no
`packages/core`, nenhuma escrita em lote, nenhum "só desta vez".

---

## 1. O que esta tela edita

**Topologia de grafo-base**: os nós e as arestas da versão corrente de uma
linhagem `base`. É a fatia que a `t170` entregou depois que o founder dividiu a
ficha original em três.

| Editável | Como |
|---|---|
| Acrescentar nó | Cartão novo, com `id`, `node_type`, `engine`, `role`, `descrição`, `skill_ref` e `contract` — tudo dentro de uma única operação `add_node`. |
| Remover nó | Um botão por cartão. As arestas que tocavam o nó saem junto, e a tela **diz** quantas saíram. |
| Editar nó existente | `role`, `descrição`, `skill_ref` (`id`/`version`/`hash`) e `contract` (JSON cru). Nada além disso — §3. |
| Acrescentar / remover aresta | Um cartão por aresta, com `from`, `to`, `condition` e `descrição`. |
| Editar aresta | Sai como **remoção seguida de acréscimo**: o vocabulário de operações identifica aresta pelas duas pontas e não tem operação de edição. |

O seletor lê `GET /v1/classes`, que lista **só linhagens base**. Variante (D13) é
outra conversa: fork, promoção e oferta continuam sendo `t118`, e esta página não
as oferece nem as edita.

---

## 2. Contrato assumido do control plane

A tela **não cria rota nenhuma** no core. Ela consome seis endpoints, todos
anteriores a esta ficha.

| Método | Rota | O que a tela usa |
|---|---|---|
| `GET` | `/v1/classes` | O seletor de grafo-base: `classe` e `grafo_id` de cada linhagem base. |
| `GET` | `/v1/graphs/:id` | `versao_corrente_id` — qual versão as edições vão sentar em cima. |
| `GET` | `/v1/graph-versions/:id` | O `snapshot`: os nós e as arestas que a página desenha. |
| `POST` | `/v1/proposals` | `{grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada}` → `201 {proposta}`. |
| `POST` | `/v1/proposals/:id/approve` | `pendente` → `aprovada`. Sem corpo. |
| `POST` | `/v1/proposals/:id/apply` | Roda o portão sobre o documento que sairia e, passando, grava a versão nova. |

Ids vão **percent-encoded** no caminho: `versao_corrente_id` é `sha256:` mais 64
hex, e id que veio da API não é fragmento de caminho em que a página confie.

Pinado contra o cliente real em
[`packages/tela/test/graph-editor-acceptance.test.ts`](../../packages/tela/test/graph-editor-acceptance.test.ts),
que grava a sequência de chamadas que a página fez e a compara com esta lista —
uma sétima chamada reprova.

### Evidência e métrica de uma edição manual

`POST /v1/proposals` exige `evidencia` e `metrica_esperada` porque proposta é
**hipótese** (D15). Uma pessoa arrastando um nó não está fazendo hipótese
nenhuma, então os dois campos são fixos e inertes:

```json
{ "evidencia": { "fonte": "tela-configuracao", "observacao": "edição manual via tela de configuração do grafo" },
  "metrica_esperada": { "nome": "edição manual (sem métrica)", "direcao": "sobe", "de": 0, "para": 0 } }
```

Inventar um número para satisfazer o campo seria pior que admitir a lacuna. A
forma da métrica só é validada em `POST /v1/proposals/:id/outcome`
([`hypothesis.ts`](../../packages/core/src/domain/hypothesis.ts)), que nada neste
fluxo chama.

---

## 3. O que não dá para mudar em nó que já existe

`id`, `node_type` e `engine` aparecem no cartão, **somente leitura**, com a frase
`remova e recrie o nó para mudar isso` ao lado. Não é limitação de interface:

- `id` e `node_type` são a identidade do nó. Aresta, telemetria e proposta antiga
  apontam para um id, e o comentário do próprio
  [`CHANGEABLE_FIELDS`](../../packages/core/src/domain/operations.ts) diz que
  trocar um dos dois "é operação própria, não troca de campo".
- `engine` — e junto dele `model`, `escalation_policy` e `escalation_recipient` —
  é **política de execução**. O core aceita propor os quatro desde a `t166`/`t167`;
  o que ainda não existe é o desenho de tela para eles, que é a ficha separada
  "Per-node execution policies (schema + API)". Ficaram de fora por escopo, não
  por falta de operação.

Remover e recriar continua sendo o caminho, e é um caminho honesto: nasce como
duas operações com inversa, passa pelo mesmo portão e vira versão nova como
qualquer outra mudança.

---

## 4. Salvar são três chamadas, e aprovar vem encadeado

```
POST /v1/proposals  →  POST /v1/proposals/:id/approve  →  POST /v1/proposals/:id/apply
```

Para na primeira que falhar, e **nada é retentado sozinho**.

O encadeamento do `approve` é o único ponto em que esta página sai do ritmo do
inbox, e é deliberado: a pessoa que acabou de editar o grafo **é** a pessoa a
quem o portão humano perguntaria, e um segundo clique no rascunho dela mesma
seria cerimônia, não julgamento. Proposta de topógrafo continua parando em
`pendente` e continua esperando alguém em `/` — a escada de segurança do
princípio 5 é sobre mudança que **outro** propôs.

O que a página produz é byte a byte o que um cliente scriptado produziria: o
aceite `AC1` registra o mesmo grafo em **dois control planes** independentes,
dirige a página em um e repete o corpo da requisição dela no outro, e exige que o
`graph_version.id` — que é o hash do snapshot — seja o mesmo dos dois lados.

---

## 5. A recusa do portão, em prosa

`POST /v1/proposals/:id/apply` valida o documento que **sairia**, antes de
escrever qualquer coisa, e responde `422` com o relatório inteiro quando reprova.
É o momento mais útil da página — é o sistema dizendo, no vocabulário do grafo,
por que aquela edição não pode existir — e despejar o JSON ali jogaria isso fora
do mesmo jeito que diff de linha joga fora um diff semântico.

| Resposta | O que a página mostra |
|---|---|
| `422 grafo_invalido` | Uma linha por entrada de `estrutura.erros` (a `mensagem` como veio, escrita pelo core) e uma por regra de `soundness.violacoes`, nomeando o nó ou a aresta do `alvo`. |
| `422 operacao_inaplicavel` | `mensagem` como veio: ela já fala do snapshot ("nó X não existe"). |
| `422 versao_sem_efeito` | `mensagem` como veio: o resultado é um snapshot que já existe na linhagem. |
| `409 proposta_desatualizada` | `a base do grafo mudou enquanto você editava`, mais um botão **Recarregar**. Sem rebase silencioso: refazer o diff é decisão de quem editava. |

As quatro regras de soundness viram estas frases:

| Regra | Linha |
|---|---|
| `alcançável` | `o nó "X" não é alcançável a partir do nó inicial: falta uma aresta que chegue até ele` |
| `termina` | `do nó "X" não há caminho até um nó final: quem cair nele não conclui a travessia` |
| `aresta_com_condicao` | `a aresta A → B está sem condição: uma transição sem rótulo é um caminho que o executor não sabe quando tomar` |
| `no_com_contrato` | `o nó "X" não declara skill_ref e contract completos: sem contrato não há como verificar o que ele produziu` |

O mapeamento mora em
[`src/public/graph-soundness.js`](../../packages/tela/src/public/graph-soundness.js),
função pura, testada em Node. E ele não pode divergir em silêncio: `graph-soundness.test.ts`
roda os quatro contraexemplos de [`schema/exemplos/`](../../schema/exemplos) pelo
validador de referência ([`scripts/validar-grafo.mjs`](../../scripts/validar-grafo.mjs))
e exige que toda violação que sair de lá tenha frase própria aqui.

---

## 6. Sem framework, sem build — e nada de `innerHTML`

Módulos ES nativos, sem bundler e sem passo de build, como o resto desta metade
do pacote. Três módulos, e a divisão é o que torna cada regra testável fora do
navegador:

| Módulo | O que é |
|---|---|
| [`graph-operations.js`](../../packages/tela/src/public/graph-operations.js) | Função pura: `diffGraphs(carregado, editado)` → operações tipadas com inversa. |
| [`graph-soundness.js`](../../packages/tela/src/public/graph-soundness.js) | Função pura: relatório do portão → uma linha por problema. |
| [`graph-editor.js`](../../packages/tela/src/public/graph-editor.js) | O único que toca o DOM. Recebe `document` e `fetch` como argumento, que é o que permite dirigi-lo de Node. |

**A ordem das operações não é cosmética.** `applyOperations` roda a lista em
ordem sobre um documento só e recusa operação que o snapshot não admite, então o
diff sai na única ordem que sempre aplica: arestas removidas, nós removidos, nós
acrescentados, campos alterados, arestas acrescentadas.

Tudo que é desenhado entra por `textContent`, **nunca** `innerHTML`: um id de nó,
um `role` ou uma condição foram escritos por um agente dentro de um documento de
grafo, e a D4 trata conteúdo de agente como vetor de injeção. É a mesma regra que
o `inbox.js` já segue.

Todo campo editável carrega `data-campo` com o nome do campo, e todo cartão
carrega `data-node` ou `data-edge` — marcadores de estrutura, no mesmo espírito
dos `data-*` de [`tela.md`](tela.md) §6. O aceite `AC3` usa exatamente esses
marcadores para exigir que um nó existente **não ofereça controle nenhum** para
`id`, `node_type` ou `engine`.

O contrato viaja como **texto** e só é parseado no `Salvar`: JSON meio digitado é
estado normal de um editor, não erro para gritar a cada tecla.

---

## 7. O que esta tela ainda não faz

Cada item é escopo declarado de outra ficha, não esquecimento:

- **Políticas de execução por nó** (modelo, pausa, timeout, escalação) — ficha
  "Per-node execution policies (schema + API)". O core já aceita propor `engine`,
  `model`, `escalation_policy` e `escalation_recipient`; falta o desenho de tela.
- **Editar o registro de skills** — `POST /v1/skills` é create-only hoje; ficha
  "Skill & contract editing (API + diff UI)". Aqui dá para apontar o `skill_ref`
  de um nó para uma skill já registrada e editar o `contract` do próprio nó,
  porque os dois são campos do documento de grafo.
- **Canvas arrastável.** O documento de grafo não tem campo de coordenada
  ([`schema/grafo.schema.json`](../../schema/grafo.schema.json)); inventar um é
  decisão própria, com dependência de renderização que este pacote não carrega.
  O que existe aqui é lista estruturada e editável — visual no mesmo sentido em
  que o inbox é.
- **Trocar `id`, `node_type` ou `engine` de nó existente** — §3.
- **Editar `initial_node`, `final_nodes`, `metadata` ou `custom_fields`** — não
  há operação semântica para nenhum deles; crescer o vocabulário é aditivo e
  espera a regra dos dois consumidores.
- **Linhagens variantes** (D13) — este editor mira grafo-base.
- **Concorrência além do `409 proposta_desatualizada`** — sem lock, sem
  colaboração ao vivo, sem rebase automático.
- **Atualização em tempo real** (polling, websocket) — a página anda por ação de
  quem está nela, como o resto da tela.
- **Login no navegador** — inalterado: a tela segue apresentando a credencial de
  serviço da `t124`.
