# Especificação: topógrafo de fluxo, da telemetria à proposta

**Versão da API:** `v1` · **Implementação:** [`packages/runner/src/surveyor/`](../../packages/runner/src/surveyor)
**Decisão de origem:** [D16](../../DECISOES.md) — "superar o flowpilot é o marco seguinte (primeira proposta do topógrafo com evidência)"

Um grafo que roda produz um rastro; um grafo que **melhora** precisa de alguém
que leia esse rastro e diga onde dói, com número. Esta camada é o primeiro
desses leitores: ela lê o log de UMA execução já terminada, mede quanto cada nó
custou, escolhe o pior e transforma isso em uma proposta de mudança no grafo —
que entra no livro `pendente` e não é aplicada por ninguém.

Duas fronteiras organizam o documento inteiro, e é melhor lê-las antes de
qualquer detalhe:

- **O topógrafo é cliente comum da API.** Ele mora em `packages/runner`, não no
  control plane. Não abre o banco, não importa `packages/core/src/db` e não tem
  privilégio nenhum que a tela não tenha — a mesma postura da [D11], estendida
  aos analisadores por [`notas/2026-08-14-extensao-e-qualidade.md`](../../notas/2026-08-14-extensao-e-qualidade.md):
  "analisadores lendo a mesma telemetria e emitindo propostas no mesmo formato".
- **O agente decide UMA coisa.** Os números, a evidência e a hipótese saem do
  nosso código, deterministicamente, a partir do log. A sessão de agente escolhe
  só as `operations` — o diff semântico — e devolve isso num arquivo. É o que faz
  "evidência rastreável a números do log" ser garantia estrutural em vez de
  promessa sobre a memória do modelo.

---

## 1. As duas metades

| Metade | Onde | O que faz | Determinística? |
|---|---|---|---|
| Lente de fluxo | [`metrics.ts`](../../packages/runner/src/surveyor/metrics.ts) | Dobra o log da execução em quatro números por nó e nomeia o gargalo. | Sim: função pura, sem HTTP, sem relógio. |
| Orquestrador | [`proposal.ts`](../../packages/runner/src/surveyor/proposal.ts) | Monta evidência e hipótese, despacha **uma** sessão para escolher as operações, valida e grava a proposta. | A parte que importa, sim — só a escolha das operações é agêntica. |

A entrada da primeira metade é `GET /v1/executions/:id/events` (§6) mais os ids
dos nós da versão de grafo sob a qual a execução correu. A saída da segunda é
uma linha em `proposta`, sempre com status `pendente`.

---

## 2. As quatro medidas, e a quem cada uma é cobrada

| Medida | De que par de eventos sai | Atribuída a |
|---|---|---|
| `tempo_agente_ms` | `session.opened` → `session.finished` | O nó em `session.opened.data.node_id`. |
| `tempo_espera_ms` | `job.blocked` → `job.unblocked` | O nó em que o trabalho **estava no momento do bloqueio**. |
| `tempo_fila_ms` | `job.transitioned` → o próximo `session.opened` do mesmo trabalho **no mesmo nó** | O nó de destino da transição. É latência de despacho. |
| `perguntas` | `input_request.created` | O nó da sessão que perguntou (`data.session_id` → `session.opened.data.node_id`). |

Três regras atravessam a dobra, e cada uma delas é uma decisão:

- **A ordem é o `id`, nunca `occurred_at`.** Dois eventos podem carregar o mesmo
  carimbo; só o id atribuído pelo servidor é ordenação total. Mesma regra do
  redutor de referência
  ([`reconstruir-estado.mjs`](../../especificacoes/eventos/reducers/reconstruir-estado.mjs)).
- **O nó em que o trabalho estava é reconstruído do log**, dobrando
  `job.created` e `job.transitioned`. A projeção só sabe onde o trabalho
  está *agora*, e "onde ele estava quando bloqueou?" é pergunta sobre o passado.
