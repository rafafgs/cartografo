# Especificação: ganchos de transição declarados no grafo

**Versão da API:** `v1` · **Migrações:**
[`0016_gancho`](../../packages/core/migrations/0016_gancho.sql),
[`0018_segredo_gancho`](../../packages/core/migrations/0018_segredo_gancho.sql)
**Formato:** [`schema/grafo.schema.json`](../../schema/grafo.schema.json) ·
**Fichas:** t169, t194

Este documento é o contrato de quem escreve o grafo **e** de quem recebe a
entrega, e ele é deliberadamente auto-suficiente: dá para escrever o gancho e o
receptor inteiro — inclusive a verificação da assinatura — sem abrir uma linha
do código do control plane. O que trafega é o envelope da
[taxonomia de eventos](../../especificacoes/eventos/taxonomia.md), sem tradução
nenhuma no caminho, exatamente o mesmo objeto que o
[stream SSE](eventos-stream.md) entrega no campo `data:` e que os
[webhooks assinados](webhooks-eventos.md) entregam por POST.

---

## 1. O que é, e quando usar em vez de um webhook

Um gancho é uma reação que **o próprio grafo declara**: "quando um trabalho
entrar no nó `testar`, avise este endereço"; "quando ele travar em `revisar`,
chame aquele". A declaração mora dentro do documento de grafo, ao lado dos nós
e das arestas.

| | Webhook ([`webhooks-eventos.md`](webhooks-eventos.md)) | Gancho (este documento) |
|---|---|---|
| Quem declara | um operador, por `POST /v1/webhooks` | quem escreve o grafo, dentro do documento |
| Onde vive | linha em `webhook_subscription` | chave `hooks` do snapshot da versão |
| Escopo | todo evento do projeto (com filtro por tipo) | um nó, um gatilho |
| Versionado com o grafo | não | **sim** — muda por proposta, com diff e volta |
| Onde fica a chave do HMAC | `webhook_subscription.secret` | `hook_secret`, referenciada por nome (§2.1) |
| Transporte | POST assinado, seis tentativas | o mesmo, byte a byte |

Regra prática: se a reação é do PROCESSO — "toda vez que qualquer trabalho
chegar nesta etapa" —, ela pertence ao mapa, e é gancho. Se é da sua
integração — "quero todo o log deste projeto na minha ferramenta" —, é webhook.

**Por que isso importa.** Um webhook registrado é estado que só existe na
máquina onde alguém rodou o `POST`: exportar o grafo não o leva junto, o
topógrafo não consegue propô-lo, e reverter uma versão não o desfaz. Um gancho
é dado do documento, então ele atravessa exportação, entra em proposta com
evidência e volta atrás junto com a versão que o introduziu (D2, D15).

**O que um gancho não é:** não é aresta. Ele não muda o nó atual, não decide
caminho, não bloqueia e não tem como fazer o trabalho parar. Falha de gancho é
incidente (§6), nunca desfecho.

---

## 2. Declarar um gancho

`hooks` é uma lista opcional no topo do documento. Ausente = nenhuma reação, que
é o caso de todo grafo escrito antes desta ficha — nenhum deles precisou ser
tocado.

```json
{
  "problem_class": "nota-curta",
  "nodes": [ ... ],
  "edges": [ ... ],
  "initial_node": "redigir",
  "final_nodes": ["revisar"],
  "hooks": [
    {
      "id": "avisar-revisao",
      "trigger": "node_entered",
      "node_id": "revisar",
      "destination": {
        "type": "webhook",
        "url": "https://meu-servico.exemplo/cartografo",
        "secret_ref": "gancho-revisao"
      },
      "description": "Avisa o revisor de plantão quando uma nota chega para revisão."
    }
  ]
}
```

| Campo | Obrigatório | Regra |
|---|---|---|
| `id` | sim | Único no documento. Mesma classe de caracteres do id de nó: `^[a-z0-9][a-z0-9_-]*$`. |
| `trigger` | sim | `node_entered` ou `node_blocked`. Qualquer outro valor é recusado na validação. |
| `node_id` | sim | Precisa ser o id de um nó que existe em `nodes`. |
| `destination.type` | sim | Hoje só `webhook` (§7). |
| `destination.url` | sim | URL absoluta `http:` ou `https:` — mesma regra do `POST /v1/webhooks`. |
| `destination.secret_ref` | sim | **Nome** da chave do HMAC, nunca a chave (§2.1). Mesma classe de caracteres do id de nó. |
| `description` | não | Para que serve a reação, em uma frase. |

O exemplo completo, com um gancho de cada gatilho, está em
[`schema/exemplos/grafo-valido-com-ganchos.json`](../../schema/exemplos/grafo-valido-com-ganchos.json).

