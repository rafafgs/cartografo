# Especificação: intake — do pedido à quebra em tickets no grafo

**Versão da API:** `v1` · **Migração:** [`packages/core/migrations/0006_intake.sql`](../../packages/core/migrations/0006_intake.sql)
**Decisão de origem:** [D3](../../DECISOES.md) — sintetizar topologia e quebrar
trabalho são **dois atos**: o primeiro produz nós (uma vez por classe), o
segundo produz tickets (a cada execução), e o caminho fica congelado durante a
execução

Até aqui trabalho entrava no grafo por `POST /v1/jobs`, com título e nó de
entrada e mais nada: sem corpo, sem critério de aceite, sem relação entre
tickets. Esta camada é o segundo ato da D3 — receber um pedido em linguagem
natural já decomposto em itens, **propor** a quebra sobre o grafo registrado da
classe, e só criar os `trabalho` depois de um humano confirmar.

A frase que resume o desenho: **o intake propõe, o humano confirma, e nada
disso toca o grafo.** Confirmar um rascunho cria viajantes; não cria versão de
grafo, não move ponteiro, não muda nó nenhum.

---

## 1. Duas fases, e por que não uma

| Fase | Rota | O que grava | O que emite no log |
|---|---|---|---|
| Propor | `POST /v1/intake` | Uma linha em `intake_draft` | Nada |
| Confirmar | `POST /v1/intake/:id/confirmations` | N `job` + M `job_dependency` | N `job.created` + M `job.dependency_declared` |

O rascunho **não emite evento nenhum** — nem ao nascer, nem ao ser editado, nem
ao ser descartado. É armazenamento de trabalho em curso, não fato de auditoria:
o log só ganha linha quando um viajante de fato nasce. É por isso que a projeção
de `intake_rascunho` pode ser atualizada in loco sem ferir a regra append-only
do log ([taxonomia](../../especificacoes/eventos/taxonomia.md)): nada nela é
reconstruído a partir do log, porque nada dela foi registrado.

A confirmação é sub-recurso plural (`/confirmations`, `/discards`) e não um
campo de status que alguém edita, pela mesma razão que o trabalho tem
`/transitions` e `/blocks`: cada uma corresponde a um **fato** distinto.

**O que está fora:** como o rascunho é PRODUZIDO a partir do pedido em
linguagem natural. `items` chega já decomposto no corpo da requisição, venha de
uma pessoa digitando, de uma sessão de agente rodada à parte ou de uma futura
tela de chat. Esta camada não despacha sessão e não conhece engine.

---

## 2. O item, e o que o intake garante sobre ele

```json
{"ref": "migracao",
 "title": "Migração 0005",
 "body": "Colunas novas em trabalho e as duas tabelas do intake.",
 "acceptance_criteria": ["a migração roda do zero"],
 "tier": "standard",
 "depends_on": ["dominio"]}
```

`ref` e `title` são obrigatórios; `body`, `acceptance_criteria`, `fields`,
`tier` e `depends_on` são opcionais. `ref` é identidade **local ao lote**: ela
existe para que um item cite outro, e morre na confirmação, quando cada `ref`
vira um `job.id` real.

As chaves do item falam inglês desde o t255 ([glossário](glossario-wire.md)
§1.1): elas viajam no corpo do `POST /v1/intake`, que é o que a D20 chama de
"campos e parâmetros de query do JSON da API". Nada responde à grafia antiga —
um item com `titulo` volta como `missing_required_field`, porque `title` é que
é obrigatório.

Os critérios que o intake grava são **preliminares**. Quem os produz de verdade
é o nó `refinar` do grafo de fábrica 1, cujo contrato recebe `{ticket_id,
pedido}` e devolve `{especificacao, criterios_de_aceite, ...}`
([`grafos-de-fabrica/desenvolvimento-de-software/grafo.json`](../../grafos-de-fabrica/desenvolvimento-de-software/grafo.json)).
Exigir critério de aceite completo na entrada seria pedir ao intake o trabalho
do grafo.

A validação mora em
[`packages/core/src/domain/intake.ts`](../../packages/core/src/domain/intake.ts),
função pura sem `Database` — mesmo espírito de `domain/graph.ts` e
`domain/operations.ts` — e devolve **a lista inteira de problemas**, nunca o
primeiro (`validateItems`, linha 242):