- **O que não dá para atribuir não é contado.** Pergunta sem sessão
  (`session_id: null` é válido na taxonomia), sessão em nó que o grafo não tem
  mais, intervalo que corre para trás: tudo descartado. Número inventado para
  não deixar buraco é pior que o buraco.

O `job.created` **não** abre fila: fila é a espera entre chegar num nó por
transição e a sessão daquele nó abrir. Uma segunda transição sem sessão no meio
descarta a fila pendente — o trabalho saiu do nó sem ninguém trabalhar nele, e
não há a quem cobrar aquele tempo.

---

## 3. O ranking e o gargalo

`total_ms` é a soma das três medidas de tempo (perguntas **não** entram na
soma: elas são sinal de outra natureza, e misturá-las exigiria um câmbio
arbitrário entre segundo e pergunta). O ranking ordena por `total_ms`
decrescente, com empate desfeito pelo id do nó em ordem crescente — duas
execuções com os mesmos números precisam nomear o mesmo gargalo.

O `gargalo` é o primeiro do ranking, **desde que custe mais que zero**. Quando
toda a execução soma zero, `gargalo` é `null`, e isso não é erro: é uma rodada
sem sinal, e o desfecho correto é não propor nada (§5).

---

## 4. A evidência e a hipótese

Uma proposta é uma hipótese: `POST /v1/proposals` recusa com `400` qualquer uma
que chegue sem `evidencia` e sem `metrica_esperada`
([`entidades-versionamento.md` §6](entidades-versionamento.md)). O topógrafo
monta as duas antes de qualquer agente entrar na história.

```json
{
  "lens": "flow",
  "fonte": "topografo/fluxo",
  "execution_id": 110,
  "grafo_versao_id": "sha256:55be71af…",
  "node_id": "redigir",
  "tempo_agente_ms": 20507,
  "tempo_espera_ms": 5009,
  "tempo_fila_ms": 0,
  "total_ms": 25516,
  "perguntas": 0,
  "eventos": [2, 3, 4, 5],
  "por_no": [ … o ranking inteiro … ]
}
```

`eventos` é o campo que dá nome ao contrato: são os ids **reais** dos eventos de
que cada número saiu, e é por eles que qualquer pessoa reconstrói a conta sem
confiar em ninguém. Uma evidência que resume sem citar id é um parecer, não uma
evidência. `por_no` viaja junto para que "por que ESTE nó?" seja respondível sem
rodar nada de novo.

`lens` é o campo que o control plane lê, e não o topógrafo: desde a `t246`
(D21), o `POST /v1/proposals` deduplica por `(lens, target_version, operations)`
— a chave é calculada pelo servidor, nunca aceita no corpo e nunca devolvida na
resposta. Rodar esta lente duas vezes sobre a mesma execução **não** cria duas
propostas: a segunda chamada responde `200` com a proposta que já existia e a
evidência dela vira uma lista, com a nova ocorrência no fim. `fonte` continua
onde sempre esteve e não foi substituída — ela é a procedência que este módulo
declara, `lens` é o discriminador do servidor, e as duas lentes precisam do
mesmo nome de campo (`cost` na de custo, desde a `t255`) para caírem na mesma
dimensão. A unicidade vale só enquanto a proposta está `pending`: depois de
rejeitada ou aplicada, o mesmo sinal abre uma proposta nova.

A hipótese aponta o **componente dominante** do gargalo, não o total: "o nó
custa 25s" não é acionável, "o nó passa 20s com agente aberto" é.

```json
{ "nome": "tempo_agente_ms:redigir", "direcao": "cai", "de": 20507, "para": 16406 }
```

`para` é 20% abaixo de `de` — ambição declarada, não limiar. Quem julga a
hipótese na rodada seguinte (`t112`) compara o número medido com **`de`**, nunca
com `para` ([`hypothesis.ts`](../../packages/core/src/domain/hypothesis.ts)):
"andou na direção declarada, menos do que se esperava" é hipótese confirmada, e
não fracasso.

---

## 5. A sessão: uma tarefa, um arquivo, nenhum privilégio

