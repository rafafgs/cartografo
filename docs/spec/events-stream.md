# Especificação: stream de eventos para fora

**Versão da API:** `v1` · **Migração:** nenhuma (lê a tabela `event` do
[`0003`](../../packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql))
**Origem:** ponto de extensão nº 5 —
["eventos para fora"](../../notas/2026-08-14-extensao-e-qualidade.md) · **Ficha:** t123

Este documento é o contrato de quem consome. Ele é deliberadamente
auto-suficiente: dá para escrever um cliente inteiro sem abrir uma linha do
código do control plane. O formato do que trafega é o envelope da
[taxonomia de eventos](../../especificacoes/eventos/taxonomia.md), sem
tradução nenhuma no caminho.

---

## 1. O que é

`GET /v1/events/stream` é uma leitura **quase em tempo real** do log de
telemetria por [SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)
(`text/event-stream`): a conexão fica aberta e cada fato novo chega como uma
mensagem, na ordem do `id`.

Por que SSE e não WebSocket: o tráfego é de mão única (servidor → cliente) e o
envelope já carrega o `id` monotônico que o protocolo de reconexão do SSE quer.
WebSocket traria uma máquina bidirecional que ninguém aqui usa, e uma
dependência nova no repositório.

**O que este endpoint não é:** não é histórico. Ele começa no presente (§5) e
serve o passado só quando você pede pelo cursor. Para ler uma rodada inteira
depois do fato, existe `GET /v1/executions/:id/events`, que devolve a lista
completa em JSON.

---

## 2. A rota

```
GET /v1/events/stream
Accept: text/event-stream
```

| | |
|---|---|
| Resposta | `200` com `content-type: text/event-stream`, corpo aberto por tempo indeterminado |
| Cabeçalhos | `cache-control: no-cache, no-transform`, `connection: keep-alive`, `x-accel-buffering: no` |
| Autenticação | `Authorization: Bearer <token>` — obrigatória, como em toda rota da v1 desde a `t124` |
| Limite de conexões | nenhum; também não há rate limit nem backpressure por cliente |

O token é o mesmo que o control plane imprime na primeira partida (`bootstrapToken`
na linha `cartografo.ready`) e que o CLI lê de `CARTOGRAFO_TOKEN`. Ele vai no
cabeçalho da requisição que ABRE o stream; depois disso não há renegociação —
uma credencial revogada só é notada na próxima conexão.

Um consumidor lento **não** segura o control plane: a conexão lê a tabela por
conta própria, num relógio próprio, e não está ligada ao caminho de escrita. O
pior que um cliente parado provoca é o próprio atraso.

---

## 3. Filtros

Os dois são opcionais e **somam** (AND, nunca OU).

| Parâmetro | Formato | O que faz |
|---|---|---|
| `projeto_id` | inteiro | Só eventos daquele projeto. Valor não-inteiro é `400`. |
| `tipo` | lista separada por vírgula | Só os tipos citados, casando string exata. Tipo desconhecido é `400`. |

```
GET /v1/events/stream?projeto_id=1&tipo=job.transitioned,job.blocked
```

Os valores aceitos em `tipo` são os tipos que o control plane grava hoje:

```
job.created                session.opened               input_request.created
job.transitioned           session.finished             input_request.answered
job.blocked                session.permission_denied    input_request.auto_resolved
job.unblocked
job.amended                lease.granted                graph_version.registered
job.dependency_declared    lease.expired                graph_version.applied
job.hook_failed                                         graph_version.reverted

execution.finished
```

São os dezenove da taxonomia, e o crescimento foi aditivo como prometido: o
filtro nunca declarou lista própria — ele valida contra `KNOWN_TYPES`
(`packages/core/src/db/event-validation.ts`) —, então ligar a emissão de
`lease.*` e `graph_version.*` na `t196` os tornou pedíveis sem uma linha de
mudança de contrato aqui, e `execution.finished` (D21, `t245`) entrou pelo mesmo
caminho: quem quiser saber só do fim das rodadas assina
`?type=execution.finished` e não recebe mais nada. Um tipo fora da taxonomia
continua sendo `400`, e não uma conexão aberta que nunca entrega nada — que é o
pior dos dois erros.

