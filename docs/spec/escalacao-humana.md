# Especificação: escalação humana, ponta a ponta

**Versão da API:** `v1` · **Migração:** nenhuma (reaproveita as tabelas do
[`0003`](../../packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql))
**Decisão de origem:** [D16](../../DECISOES.md) — a régua da PoC exige "perguntas
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

A fronteira é a de sempre: **só o servidor escreve** ([D1](../../DECISOES.md)).
O runner lê o trabalho, abre a sessão, e o que ele faz com um pedido de
escalação é `POST /v1/perguntas` — como qualquer outro cliente da API.

---

## 2. Perguntar bloqueia, na mesma transação

`POST /v1/perguntas` grava a pergunta, o evento
[`pergunta.criada`](../../especificacoes/eventos/schemas/pergunta.criada.schema.json)
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

**A rota não mudou de forma.** `POST /v1/perguntas` continua devolvendo só a
pergunta; quem quer a bandeira lê `GET /v1/trabalhos/:id`. Devolver as duas
coisas juntas economizaria uma requisição e custaria um contrato — a resposta
de criação de pergunta passaria a falar de trabalho.

### Por que não deixar o runner bloquear

Porque seriam dois donos para uma bandeira só. O runner teria de fazer
`POST /v1/perguntas` e `POST /v1/trabalhos/:id/bloqueios` em sequência, e todo
processo morto entre as duas chamadas deixaria uma pergunta pendente com o
trabalho solto — que é exatamente o estado que o ciclo existe para impedir. As
duas rotas continuam existindo e continuam válidas para bloqueio manual; o que
não existe é um caminho em que perguntar e bloquear possam se separar.

---

## 3. Responder desbloqueia, com o ator de quem respondeu

`PATCH /v1/perguntas/:id/resposta` e `PATCH /v1/perguntas/:id/auto_resolucao`
gravam a resposta e baixam a bandeira na mesma transação. O evento
[`trabalho.desbloqueado`](../../especificacoes/eventos/schemas/trabalho.desbloqueado.schema.json)
carrega o **mesmo ator** do evento de resposta:

| Quem respondeu | Evento da resposta | Ator do desbloqueio |
|---|---|---|
| gente | `pergunta.respondida` | `usuario/<respondido_por>` |
| portão automático | `pergunta.auto_resolvida` | `sistema/portao-auto-aprovacao` |

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
([D17](../../DECISOES.md) — flowpilot é referência de comportamento, nunca
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
[controller](runner-e-controller.md), com uma sessão nova.

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
trabalho (`GET /v1/trabalhos/:id/eventos` — o log é a única ordenação total que
existe), e a RESPOSTA sai da projeção (`GET /v1/perguntas?status=respondida`).
Não é redundância: `pergunta.respondida` não carrega `trabalho_id` no payload,
então a linha do tempo do trabalho estruturalmente não a enxerga
([`eventos.ts`](../../packages/core/src/db/eventos.ts), `FiltroDeEventos`).
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

## 7. O que esta camada ainda não faz

Cada item aqui é escopo declarado de outra ficha, não esquecimento:

- **Política de auto-resposta.** O campo `auto_aprovavel` é gravado como `true`
  pelo despacho, e nada o lê para responder sozinho. A rota
  `/auto_resolucao` existe e funciona; quem a chama é gente, por enquanto.
- **Guarda contra responder duas vezes a mesma pergunta.** `responder` não
  checa `status === 'respondida'` antes de sobrescrever — gap herdado do
  `t102`, não introduzido aqui. Hoje a consequência ficou um pouco maior: uma
  segunda resposta grava um segundo `trabalho.desbloqueado`.
- **Atualizar `engine_session_ref` depois da abertura.** `sessao.aberta` é
  gravado assim que a sessão sobe, e o ref que o engine revela no primeiro
  quadro chega depois disso — não existe endpoint de PATCH para preenchê-lo.
  Na prática o campo fica `null`, e `null` aqui significa "o engine ainda não
  tinha dito", nunca "este engine não tem ref".
- **Instruções do nó vindas do grafo registrado.** O despacho usa uma
  instrução fixa e literal (`INSTRUCOES_PADRAO`), no mesmo espírito do spike do
  `t104`. Puxar a skill de verdade do grafo de fábrica é o que a PoC (`t109`)
  prova.
- **Timeout de pergunta pendente.** Uma pergunta sem resposta bloqueia o
  trabalho para sempre, por desenho: a alternativa é o sistema decidir sozinho
  o que declarou não saber decidir.
- **Tela da fila** (`t107`) e **identidade de quem responde**: a `t124`
  autenticou estas rotas, mas o token não diz qual pessoa está do outro lado, e
  `respondido_por` segue vindo do corpo.