A única coisa que um agente decide aqui é **quais operações** atacam o gargalo.
A `SessionSpec` que ele recebe é:

- `instructions` — o contrato de saída: os cinco tipos de operação
  ([§3 de `entidades-versionamento.md`](entidades-versionamento.md), nenhum tipo
  novo), a exigência da inversa, e o arquivo a escrever;
- `prompt` — os nós e arestas da versão que rodou, mais a tabela de medição da
  execução com o gargalo apontado;
- `workingDir` — um diretório de rascunho, que é o único lugar que a sessão
  toca.

A saída é o arquivo `proposta-topografo.json`, com a forma `{"operations": [...]}`
e nada mais. Arquivo, e não stdout, porque a saída de uma CLI real é um fluxo de
quadros com prosa no meio ([`escalacao-humana.md` §4](escalacao-humana.md)) —
um contrato que sobrevive a isso é o que a sessão cumpre com uma escrita só.

A sessão **não** recebe URL do control plane, credencial nem acesso de escrita a
mais nada. O único `POST` desta camada é o do orquestrador.

---

## 6. A ordem de uma rodada

```
resolver versão da execução      (GET /v1/executions/:id/metrics-by-version)
        │
        ├─ nenhuma versão declarada ──▶ erro, nada gravado
        ▼
ler o snapshot da versão          (GET /v1/graph-versions/:id)
ler o log inteiro da execução     (GET /v1/executions/:id/events)
        ▼
calcularMetricasDeFluxo(eventos, nós do snapshot)
        │
        ├─ gargalo == null ──▶ sai 0, SEM abrir sessão e SEM propor nada
        ▼
montar evidência + métrica esperada   (nosso código, determinístico)
        ▼
uma sessão de EngineAdapter escolhe as operações
        │
        ├─ falhou / estourou o relógio / arquivo ausente / `operations` vazias
        │  ou malformadas ──▶ erro, ZERO chamadas a POST /v1/proposals
        ▼
POST /v1/proposals  (exatamente uma vez)  ──▶  proposta `pendente`
```

Três garantias que o desenho compra, e que os testes de aceite cobram:

1. **Zero escrita numa rodada ruim.** As operações são validadas do lado do
   cliente, com as mesmas regras estruturais do servidor, ANTES do `POST`. O
   servidor continua sendo a autoridade — ele valida de novo — mas descobrir um
   diff malformado não custa uma linha no banco.
2. **Exatamente uma proposta por rodada.** Não há laço, não há retry silencioso.
3. **Nada é aplicado.** Não existe chamada a `POST /v1/proposals/:id/apply`
   nesta camada, e o cliente do runner nem sequer tem o método: aplicar é
   decisão humana (README, princípio 5), e um cliente que não tem o botão não o
   aperta por engano.

A versão-alvo é a versão sob a qual a execução **rodou** — é sobre ela que a
evidência fala. Se o grafo andou desde então, a proposta continua no livro e é o
`aplicar` que recusa com `409 proposta_desatualizada`; refazer o diff sobre a
base nova é trabalho de outra rodada ([t118](entidades-versionamento.md)).

---

## 7. Endpoints e comando

| Método | Rota | Papel nesta camada |
|---|---|---|
| `GET` | `/v1/executions/:id/events` | **Novo (t110).** O log inteiro da execução, em ordem de `id`. Execução sem evento nenhum responde `200` com lista vazia — execução é agrupador opaco, nunca entidade, então não há `404`. |
| `GET` | `/v1/executions/:id/metrics-by-version` | Sob que versão a rodada correu (o log não carrega `grafo_versao_id`). |
| `GET` | `/v1/graph-versions/:id` | O snapshot: os nós que a medição reporta e as arestas que vão no prompt. |
| `POST` | `/v1/proposals` | A única escrita. Devolve `201` com a proposta `pendente`. |

Do lado do runner, tudo isso passa por `ClienteControle`
([`cliente-controle.ts`](../../packages/runner/src/controller/cliente-controle.ts)),
que continua sendo a única porta HTTP do processo.

