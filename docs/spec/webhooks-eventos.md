# Especificação: webhooks assinados de eventos

**Versão da API:** `v1` · **Migração:**
[`0008_webhook`](../../packages/core/migrations/0008_webhook.sql)
**Origem:** ponto de extensão nº 5 —
["eventos para fora"](../../notas/2026-08-14-extensao-e-qualidade.md) · **Ficha:** t142

Este documento é o contrato de quem consome, e ele é deliberadamente
auto-suficiente: dá para escrever um receptor inteiro — inclusive a verificação
da assinatura — sem abrir uma linha do código do control plane. O que trafega é
o envelope da [taxonomia de eventos](../../especificacoes/eventos/taxonomia.md),
sem tradução nenhuma no caminho, exatamente o mesmo objeto que o
[stream SSE](eventos-stream.md) entrega no campo `data:`.

---

## 1. O que é, e quando usar em vez do stream

Um webhook é o transporte ***push*** da telemetria: você registra uma URL, e o
control plane faz `POST` nela a cada evento novo, com uma assinatura HMAC que
prova que a entrega veio dele.

| | Stream ([`eventos-stream.md`](eventos-stream.md)) | Webhook (este documento) |
|---|---|---|
| Quem mantém a conexão | você, aberta o tempo todo | ninguém: cada entrega é um POST |
| Quem retenta | você, com `Last-Event-ID` | o servidor, com backoff (§6) |
| Se ninguém estiver ouvindo | o evento passa e não volta | a entrega fica na fila e é retentada |
| Precisa de endereço público | não | sim |
| Latência típica | ~300ms | ~1s |

Regra prática: se o seu consumidor é um processo que você mantém rodando, o
stream é mais simples. Se é uma função HTTP, um serviço de terceiro ou algo que
não pode ficar com um socket aberto, é webhook.

**O que os webhooks não são:** não são histórico. Uma assinatura nasce apontando
para o FIM do log e recebe só o que for gravado dali em diante (§4). Para ler
uma rodada inteira depois do fato, existe `GET /v1/executions/:id/events`.

---

## 2. Registrar uma assinatura

```
POST /v1/webhooks
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{"url": "https://meu-servico.exemplo/cartografo",
 "segredo": "uma-string-longa-e-aleatoria-que-eu-escolhi",
 "tipos": ["job.created", "job.transitioned"],
 "project_id": 1}
```

| Campo | Obrigatório | Regra |
|---|---|---|
| `url` | sim | URL absoluta `http:` ou `https:`. Qualquer outra coisa é `400`. |
| `segredo` | sim | String não vazia, **escolhida por você**. É a chave do HMAC (§5). |
| `tipos` | não | Lista de tipos exatos da taxonomia. Ausente ou vazia = todo tipo. Tipo desconhecido é `400`. |
| `projeto_id` | não | Inteiro; sem ele, o projeto padrão (`1`). |

Resposta `201`:

```json
{"id": 3,
 "project_id": 1,
 "url": "https://meu-servico.exemplo/cartografo",
 "tipos": ["job.created", "job.transitioned"],
 "evento_inicial_id": 128,
 "criada_em": "2026-08-15T12:00:00.000Z",
 "desativada_em": null}
```

**O `segredo` não volta em resposta nenhuma**, nem aqui nem na listagem. Ele é
seu: o servidor não gera segredo, não revela o que guardou e não tem rota para
lê-lo de volta. Se você o perdeu, registre outra assinatura e desative esta.

Os valores aceitos em `tipos` são os tipos que o control plane grava hoje — o
mesmo catálogo do stream:

```
job.created          session.opened       input_request.created
job.transitioned       session.finished   input_request.answered
job.blocked                           input_request.auto_resolved
job.unblocked
job.amended
job.dependency_declared
```

`lease.*` e `graph_version.*` estão declarados na taxonomia mas ainda não são
gravados por ninguém, então pedi-los é `400` — e não uma assinatura que nunca
recebe nada, que é o pior dos dois erros.