### 2.1. O segredo não mora no documento

O documento **nomeia** a chave; quem a guarda é o deployment. Um grafo que ainda
traga um campo `secret` é recusado na validação de forma — o `secret_ref`
obrigatório falta, e a chave desconhecida bate no `additionalProperties: false`.

**Por quê.** O documento é endereçado por conteúdo (D15): ele entra inteiro no
hash da versão, sai inteiro por `GET /v1/graph-versions/:id`, é escrito em disco
pelo `cartografo export` e copiado byte a byte para o atlas que a D7 manda
publicar. Chave escrita ali é chave de todo mundo que lê o mapa — e rotacionar
uma que vazou seria propor uma versão nova cujo diff mostra a velha e a nova
lado a lado, para sempre, no histórico que nunca se apaga.

O `secret_ref` é da mesma família que `engine`, `model` e `escalation_policy`
([`grafo.md`](grafo.md)): valor que o documento declara e o deployment resolve
na hora de despachar, nunca o validador na importação — porque o validador não
sabe o que ESTE deployment tem. Por isso um `secret_ref` que não resolve **não**
é erro de validação: é zero entrega (§4).

Registrar a chave é um `PUT` autenticado, com o nome no caminho:

```
PUT /v1/hook-secrets/gancho-revisao
Content-Type: application/json

{"valor": "uma-string-longa-e-aleatoria-que-eu-escolhi"}
```

| Rota | O que faz |
|---|---|
| `PUT /v1/hook-secrets/:nome` | Registra (`201`) ou **rotaciona** (`200`). Responde `{nome, criada_em}` — o `valor` nunca volta. |
| `GET /v1/hook-secrets` | Lista `{segredos: [{nome, criada_em, revogada_em}]}`, do mais antigo para o mais novo, sem `valor` em lugar nenhum. |
| `DELETE /v1/hook-secrets/:nome` | Revoga a chave viva daquele nome. Idempotente; `404` num nome que ninguém registrou. |

As três exigem credencial de `usuario`: um runner leva `403
credencial_fora_de_escopo`.

**Rotacionar é registrar de novo.** O `PUT` revoga a linha viva e grava uma
linha nova, na mesma transação — nada é sobrescrito e nada é apagado (D15/D2),
então "quando esta chave parou de valer" continua respondível. A chave nova vale
a partir da próxima entrega enfileirada; uma entrega já em voo termina com a que
valia quando ela nasceu (§4). E o documento de grafo não muda uma vírgula: o
nome continua o mesmo, então não há versão nova, não há proposta e não há diff.

O `value` fica em texto claro no banco, e isso é deliberado: a assinatura é
HMAC, então a chave precisa ser REUSADA a cada entrega — ela não pode virar
digest como a credencial da `0007`. É exatamente a postura do
`webhook_subscription.secret` (t142); o que esta ficha mudou foi ONDE a chave
mora, não como ela é guardada.

---

## 3. O que dispara, exatamente

| Gatilho | Dispara em | Casa quando |
|---|---|---|
| `node_entered` | `job.transitioned` | `data.to_node_id` é igual ao `node_id` do gancho |
| `node_blocked` | `job.blocked` | o `no_atual` do trabalho no instante do bloqueio é o `node_id` do gancho |

Vários ganchos podem casar com o mesmo fato, e cada um vira uma entrega
independente: uma que falha não atrasa nem cancela a outra (§6).

**Um gancho no `initial_node` nunca dispara.** A colocação inicial do trabalho é
um `job.created`, não uma `job.transitioned` — pela mesma razão que
`from_node_id` é `null` na primeira transição. Não é uma limitação escondida: é o
que "entrou no nó" significa quando a chegada é o nascimento. Se você precisa
reagir à criação, o transporte para isso é o webhook do tipo `job.created`.

**Desbloquear não dispara nada.** `node_unblocked`, `node_exited` e condições
customizadas estão fora de escopo desta ficha.

---

## 4. Enfileirar é síncrono; entregar não é

Isto é o coração da garantia "gancho nunca trava o viajante", e vale a pena ser
explícito sobre as duas metades:

1. **Enfileirar** acontece DENTRO da mesma transação SQLite que grava a projeção
   do trabalho e o evento. Se a transição for revertida, as entregas dela somem
   junto; não existe janela em que o trabalho andou sem a reação declarada estar
   na fila.
2. **Tentar entregar** acontece depois, num tick de fundo. `POST
   /v1/jobs/:id/transitions` responde `200` sem esperar por chamada de rede
   nenhuma — nem a primeira tentativa, nem o timeout de 10 segundos, nem as seis
   retentativas.

