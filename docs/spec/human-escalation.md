# Especificação: escalação humana, ponta a ponta

**Versão da API:** `v1` · **Migração:** nenhuma (reaproveita as tabelas do
[`0003`](../../packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql))
**Decisão de origem:** [D16](../../DECISIONS.md) — a régua da PoC exige "perguntas
humanas fluindo pela API" com "sessões despachadas pelo EngineAdapter"

Escalação humana é entidade de primeira classe, não caso especial
([README](../../README.md), princípio 5). O `t102` construiu a entidade —
pergunta, resposta, auto-resolução, fila — e parou de propósito antes de ligá-la
ao trabalho. Este documento descreve o ciclo que a `t106` fechou:

```
sessão pergunta → trabalho bloqueia → alguém responde → trabalho desbloqueia
                → o próximo tick redespacha, já sabendo a resposta
```

O ponto não é nenhuma das cinco setas isoladamente: é que nenhuma delas depende
de um passo manual que alguém possa esquecer de dar.

---

## 1. Onde cada metade mora

| Metade | Onde | Por quê |
|---|---|---|
| pergunta ↔ bandeira de bloqueio | `packages/core` (repositório da pergunta) | Os dois vivem no mesmo banco e no mesmo processo. Atomicidade sai de graça. |
| bloco de escalação → pergunta | `packages/runner` (`src/dispatch/`) | Só o runner vê o output de uma sessão. O control plane nunca lê transcript. |

A fronteira é a de sempre: **só o servidor escreve** ([D1](../../DECISIONS.md)).
O runner lê o trabalho, abre a sessão, e o que ele faz com um pedido de
escalação é `POST /v1/input-requests` — como qualquer outro cliente da API.

---

## 2. Perguntar bloqueia, na mesma transação

`POST /v1/input-requests` grava a pergunta, o evento
[`input_request.created`](../../especificacoes/eventos/schemas/input_request.created.schema.json)
**e** levanta a bandeira do trabalho dono, tudo dentro da mesma transação —
`db.transaction` aninhado vira savepoint no `better-sqlite3`, então ou as três
coisas acontecem ou nenhuma acontece.

```json
{"motivo": "aguardando resposta da pergunta 900"}
```

O motivo cita o id da pergunta (o exemplo é o da própria
[taxonomia](../../especificacoes/eventos/taxonomia.md)): quem lê o trabalho
descobre pelo motivo o que precisa acontecer para ele voltar a andar, sem
cruzar duas tabelas.

**O ator do bloqueio é `sistema/escalacao-humana`**, e não o agente que
perguntou nem o humano que vai responder: quem levantou a bandeira foi o
wiring. É o único uso da constante `ATOR_ESCALACAO`.

**A rota não mudou de forma.** `POST /v1/input-requests` continua devolvendo
só a pergunta; quem quer a bandeira lê `GET /v1/jobs/:id`. Devolver as duas
coisas juntas economizaria uma requisição e custaria um contrato — a resposta
de criação de pergunta passaria a falar de trabalho.

### Por que não deixar o runner bloquear

Porque seriam dois donos para uma bandeira só. O runner teria de fazer
`POST /v1/input-requests` e `POST /v1/jobs/:id/blocks` em sequência, e todo
processo morto entre as duas chamadas deixaria uma pergunta pendente com o
trabalho solto — que é exatamente o estado que o ciclo existe para impedir. As
duas rotas continuam existindo e continuam válidas para bloqueio manual; o que
não existe é um caminho em que perguntar e bloquear possam se separar.

---

## 3. Responder desbloqueia, com o ator de quem respondeu

`PATCH /v1/input-requests/:id/answer` e
`PATCH /v1/input-requests/:id/auto-resolution` gravam a resposta e baixam a
bandeira na mesma transação. O evento
[`job.unblocked`](../../especificacoes/eventos/schemas/job.unblocked.schema.json)
carrega o **mesmo ator** do evento de resposta:

| Quem respondeu | Evento da resposta | Ator do desbloqueio |
|---|---|---|
| gente | `input_request.answered` | `usuario/<respondido_por>` |
| portão automático | `input_request.auto_resolved` | `sistema/portao-auto-aprovacao` |

Isto não é detalhe de log. A escada de segurança da evolução
([README](../../README.md), princípio 5) inteira depende de conseguir responder
"isto foi decidido por gente ou pelo sistema?" — e um desbloqueio que sempre
diz "sistema" apaga metade da resposta.

