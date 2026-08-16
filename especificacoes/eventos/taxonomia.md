# Taxonomia de eventos de telemetria — v1

O formato do log de telemetria é **API pública**. É o que a tela de
observabilidade lê, o que os topógrafos plugáveis consomem e o que uma
integração de terceiro vai receber quando o stream de eventos existir. Por
isso ele é um dos quatro formatos tratados como produto, com schema versionado
e documento de especificação (`notas/2026-08-14-extensao-e-qualidade.md`,
princípio organizador e ponto de extensão 5).

Esta é a especificação v1. Ela entrega **contrato, não código**: nenhuma
tabela SQL, nenhum endpoint, nenhum servidor — a ordem do MVP (D6) põe control
plane + EngineAdapter + grafo fixo antes de qualquer coisa aqui virar
implementação.

## Arquivos

| Arquivo | O que é |
|---|---|
| `schemas/envelope.schema.json` | Os campos que existem em todo evento |
| `schemas/<tipo>.schema.json` | Um por tipo de evento (18) |
| `exemplos/log-exemplo.jsonl` | Uma execução ponta a ponta, com os 18 tipos |
| `exemplos/estado-final-esperado.json` | O estado que aquele log reconstrói |
| `reducers/reconstruir-estado.mjs` | A dobra do log até esse estado |
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
> `trabalho.dependencia_declarada` (t122), e o enforcement de permissão de
> skill acrescentou o 17º, `sessao.permissao_negada` (t125), e os ganchos
> declarados no grafo acrescentaram o 18º, `trabalho.gancho_falhou` (t169) —
> crescer é aditivo, e é isso que a regra de "tipo desconhecido é ignorado"
> compra. Hoje: **18 tipos + o envelope = 19 arquivos**.

## Envelope

Todo evento carrega os mesmos oito campos. O payload específico do tipo vive
inteiro dentro de `dados`, e em lugar nenhum além dele.

| Campo | Tipo | O que é |
|---|---|---|
| `id` | inteiro | Monotônico, atribuído pelo servidor. **É a ordem do log** e a única ordenação total que existe. |
| `tipo` | string | Discriminador, ex. `"trabalho.criado"`. Cada valor tem um schema que o fixa com `const`. |
| `projeto_id` | inteiro | Projeto dono do evento. |
| `execucao_id` | inteiro \| null | Execução à qual o evento pertence; `null` quando o fato acontece fora de uma rodada. |
| `entidade` | `{tipo, id}` | O sujeito do evento — a chave de join com o resto do banco. `tipo` ∈ `trabalho`/`sessao`/`pergunta`/`lease`/`grafo_versao`. |
| `ator` | `{tipo, ref}` | Quem causou. `tipo` ∈ `usuario`/`agente`/`sistema`; `ref` é string livre (login, papel do agente, nome do componente). |
| `ocorrido_em` | string (date-time) | Quando o fato aconteceu, ISO 8601. |
| `dados` | objeto | Payload do tipo. |

`entidade.id` é sempre o id da entidade nomeada em `entidade.tipo`: em
`sessao.finalizada` é o id da sessão, em `grafo_versao.aplicada` é o hash do
snapshot (string — D15), nunca o id do trabalho por trás.

Um evento inteiro, como ele sai do log:

```json
{"id":5,"tipo":"sessao.finalizada","projeto_id":1,"execucao_id":7,
 "entidade":{"tipo":"sessao","id":5001},
 "ator":{"tipo":"sistema","ref":"runner-a"},
 "ocorrido_em":"2026-08-14T09:41:22Z",
 "dados":{"status":"concluida","exit_code":0,
          "uso":{"input_tokens":18422,"output_tokens":3110,
                 "cache_creation_input_tokens":9004,
                 "cache_read_input_tokens":120344}}}
```