---

## 3. Listar e desativar

```
GET /v1/webhooks               → {"webhooks": [ ...assinaturas... ]}
GET /v1/webhooks?projeto_id=9  → só as daquele projeto
DELETE /v1/webhooks/3          → a assinatura, agora com desativada_em
```

`DELETE` **desativa**, não apaga: a linha continua existindo, com
`desativada_em` preenchido, e continua aparecendo na listagem. É a mesma
disciplina do resto do repositório — nada é deletado, e "quando deixou de
valer" é pergunta de auditoria que um booleano apagaria.

Desativar faz três coisas, na mesma chamada:

1. a assinatura para de receber fan-out de eventos novos;
2. toda entrega dela que ainda estava `pendente` vira `esgotada` — ou seja, a
   retentativa que estava em voo é cortada, e não fica nada preso na fila;
3. chamar `DELETE` de novo devolve `200` com o **mesmo** `desativada_em`.
   Desativar é um estado, não um evento a ser contado. `DELETE` num id
   desconhecido é `404`.

---

## 4. Onde a assinatura começa

`evento_inicial_id` é o `id` do último evento do log no instante do registro.
A partir daí, a assinatura recebe tudo que for gravado com `id` maior que esse —
e **nada** do que já estava lá.

É a mesma regra do stream sem `Last-Event-ID`, e existe pela mesma razão:
registrar um webhook num control plane que já rodou por meses não pode
significar tomar dez mil POSTs na cara.

A retomada é automática e não tem nada para você configurar: o servidor guarda
uma linha de entrega por (assinatura, evento), e é dela que ele deriva de onde
continuar. Servidor reiniciado no meio de uma rajada retoma exatamente de onde
parou, sem repetir o que já enfileirou.

---

## 5. A entrega, e como verificar a assinatura

Cada evento vira um POST:

```
POST /cartografo HTTP/1.1
Host: meu-servico.exemplo
Content-Type: application/json
X-Cartografo-Signature: sha256=8f4c...  (64 caracteres hex)

{"id":129,"type":"job.created","project_id":1,"execution_id":2,"entity":{"type":"job","id":7},"actor":{"type":"system","ref":"control-plane"},"occurred_at":"2026-08-15T12:00:03.114Z","data":{"title":"exemplo do doc","entry_node_id":"entrada","body":null,"acceptance_criteria":null}}
```

O corpo é o envelope inteiro, byte a byte o mesmo objeto que
`GET /v1/executions/:id/events` devolve e que o `data:` do stream carrega.

A receita da assinatura, inteira:

> `X-Cartografo-Signature` = `sha256=` + HMAC-SHA256 do **corpo cru**,
> com o seu `segredo` como chave, em hex minúsculo.

Três detalhes que decidem se a sua verificação funciona:

- **Assine os bytes que chegaram, não o objeto reparseado.** `JSON.parse`
  seguido de `JSON.stringify` não devolve necessariamente os mesmos bytes, e um
  byte diferente é um digest diferente. Leia o corpo cru primeiro, verifique,
  e só então faça o parse.
- **Compare em tempo constante** (`crypto.timingSafeEqual`), nunca com `===`.
  Comparação que sai no primeiro byte diferente vaza, pelo tempo, quanto do
  digest o atacante já acertou.
- **Sem assinatura válida, não confie no corpo.** A URL do seu webhook é
  pública; a assinatura é a única coisa que separa uma entrega do control plane
  de qualquer um que descobriu o endereço.

Vetor fechado, para conferir a sua implementação **antes** de ligá-la no real —
se a sua conta não der exatamente isto, o problema é seu e não da entrega:

| | |
|---|---|
| `segredo` | `segredo-de-exemplo` |
| corpo cru | `{"id":1,"type":"job.created"}` |
| assinatura | `sha256=4d62c8b3801c05f74e912c122b02b34cf183e64ec81d1bb7dc38bb8f329b1bb2` |