O desbloqueio é incondicional: não verifica se a bandeira foi levantada por
esta pergunta. Um trabalho pode ter sido bloqueado por outra razão junto, e
"respondi e o trabalho continuou parado" é o pior desfecho possível para quem
acabou de responder.

---

## 4. Do bloco de texto até a pergunta

Uma sessão que não pode continuar sem uma decisão **termina o turno** com um
bloco cercado e para. Ela não fica viva esperando: sessão parada é quota
parada, e o control plane já sabe guardar o estado.

````
```input-request
{"question": "...", "context": "...", "options": ["..."],
 "recommendation": "...", "default": "..."}
```
````

O parser (`packages/runner/src/dispatch/parse-input-request.ts`) herda o
contrato de comportamento do `controller_parser.py` do flowpilot
([D17](../../DECISIONS.md) — flowpilot é referência de comportamento, nunca
dependência):

1. **A extensão do bloco sai do JSON, nunca de uma busca pela cerca de
   fechamento.** Um `context` cita código cercado o tempo todo, e uma varredura
   ingênua pela próxima cerca cortaria o bloco no meio.
2. **Bloco malformado é ignorado, nunca lançado.** Output ruim de modelo não
   pode derrubar um despacho: o trabalho simplesmente segue sem escalação.
3. **O último bloco válido vence.** A resposta final supera o rascunho — e
   lixo escrito depois de um bloco válido não apaga o bloco válido.

Só `question` é obrigatório. Um bloco sem pergunta não é respondível, e
registrá-lo colocaria uma linha vazia na fila de alguém com um trabalho
bloqueado atrás dela.

### O output vem em quadros, não em prosa

O adapter do Claude Code entrega `stream-json`: cada linha é um quadro, e o
texto do agente chega **escapado** dentro dele. Se o parser recebesse as linhas
cruas, nenhum bloco cercado jamais faria parse — as aspas seriam `\"` e as
quebras seriam `\n` literais. Por isso o despacho decodifica os quadros de
volta em texto antes de chamar o parser.

O fake engine da suíte imprime linhas de texto puro, que passam intocadas por
essa decodificação. Ou seja: **este é um caso que o CI não pega e só a prova
manual pega** (`scripts/spike-t106-human-escalation.mjs`).

---

## 5. Retomar é redespachar

Não existe retomada de sessão. `continueSession`/resume está declaradamente
fora do `EngineAdapter` v0
([engine-adapter.md](../formatos/engine-adapter.md), "Fora de escopo (v0)"), e
a `t106` não o traz pela porta dos fundos: **retomada aqui é sempre um despacho
novo**, feito pelo `tick()` seguinte do
[controller](runner-and-controller.md), com uma sessão nova.

O que atravessa de uma sessão para a outra é o **prompt**. O despacho monta,
para cada pergunta daquele trabalho que já foi respondida:

```
## O que você já perguntou, e o que responderam

Isto já foi decidido. Não pergunte de novo: siga a resposta.

- **Você perguntou:** <a pergunta>
  **<quem> respondeu:** <a resposta>
```

Sem esse bloco, a sessão redespachada tropeça na mesma dúvida e pergunta de
novo, para sempre. Com ele, a mesma instrução de nó produz comportamentos
diferentes nos dois despachos — e é exatamente isso que a prova manual
demonstra: sessão 1 pergunta e não cria nada, sessão 2 cria o arquivo com o
nome que a pessoa escolheu.

**De onde sai cada metade:** a ORDEM das perguntas sai da linha do tempo do
trabalho (`GET /v1/jobs/:id/events` — o log é a única ordenação total que
existe), e a RESPOSTA sai da projeção
(`GET /v1/input-requests?status=answered`). Não é redundância:
`input_request.answered` não carrega `job_id` no payload, então a linha do
tempo do trabalho estruturalmente não a enxerga
([`events.ts`](../../packages/core/src/db/events.ts), `EventFilter`).
Quem for ler essa linha do tempo esperando ver respostas vai se surpreender —
por isso está escrito aqui.

---

## 6. Perguntar é despacho bem-sucedido

`despachar` **resolve** quando a sessão termina tendo perguntado. A lease volta
pelo `finally` que o controller já tem, e o trabalho para de ser candidato
porque está bloqueado — não porque alguém tratou o despacho como falha.

