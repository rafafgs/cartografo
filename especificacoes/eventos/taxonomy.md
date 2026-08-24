# Taxonomia de eventos de telemetria — v1

O formato do log de telemetria é **API pública**. É o que a tela de
observabilidade lê, o que os topógrafos plugáveis consomem e o que uma
integração de terceiro vai receber quando o stream de eventos existir. Por
isso ele é um dos quatro formatos tratados como produto, com schema versionado
e documento de especificação (`notas/2026-08-14-extension-and-quality.md`,
princípio organizador e ponto de extensão 5).

Esta é a especificação v1. Ela entrega **contrato, não código**: nenhuma
tabela SQL, nenhum endpoint, nenhum servidor — a ordem do MVP (D6) põe control
plane + EngineAdapter + grafo fixo antes de qualquer coisa aqui virar
implementação.

## Arquivos

| Arquivo | O que é |
|---|---|
| `schemas/envelope.schema.json` | Os campos que existem em todo evento |
| `schemas/<tipo>.schema.json` | Um por tipo de evento (19) |
| `exemplos/example-log.jsonl` | Uma execução ponta a ponta, com os 19 tipos |
| `exemplos/expected-final-state.json` | O estado que aquele log reconstrói |
| `reducers/reconstruct-state.mjs` | A dobra do log até esse estado |
| `tests/` | Runner nativo do Node, sem `package.json` e sem dependência |

Para rodar, da raiz do repo:

```sh
node --test "especificacoes/eventos/tests/*.test.mjs"   # só esta ficha
node --test                                             # tudo que houver
```

Passar o diretório (`node --test especificacoes/eventos/tests/`) **não**
funciona no Node 25: a partir do 23 o argumento posicional é tratado como
caminho de arquivo/glob, não como pasta a varrer. Use uma das duas formas
acima.

> **Contagem.** A v1 nasceu com **15 tipos + o envelope = 16 arquivos** em
> `schemas/` (a ficha t98 falava em "16 tipos"; valeu a tabela normativa dela).
> O intake de duas fases acrescentou o 16º tipo,
> `job.dependency_declared` (t122), e o enforcement de permissão de
> skill acrescentou o 17º, `session.permission_denied` (t125), e os ganchos
> declarados no grafo acrescentaram o 18º, `job.hook_failed` (t169), e o fim de
> execução da D21 acrescentou o 19º, `execution.finished` (t245), e o estado de
> contrato da versão de grafo acrescentou o 20º,
> `graph_version.contracts_checked` (t283) —
> crescer é aditivo, e é isso que a regra de "tipo desconhecido é ignorado"
> compra. Hoje: **20 tipos + o envelope = 21 arquivos**.

## Envelope

Todo evento carrega os mesmos oito campos. O payload específico do tipo vive
inteiro dentro de `data`, e em lugar nenhum além dele.

| Campo | Tipo | O que é |
|---|---|---|
| `id` | inteiro | Monotônico, atribuído pelo servidor. **É a ordem do log** e a única ordenação total que existe. |
| `type` | string | Discriminador, ex. `"job.created"`. Cada valor tem um schema que o fixa com `const`. |
| `project_id` | inteiro | Projeto dono do evento. |
| `execution_id` | inteiro \| null | Execução à qual o evento pertence; `null` quando o fato acontece fora de uma rodada. |
| `entity` | `{type, id}` | O sujeito do evento — a chave de join com o resto do banco. `type` ∈ `job`/`session`/`input_request`/`lease`/`graph_version`/`execution`. |
| `actor` | `{type, ref}` | Quem causou. `type` ∈ `user`/`agent`/`system`; `ref` é string livre (login, papel do agente, nome do componente). |
| `occurred_at` | string (date-time) | Quando o fato aconteceu, ISO 8601. |
| `data` | objeto | Payload do tipo. |

`entity.id` é sempre o id da entidade nomeada em `entity.type`: em
`session.finished` é o id da sessão, em `graph_version.applied` é o hash do
snapshot (string — D15), em `execution.finished` é o próprio `execution_id`
(inteiro), nunca o id do trabalho por trás.

Um evento inteiro, como ele sai do log:

```json
{"id":5,"type":"session.finished","project_id":1,"execution_id":7,
 "entity":{"type":"sessao","id":5001},
 "actor":{"type":"system","ref":"runner-a"},
 "occurred_at":"2026-08-14T09:41:22Z",
 "data":{"status":"completed","exit_code":0,
          "usage":{"input_tokens":18422,"output_tokens":3110,
                 "cache_creation_input_tokens":9004,
                 "cache_read_input_tokens":120344}}}
```

**Por que um log só, e não o trio de tabelas do flowpilot.** D15 exige cruzar
versão de grafo × telemetria por join, e D9 trata contrato/schema como espinha
comum. Três formatos separados dariam três joins e três esquemas de
versionamento para o mesmo ato de leitura. A entidade genérica
(`entity.type` + `entity.id`) é o preço disso, e é um preço barato: quem
quer só sessões filtra por `entity.type = 'session'`.