Em Node, a receita inteira é uma linha — a mesma que o servidor executa:

```javascript
import { createHmac } from 'node:crypto';
const assinatura = `sha256=${createHmac('sha256', segredo).update(corpoCru, 'utf8').digest('hex')}`;
```

**Responda rápido.** Qualquer `2xx` encerra a entrega; o servidor não lê o corpo
da sua resposta. Se o seu processamento é demorado, aceite (`200`), enfileire do
seu lado e processe depois — segurar a conexão só faz você bater no timeout de
10 segundos e receber a mesma entrega de novo.

---

## 6. Retentativa e estados terminais

| Tentativa | Quando |
|---|---|
| 1ª | assim que o evento é enfileirado (até ~1s depois do fato) |
| 2ª | 10 segundos depois da falha |
| 3ª | 1 minuto depois |
| 4ª | 5 minutos depois |
| 5ª | 30 minutos depois |
| 6ª | 2 horas depois |

Seis tentativas no total: a primeira, mais um degrau por atraso da escala.
Contam como falha o `timeout` de 10 segundos, o erro de rede e **qualquer**
resposta que não seja `2xx` — inclusive `3xx`, que não é seguido.

Cada entrega termina em um de dois estados, e os dois são finais:

| Estado | Significa |
|---|---|
| `entregue` | um `2xx` chegou. `entregue_em` registra quando. |
| `esgotada` | as seis tentativas falharam, ou a assinatura foi desativada com esta entrega pendente. `last_error` guarda a última falha. |

Uma entrega `esgotada` **não** é retentada, por mais tempo que passe, e não há
rota para reenviar. A linha não é apagada, então "tentei seis vezes e desisti" é
uma pergunta respondível — e o log continua sendo a fonte da verdade: o que você
perdeu está inteiro em `GET /v1/executions/:id/events`, e o jeito de se
recuperar de uma janela de indisponibilidade é ler o log por lá.

Um assinante quebrado é problema só dele: as entregas de um lote saem juntas,
cada uma com seu próprio timeout, e nenhuma falha atrasa a de outro assinante,
segura o fan-out ou toca no caminho de escrita do control plane.

---

## 7. Erros do registro

Antes de qualquer escrita, o corpo é validado. Erro é `400`,
`application/json`, com a lista INTEIRA dos problemas — não só o primeiro:

```json
{"error": "validation_failed",
 "details": ["url has to use http or https (got: ftp:)",
             "segredo has to be a non-empty string",
             "tipo \"nao_existe\" is not in the taxonomy (see KNOWN_TYPES)"]}
```

Antes ainda da validação vem a credencial: sem `Authorization: Bearer <token>`
válido, `401` com `credencial_ausente` ou `credencial_invalida`. É a mesma
credencial que abre toda a `/v1` (`t124`) — não há escopo só-de-webhook.

---

## 8. Receptor mínimo, zero dependência

Node ≥ 20, nada instalado. Ele lê o corpo cru, verifica a assinatura em tempo
constante e só então confia no evento:

```javascript
// receptor.mjs — CARTOGRAFO_WEBHOOK_SEGREDO=... node receptor.mjs
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const segredo = process.env.CARTOGRAFO_WEBHOOK_SEGREDO;

/** Compara dois hex de mesmo algoritmo sem vazar, pelo tempo, onde diferem. */
function confere(esperado, recebido) {
  if (typeof recebido !== 'string') return false;
  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(recebido, 'utf8');
  // timingSafeEqual exige tamanhos iguais; tamanho diferente já é recusa.
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer((requisicao, resposta) => {
  if (requisicao.method !== 'POST') {
    resposta.writeHead(405).end();
    return;
  }

  // O corpo CRU, em pedaços, sem parsear nada ainda: é sobre estes bytes que a
  // assinatura foi calculada.
  const pedacos = [];
  requisicao.on('data', (pedaco) => pedacos.push(pedaco));
  requisicao.on('end', () => {
    const corpoCru = Buffer.concat(pedacos).toString('utf8');
    const esperado = `sha256=${createHmac('sha256', segredo).update(corpoCru, 'utf8').digest('hex')}`;

    // Node normaliza o nome do cabeçalho para minúsculas.
    if (!confere(esperado, requisicao.headers['x-cartografo-signature'])) {
      console.error('assinatura não confere — descartando');
      resposta.writeHead(401).end();
      return;
    }

    // Só depois de conferir é que o corpo vira objeto.
    const evento = JSON.parse(corpoCru);
    console.log(`#${evento.id} ${evento.type} ${JSON.stringify(evento.data)}`);

    // Responda antes de processar: 2xx encerra a entrega, e o servidor não lê
    // este corpo. Trabalho demorado vai para uma fila sua, não para cá.
    resposta.writeHead(200).end();
  });
}).listen(8099, () => console.error('ouvindo em http://127.0.0.1:8099'));
```

Registrando esse receptor (com um túnel, ou de dentro da mesma rede):

```
curl -sS -X POST http://127.0.0.1:4317/v1/webhooks \
  -H "authorization: Bearer $CARTOGRAFO_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:8099/cartografo","segredo":"'"$CARTOGRAFO_WEBHOOK_SEGREDO"'"}'
```

E uma rodada acontecendo do outro lado:

```
#129 job.created {"title":"rodada de demonstração","entry_node_id":"entrada","body":null,"acceptance_criteria":null}
#130 job.transitioned {"from_node_id":null,"to_node_id":"refinar"}
#131 job.transitioned {"from_node_id":"refinar","to_node_id":"construir"}
```

**Tipo desconhecido é para ser ignorado, não é erro.** Um receptor antigo
recebendo um tipo novo continua tratando o que entende; é o que torna a
taxonomia extensível de forma aditiva.

---

## 9. Garantias, e o que elas custam

| Garantia | Como |
|---|---|
| Nenhuma entrega duplicada por reprocessamento | uma linha por (assinatura, evento), com `UNIQUE` no banco; refazer o fan-out não cria linha nova |
| Nenhum evento pulado enquanto a assinatura vive | o cursor é derivado das entregas já gravadas, não de um contador em memória |
| Autenticidade | HMAC-SHA256 do corpo cru, com o segredo que só você e o servidor conhecem |
| Um assinante morto não afeta ninguém | as entregas do lote saem juntas, cada uma com timeout próprio; falha vira retentativa, nunca exceção que suba |
| O caminho de escrita nunca espera por webhook | o tick lê o log e escreve só nas tabelas dele; `recordEvent` não sabe que ele existe |

O que **não** existe nesta versão:

- **entrega exatamente-uma-vez.** Se o seu serviço responde `2xx` mas cai antes
  de persistir, o control plane já considerou entregue. Trate o `id` do evento
  como chave de idempotência do seu lado — ele é único e monotônico;
- **reenvio manual** de uma entrega `esgotada`;
- **proteção de SSRF** na URL assinada (loopback e faixas privadas não são
  bloqueados): é a mesma fronteira de confiança de toda rota `/v1` — um token
  válido já abre a API inteira;
- **escopo de credencial**: o token que registra um webhook é o mesmo que abre
  toda a `/v1`;
- **limite de taxa por assinatura** e teto de requisições simultâneas para fora.

---

## 10. O que ainda não existe

**Ciclo de vida do webhook na taxonomia** — "assinou", "entregou", "esgotou"
ainda não são eventos do log: eles vivem nas colunas de `entrega_webhook` e nada
mais. Enquanto o rastro daquelas colunas bastar, é assim que fica; virar tipo de
evento é ficha própria, com schema e entrada na taxonomia.

**Segredo gerado pelo servidor**, com revelação única, do jeito que a `0007` faz
com a credencial. Hoje o segredo é seu, o que evita construir um segundo fluxo
de revelação antes de o primeiro ter rodado em produção.