Rejeita só o que é falha de verdade: sessão que não subiu (`SessionStartError`)
ou que terminou em status diferente de `completed` (`failed`, `timed_out`,
`cancelled`). E mesmo nesses casos a pergunta, se houver, é registrada antes de
o erro subir: uma escalação já escrita não pode ser perdida porque o processo
que a produziu morreu logo depois.

---

## 7. Quem pergunta é o nó, não o runner

Tudo acima descreve **um** comportamento: perguntar quando trava, e bloquear até
alguém responder. Desde a `t167` esse comportamento é o *default*, e não a única
opção — o nó declara a sua no grafo, em `escalation_policy`
([graph.md](graph.md), §2):

| Política | O que a sessão recebe no prompt | O que a fiação faz com um pedido de escalação |
|---|---|---|
| `always` | O bloco `input-request` **mais** a instrução de escalar antes de fechar o nó, mesmo achando que sabe | `POST /v1/input-requests` — o ciclo inteiro descrito acima |
| `on_uncertainty` (default) | O bloco `input-request`, com o texto de sempre | `POST /v1/input-requests` — o ciclo inteiro descrito acima |
| `never` | **Nenhum bloco.** No lugar dele, a instrução de que este nó não tem a quem perguntar, e de que travar aqui se relata como falha do contrato do nó | `POST /v1/jobs/:id/blocks`, com motivo citando o nó e o que travou. Nenhuma pergunta é criada |

**Ausente é `on_uncertainty`**, resolvido na hora do despacho: todo grafo escrito
antes deste campo se comporta exatamente como se comportava, e o texto que a
sessão recebe é byte a byte o de antes.

### Por que `never` não é só uma frase no prompt

Porque instrução de prompt é obedecida com probabilidade, não com certeza, e o
que está em jogo aqui é uma pergunta pendente na fila de alguém que não existe.
Se a única defesa fosse a instrução, a primeira sessão que escrevesse o bloco
mesmo assim criaria uma `pergunta` que **ninguém** iria responder, com o trabalho
bloqueado atrás dela para sempre — o pior desfecho possível, e justamente o que a
política declarou querer evitar.

Então `never` é fiação, não texto: o runner resolve a política do nó antes de
qualquer escrita e, quando ela é `never`, troca a rota. As duas rotas já
existiam, e nenhuma delas é nova — `POST /v1/jobs/:id/blocks` é o bloqueio
incondicional com motivo desde a `t102`. O que a `t167` escolhe é **qual das duas
mecânicas para o trabalho**, e nada mais.

O trabalho para nos dois casos. A diferença é que num deles alguém é chamado.

Isso vale para as **duas** portas por onde uma pergunta nasce (§2 e §4): a que a
sessão escreve, e a que a fiação levanta sozinha quando um nó de duas saídas
termina sem nomear nenhuma. Num nó `never` as duas viram bloqueio com motivo.

`always` e `on_uncertainty` continuam sendo instrução, e isso é deliberado: se a
sessão estava mesmo incerta não é conferível por máquina, e um portão que
fingisse conferir isso estaria conferindo nada.

### Trocar a política é uma proposta

`escalation_policy` e `escalation_recipient` entraram em `CHANGEABLE_FIELDS`
(`packages/core/src/domain/operations.ts`), então mudar a política de um nó é uma
operação `change_node_field` como outra qualquer: passa pelo portão humano,
produz uma `grafo_versao` nova, revalida o documento inteiro e tem inversa. Quem
mudou, quando e para quê fica no histórico — que é o mínimo para uma decisão do
tipo "este nó para de chamar gente".

### De qual nó veio a pergunta

`input_request` ganhou a coluna `node_id`, carimbada pelo servidor a partir do
`current_node_id` do trabalho dono — nunca vinda do corpo do pedido, a mesma
fronteira de confiança que `project_id` e `execution_id` já tinham. O evento
`input_request.created` carrega o mesmo campo, e
`GET /v1/executions/:id/metrics-by-version` devolve `input_requests_by_node` ao lado
das métricas por versão.

Sem isso, uma política por nó seria uma política que ninguém consegue avaliar:
"este nó para demais para perguntar" precisa de um número, e o número precisa
saber de qual nó a pergunta veio.

---

## 8. O que esta camada ainda não faz

Cada item aqui é escopo declarado de outra ficha, não esquecimento:

- **Política de auto-resposta.** O campo `auto_aprovavel` é gravado como `true`
  pelo despacho, e nada o lê para responder sozinho. A rota
  `/auto_resolucao` existe e funciona; quem a chama é gente, por enquanto.
  A `t167` não a construiu: o que ela deixou pronto é o **fato** que esse portão
  vai precisar ler — a política do nó, no snapshot do grafo, e o `node_id` na
  própria pergunta.