## Regra append-only

**A única operação sobre o log é inserir.** Não existe update de evento, não
existe delete de evento, não existe correção de evento — um fato registrado
errado é corrigido por outro fato, nunca por sobrescrita.

É paridade explícita com a regra 10 do flowpilot, onde a garantia é de código
e não de convenção: `TicketEventRepository` expõe `create` e leituras, e mais
nada, com um teste que varre `app/` atrás de update/delete em massa contra a
tabela. Quando o control plane desta especificação existir, o repositório
correspondente nasce com a mesma restrição.

Três consequências que atravessam esta ficha inteira:

1. **Nenhum schema aqui descreve modificação.** Não há `evento.atualizado`,
   não há campo de revisão, não há carimbo de alteração — `occurred_at` é o
   único tempo do envelope, porque um campo de "modificado em" num log
   append-only seria mentira.
2. **Nada do que o flowpilot muta in loco vira coluna mutável aqui.** A linha
   de `agent_sessions` que nasce `pending` e é atualizada até `completed`
   virou dois eventos (`session.opened`, `session.finished`); a linha de
   `input_requests` que é respondida in loco virou três tipos. Estado atual é
   projeção (ver [Replay](#replay-a-prova)), nunca a fonte.
3. **`MAX(id)` resume o log.** Como nada some, o maior id é um cursor completo
   de "algo mudou" — a mesma propriedade que o flowpilot usa hoje.

## Catálogo

19 tipos, em 6 grupos. "Quem emite" é o `actor.type` esperado; os exemplos
mostram o conteúdo de `data` e saíram do `example-log.jsonl`.

### Trabalho

O trabalho (viajante) atravessando o grafo. `entity.type` = `job`.

#### `job.created` — [schema](schemas/job.created.schema.json)

Emitido quando um trabalho entra no grafo, no fim do intake. Ator: `user`
(criação manual) ou `agent` (quebra automática de trabalho).

```json
{"title":"Especificar a taxonomia de eventos de telemetria","entry_node_id":"intake",
 "body":"Um log só, com envelope comum e entidade generica.",
 "acceptance_criteria":["um schema por tipo","o reducer reproduz o estado final"]}
```

`body` e `acceptance_criteria` são **opcionais** e entraram com o intake de
duas fases (t122): um trabalho pode nascer com conteúdo, e um criado à mão
continua nascendo só com título — nesse caso os dois chegam ao log como `null`,
como todo campo opcional desta taxonomia. Os critérios que o intake grava são
**preliminares**: quem os produz de verdade é o nó que refina, a partir do
pedido bruto, e ele reescreve o trabalho por `job.amended`.

`fields` é o terceiro opcional e entrou com os campos customizados por classe
(t168): um mapa de valores escalares cujas CHAVES a classe declara no grafo
dela (`custom_fields`), não esta taxonomia — `{"premise_source": "relatório
trimestral", "downside": -12.5}` em bets assimétricas (D14). Um trabalho que
nasce sem campo nenhum grava `null`, e `null` não é `{}`.

#### `job.transitioned` — [schema](schemas/job.transitioned.schema.json)

Emitido quando o trabalho anda de um nó para outro. Ator: `system` (o
controller move; nó não escolhe caminho em runtime — princípio 2 do README).
`from_node_id` é `null` na primeira transição.

```json
{"from_node_id":"refinamento","to_node_id":"desenvolvimento"}
```

#### `job.blocked` — [schema](schemas/job.blocked.schema.json)

Emitido quando o trabalho para de andar **sem sair do nó**: fato de bandeira,
não de movimento. Ator: `system` normalmente, `user` quando o bloqueio é
manual.

```json
{"reason":"aguardando resposta da pergunta 900"}
```

#### `job.unblocked` — [schema](schemas/job.unblocked.schema.json)

Emitido quando a bandeira cai. Ator: `system` ou `user`. Sem payload — o
fato é a própria queda da bandeira.

```json
{}
```

#### `job.amended` — [schema](schemas/job.amended.schema.json)

Emitido quando o **conteúdo** do trabalho é editado. Ator: `agent` (o
refinador enriquecendo a ficha) ou `user`.

```json
{"changed_fields":["corpo","testes_de_aceite"]}
```

Carrega os **nomes** dos campos e nunca o conteúdo. Isto é registro de
auditoria, não histórico de versões — mesma disciplina do `AMENDED` do
flowpilot. Quem quer o texto novo lê o trabalho.

#### `job.dependency_declared` — [schema](schemas/job.dependency_declared.schema.json)

Emitido na **confirmação do intake**, uma vez por aresta declarada entre dois
trabalhos do mesmo lote (t122). Ator: `user` — é um portão humano, e quando
quem confirma se identifica é o login dele que fica no `actor.ref`; a t124
autenticou a API, mas um token prova posse e não pessoa, então o control plane
segue gravando honestamente `system`/`intake` em vez de inventar um usuário.

```json
{"depends_on_job_id":101}
```

`entity.id` é o trabalho **dependente** e `data.depends_on_job_id` é
aquele de quem ele depende: "este espera por aquele" é fato de quem espera, e é
na linha do tempo dele que alguém vai procurar o motivo de não ter andado.

Declarar a dependência **não bloqueia** o trabalho dependente. A aresta é
registro; exigir a ordem — bloquear automaticamente, ordenar despacho — é
decisão de outra ficha, e uma bandeira que ninguém sabe baixar seria pior que
bandeira nenhuma.

#### `job.hook_failed` — [schema](schemas/job.hook_failed.schema.json)

Emitido quando a entrega de um **gancho declarado no grafo** (t169) esgota as
seis tentativas e desiste. Ator: `system` (o control plane, que é quem tenta).
`entity.id` é o trabalho cuja transição ou bloqueio disparou o gancho.

```json
{"hook_id":"avisar-plantao","node_id":"desenvolvimento",
 "url":"https://plantao.exemplo/cartografo","last_error":"HTTP 502"}
```

**É incidente, não desfecho** — mesma leitura de `session.permission_denied`. O
trabalho não muda de nó, não é bloqueado e não fica sabendo: gancho não
participa da travessia, e é justamente por isso que "falha de gancho nunca
trava o viajante" é verdade por construção, e não por um `try/catch` que
alguém precisa lembrar de manter.

**Por que este tipo existe, se a `entrega_webhook` da t142 nunca precisou de
um.** Uma assinatura de webhook tem dono: alguém a registrou pela API e pode
consultar `last_error` na linha de entrega. Um gancho não tem — ele é uma
linha do documento de grafo, e ninguém está fazendo polling da fila dele. Sem
este evento, a reação que quem escreveu o grafo declarou falharia em silêncio
para sempre. Como ele entra pelos transportes que já existem (stream da t123,
webhooks da t142), o sinal chega a quem estiver ouvindo sem nenhum trabalho a
mais — e cliente antigo o ignora, pela regra de "tipo desconhecido é ignorado".

**Só no esgotamento, nunca por tentativa.** Uma falha transitória — o consumidor
reiniciando, um 502 de dois minutos — é retentada e some sozinha; gravar evento
a cada uma encheria o log de ruído que se corrige. O sucesso, por simetria, é
mudo: `status='entregue'` na linha de entrega e mais nada.

### Sessão

A execução de um agente por um EngineAdapter. `entity.type` = `session`.

#### `session.opened` — [schema](schemas/session.opened.schema.json)

Emitido quando o runner despacha a sessão. Ator: `system` (`ref` = o runner).
`job_id`/`node_id` são opcionais: nem toda sessão serve um trabalho.

```json
{"job_id":101,"node_id":"refinamento","engine":"claude-code",
 "engine_session_ref":"cc-9f2b41d0","working_dir":"/Users/rafael/cartografo-ticket-98",
 "prompt":"Refine o trabalho 101 contra as convencoes do projeto.","timeout_seconds":5400,
 "silence_seconds":900}
```

Os dois orçamentos são independentes e opcionais (t163): `timeout_seconds` é
relógio de parede, `silence_seconds` é quanto tempo a sessão pode ficar sem
produzir saída nenhuma. `null` em qualquer um deles é "não declara política
própria", nunca "zero".

`engine_session_ref` é o id da sessão no vocabulário do próprio engine, e é o
que torna o retomar possível depois de uma pausa por cota — por isso é
registrado assim que se conhece, não no fim.

#### `session.finished` — [schema](schemas/session.finished.schema.json)

Emitido no fim da vida da sessão. Ator: `system`. `status` ∈ `completed`,
`failed`, `stuck`, `timed_out`, `quota_paused`, `resume_failed`.

```json
{"status":"timed_out","exit_code":null,"usage":null,"timeout_reason":"silence"}
```

Os quatro status além de completed/failed existem para que um desfecho
saudável (`quota_paused` — sem combustível, retomável), um ref inválido
(`resume_failed`) e uma parada nossa (`timed_out`) nunca sejam lidos
como bug a investigar.

**As duas paradas nossas são uma só no `status`.** O runner tem dois cães de
guarda independentes — relógio de parede e silêncio (t163) — e ambos
desembocam em `timed_out`. Quem os separa é `data.timeout_reason`
(`wall_clock` | `silence` | `null`), não um status a mais: crescer o
vocabulário de status foi rejeitado uma vez, para estados de cota, e o
raciocínio vale igual — "o motivo real vive no log de eventos, que é
append-only e não perde nada" (`docs/formatos/engine-adapter.md`, *Rejeitado
— `SessionStatus` mais rico*).

Correção de rota, registrada em vez de apagada: até a t163 esta seção
descrevia `stuck` como "parada por silêncio", em porte 1:1 do `STALLED` do
flowpilot. Esse porte nunca foi construído, e o único lugar que produz
`stuck` hoje (`TAXONOMY_STATUS`, `packages/runner/src/dispatch/`) o usa
como o slot de quem não tem slot — `pending`, `running` e `cancelled` não têm
correspondente aqui. `stuck` não tem relação nenhuma com silêncio, e a
frase que dizia o contrário era aspiração documentada como se fosse fato.

`usage` é `null` quando o engine não reportou nada — **nunca colapsar em zero**.
Não há campo de custo: custo é vocabulário de engine, e o log é neutro.

E até a t172 esse `null` era *sempre*: o adapter do Claude Code mandava `usage:
null` cravado no código, porque contagem de uso estava em "Fora de escopo (v0)"
do `docs/formatos/engine-adapter.md`. Toda sessão que este sistema já rodou
registrou zero dado de custo, e o placeholder era indistinguível de uma ausência
honesta — que é justamente por que ele durou tanto. O frame `result` terminal
daquela CLI sempre trouxe a contagem; o que faltava era alguém lê-la.

`models` (t172) é a identidade que nunca existiu em lugar nenhum desta
taxonomia: `session.opened.engine` diz qual MOTOR rodou (`claude-code`, `codex`)
e nada dizia qual modelo. "Custo por modelo" não tinha resposta porque o dado
nunca foi coletado, não porque faltasse agregação.

```json
{"status":"completed","exit_code":0,
 "usage":{"input_tokens":2,"output_tokens":5,
        "cache_creation_input_tokens":3022,"cache_read_input_tokens":15688},
 "timeout_reason":null,
 "models":["claude-haiku-4-5-20251001","claude-sonnet-5"]}
```

**É lista, e o exemplo acima é de uma execução real.** Um único turno da CLI
devolveu dois modelos — o do turno principal e o de um auxiliar mais barato — e
colapsar em "o" modelo atribuiria a conta inteira ao errado, que é o mesmo
estrago que a regra do `usage` evita para tokens. `null` é "o engine não nomeou
nenhum"; lista vazia não é resposta, e o schema a recusa (`minItems: 1`). O
conjunto de valores é aberto: o identificador é o que o engine reportou, e um
enum fechado pediria mudança de schema a cada modelo novo.

**O que `models` não promete.** Ele diz quais modelos rodaram, nunca como as
quatro contagens de `usage` se dividem entre eles — essa separação existe no frame
do engine e não atravessa para cá, porque `usage` é um total só. Uma sessão de dois
modelos entra inteira nos dois quando alguém agrega por modelo, e é isso que a
lente de custo lê.

**O relato estruturado do nó, e o veredito sobre ele** (`t253`, `t268`).
`output` é o que a sessão relatou do nó — o objeto de que a projeção de `input`
do nó seguinte é montada — e ele é conferido, no fechamento, contra o schema
`output` da skill que o nó pina (D9). Quando essa conferência recusa, `output`
vai a `null` e os motivos viajam inteiros em `output_schema_error`; o status
terminal é gravado de qualquer jeito, porque perder o fim da sessão por causa de
um auto-relato malformado seria estritamente pior — auto-relato de nó de
trabalho nunca foi evidência.

`output_accepted` é o mesmo fato visto do lado de quem age: a lista diz *por
que* um relato foi recusado e só existe quando houve recusa; o booleano diz *se*
ele foi aceito, e é gravado em **todo** fechamento — `true` quando nada foi
relatado e quando o relato casou, `false` só na recusa. Ele existe porque quem
lê é o runner, na resposta do próprio `PATCH /finish`, para decidir se o
trabalho anda: até a `t268` esse veredito era descartado e a rota era escolhida
a partir de um segundo parse do mesmo bloco, então um relato que o control plane
recusara movia o trabalho pela aresta assim mesmo.

#### `session.permission_denied` — [schema](schemas/session.permission_denied.schema.json)

Emitido quando a sessão tenta usar uma ferramenta que a política de permissão
dela negava (t125). Ator: `system` (o runner, que é quem vê a recusa passar no
stream do engine). `resource` ∈ `filesystem`, `rede` — os dois eixos que o
manifesto de skill declara.

```json
{"resource":"rede","tool":"WebFetch",
 "reason":"Claude requested permissions to use WebFetch, but you have not granted it."}
```

**É incidente, não desfecho.** Não há `UPDATE` na linha da sessão e não há
transição de status: a sessão continua, e pode ser negada de novo — o log é
append-only e uma segunda negação é um segundo fato. Encerrar sessão por
negação repetida seria política de escalada, e ninguém decidiu isso ainda.

`tool` carrega vocabulário de engine dentro do log de propósito
(`WebFetch`, `Bash(curl *)`). É a exceção que a regra "o log é neutro" aceita
pelo mesmo motivo que `session.opened` carrega `engine`: sem o nome exato que
foi negado, a negação não é auditável.

**O que este evento não promete.** Ele registra o que o gating por nome de
ferramenta pegou, não tudo que a sessão tentou. Medido contra a CLI real: uma
ferramenta negada por nome nem chega a ser oferecida ao modelo, então nunca há
tentativa e nunca há evento — quem aparece aqui é a negação de um *padrão*
(`Bash(curl *)`), que é recusada na chamada. Ausência de evento significa "não
tentou ou não foi oferecida", jamais "nada foi barrado". A lacuna residual está
escrita em `docs/formatos/engine-adapter.md`, "Permissões da sessão".

### Pergunta

Escalação para humano como entidade de primeira classe.
`entity.type` = `input_request`.

#### `input_request.created` — [schema](schemas/input_request.created.schema.json)

Emitido quando um agente precisa de algo do humano para continuar. Ator:
`agent`. `kind` ∈ `question` (preciso saber algo) / `approval` (um portão
manual quer um OK sobre um artefato) — mesmo animal, mesma fila, mesmo loop.

```json
{"job_id":101,"session_id":5001,"node_id":"refinar","type":"pergunta",
 "question":"Unifico o trio de tabelas do flowpilot num log de eventos so, ou porto as tres separadas?",
 "context":"D15 exige cruzar versao de grafo com telemetria por join, o que fica mais barato com um log unico.",
 "options":["Unificar num log so","Portar as tres separadas"],
 "recommendation":"Unificar num log so, com envelope comum e entidade generica",
 "default_answer":"Unificar num log so, com envelope comum e entidade generica",
 "auto_approvable":true}
```

`auto_approvable` é carregado explicitamente porque "sem opções e sem padrão"
nunca foi bom proxy para inaprovável: uma pergunta cuja resposta só o humano
pode dar precisa dizer isso, não torcer para que o formato dela sugira.

`node_id` é de qual **nó** a pergunta veio, carimbado pelo servidor a partir da
posição do trabalho dono — nunca vindo do corpo do pedido. Sem ele, "quais
etapas mais param para pedir gente?" só se responde reconstruindo a travessia
evento a evento, e a política de escalação por nó
([graph.md](../../docs/spec/graph.md), §2) seria uma política que ninguém
consegue avaliar. Opcional: `null` é "não se sabe de qual nó veio" — trabalho
sem posição, ou pergunta gravada antes de o campo existir.

#### `input_request.answered` — [schema](schemas/input_request.answered.schema.json)

Emitido quando um humano responde. Ator: `user`.

```json
{"answer":"Unificar num log so, com envelope comum e entidade generica","answered_by":"rafael"}
```

#### `input_request.auto_resolved` — [schema](schemas/input_request.auto_resolved.schema.json)

Emitido quando o portão de auto-aprovação responde em nome do humano. Ator:
`system`. `based_on` ∈ `recommendation` / `default_answer` / `precedent`.

```json
{"answer":"Porte os 12 nos como estao; reagrupar e decisao de outra ficha","based_on":"recomendacao"}
```

Dois tipos em vez de um evento com coluna `answer_source`: o `type` já é o
discriminador de todo o resto do log, e a garantia que importa — a auditoria
**sempre** distingue aprovado-por-usuário de aprovado-pelo-sistema — fica mais
forte quando é a identidade do evento que a carrega, não um campo dentro dele.

### Lease

Posse de um trabalho por um runner, com prazo (D5). `entity.type` = `lease`.

#### `lease.granted` — [schema](schemas/lease.granted.schema.json)

Emitido quando o controller despacha um trabalho para um runner. Ator:
`system`.

```json
{"job_id":102,"runner_id":"runner-b","expires_at":"2026-08-14T11:30:05Z"}
```

#### `lease.expired` — [schema](schemas/lease.expired.schema.json)

Emitido quando a posse caduca e o trabalho volta para a fila. Ator: `system`.
`reason` ∈ `heartbeat_lost` (o runner parou de dar sinal antes do prazo) /
`ttl_elapsed` (o prazo acabou sem renovação).

```json
{"runner_id":"runner-b","reason":"heartbeat_lost"}
```

### Versão de grafo

O grafo vive como dado versionado, com semântica git-like dentro do banco
(D15). `entity.type` = `graph_version`, e `entity.id` é o **hash do
snapshot** — string, não inteiro.

#### `graph_version.registered` — [schema](schemas/graph_version.registered.schema.json)

Emitido quando uma versão nova entra no banco. Ator: `user` (registro
manual) ou `agent` (sintetizador, fora da PoC). `source` ∈ `synthesizer` /
`manual` / `proposal`.

```json
{"graph_id":"software-dev","parent_version":"sha256:1a0b7e55","source":"manual"}
```

**Registrar não move o ponteiro.** Uma versão pode existir no banco sem nunca
ter valido; quem move é o evento seguinte.

#### `graph_version.applied` — [schema](schemas/graph_version.applied.schema.json)

Emitido quando o ponteiro de versão corrente passa a apontar para esta versão.
Ator: `user` (portão humano) ou `system` (auto-aplicação de mutação de
baixo risco, degrau final da escada de segurança — princípio 5 do README).

```json
{"graph_id":"software-dev"}
```

#### `graph_version.reverted` — [schema](schemas/graph_version.reverted.schema.json)

Emitido no rollback. Ator: `user` ou `system`. `entity.id` é a versão
abandonada; `target_version` é para onde o ponteiro voltou.

```json
{"graph_id":"software-dev","target_version":"sha256:1a0b7e55",
 "reason":"o no de revisao novo dobrou o tempo de travessia sem mexer na taxa de aprovacao"}
```

Rollback move ponteiro e **nada se apaga**: a versão abandonada continua no
banco com a telemetria dela, que é exatamente o que o topógrafo vai cruzar
depois.

#### `graph_version.contracts_checked` — [schema](schemas/graph_version.contracts_checked.schema.json)

*(This entry is in English per the 2026-08-18 language rule; the entries around
it are the pre-existing Portuguese of this document.)*

A version carries a contract-check state — `checked` / `unchecked` / `failed` —
and this is the fact of it MOVING (`t283`). Actor: always `system` /
`control-plane`; the control plane asserts it about itself (D1).

```json
{"state":"checked","problem_count":0}
```

**Only the re-check emits it, never a version's birth.** A version is born with
a state already computed (`POST /graphs` runs the check against the registry, a
fork copies its base's answer, applying a proposal recomputes), and that instant
already records `graph_version.registered` + `graph_version.applied` — a third
event for the same moment would repeat what the envelope already says, the same
reasoning `execution.finished` writes for its empty payload. What has no other
witness is the LATER move: registering a skill manifest re-judges every version
that pinned it and could not be checked, and each version that moves records
this.

**`problem_count`, not the report.** The problems are on the version row and one
`GET /v1/graph-versions/:id` away; carrying them here as well would put one
object in two places with no way to keep them agreeing — the same call
`job.blocked.consecutive_failures` makes.

### Execução

A rodada inteira, como sujeito de um fato só (D21). `entity.type` =
`execution`, e `entity.id` é o próprio `execution_id` — inteiro, como o de
quase todo mundo aqui.

Este grupo **corrige uma moldura anterior à decisão**. Até a D21 a taxonomia
dizia que execução não era entidade de evento: `execution_id` era um agrupador
opaco e ponto final, e é isso que ainda está escrito no cabeçalho da migração
`0003` e no de `packages/core/src/routes/executions.ts`. Os dois são anteriores
à D21, que registrou o contrário — "ao fim de cada execução, o control plane
declara a execução concluída (fato que só ele afirma, D1)". A entidade nasce
para carregar esse fato, e só ele: continua não havendo tabela `execution`, e o
`finished_at` que a API publica é derivado deste evento em tempo de leitura,
nunca uma coluna.

#### `execution.finished` — [schema](schemas/execution.finished.schema.json)

Emitido quando **todo** trabalho da rodada chegou a um nó final do grafo dele e
**nenhuma lease ativa** segura mais nenhum deles. Ator: sempre `system` /
`control-plane` — quem afirma é o control plane sobre si mesmo (D1), nunca o
ator que por acaso empurrou o trabalho que fechou a conta.

```json
{}
```

**Sem payload**, pela mesma razão de `job.unblocked`: `execution_id`,
`entity.id` e `occurred_at` do envelope já dizem qual rodada acabou e quando, e
repetir isso dentro de `data` seria dado duplicado no próprio evento.

**Uma vez, para sempre.** O fato é gravado na primeira vez que a condição vale,
na MESMA transação da transição que a tornou verdadeira, e nunca de novo — um
trabalho que sai do nó final e volta não produz um segundo evento. Zero trabalho
nunca satisfaz a condição: uma rodada sem trabalho nenhum não é uma rodada
concluída.

**O que ele ainda não vê.** A verificação roda no caminho do trabalho
(`transitionJob` e `createJob`, em `packages/core/src/repositories/job.ts`) e em
lugar nenhum mais. Uma liberação comum de lease não grava evento — a taxonomia
não declara `lease.released`, gap conhecido desde a t196 — então a rodada cujo
último trabalho chega COM a lease dele ainda ativa (que é o caso comum do runner
real: ele solta a lease depois de reportar a transição) só será declarada
concluída se algum trabalho dela voltar a se mexer depois. Fechar isso é a ficha
que ligar `lease` e `job` pelos dois lados, como o cabeçalho da migração `0004`
já prevê.

## Paridade com o flowpilot

Conferida linha a linha contra `~/flowpilot/app/models/ticket_event_model.py`,
`agent_session_model.py` e `input_request_model.py`. O flowpilot é referência
de comportamento, não dependência de código (D17).

Legenda: **=** equivalência direta · **≠** divergência de modelo justificada ·
**+** extensão do cartografo sem equivalente lá.

### `ticket_events` → eventos de trabalho

| flowpilot | cartografo | | Nota |
|---|---|---|---|
| `EventKind.CREATED` | `job.created` | = | `entry_node_id` no lugar do estado inicial fixo. |
| `EventKind.STATE_CHANGE` + `from_state`/`to_state` (`TicketState`) | `job.transitioned` + `from_node_id`/`to_node_id` | ≠ | O cartografo não tem estados fixos: o caminho é o grafo, congelado por versão (princípio 2, D2). Um enum de 12 estados no schema do evento amarraria o log a um grafo. |
| `EventKind.BLOCKED` | `job.blocked` | = | `note` livre vira `reason` obrigatório. |
| `EventKind.UNBLOCKED` | `job.unblocked` | = | |
| `EventKind.AMENDED` + `note` (nomes separados por vírgula) | `job.amended` + `changed_fields` | = | Mesma disciplina (só nomes), com o payload tipado como array em vez de string. |
| — | `job.dependency_declared` | + | Lá a ordem entre tickets é convenção do humano que os cria; aqui o intake quebra um pedido em lote e a aresta entre dois trabalhos do lote é fato do log (t122). |
| `EventKind.INPUT_REQUESTED` + linha de `input_requests` | `input_request.created` | ≠ | Lá são duas coisas: o evento de bandeira e a linha de conteúdo. Aqui um evento só, porque o log já é a fonte do conteúdo. |
| `EventKind.INPUT_ANSWERED` + `answer_source='user'` | `input_request.answered` | ≠ | A origem da resposta virou o tipo do evento. |
| `EventKind.INPUT_ANSWERED` + `answer_source='auto'` | `input_request.auto_resolved` | ≠ | Idem. |
| `EventKind.SERVICE_CLASS` | — | | Fora de escopo: D16 não pede urgência de trabalho na PoC. Extensão aditiva se a onda 2 precisar. |
| `ActorType.USER/AGENT/SYSTEM` | `actor.type` `user`/`agent`/`system` | = | Traduzido, não remodelado. |
| `actor_ref` | `actor.ref` | = | |
| `occurred_at` | `occurred_at` | = | Único carimbo de tempo, pela mesma razão de lá. |
| `id` (BigInt autoincrement) | `id` | = | Monotônico, do servidor, é a ordem do log. |
| `ticket_id` (FK) | `entity` `{tipo:"trabalho", id}` | ≠ | Entidade genérica: o mesmo log carrega sessão, pergunta, lease e versão de grafo. |
| `note` (texto livre) | `data` (objeto por tipo) | ≠ | Payload tipado com schema em vez de string interpretável. |

### `agent_sessions` → eventos de sessão

A linha de `agent_sessions` nasce `pending` e é **atualizada** até um status
terminal. Aqui ela é dois eventos e nenhuma atualização — é a divergência
estrutural desta ficha.

| flowpilot (coluna) | cartografo | | Nota |
|---|---|---|---|
| criação da linha (`pending`) | `session.opened` | ≠ | Evento, não linha mutável. |
| `status` terminal | `session.finished.status` | ≠ | 6 valores contra 9: `pending`/`running` não são desfechos (a abertura já é evento própria). |
| `SessionStatus.COMPLETED/FAILED` | `completed`/`failed` | = | |
| `STALLED`/`TIMED_OUT` | `timed_out` + `data.timeout_reason` | ≠ | Dois status lá, um status e uma causa aqui (t163). `stuck` **não** é o porte de `STALLED`: é o slot de `pending`/`running`/`cancelled`, que não têm um. |
| `PAUSED_QUOTA`/`RESUME_FAILED` | `quota_paused`/`resume_failed` | = | |
| `CANCELLED` | — | | **Sem porte na v1** (não está na tabela da ficha). Se a PoC precisar cancelar sessão, é acréscimo aditivo ao enum. |
| `engine`, `engine_session_ref` | idem em `session.opened` | = | A fronteira de independência de LLM. |
| `working_dir`, `prompt`, `timeout_seconds` | idem | = | |
| `last_output_at` (relógio de silêncio) | `session.opened.silence_seconds` + `session.finished.timeout_reason` | ≠ | Lá é um instante atualizado na linha e varrido por fora; aqui é o orçamento na abertura e a causa no fim, sem nada mutável no meio. |
| `stage` (estado do fluxo) | `node_id` | ≠ | Nó do grafo, mesma razão de `job.transitioned`. |
| `ticket_id` | `job_id` (opcional) | = | Opcional lá e aqui: nem toda sessão serve um trabalho. |
| `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | `usage.{...}` | = | Nomes idênticos, de propósito. `null` ≠ zero, também de propósito. |
| `exit_code` | `exit_code` | = | |
| `log_path`, `worktree_path`, `branch`, `silence_seconds`, `quota_resets_at`, `last_output_at`, `processed_at` | — | | **Sem porte na v1**: são bookkeeping do controller e caminhos locais, não fatos de auditoria. Revisitar quando o control plane existir. |

### `input_requests` → eventos de pergunta

| flowpilot (coluna) | cartografo | | Nota |
|---|---|---|---|
| criação da linha | `input_request.created` | = | |
| `kind` (`question`/`approval`) | `data.kind` (`question`/`approval`) | = | Mesma tese: pergunta e aprovação são o mesmo animal. |
| `status` (`pending`/`answered`) | — (derivado) | ≠ | Existe como projeção do reducer, não como campo: o log diz o que houve, o estado diz onde parou. |
| `answer_source` (`user`/`auto`) | — (o tipo do evento) | ≠ | `input_request.answered` vs `input_request.auto_resolved`. |
| `question`, `context`, `options_json`, `recommendation`, `default_answer` | `question`, `context`, `options`, `recommendation`, `default_answer` | = | Traduzidos. |
| `auto_approvable` | `auto_approvable` | = | Mesma razão de existir. |
| `answer` | `answer` | = | |
| `answered_by` (FK `users`) | `answered_by` (string) | ≠ | Não há entidade de usuário na PoC; string livre, como `actor.ref`. |
| `session_id`, `ticket_id` | `session_id`, `job_id` | = | `session_id` opcional pela mesma razão de lá: a resposta sobrevive à sessão. |
| `resumed_at` | — | | **Sem porte na v1**: marcador de idempotência do controller, não fato de auditoria. |

### Extensões do cartografo

| cartografo | | Por quê |
|---|---|---|
| `lease.granted`, `lease.expired` | + | D5: com N runners, trabalho de runner morto volta para a fila. O flowpilot é de um runner só e não tem o problema. |
| `graph_version.registered`, `.aplicada`, `.revertida` | + | D15: no flowpilot o fluxo é código, então não há o que versionar em banco. Aqui o grafo é dado, e é a linha que o topógrafo cruza com a telemetria. |
| `execution_id` no envelope | + | Não existe entidade "execução" no flowpilot. |
| `execution.finished` + `entity.type = execution` | + | A D21 amenda o "não existe entidade execução" que esta ficha escreveu antes dela: a rodada não tem tabela, mas tem um fato — o control plane declarando o fim dela (D1) — e um fato precisa de sujeito. Lá o fim de uma rodada não existe como conceito: cada ticket termina por conta própria. |
| `entity` genérica | + | Um log só para o trio de tabelas de lá. |

## Replay: a prova

O inegociável de qualidade é **reprodutibilidade por event sourcing**: grafo
vN + inputs ⇒ execução replayável do log. A prova executável desta ficha é
`reducers/reconstruct-state.mjs`, que dobra o log e devolve:

```
{ trabalhos:  {[id]: {no_atual, bloqueado, historico_nos}},
  sessoes:    {[id]: {status, exit_code}},
  perguntas:  {[id]: {status, resposta, origem}},
  leases:     {[id]: {status}},
  grafo_versao_corrente: {[grafo_id]: versao_id},
  execucoes:  {[execution_id]: {finalizada_em}} }
```

`tests/replay.test.mjs` roda o reducer contra `exemplos/example-log.jsonl` e
compara com `exemplos/expected-final-state.json`, calculado à mão a partir do
mesmo log. Enquanto essa igualdade valer, o log é suficiente: nenhum estado
final precisa de outra fonte.

Quatro decisões do reducer que são, na prática, decisões do formato:

- **A ordem é a do `id`**, não a da lista recebida. Quem lê de arquivo, de
  resposta paginada ou de stream fora de ordem chega no mesmo estado.
  `occurred_at` não serviria: dois eventos podem carregar o mesmo carimbo.
- **Tipo desconhecido é ignorado**, não é erro. Um cliente antigo lendo um log
  novo continua reconstruindo o que entende — é o que torna a taxonomia
  extensível de forma aditiva.
- **`origem` volta a ser campo** na projeção de pergunta (`user`/`auto`),
  colapsando os dois tipos de evento de volta no `answer_source` do flowpilot.
  No log a origem é identidade; em estado, quem lê quer comparar.
- **`job.amended` não move nada.** É fato de conteúdo, não de fluxo —
  por isso ele carrega só nomes de campos.

## Fora do escopo da v1

- **Eventos de proposta/topógrafo** (`proposta.*`) — o topógrafo está fora da
  PoC (D6, D16). Ficha da onda 2.
- **`service_class`** (urgência) — D16 não a pede na PoC.
- **Transporte para fora** — saiu daqui, pelas duas metades, e nenhuma delas
  mexeu neste envelope: `GET /v1/events/stream` entrega este mesmo objeto por
  SSE, com filtro por `project_id`/`type` e reconexão pelo `id`
  ([`docs/spec/events-stream.md`](../../docs/spec/events-stream.md), t123), e
  os webhooks assinados o entregam por `POST`, com HMAC-SHA256 do corpo cru e
  retentativa com backoff
  ([`docs/spec/webhooks-events.md`](../../docs/spec/webhooks-events.md),
  t142). Os dois são consumidores do mesmo `listEvents`, e nenhum deles escreve
  no log.
- **Tabela SQL e endpoints** que gravem isto de verdade — D6.
- **Hash/versão do próprio schema de eventos** — isto é a v1; congela só
  depois de dois consumidores reais (regra dos dois consumidores). Até lá,
  mudanças aditivas são esperadas, e a v1 é um contrato entre esta ficha e as
  fichas de construção que vêm depois, não uma promessa a terceiros.