---

## 4. Formato da mensagem

Cada evento vira uma mensagem SSE com os três campos:

- `id` — o `id` do envelope. **É o cursor**, e é a única ordenação total que
  existe ([taxonomia](../../especificacoes/eventos/taxonomia.md));
- `event` — o `type` do evento, que é o que o `EventSource` do navegador usa
  para despachar por `addEventListener`;
- `data` — o envelope inteiro em JSON, numa única linha.

Um trecho real do fio, capturado com `curl -sN`:

```
id: 1
event: job.created
data: {"id":1,"type":"job.created","project_id":1,"execution_id":2,"entity":{"type":"job","id":1},"actor":{"type":"system","ref":"control-plane"},"occurred_at":"2026-08-14T23:10:11.489Z","data":{"title":"exemplo do doc","entry_node_id":"entrada","body":null,"acceptance_criteria":null}}

: heartbeat

```

O objeto em `data` é byte a byte o mesmo envelope que
`GET /v1/executions/:id/events` devolve — os oito campos da
[taxonomia](../../especificacoes/eventos/taxonomia.md), com o payload
específico do tipo inteiro dentro de `data`.

**O payload de um tipo também cresce, e cresce aditivamente.** O envelope tem
sempre os mesmos oito campos; o que vive dentro de `data` é por tipo, e ganhar
campo novo ali nunca pediu mudança de contrato aqui — mesmo caminho que a §3
descreve para o conjunto de tipos. `session.finished` é o mais mexido dos
dezenove: recebeu `output` e `output_schema_error` na `t253`, `failure_kind` e
`refusal_category` na `t265`, e `output_accepted` na `t268`.