- **Atualizar `engine_session_ref` depois da abertura.** `session.opened` é
  gravado assim que a sessão sobe, e o ref que o engine revela no primeiro
  quadro chega depois disso — não existe endpoint de PATCH para preenchê-lo.
  Na prática o campo fica `null`, e `null` aqui significa "o engine ainda não
  tinha dito", nunca "este engine não tem ref".
- ~~**Instruções do nó vindas do grafo registrado.**~~ **Fechado pela `t161`.**
  Um trabalho parado num nó de grafo registrado é despachado com a skill
  daquele nó renderizada para dentro da sessão —
  [`render-skill-instructions.ts`](../../packages/runner/src/dispatch/render-skill-instructions.ts)
  busca o manifesto pinado, recusa o despacho se o hash não bate (D4) e compõe
  instruções, contrato do nó, checks e permissões. O literal fixo
  (`DEFAULT_INSTRUCTIONS`) continua existindo, e só para o caso que não tem
  grafo nenhum para ler.
  **O que isto acrescenta a esta doc:** o parágrafo do bloco `input-request`
  virou a constante `ESCALATION_PROTOCOL`, e ele entra nos DOIS textos. Não é
  arrumação: uma sessão que não sabe escalar nunca escala, e sem essa
  composição o ciclo inteiro descrito aqui teria sumido em silêncio justamente
  para os trabalhos que a `t161` passou a dirigir sozinha.
  **E ele renderiza POR ÚLTIMO, o que é medido e não estilo (`t261`).** Da
  `t161` até a primeira travessia real do grafo de bets (plantão, 2026-08-17)
  esse parágrafo ABRIA o system prompt, e nessa travessia todas as sessões
  voltaram recusadas pelo próprio `claude --print`: `stop_reason: "refusal"`,
  `stop_details.category: "reasoning_extraction"`, zero token de saída, 5/5,
  antes de o modelo ler o nó. O bisect isolou a causa na POSIÇÃO e em mais
  nada — o mesmo prompt sem essas linhas chega em `end_turn`, as mesmas linhas
  movidas para o fim chegam em `end_turn`, e uma reescrita mais suave mantida
  no topo continua sendo recusada. O que o classificador de salvaguarda da
  Anthropic morde é um template JSON cercado ABRINDO um system prompt. Quem
  mexer nessa ordem de novo está transformando toda sessão despachada com
  grafo em recusa: o texto abre com o cabeçalho do nó e fecha com este
  parágrafo, e é assim que `DEFAULT_INSTRUCTIONS` (o caso sem grafo) sempre
  compôs — ele nunca foi implicado pelo bisect por já colocar a constante no
  fim.
- **Pergunta levantada pela fiação, não pela sessão.** Ainda na `t161`, um nó
  com duas ou mais saídas cuja sessão termina sem nomear nenhuma delas — sem
  bloco, bloco malformado, ou um `resultado` que não casa com aresta alguma —
  vira pergunta pela mesma rota e com o mesmo efeito de bloqueio descrito aqui.
  A única diferença está no ator: `{"tipo": "sistema", "ref": "runner"}`, contra
  o `{"tipo": "agente"}` de uma pergunta que a sessão escreveu. São dois fatos
  diferentes — um modelo pedindo decisão, e a fiação relatando que não tem
  regra a aplicar —, e duas grafias é o que deixa o log separar os dois.
- **Timeout de pergunta pendente.** Uma pergunta sem resposta bloqueia o
  trabalho para sempre, por desenho: a alternativa é o sistema decidir sozinho
  o que declarou não saber decidir. Vale igual para o bloqueio de um nó `never`
  (§7): ele também espera alguém, e quem o levanta é
  `POST /v1/jobs/:id/unblocks`, que já existe.
- **Entregar a escalação a `escalation_recipient`.** O nó pode nomear quem
  deveria ser chamado, e nada envia nada para esse nome: não existe sistema de
  notificação nem de papéis neste repositório para entregar a. O campo é dado do
  grafo, e só ([graph.md](graph.md), §2).
- **Tela da fila** (`t107`) e **identidade de quem responde**: a `t124`
  autenticou estas rotas, mas o token não diz qual pessoa está do outro lado, e
  `respondido_por` segue vindo do corpo.