É a mesma disciplina da t142 ("o caminho de escrita nunca espera por webhook"), e
ela é o que torna a garantia estrutural em vez de defensiva: não há `try/catch`
protegendo a travessia porque não existe caminho de código do socket até ela.

A `url` do documento e a chave **resolvida** a partir do `secret_ref` são
copiadas para a linha de entrega no momento em que ela é enfileirada. Uma versão
nova do grafo pode apontar o mesmo gancho para outro lugar, e um `PUT
/v1/hook-secrets/:nome` pode rotacionar a chave — e uma entrega em voo termina
contra o destino que valia quando ela nasceu, nunca contra o que valeria hoje.
É o mesmo instante e a mesma razão para as duas: só a FONTE da chave mudou de
lugar (t194), a semântica da coluna `secret` da linha de entrega é a de sempre.

Se o trabalho não tem `graph_version_id`, se a versão citada não resolve, se o
snapshot dela não tem `hooks`, ou se o `secret_ref` de um gancho não casa com
nenhum segredo vivo, o resultado é o mesmo: zero entregas, zero erro. O último
caso é o de quem importou um grafo sem registrar o que ele referencia, e por
enquanto ele é silencioso de propósito — dar sinal disso (evento, portão, aviso
na importação) é ficha separada.

---

## 5. A entrega, e como verificar a assinatura

Cada disparo vira um POST idêntico ao de um webhook registrado:

```
POST /cartografo HTTP/1.1
Host: meu-servico.exemplo
Content-Type: application/json
X-Cartografo-Signature: sha256=8f4c...  (64 caracteres hex)

{"id":131,"type":"job.transitioned","project_id":1,"execution_id":2,"entity":{"type":"job","id":7},"actor":{"type":"system","ref":"control-plane"},"occurred_at":"2026-08-16T12:00:03.114Z","data":{"from_node_id":"redigir","to_node_id":"revisar"}}
```

O corpo é o envelope inteiro do evento que disparou o gancho, byte a byte o
mesmo objeto que `GET /v1/executions/:id/events` devolve e que o `data:` do
stream carrega. Não há campo dizendo qual gancho produziu esta entrega: o
receptor sabe qual é o dele porque cada gancho tem sua própria URL e seu próprio
segredo.

A receita da assinatura, inteira — a mesma da t142, com uma diferença de chave:

> `X-Cartografo-Signature` = `sha256=` + HMAC-SHA256 do **corpo cru**,
> com a chave que o `destination.secret_ref` DESTE GANCHO resolveu, em hex
> minúsculo.

Do seu lado nada muda: a chave é a string que você mandou no `valor` do
`PUT /v1/hook-secrets/:nome`. O documento de grafo carrega o nome dela, e o
control plane resolve o nome no enfileiramento — você nunca lê a chave de volta
por rota nenhuma, então guarde-a quando registrar.

Três detalhes que decidem se a sua verificação funciona:

- **Assine os bytes que chegaram, não o objeto reparseado.** `JSON.parse`
  seguido de `JSON.stringify` não devolve necessariamente os mesmos bytes, e um
  byte diferente é um digest diferente. Leia o corpo cru primeiro, verifique,
  e só então faça o parse.
- **Compare em tempo constante** (`crypto.timingSafeEqual`), nunca com `===`.
- **Sem assinatura válida, não confie no corpo.** A URL está escrita num
  documento de grafo que qualquer cliente da API lê; a assinatura é a única
  coisa que separa uma entrega do control plane de quem descobriu o endereço.
  Desde a t194 a chave que a produz não está mais nesse documento — quem lê o
  mapa lê para onde a reação vai, e não com o que ela assina.

Em Node, a receita inteira é uma linha — a mesma que o servidor executa:

```javascript
import { createHmac } from 'node:crypto';
const assinatura = `sha256=${createHmac('sha256', segredo).update(corpoCru, 'utf8').digest('hex')}`;
```

O receptor mínimo de zero dependência da
[§8 de `webhooks-eventos.md`](webhooks-eventos.md) serve aqui sem uma linha de
diferença: troque a variável do segredo pela chave que você registrou para o
`secret_ref` deste gancho.

**Responda rápido.** Qualquer `2xx` encerra a entrega; o servidor não lê o corpo
da sua resposta. Se o seu processamento é demorado, aceite (`200`), enfileire do
seu lado e processe depois.

---

## 6. Retentativa, desistência e o evento de falha

A escala é a da t142, degrau por degrau — o mesmo `RETRY_BACKOFF_MS`, para que
um receptor já escrito não precise de ajuste nenhum:

| Tentativa | Quando |
|---|---|
| 1ª | assim que o gancho é enfileirado (até ~1s depois do fato) |
| 2ª | 10 segundos depois da falha |
| 3ª | 1 minuto depois |
| 4ª | 5 minutos depois |
| 5ª | 30 minutos depois |
| 6ª | 2 horas depois |