**`output_accepted` é o veredito sobre o relato estruturado da sessão** — se ele
foi aceito na conferência contra o schema `output` da skill que o nó pina (D9).
Dos três, é o único que aparece em **todo** fechamento a partir da `t268`:
`true` quando o relato casou e também quando nada foi relatado, `false` só na
recusa — e é só na recusa que `output` vem `null` e os motivos vêm inteiros em
`output_schema_error`. Para quem lê este stream isso é o que torna a contagem
possível: relato recusado é `output_accepted === false`, e não a ausência da
lista de motivos, porque "não foi recusado" e "não foi conferido" seriam a mesma
ausência. Ausente também não é `false`, e é por isso que o schema o declara
opcional: o log gravado antes da `t268` não tem o campo, e continua válido.
Quem decide se o trabalho anda a partir desse veredito é o runner, e ele o lê
**de forma síncrona** na resposta do próprio `PATCH /finish`, não daqui
([runner-and-controller.md](runner-and-controller.md), "Relato recusado pelo control
plane segura o trabalho no nó", `t268`): este stream é observação, nunca caminho
de decisão.

O campo a campo de cada tipo continua sendo da
[taxonomia](../../especificacoes/eventos/taxonomia.md), e não deste documento:
repetir aqui a descrição dos payloads criaria uma segunda fonte da verdade só
para ela divergir da primeira.

**Tipo desconhecido é para ser ignorado, não é erro** — e campo desconhecido
dentro de `data`, também. Um cliente antigo lendo um log novo continua
reconstruindo o que entende; é o que torna a taxonomia extensível de forma
aditiva, nas duas dimensões. Vale para quem lê este stream.

---

## 5. Reconexão: `Last-Event-ID`

O mecanismo de retomada é **um só**, o padrão do SSE. Não existe parâmetro
`desde_id` na query: duas formas de fazer a mesma coisa é uma a mais.

| Situação | O que chega |
|---|---|
| Conexão **sem** `Last-Event-ID` | Só o que for gravado a partir do instante da conexão. Nada de histórico por acidente. |
| Conexão **com** `Last-Event-ID: 42` | Tudo com `id > 42`, em ordem, e daí em diante ao vivo. |

O navegador manda esse cabeçalho sozinho quando o `EventSource` reconecta.
Qualquer outro cliente manda na mão — guarde o `id` da última mensagem que você
**processou** (não a que você recebeu) e devolva esse valor no cabeçalho da
reconexão. É o que fecha o buraco sem duplicar nada.

`Last-Event-ID` que não seja um inteiro ≥ 0 é `400`.

Uma retomada muito atrasada não vira uma rajada única: o servidor entrega o
atraso em leituras de no máximo 500 eventos, encadeadas até alcançar o
presente.

---

## 6. Keep-alive

A cada **15 segundos sem nenhum byte real**, a conexão recebe um comentário:

```
: heartbeat
```

É o que impede proxy e load balancer de derrubarem uma conexão ociosa. A conta
é feita a partir do último byte escrito, então um stream movimentado
simplesmente não gasta comentário nenhum.

**Toda linha começando com `:` é comentário e deve ser ignorada pelo cliente.**
Quem usa `EventSource` ganha isso de graça; quem lê o corpo na mão precisa
filtrar (o exemplo da §8 filtra).

---

## 7. Erros

Antes de qualquer byte de SSE, os filtros são validados. Se algo estiver
errado, a resposta é uma resposta HTTP comum — `400`, `application/json`, e a
conexão **nunca** chega a virar `text/event-stream`:

```json
{"error": "validation_failed",
 "details": ["tipo \"nao_existe\" is not in the taxonomy (see KNOWN_TYPES)"]}
```

`details` traz a lista inteira dos problemas, não só o primeiro.

Antes ainda dos filtros vem a credencial (§2). Sem ela, ou com uma que não
resolve, a resposta é `401` — também `application/json`, também sem virar
`text/event-stream`:

```json
{"error": "missing_credential", "message": "esta rota exige `Authorization: Bearer <token>` — ..."}
```

`missing_credential` é "não veio cabeçalho usável" e `invalid_credential` é
"veio e não vale (desconhecida ou revogada)". Nenhum dos dois melhora com
retentativa: é configuração, não indisponibilidade.

Depois que o stream abriu, não há corpo de erro possível: o que existe é a
conexão cair. Trate queda como reconexão (§5), não como falha.

---

## 8. Consumidor mínimo, zero dependência

Node ≥ 20, nada instalado. Ele reconecta sozinho pelo cursor:

```javascript
// events-stream.mjs — CARTOGRAFO_TOKEN=... node events-stream.mjs [http://127.0.0.1:4317]
const base = process.argv[2] ?? 'http://127.0.0.1:4317';
const token = process.env.CARTOGRAFO_TOKEN;
const query = new URLSearchParams({ tipo: 'job.created,job.transitioned' });

let lastEventId = null;

// Reconectar é trabalho do cliente: o servidor não guarda nada da conexão, e o
// `Last-Event-ID` é o que faz a retomada não ter buraco nem repetição. A
// credencial vai em toda tentativa: cada reconexão é uma requisição nova.
for (;;) {
  try {
    const response = await fetch(`${base}/v1/events/stream?${query}`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(lastEventId === null ? {} : { 'Last-Event-ID': lastEventId }),
      },
    });

    // 400 é contrato errado (filtro inválido) e 401 é credencial: insistir não
    // conserta nenhum dos dois.
    if (!response.ok) {
      console.error(`stream recusado (${response.status}):`, await response.text());
      break;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });

      let cut;
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);

        // Linha que começa com ':' é comentário — é o keep-alive. Ignore.
        const lines = block.split('\n').filter((line) => line !== '' && !line.startsWith(':'));
        if (lines.length === 0) continue;

        const message = {};
        for (const line of lines) {
          const separator = line.indexOf(':');
          message[line.slice(0, separator)] = line.slice(separator + 1).replace(/^ /, '');
        }

        lastEventId = message.id ?? lastEventId;
        const event = JSON.parse(message.data);
        console.log(`#${event.id} ${event.type} ${JSON.stringify(event.data)}`);
      }
    }
  } catch (failure) {
    // Servidor fora do ar, socket cortado no meio: é queda, e queda é
    // reconexão. Só o 400 acima é motivo para desistir.
    console.error(`stream indisponível: ${failure.message}`);
  }

  console.error(`reconectando a partir do id ${lastEventId}`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
```

Rodando contra um control plane com uma rodada acontecendo:

```
#1 job.created {"title":"rodada de demonstração","entry_node_id":"entrada","body":null,"acceptance_criteria":null}
#2 job.transitioned {"from_node_id":null,"to_node_id":"refinar"}
#3 job.transitioned {"from_node_id":"refinar","to_node_id":"construir"}
```

No navegador o mesmo consumo cabe em cinco linhas, e a reconexão com
`Last-Event-ID` é automática:

```javascript
const stream = new EventSource('/v1/events/stream?tipo=job.transitioned');
stream.addEventListener('job.transitioned', (message) => {
  const event = JSON.parse(message.data);
  console.log(event.entity.id, event.data.from_node_id, '→', event.data.to_node_id);
});
```

Com uma ressalva desde a `t124`: `EventSource` não deixa mandar cabeçalho, e a
rota exige um. Esse trecho só funciona atrás de uma origem que anexe a
credencial pelo navegador — que é exatamente o papel da tela (D11: ela guarda um
token de serviço e o repassa, o navegador não apresenta nenhum). O repasse
`/v1/*` da tela ainda espera o corpo terminar antes de responder, e um corpo SSE
não termina, então esse caminho está listado na §10.

---

## 9. Garantias, e o que elas custam

| Garantia | Como |
|---|---|
| Sem buraco e sem repetição na reconexão | `id > cursor`, estritamente; o `id` é atribuído pelo servidor e é monotônico |
| Ordem | sempre crescente por `id`, dentro e entre reconexões |
| Latência | até ~300ms: a conexão faz *poll* da tabela nesse ritmo, e não é acoplada à escrita |
| Rajada limitada | no máximo 500 eventos por leitura, encadeadas até alcançar o presente |
| Um consumidor morto não afeta ninguém | a conexão morre com o socket; os relógios dela são desarmados junto |

O que **não** existe nesta versão: entrega garantida (se ninguém estiver
conectado, ninguém recebe — o log é que é a fonte da verdade, e ele continua
lá), limite de conexões simultâneas, e credencial só de leitura.

Escopo de credencial passou a existir na `t143`, e não é este: a credencial de
runner, emitida no pareamento, alcança uma lista literal de cinco rotas de
despacho ([runner-and-controller.md](runner-and-controller.md) §5) — e esta rota não
está nela. Um runner apresentando o token dele aqui toma `403
credencial_fora_de_escopo`. Quem abre o stream continua sendo a credencial de
operador, a mesma que abre toda a `/v1`; um credenciamento de leitura, que
distinguisse "ler o log" de "escrever no control plane", segue sem existir.

---

## 10. O que ainda não existe

O transporte *push* passou a existir: **webhooks assinados, com retentativa**
([`docs/spec/webhooks-events.md`](webhooks-events.md), `t142`), para quem não
quer manter uma conexão aberta. Com ele, o ponto de extensão nº 5 está fechado
pelas duas metades — este documento é a de *pull*. A §1 daquele compara as duas
e diz quando cada uma serve.

**O stream atravessando a tela** — o repasse `/v1/*` de `packages/tela` lê a
resposta inteira antes de devolvê-la, o que serve para JSON e não serve para um
corpo que nunca acaba. Enquanto isso não mudar, o `EventSource` da §8 não tem
por onde entrar: consumir o stream é coisa de cliente fora do navegador, com o
cabeçalho na mão.