| Código | Quando |
|---|---|
| `invalid_list` | `items` não é lista, ou é lista vazia |
| `invalid_item` | um item não é objeto |
| `missing_required_field` | falta `ref` ou `title` |
| `invalid_field` | `body`, `acceptance_criteria`, `fields`, `tier` ou `depends_on` com forma errada |
| `duplicate_ref` | dois itens do lote usam o mesmo `ref` |
| `unknown_dependency` | `depends_on` cita `ref` que não é de nenhum item do lote |
| `self_dependency` | o item cita o próprio `ref` |
| `dependency_cycle` | as dependências fecham um ciclo |

Cada problema é `{code, message, target}` — a mesma forma do relatório de grafo
(§5.3 do glossário), e em inglês desde o t255 pela mesma razão que o item: esse
relatório É o corpo do `400`.

Os dois primeiros códigos de campo são os que a rota ao lado já respondia
(`missing_required_field`, `invalid_field`): o t255 dobrou os dois do validador
neles em vez de traduzi-los, para que um mesmo item não volte com duas grafias
do mesmo problema.

O ciclo é procurado por busca em profundidade com três cores
(`findCycles`, linha 209). Cinza = no caminho atual, preto = já fechado: bater
num cinza é ciclo, bater num preto é apenas um nó alcançado duas vezes. Um
diamante — `a` depende de `b` e de `c`, ambos dependendo de `d` — é uma quebra
perfeitamente boa, e um caminhamento que confunde os dois rejeita justamente a
forma que um lote real tem.

---

## 3. Confirmar: uma transação, três escritas

[`repositories/intake.ts`](../../packages/core/src/repositories/intake.ts),
`confirmDraft` (linha 258). A ordem dentro da transação não é decoração:

1. **Relê o ponteiro corrente da classe.** A rota resolve
   `getClassBase` → `getVersion` no momento da confirmação, não no da proposta:
   entre propor e aceitar a classe pode ter ganhado versão, e os viajantes
   pertencem à que vale agora.
2. **Cria um `job` por item**, todos no `no_inicial` da versão vigente,
   todos com o `graph_version_id` dela e com o `project_id`/`execution_id` do
   rascunho. Cada criação grava `job.created`.
3. **Só então grava as dependências.** Uma aresta só pode ser registrada
   quando as duas pontas já têm id real — `ref` é local ao lote e morre aqui.

Tudo isso é **uma transação SQLite**: todo trabalho, toda dependência e todo
evento entram juntos ou nenhum entra. O `db.transaction` aninhado de `createJob`
vira savepoint no `better-sqlite3`, a mesma composição que a escalação humana já
usa.

O `UPDATE` final do rascunho é guardado por `AND status = 'pendente'` e a
transação inteira cai se ele não afetar exatamente uma linha: confirmar duas
vezes é um `409`, nunca dois lotes de trabalho.

### O ator da confirmação

O portão é humano por desenho, e a `t124` autenticou a API — mas um token prova
posse, não identidade: quem apresenta a credencial de operador pode ser qualquer
pessoa da equipe, e o control plane não tem como dizer qual delas. Em vez
de inventar um usuário, o log registra honestamente o componente que agiu —
`INTAKE_ACTOR`, `sistema`/`intake` (linha 47) — e quem sabe quem está do outro
lado manda `ator` no corpo da confirmação, como em qualquer outra escrita desta
API.

> **Nota de escopo.** A ficha listava `ator?` também no corpo de
> `POST /v1/intake`. Ele é aceito e ignorado ali: a criação do rascunho não
> emite evento e a tabela não tem coluna de ator, então o único lugar onde um
> ator declarado muda alguma coisa é a confirmação.

---

## 4. Dependência declarada é registro, não bandeira

```sql
CREATE TABLE job_dependency (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL REFERENCES job(id),
  depends_on_job_id INTEGER NOT NULL REFERENCES job(id),
  created_at        TEXT NOT NULL,
  CHECK (job_id != depends_on_job_id)
);
```

Cada aresta também vira um evento
[`job.dependency_declared`](../../especificacoes/eventos/schemas/job.dependency_declared.schema.json),
o 16º tipo do catálogo:

```json
{"depende_de_trabalho_id": 101}
```

`entidade.id` é o trabalho **dependente**; `dados.depende_de_trabalho_id` é
aquele de quem ele depende. "Este espera por aquele" é fato de quem espera, e é
na linha do tempo dele que alguém vai procurar o motivo de não ter andado —
`GET /v1/jobs/:id/events` do dependente mostra a declaração, o do outro não.

**Declarar não bloqueia.** Nenhum `job.blocked` nasce daqui. Exigir a
ordem — bloquear automaticamente, ordenar despacho, contar WIP por dependência —
é decisão de outra ficha, e uma bandeira que ninguém sabe baixar seria pior que
bandeira nenhuma.

Dependência **não atravessa lote**: `depends_on` só resolve `ref` de itens do
mesmo rascunho. Declarar dependência sobre um `trabalho` que já existe não é
suportado nesta versão.

---

## 5. O trabalho ganhou conteúdo

A migração acrescenta duas colunas a `job` (linhas 33-34), e o contrato do
evento `job.created` ganhou os dois campos correspondentes, **opcionais**
([`event-validation.ts:143-153`](../../packages/core/src/db/event-validation.ts)):

| Coluna | Tipo | Nota |
|---|---|---|
| `corpo` | TEXT | `null` quando o trabalho nasceu só com título |
| `criterios_de_aceite` | TEXT (JSON `string[]`) | `null` **não** é `[]` |
| `tier` | TEXT (`trivial` \| `standard`) | t175. `null` **não** é `trivial` |

`null ≠ []` é a distinção que importa para o nó que refina: "ninguém escreveu
critério ainda" e "declarei que não há critério" são afirmações diferentes.

`null ≠ trivial` é a mesma disciplina com um preço maior: `tier` é a triagem de
custo que a sessão de intake faz de graça (t175, ficha
[`intake-geracao.md`](intake-geracao.md)), e é dela que o runner tira o modelo
que vai rodar cada nó. Ler ausência como "trivial" rebaixaria para um modelo
mais barato todo trabalho nascido antes desta coluna existir, sem que ninguém
tivesse escolhido isso e sem nada falhar em lugar nenhum. O que o tier muda é
quanto um nó CUSTA para rodar, nunca por qual aresta o trabalho sai: o grafo
segue congelado durante a execução, e os atalhos de topologia do flowpilot
seguem fora do porte ([`grafo.md`](grafo.md), seção do `work_tier`).

Um trabalho criado à mão por `POST /v1/jobs` continua nascendo só com título, e
nesse caso os dois campos chegam ao log como `null` explícito — a regra de
normalização que esta taxonomia aplica a todo campo opcional desde sempre.
`PATCH /v1/jobs/:id` continua editando **só** `titulo`: o nó `refinar`
reescrevendo corpo e critérios via `job.amended` é ficha própria.

---

## 6. A superfície HTTP

Registrada em [`routes/intake.ts`](../../packages/core/src/routes/intake.ts)
(`registerIntake`, linha 72; uma linha em `server.ts:60`).

| Rota | Resposta | Erros |
|---|---|---|
| `POST /v1/intake` | `201 {rascunho}` | `400 campo_obrigatorio_ausente` (sem `classe`/`pedido`) · `404 grafo_desconhecido` · `400 itens_invalidos` |
| `GET /v1/intake` | `200 {rascunhos}` | filtros `status`, `classe`, `projeto_id` |
| `GET /v1/intake/:id` | `200 {rascunho}` | `404 rascunho_desconhecido` |
| `PATCH /v1/intake/:id` | `200 {rascunho}` | `404` · `409 rascunho_nao_pendente` · `400 itens_invalidos` |
| `POST /v1/intake/:id/discards` | `200 {rascunho}` | `404` · `409 rascunho_nao_pendente` |
| `POST /v1/intake/:id/confirmations` | `201 {rascunho, trabalhos}` | `404` · `409 rascunho_nao_pendente` · `404 grafo_desconhecido` · `400 validation_failed` |