Seis tentativas no total. Contam como falha o `timeout` de 10 segundos, o erro
de rede e **qualquer** resposta que não seja `2xx` — inclusive `3xx`, que não é
seguido.

| Estado | Significa |
|---|---|
| `entregue` | um `2xx` chegou. `entregue_em` registra quando, e **nada é gravado no log**. |
| `esgotada` | as seis tentativas falharam. `last_error` guarda a última, e o control plane grava UM `job.hook_failed`. |

**Sucesso é mudo, desistência é evento.** Um gancho não tem assinante
registrado: ninguém está fazendo polling da fila dele, então uma reação que
falha para sempre em silêncio é exatamente o que quem escreveu o grafo não
consegue descobrir. O
[`job.hook_failed`](../../especificacoes/eventos/schemas/job.hook_failed.schema.json)
resolve isso pelos transportes que já existem — ele aparece no stream e nos
webhooks registrados sem trabalho nenhum a mais:

```json
{"hook_id":"avisar-revisao","node_id":"revisar",
 "url":"https://meu-servico.exemplo/cartografo","last_error":"HTTP 502"}
```

Ele é gravado **só no esgotamento**, nunca por tentativa: uma falha transitória
é retentada e some sozinha, e um evento por tentativa encheria o log de ruído
que se corrige. E ele é **incidente, não desfecho** — `entity.id` é o
trabalho, mas nada na travessia dele muda por causa disso.

Uma entrega `esgotada` não é retentada, por mais tempo que passe, e não há rota
para reenviar — mesma ausência da t142. A linha não é apagada: "tentei seis
vezes e desisti" é fato de auditoria.

Um gancho quebrado é problema só dele: as entregas de um lote saem juntas, cada
uma com seu próprio timeout, e nenhuma falha atrasa a de outro gancho, segura o
tick ou toca no caminho de escrita.

---

## 7. Validação: o que é recusado, e onde

A validação de FORMA é do [`grafo.schema.json`](../../schema/grafo.schema.json)
— campo obrigatório faltando, `trigger` fora do vocabulário, `destination.type`
desconhecido, `url` que não é `http(s)` absoluta, `secret_ref` fora do charset
`^[a-z0-9][a-z0-9_-]*$` (e um `secret` sobrando, que é como um documento do
formato antigo é recusado).

O que a validação **não** faz é resolver o `secret_ref` contra o banco. As duas
passagens estruturais são puras e sem banco, mantidas em paridade byte a byte
entre `scripts/validar-grafo.mjs` e o porte em `packages/core/src/domain/graph.ts`
— uma checagem que consultasse o banco quebraria o contrato para uma das duas e
não para a outra. Nome que não resolve é zero entrega (§4), nunca `422`.

A validação REFERENCIAL é da passagem **estrutural** do validador de grafo
(`scripts/validar-grafo.mjs` e o porte em
`packages/core/src/domain/graph.ts`, mantidos em paridade byte a byte):

| Código | Quando |
|---|---|
| `gancho_no_inexistente` | o `node_id` do gancho não é nó do documento |
| `id_gancho_duplicado` | dois ganchos com o mesmo `id` |
| `gancho_invalido` | a entrada de `hooks` não é objeto |

Um gancho pendurado **não** é violação de soundness. As quatro regras formais
(alcançável, termina, aresta com condição, nó com contrato) são propriedades da
rede de workflow, e uma reação que aponta para lugar nenhum não diz nada sobre
a rede — é defeito de forma, e sai na lista de `estrutura.erros` do `422`.

---

## 8. O que ainda não existe

- **Destino `local_command`.** Mandar o control plane executar um comando de
  shell que chegou como DADO de grafo é outra ficha, com portão de
  revisão/permissão próprio espelhando o da importação de skill (D4). O
  `destination.type` é enum de um valor só justamente para que a segunda
  variante seja aditiva. Note a assimetria com o resto do sistema: todo comando
  que o cartografo roda hoje executa dentro do worktree de uma sessão, sob o
  runner, e nunca na máquina do control plane.
- **Outros gatilhos** (`node_exited`, `node_unblocked`, condição customizada).
- **Sinal para um `secret_ref` que não resolve.** Hoje ele produz zero entregas
  em silêncio (§4). Um evento, um portão ou um aviso na importação é ficha
  separada, e vale a pena escrevê-la se isso morder alguém na prática.
- **Reenvio manual** de uma entrega `esgotada`.
- **Tela para ganchos.** Esta ficha é só control plane; o gancho se lê e se
  edita no documento de grafo.
- **Filtro por trabalho ou por execução.** Um gancho reage a um nó, para todo
  trabalho que passar por ele.