**Por que um log só, e não o trio de tabelas do flowpilot.** D15 exige cruzar
versão de grafo × telemetria por join, e D9 trata contrato/schema como espinha
comum. Três formatos separados dariam três joins e três esquemas de
versionamento para o mesmo ato de leitura. A entidade genérica
(`entidade.tipo` + `entidade.id`) é o preço disso, e é um preço barato: quem
quer só sessões filtra por `entidade.tipo = 'sessao'`.

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
   não há campo de revisão, não há carimbo de alteração — `ocorrido_em` é o
   único tempo do envelope, porque um campo de "modificado em" num log
   append-only seria mentira.
2. **Nada do que o flowpilot muta in loco vira coluna mutável aqui.** A linha
   de `agent_sessions` que nasce `pending` e é atualizada até `completed`
   virou dois eventos (`sessao.aberta`, `sessao.finalizada`); a linha de
   `input_requests` que é respondida in loco virou três tipos. Estado atual é
   projeção (ver [Replay](#replay-a-prova)), nunca a fonte.
3. **`MAX(id)` resume o log.** Como nada some, o maior id é um cursor completo
   de "algo mudou" — a mesma propriedade que o flowpilot usa hoje.

## Catálogo

18 tipos, em 5 grupos. "Quem emite" é o `ator.tipo` esperado; os exemplos
mostram o conteúdo de `dados` e saíram do `log-exemplo.jsonl`.

### Trabalho

O trabalho (viajante) atravessando o grafo. `entidade.tipo` = `trabalho`.

#### `trabalho.criado` — [schema](schemas/trabalho.criado.schema.json)

Emitido quando um trabalho entra no grafo, no fim do intake. Ator: `usuario`
(criação manual) ou `agente` (quebra automática de trabalho).

```json
{"titulo":"Especificar a taxonomia de eventos de telemetria","no_entrada_id":"intake",
 "corpo":"Um log só, com envelope comum e entidade generica.",
 "criterios_de_aceite":["um schema por tipo","o reducer reproduz o estado final"]}
```

`corpo` e `criterios_de_aceite` são **opcionais** e entraram com o intake de
duas fases (t122): um trabalho pode nascer com conteúdo, e um criado à mão
continua nascendo só com título — nesse caso os dois chegam ao log como `null`,
como todo campo opcional desta taxonomia. Os critérios que o intake grava são
**preliminares**: quem os produz de verdade é o nó que refina, a partir do
pedido bruto, e ele reescreve o trabalho por `trabalho.emendado`.

#### `trabalho.transicao` — [schema](schemas/trabalho.transicao.schema.json)

Emitido quando o trabalho anda de um nó para outro. Ator: `sistema` (o
controller move; nó não escolhe caminho em runtime — princípio 2 do README).
`de_no_id` é `null` na primeira transição.

```json
{"de_no_id":"refinamento","para_no_id":"desenvolvimento"}
```

#### `trabalho.bloqueado` — [schema](schemas/trabalho.bloqueado.schema.json)

Emitido quando o trabalho para de andar **sem sair do nó**: fato de bandeira,
não de movimento. Ator: `sistema` normalmente, `usuario` quando o bloqueio é
manual.

```json
{"motivo":"aguardando resposta da pergunta 900"}
```

#### `trabalho.desbloqueado` — [schema](schemas/trabalho.desbloqueado.schema.json)

Emitido quando a bandeira cai. Ator: `sistema` ou `usuario`. Sem payload — o
fato é a própria queda da bandeira.

```json
{}
```

#### `trabalho.emendado` — [schema](schemas/trabalho.emendado.schema.json)

Emitido quando o **conteúdo** do trabalho é editado. Ator: `agente` (o
refinador enriquecendo a ficha) ou `usuario`.

```json
{"campos_alterados":["corpo","testes_de_aceite"]}
```

Carrega os **nomes** dos campos e nunca o conteúdo. Isto é registro de
auditoria, não histórico de versões — mesma disciplina do `AMENDED` do
flowpilot. Quem quer o texto novo lê o trabalho.

#### `trabalho.dependencia_declarada` — [schema](schemas/trabalho.dependencia_declarada.schema.json)

Emitido na **confirmação do intake**, uma vez por aresta declarada entre dois
trabalhos do mesmo lote (t122). Ator: `usuario` — é um portão humano, e quando
quem confirma se identifica é o login dele que fica no `ator.ref`; a t124
autenticou a API, mas um token prova posse e não pessoa, então o control plane
segue gravando honestamente `sistema`/`intake` em vez de inventar um usuário.

```json
{"depende_de_trabalho_id":101}
```

`entidade.id` é o trabalho **dependente** e `dados.depende_de_trabalho_id` é
aquele de quem ele depende: "este espera por aquele" é fato de quem espera, e é
na linha do tempo dele que alguém vai procurar o motivo de não ter andado.

Declarar a dependência **não bloqueia** o trabalho dependente. A aresta é
registro; exigir a ordem — bloquear automaticamente, ordenar despacho — é
decisão de outra ficha, e uma bandeira que ninguém sabe baixar seria pior que
bandeira nenhuma.

#### `trabalho.gancho_falhou` — [schema](schemas/trabalho.gancho_falhou.schema.json)

Emitido quando a entrega de um **gancho declarado no grafo** (t169) esgota as
seis tentativas e desiste. Ator: `sistema` (o control plane, que é quem tenta).
`entidade.id` é o trabalho cuja transição ou bloqueio disparou o gancho.

```json
{"gancho_id":"avisar-plantao","no_id":"desenvolvimento",
 "url":"https://plantao.exemplo/cartografo","ultimo_erro":"HTTP 502"}
```

**É incidente, não desfecho** — mesma leitura de `sessao.permissao_negada`. O
trabalho não muda de nó, não é bloqueado e não fica sabendo: gancho não
participa da travessia, e é justamente por isso que "falha de gancho nunca
trava o viajante" é verdade por construção, e não por um `try/catch` que
alguém precisa lembrar de manter.

**Por que este tipo existe, se a `entrega_webhook` da t142 nunca precisou de
um.** Uma assinatura de webhook tem dono: alguém a registrou pela API e pode
consultar `ultimo_erro` na linha de entrega. Um gancho não tem — ele é uma
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

A execução de um agente por um EngineAdapter. `entidade.tipo` = `sessao`.

#### `sessao.aberta` — [schema](schemas/sessao.aberta.schema.json)

Emitido quando o runner despacha a sessão. Ator: `sistema` (`ref` = o runner).
`trabalho_id`/`no_id` são opcionais: nem toda sessão serve um trabalho.

```json
{"trabalho_id":101,"no_id":"refinamento","engine":"claude-code",
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

#### `sessao.finalizada` — [schema](schemas/sessao.finalizada.schema.json)

Emitido no fim da vida da sessão. Ator: `sistema`. `status` ∈ `concluida`,
`falhou`, `travada`, `tempo_esgotado`, `pausada_cota`, `retomada_falhou`.

```json
{"status":"tempo_esgotado","exit_code":null,"uso":null,"timeout_reason":"silence"}
```

Os quatro status além de concluída/falhou existem para que um desfecho
saudável (`pausada_cota` — sem combustível, retomável), um ref inválido
(`retomada_falhou`) e uma parada nossa (`tempo_esgotado`) nunca sejam lidos
como bug a investigar.

**As duas paradas nossas são uma só no `status`.** O runner tem dois cães de
guarda independentes — relógio de parede e silêncio (t163) — e ambos
desembocam em `tempo_esgotado`. Quem os separa é `dados.timeout_reason`
(`wall_clock` | `silence` | `null`), não um status a mais: crescer o
vocabulário de status foi rejeitado uma vez, para estados de cota, e o
raciocínio vale igual — "o motivo real vive no log de eventos, que é
append-only e não perde nada" (`docs/formatos/engine-adapter.md`, *Rejeitado
— `SessionStatus` mais rico*).

Correção de rota, registrada em vez de apagada: até a t163 esta seção
descrevia `travada` como "parada por silêncio", em porte 1:1 do `STALLED` do
flowpilot. Esse porte nunca foi construído, e o único lugar que produz
`travada` hoje (`TAXONOMY_STATUS`, `packages/runner/src/dispatch/`) o usa
como o slot de quem não tem slot — `pending`, `running` e `cancelled` não têm
correspondente aqui. `travada` não tem relação nenhuma com silêncio, e a
frase que dizia o contrário era aspiração documentada como se fosse fato.

`uso` é `null` quando o engine não reportou nada — **nunca colapsar em zero**.
Não há campo de custo: custo é vocabulário de engine, e o log é neutro.

E até a t172 esse `null` era *sempre*: o adapter do Claude Code mandava `uso:
null` cravado no código, porque contagem de uso estava em "Fora de escopo (v0)"
do `docs/formatos/engine-adapter.md`. Toda sessão que este sistema já rodou
registrou zero dado de custo, e o placeholder era indistinguível de uma ausência
honesta — que é justamente por que ele durou tanto. O frame `result` terminal
daquela CLI sempre trouxe a contagem; o que faltava era alguém lê-la.

`modelos` (t172) é a identidade que nunca existiu em lugar nenhum desta
taxonomia: `sessao.aberta.engine` diz qual MOTOR rodou (`claude-code`, `codex`)
e nada dizia qual modelo. "Custo por modelo" não tinha resposta porque o dado
nunca foi coletado, não porque faltasse agregação.

```json
{"status":"concluida","exit_code":0,
 "uso":{"input_tokens":2,"output_tokens":5,
        "cache_creation_input_tokens":3022,"cache_read_input_tokens":15688},
 "timeout_reason":null,
 "modelos":["claude-haiku-4-5-20251001","claude-sonnet-5"]}
```

**É lista, e o exemplo acima é de uma execução real.** Um único turno da CLI
devolveu dois modelos — o do turno principal e o de um auxiliar mais barato — e
colapsar em "o" modelo atribuiria a conta inteira ao errado, que é o mesmo
estrago que a regra do `uso` evita para tokens. `null` é "o engine não nomeou
nenhum"; lista vazia não é resposta, e o schema a recusa (`minItems: 1`). O
conjunto de valores é aberto: o identificador é o que o engine reportou, e um
enum fechado pediria mudança de schema a cada modelo novo.

**O que `modelos` não promete.** Ele diz quais modelos rodaram, nunca como as
quatro contagens de `uso` se dividem entre eles — essa separação existe no frame
do engine e não atravessa para cá, porque `uso` é um total só. Uma sessão de dois
modelos entra inteira nos dois quando alguém agrega por modelo, e é isso que a
lente de custo lê.

#### `sessao.permissao_negada` — [schema](schemas/sessao.permissao_negada.schema.json)

Emitido quando a sessão tenta usar uma ferramenta que a política de permissão
dela negava (t125). Ator: `sistema` (o runner, que é quem vê a recusa passar no
stream do engine). `recurso` ∈ `filesystem`, `rede` — os dois eixos que o
manifesto de skill declara.

```json
{"recurso":"rede","ferramenta":"WebFetch",
 "motivo":"Claude requested permissions to use WebFetch, but you have not granted it."}
```

**É incidente, não desfecho.** Não há `UPDATE` na linha da sessão e não há
transição de status: a sessão continua, e pode ser negada de novo — o log é
append-only e uma segunda negação é um segundo fato. Encerrar sessão por
negação repetida seria política de escalada, e ninguém decidiu isso ainda.

`ferramenta` carrega vocabulário de engine dentro do log de propósito
(`WebFetch`, `Bash(curl *)`). É a exceção que a regra "o log é neutro" aceita
pelo mesmo motivo que `sessao.aberta` carrega `engine`: sem o nome exato que
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
`entidade.tipo` = `pergunta`.

#### `pergunta.criada` — [schema](schemas/pergunta.criada.schema.json)

Emitido quando um agente precisa de algo do humano para continuar. Ator:
`agente`. `tipo` ∈ `pergunta` (preciso saber algo) / `aprovacao` (um portão
manual quer um OK sobre um artefato) — mesmo animal, mesma fila, mesmo loop.

```json
{"trabalho_id":101,"sessao_id":5001,"no_id":"refinar","tipo":"pergunta",
 "pergunta":"Unifico o trio de tabelas do flowpilot num log de eventos so, ou porto as tres separadas?",
 "contexto":"D15 exige cruzar versao de grafo com telemetria por join, o que fica mais barato com um log unico.",
 "opcoes":["Unificar num log so","Portar as tres separadas"],
 "recomendacao":"Unificar num log so, com envelope comum e entidade generica",
 "resposta_padrao":"Unificar num log so, com envelope comum e entidade generica",
 "auto_aprovavel":true}
```

`auto_aprovavel` é carregado explicitamente porque "sem opções e sem padrão"
nunca foi bom proxy para inaprovável: uma pergunta cuja resposta só o humano
pode dar precisa dizer isso, não torcer para que o formato dela sugira.

`no_id` é de qual **nó** a pergunta veio, carimbado pelo servidor a partir da
posição do trabalho dono — nunca vindo do corpo do pedido. Sem ele, "quais
etapas mais param para pedir gente?" só se responde reconstruindo a travessia
evento a evento, e a política de escalação por nó
([grafo.md](../../docs/spec/grafo.md), §2) seria uma política que ninguém
consegue avaliar. Opcional: `null` é "não se sabe de qual nó veio" — trabalho
sem posição, ou pergunta gravada antes de o campo existir.

#### `pergunta.respondida` — [schema](schemas/pergunta.respondida.schema.json)

Emitido quando um humano responde. Ator: `usuario`.

```json
{"resposta":"Unificar num log so, com envelope comum e entidade generica","respondido_por":"rafael"}
```

#### `pergunta.auto_resolvida` — [schema](schemas/pergunta.auto_resolvida.schema.json)

Emitido quando o portão de auto-aprovação responde em nome do humano. Ator:
`sistema`. `baseada_em` ∈ `recomendacao` / `resposta_padrao` / `precedente`.

```json
{"resposta":"Porte os 12 nos como estao; reagrupar e decisao de outra ficha","baseada_em":"recomendacao"}
```

Dois tipos em vez de um evento com coluna `answer_source`: o `tipo` já é o
discriminador de todo o resto do log, e a garantia que importa — a auditoria
**sempre** distingue aprovado-por-usuário de aprovado-pelo-sistema — fica mais
forte quando é a identidade do evento que a carrega, não um campo dentro dele.

### Lease

Posse de um trabalho por um runner, com prazo (D5). `entidade.tipo` = `lease`.

#### `lease.concedida` — [schema](schemas/lease.concedida.schema.json)

Emitido quando o controller despacha um trabalho para um runner. Ator:
`sistema`.

```json
{"trabalho_id":102,"runner_id":"runner-b","expira_em":"2026-08-14T11:30:05Z"}
```

#### `lease.expirada` — [schema](schemas/lease.expirada.schema.json)

Emitido quando a posse caduca e o trabalho volta para a fila. Ator: `sistema`.
`motivo` ∈ `heartbeat_perdido` (o runner parou de dar sinal antes do prazo) /
`expirou` (o prazo acabou sem renovação).

```json
{"runner_id":"runner-b","motivo":"heartbeat_perdido"}
```

### Versão de grafo

O grafo vive como dado versionado, com semântica git-like dentro do banco
(D15). `entidade.tipo` = `grafo_versao`, e `entidade.id` é o **hash do
snapshot** — string, não inteiro.

#### `grafo_versao.registrada` — [schema](schemas/grafo_versao.registrada.schema.json)

Emitido quando uma versão nova entra no banco. Ator: `usuario` (registro
manual) ou `agente` (sintetizador, fora da PoC). `origem` ∈ `sintetizador` /
`manual` / `proposta`.

```json
{"grafo_id":"software-dev","versao_pai":"sha256:1a0b7e55","origem":"manual"}
```

**Registrar não move o ponteiro.** Uma versão pode existir no banco sem nunca
ter valido; quem move é o evento seguinte.

#### `grafo_versao.aplicada` — [schema](schemas/grafo_versao.aplicada.schema.json)

Emitido quando o ponteiro de versão corrente passa a apontar para esta versão.
Ator: `usuario` (portão humano) ou `sistema` (auto-aplicação de mutação de
baixo risco, degrau final da escada de segurança — princípio 5 do README).

```json
{"grafo_id":"software-dev"}
```

#### `grafo_versao.revertida` — [schema](schemas/grafo_versao.revertida.schema.json)

Emitido no rollback. Ator: `usuario` ou `sistema`. `entidade.id` é a versão
abandonada; `versao_alvo` é para onde o ponteiro voltou.

```json
{"grafo_id":"software-dev","versao_alvo":"sha256:1a0b7e55",
 "motivo":"o no de revisao novo dobrou o tempo de travessia sem mexer na taxa de aprovacao"}
```

Rollback move ponteiro e **nada se apaga**: a versão abandonada continua no
banco com a telemetria dela, que é exatamente o que o topógrafo vai cruzar
depois.

## Paridade com o flowpilot

Conferida linha a linha contra `~/flowpilot/app/models/ticket_event_model.py`,
`agent_session_model.py` e `input_request_model.py`. O flowpilot é referência
de comportamento, não dependência de código (D17).

Legenda: **=** equivalência direta · **≠** divergência de modelo justificada ·
**+** extensão do cartografo sem equivalente lá.

### `ticket_events` → eventos de trabalho

| flowpilot | cartografo | | Nota |
|---|---|---|---|
| `EventKind.CREATED` | `trabalho.criado` | = | `no_entrada_id` no lugar do estado inicial fixo. |
| `EventKind.STATE_CHANGE` + `from_state`/`to_state` (`TicketState`) | `trabalho.transicao` + `de_no_id`/`para_no_id` | ≠ | O cartografo não tem estados fixos: o caminho é o grafo, congelado por versão (princípio 2, D2). Um enum de 12 estados no schema do evento amarraria o log a um grafo. |
| `EventKind.BLOCKED` | `trabalho.bloqueado` | = | `note` livre vira `motivo` obrigatório. |
| `EventKind.UNBLOCKED` | `trabalho.desbloqueado` | = | |
| `EventKind.AMENDED` + `note` (nomes separados por vírgula) | `trabalho.emendado` + `campos_alterados` | = | Mesma disciplina (só nomes), com o payload tipado como array em vez de string. |
| — | `trabalho.dependencia_declarada` | + | Lá a ordem entre tickets é convenção do humano que os cria; aqui o intake quebra um pedido em lote e a aresta entre dois trabalhos do lote é fato do log (t122). |
| `EventKind.INPUT_REQUESTED` + linha de `input_requests` | `pergunta.criada` | ≠ | Lá são duas coisas: o evento de bandeira e a linha de conteúdo. Aqui um evento só, porque o log já é a fonte do conteúdo. |
| `EventKind.INPUT_ANSWERED` + `answer_source='user'` | `pergunta.respondida` | ≠ | A origem da resposta virou o tipo do evento. |
| `EventKind.INPUT_ANSWERED` + `answer_source='auto'` | `pergunta.auto_resolvida` | ≠ | Idem. |
| `EventKind.SERVICE_CLASS` | — | | Fora de escopo: D16 não pede urgência de trabalho na PoC. Extensão aditiva se a onda 2 precisar. |
| `ActorType.USER/AGENT/SYSTEM` | `ator.tipo` `usuario`/`agente`/`sistema` | = | Traduzido, não remodelado. |
| `actor_ref` | `ator.ref` | = | |
| `occurred_at` | `ocorrido_em` | = | Único carimbo de tempo, pela mesma razão de lá. |
| `id` (BigInt autoincrement) | `id` | = | Monotônico, do servidor, é a ordem do log. |
| `ticket_id` (FK) | `entidade` `{tipo:"trabalho", id}` | ≠ | Entidade genérica: o mesmo log carrega sessão, pergunta, lease e versão de grafo. |
| `note` (texto livre) | `dados` (objeto por tipo) | ≠ | Payload tipado com schema em vez de string interpretável. |

### `agent_sessions` → eventos de sessão

A linha de `agent_sessions` nasce `pending` e é **atualizada** até um status
terminal. Aqui ela é dois eventos e nenhuma atualização — é a divergência
estrutural desta ficha.

| flowpilot (coluna) | cartografo | | Nota |
|---|---|---|---|
| criação da linha (`pending`) | `sessao.aberta` | ≠ | Evento, não linha mutável. |
| `status` terminal | `sessao.finalizada.status` | ≠ | 6 valores contra 9: `pending`/`running` não são desfechos (a abertura já é evento própria). |
| `SessionStatus.COMPLETED/FAILED` | `concluida`/`falhou` | = | |
| `STALLED`/`TIMED_OUT` | `tempo_esgotado` + `dados.timeout_reason` | ≠ | Dois status lá, um status e uma causa aqui (t163). `travada` **não** é o porte de `STALLED`: é o slot de `pending`/`running`/`cancelled`, que não têm um. |
| `PAUSED_QUOTA`/`RESUME_FAILED` | `pausada_cota`/`retomada_falhou` | = | |
| `CANCELLED` | — | | **Sem porte na v1** (não está na tabela da ficha). Se a PoC precisar cancelar sessão, é acréscimo aditivo ao enum. |
| `engine`, `engine_session_ref` | idem em `sessao.aberta` | = | A fronteira de independência de LLM. |
| `working_dir`, `prompt`, `timeout_seconds` | idem | = | |
| `last_output_at` (relógio de silêncio) | `sessao.aberta.silence_seconds` + `sessao.finalizada.timeout_reason` | ≠ | Lá é um instante atualizado na linha e varrido por fora; aqui é o orçamento na abertura e a causa no fim, sem nada mutável no meio. |
| `stage` (estado do fluxo) | `no_id` | ≠ | Nó do grafo, mesma razão de `trabalho.transicao`. |
| `ticket_id` | `trabalho_id` (opcional) | = | Opcional lá e aqui: nem toda sessão serve um trabalho. |
| `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | `uso.{...}` | = | Nomes idênticos, de propósito. `null` ≠ zero, também de propósito. |
| `exit_code` | `exit_code` | = | |
| `log_path`, `worktree_path`, `branch`, `silence_seconds`, `quota_resets_at`, `last_output_at`, `processed_at` | — | | **Sem porte na v1**: são bookkeeping do controller e caminhos locais, não fatos de auditoria. Revisitar quando o control plane existir. |

### `input_requests` → eventos de pergunta

| flowpilot (coluna) | cartografo | | Nota |
|---|---|---|---|
| criação da linha | `pergunta.criada` | = | |
| `kind` (`question`/`approval`) | `dados.tipo` (`pergunta`/`aprovacao`) | = | Mesma tese: pergunta e aprovação são o mesmo animal. |
| `status` (`pending`/`answered`) | — (derivado) | ≠ | Existe como projeção do reducer, não como campo: o log diz o que houve, o estado diz onde parou. |
| `answer_source` (`user`/`auto`) | — (o tipo do evento) | ≠ | `pergunta.respondida` vs `pergunta.auto_resolvida`. |
| `question`, `context`, `options_json`, `recommendation`, `default_answer` | `pergunta`, `contexto`, `opcoes`, `recomendacao`, `resposta_padrao` | = | Traduzidos. |
| `auto_approvable` | `auto_aprovavel` | = | Mesma razão de existir. |
| `answer` | `resposta` | = | |
| `answered_by` (FK `users`) | `respondido_por` (string) | ≠ | Não há entidade de usuário na PoC; string livre, como `ator.ref`. |
| `session_id`, `ticket_id` | `sessao_id`, `trabalho_id` | = | `sessao_id` opcional pela mesma razão de lá: a resposta sobrevive à sessão. |
| `resumed_at` | — | | **Sem porte na v1**: marcador de idempotência do controller, não fato de auditoria. |

### Extensões do cartografo

| cartografo | | Por quê |
|---|---|---|
| `lease.concedida`, `lease.expirada` | + | D5: com N runners, trabalho de runner morto volta para a fila. O flowpilot é de um runner só e não tem o problema. |
| `grafo_versao.registrada`, `.aplicada`, `.revertida` | + | D15: no flowpilot o fluxo é código, então não há o que versionar em banco. Aqui o grafo é dado, e é a linha que o topógrafo cruza com a telemetria. |
| `execucao_id` no envelope | + | Não existe entidade "execução" no flowpilot. |
| `entidade` genérica | + | Um log só para o trio de tabelas de lá. |

## Replay: a prova

O inegociável de qualidade é **reprodutibilidade por event sourcing**: grafo
vN + inputs ⇒ execução replayável do log. A prova executável desta ficha é
`reducers/reconstruir-estado.mjs`, que dobra o log e devolve:

```
{ trabalhos:  {[id]: {no_atual, bloqueado, historico_nos}},
  sessoes:    {[id]: {status, exit_code}},
  perguntas:  {[id]: {status, resposta, origem}},
  leases:     {[id]: {status}},
  grafo_versao_corrente: {[grafo_id]: versao_id} }
```

`tests/replay.test.mjs` roda o reducer contra `exemplos/log-exemplo.jsonl` e
compara com `exemplos/estado-final-esperado.json`, calculado à mão a partir do
mesmo log. Enquanto essa igualdade valer, o log é suficiente: nenhum estado
final precisa de outra fonte.

Quatro decisões do reducer que são, na prática, decisões do formato:

- **A ordem é a do `id`**, não a da lista recebida. Quem lê de arquivo, de
  resposta paginada ou de stream fora de ordem chega no mesmo estado.
  `ocorrido_em` não serviria: dois eventos podem carregar o mesmo carimbo.
- **Tipo desconhecido é ignorado**, não é erro. Um cliente antigo lendo um log
  novo continua reconstruindo o que entende — é o que torna a taxonomia
  extensível de forma aditiva.
- **`origem` volta a ser campo** na projeção de pergunta (`usuario`/`auto`),
  colapsando os dois tipos de evento de volta no `answer_source` do flowpilot.
  No log a origem é identidade; em estado, quem lê quer comparar.
- **`trabalho.emendado` não move nada.** É fato de conteúdo, não de fluxo —
  por isso ele carrega só nomes de campos.

## Fora do escopo da v1

- **Eventos de proposta/topógrafo** (`proposta.*`) — o topógrafo está fora da
  PoC (D6, D16). Ficha da onda 2.
- **`service_class`** (urgência) — D16 não a pede na PoC.
- **Transporte para fora** — saiu daqui, pelas duas metades, e nenhuma delas
  mexeu neste envelope: `GET /v1/events/stream` entrega este mesmo objeto por
  SSE, com filtro por `projeto_id`/`tipo` e reconexão pelo `id`
  ([`docs/spec/eventos-stream.md`](../../docs/spec/eventos-stream.md), t123), e
  os webhooks assinados o entregam por `POST`, com HMAC-SHA256 do corpo cru e
  retentativa com backoff
  ([`docs/spec/webhooks-eventos.md`](../../docs/spec/webhooks-eventos.md),
  t142). Os dois são consumidores do mesmo `listEvents`, e nenhum deles escreve
  no log.
- **Tabela SQL e endpoints** que gravem isto de verdade — D6.
- **Hash/versão do próprio schema de eventos** — isto é a v1; congela só
  depois de dois consumidores reais (regra dos dois consumidores). Até lá,
  mudanças aditivas são esperadas, e a v1 é um contrato entre esta ficha e as
  fichas de construção que vêm depois, não uma promessa a terceiros.