O comando é manual, e é assim de propósito (§8):

```
npm run surveyor --workspace @cartografo/runner -- <execucao_id> [url] [dir] [--token <token>]
```

A credencial não é opcional na prática: desde a `t124` nenhuma rota de `/v1`
responde anônima, e as quatro que este comando usa recusam com `401`. Ela vem
de `--token` ou de `CARTOGRAFO_TOKEN` — mesma precedência da CLI `cartografo`
([`cli/url.ts`](../../packages/core/src/cli/url.ts)) e do topógrafo de custo —,
e é o token impresso na linha de prontidão da primeira partida do control
plane. Sem ela o comando não degrada: ele é negado, e diz numa linha o que
fazer a respeito.

Códigos de saída: `0` quando gravou a proposta (o id vai para stdout) **ou**
quando não havia o que propor; `1` quando a sessão falhou, não devolveu
`operations` utilizáveis ou teve a credencial recusada — e nesse caso nada foi
gravado.

A prova manual contra a CLI real é
[`scripts/spike-surveyor-flow.mjs`](../../packages/runner/scripts/spike-surveyor-flow.mjs)
(`npm run spike:surveyor`): ela sobe um control plane de verdade, faz um
trabalho atravessar dois nós com duas sessões `claude` reais, bloqueia e
desbloqueia o trabalho, e só então roda o topógrafo. Não é teste de CI e não
deve virar um — a suíte roda contra o fake engine justamente para não depender
de binário instalado. Ela não pede nada do ambiente: como sobe o próprio
control plane contra um banco novo, o token que apresenta em toda chamada é o
que aquela partida imprimiu.

---

## 8. O que esta camada ainda não faz

Cada item aqui é escopo declarado de outra ficha, não esquecimento:

- **Disparo automático.** O topógrafo é um comando que uma pessoa roda depois da
  execução — nunca um nó do grafo nem um passo do laço de despacho do
  controller. É a escada de segurança do princípio 5 do README (o avaliador
  primeiro só *sugere*) e a postura de "copiloto no MVP" da [D10]. Ligar o
  disparo é decisão própria, não refatoração.
- **A superfície aprendível "políticas"** (timeouts, concorrência,
  auto-resposta): hoje não existe artefato versionado a que uma proposta possa
  se dirigir — `schema/grafo.schema.json` não tem campo de política, e os tetos
  e TTL do runner são parâmetros por requisição
  ([`runner-e-controller.md` §5](runner-e-controller.md)).
- **Um segundo topógrafo** (custo, qualidade) e o congelamento do formato de
  proposta: a regra dos dois consumidores pede dois antes de congelar
  ([`extensao-e-qualidade.md`](../../notas/2026-08-14-extensao-e-qualidade.md)).
- **`resultado` da hipótese** (`confirmada`/`sem_efeito`/`piorou`): é `t112`, e
  já existe — só não é esta camada que o chama.
- **Aprovação ou rejeição humana** como ação (`t111`), e **variantes** a partir
  de proposta (`t118`).
- **Eventos `proposta.*`**: a taxonomia adiou esses tipos para ficha própria da
  onda 2 ([`taxonomia.md`](../../especificacoes/eventos/taxonomia.md)), então
  uma rodada do topógrafo não emite telemetria sobre si mesma.
- **Concorrência** entre dois topógrafos na mesma execução: a v1 assume invocação
  manual única.
- **Escopo de credencial** na rota nova e no comando. A `t124` autenticou todas
  as rotas de `/v1`, esta inclusive, e o comando apresenta o token
  (`CARTOGRAFO_TOKEN` ou `--token`, §7 — foi a `t146` que fechou essa metade);
  o que ele apresenta é credencial de operador, porque as quatro rotas do
  topógrafo estão fora da superfície que a `t143` abriu para credencial de
  runner. Recortar uma credencial que alcance exatamente estas rotas é outra
  ficha.

[D10]: ../../DECISOES.md
[D11]: ../../DECISOES.md