Os erros desta camada falam a vocabulário de fio dela — `erro` em português,
como os das rotas de grafo e de proposta (t127, FR8). A confirmação tem **uma**
exceção, e é a única rota do intake que grava EVENTO: um envelope de evento
torto (um `ator` que não é `{tipo, ref}`, por exemplo) é recusado pelo mesmo
`validateEvent` que serve toda a API, e volta pelo mesmo `withValidation` de
[`routes/common.ts`](../../packages/core/src/routes/common.ts), com o mesmo
corpo `{error: "validation_failed", details: [...]}` que `POST /v1/jobs`
devolve. Quem precisa corrigir o próprio `ator` não deveria ter de aprender uma
segunda forma de erro para descobrir isso — era um `500` até a rodada alfa
t139. O rascunho recusado continua `pendente` e confirmável; nenhum `trabalho`,
nenhuma dependência e nenhuma linha de log sobrevivem à transação que caiu.

`PATCH` **substitui** a lista de itens, nunca funde: um intake que fundisse não
teria como remover um item de que alguém desistiu, e "me mande a quebra que você
quer" é contrato mais simples que uma linguagem de patch sobre lista.

A classe precisa nomear uma linhagem já registrada — sugestão de classe por
semelhança (D8) e variantes de grafo (D13) estão fora. Sem correspondência
exata, `404`, e nada é gravado.

---

## 7. A prova de que o grafo não se mexe

É o critério de aceite original da ficha, e o teste que o guarda é
`AT16` em
[`packages/core/test/intake-routes.test.ts`](../../packages/core/test/intake-routes.test.ts):
o fluxo completo roda contra a classe registrada a partir do bundle de fábrica
1, e a lista de versões antes e depois é comparada inteira. Rodado também à mão
contra o grafo de fábrica, sem edição nenhuma no documento — o transcrito
abaixo foi regravado numa corrida nova em 2026-08-17, contra o banco recriado
que a D20 pede, e é por isso que ele fala inglês do começo ao fim:

```
POST /v1/graphs -> 201
POST /v1/intake -> 201 status: pending
POST /v1/intake/:id/confirmations -> 201
trabalhos criados: {"migracao":1,"dominio":2,"rotas":3}
nós de entrada: refinar, refinar, refinar
graph_version_id dos trabalhos: sha256:36023db054cb9499742b3d44f96142aba9f59faed5a60652064aec592330a37f

=== GET /v1/graphs/desenvolvimento-de-software/versions (ANTES e DEPOIS) ===
{"versions":[{"id":"sha256:36023db054cb9499742b3d44f96142aba9f59faed5a60652064aec592330a37f",
              "graph_id":"desenvolvimento-de-software","parent_version":null,
              "source":"manual","proposal_id":null,
              "created_at":"2026-08-17T11:12:37.705Z"}]}

mesma lista? true

eventos do trabalho "rotas": job.created, job.dependency_declared
data da dependência: {"depends_on_job_id":2}
```

Nenhuma rota desta camada chama `registerBaseGraph`, `insertVersion` ou
`movePointer` — direta ou indiretamente. É a D3 ("o caminho fica congelado")
aplicada ao intake.

---

## 8. O que esta camada ainda não faz

> **Gerar o rascunho** a partir do pedido em linguagem natural saiu desta lista
> com a t144, e continua fora **desta camada**: quem decompõe é um comando do
> runner que despacha uma sessão de agente e chega aqui por
> `POST /v1/intake` como qualquer outro cliente — ver
> [`intake-geracao.md`](./intake-geracao.md). Estas rotas seguem sem despachar
> sessão e sem conhecer engine.

- **Exigir a dependência declarada.** A aresta é registro; bloqueio automático,
  ordem de despacho e WIP por dependência ficam de fora.
- **Dependência entre lotes** e sobre trabalho já existente.
- **Editar corpo/critérios de um trabalho já criado** — é o nó `refinar`, por
  `job.amended`, em ficha própria.
- **Tela de revisão e confirmação.** A D11 põe observabilidade e inbox antes de
  tela de edição; aqui entrega-se só a API, no mesmo espírito do inbox de
  propostas.
- **Identidade por usuário** — a `t124` fechou a autenticação destas rotas, mas
  não diz QUEM confirmou (ver "O ator da confirmação") — e **idempotência de
  submissão**: reenviar o mesmo pedido duas vezes cria dois rascunhos.
