# Especificação: stream de eventos para fora

**Versão da API:** `v1` · **Migração:** nenhuma (lê a tabela `evento` do
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
| Autenticação | nenhuma — como em toda rota da v1 |
| Limite de conexões | nenhum; também não há rate limit nem backpressure por cliente |

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
GET /v1/events/stream?projeto_id=1&tipo=trabalho.transicao,trabalho.bloqueado
```

Os valores aceitos em `tipo` são os tipos que o control plane grava hoje:

```
trabalho.criado          sessao.aberta       pergunta.criada
trabalho.transicao       sessao.finalizada   pergunta.respondida
trabalho.bloqueado                           pergunta.auto_resolvida
trabalho.desbloqueado
trabalho.emendado
trabalho.dependencia_declarada
```

A taxonomia também declara `lease.*` e `grafo_versao.*`; eles ainda não são
gravados por ninguém, então pedi-los aqui é `400` — e não uma conexão aberta
que nunca entrega nada, que é o pior dos dois erros. Crescer é aditivo: quando
o control plane passar a gravá-los, eles passam a ser aceitos sem mudança de
contrato.

---

## 4. Formato da mensagem

Cada evento vira uma mensagem SSE com os três campos:

- `id` — o `id` do envelope. **É o cursor**, e é a única ordenação total que
  existe ([taxonomia](../../especificacoes/eventos/taxonomia.md));
- `event` — o `tipo` do evento, que é o que o `EventSource` do navegador usa
  para despachar por `addEventListener`;
- `data` — o envelope inteiro em JSON, numa única linha.

Um trecho real do fio, capturado com `curl -sN`:

```
id: 1
event: trabalho.criado
data: {"id":1,"tipo":"trabalho.criado","projeto_id":1,"execucao_id":2,"entidade":{"tipo":"trabalho","id":1},"ator":{"tipo":"sistema","ref":"control-plane"},"ocorrido_em":"2026-08-14T23:10:11.489Z","dados":{"titulo":"exemplo do doc","no_entrada_id":"entrada","corpo":null,"criterios_de_aceite":null}}

: heartbeat

```

O objeto em `data` é byte a byte o mesmo envelope que
`GET /v1/executions/:id/events` devolve — os oito campos da
[taxonomia](../../especificacoes/eventos/taxonomia.md), com o payload
específico do tipo inteiro dentro de `dados`.

**Tipo desconhecido é para ser ignorado, não é erro.** Um cliente antigo lendo
um log novo continua reconstruindo o que entende; é o que torna a taxonomia
extensível de forma aditiva. Vale para quem lê este stream.

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

Depois que o stream abriu, não há corpo de erro possível: o que existe é a
conexão cair. Trate queda como reconexão (§5), não como falha.

---

## 8. Consumidor mínimo, zero dependência

Node ≥ 20, nada instalado. Ele reconecta sozinho pelo cursor:

```javascript
// events-stream.mjs — node events-stream.mjs [http://127.0.0.1:4317]
const base = process.argv[2] ?? 'http://127.0.0.1:4317';
const query = new URLSearchParams({ tipo: 'trabalho.criado,trabalho.transicao' });

let lastEventId = null;

// Reconectar é trabalho do cliente: o servidor não guarda nada da conexão, e o
// `Last-Event-ID` é o que faz a retomada não ter buraco nem repetição.
for (;;) {
  try {
    const response = await fetch(`${base}/v1/events/stream?${query}`, {
      headers: lastEventId === null ? {} : { 'Last-Event-ID': lastEventId },
    });

    // 400 é contrato errado (filtro inválido): insistir não conserta.
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
        console.log(`#${event.id} ${event.tipo} ${JSON.stringify(event.dados)}`);
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
#1 trabalho.criado {"titulo":"rodada de demonstração","no_entrada_id":"entrada","corpo":null,"criterios_de_aceite":null}
#2 trabalho.transicao {"de_no_id":null,"para_no_id":"refinar"}
#3 trabalho.transicao {"de_no_id":"refinar","para_no_id":"construir"}
```

No navegador o mesmo consumo cabe em cinco linhas, e a reconexão com
`Last-Event-ID` é automática:

```javascript
const stream = new EventSource('/v1/events/stream?tipo=trabalho.transicao');
stream.addEventListener('trabalho.transicao', (message) => {
  const event = JSON.parse(message.data);
  console.log(event.entidade.id, event.dados.de_no_id, '→', event.dados.para_no_id);
});
```

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
lá), autenticação, e limite de conexões simultâneas.

---

## 10. O que ainda não existe

**Webhooks assinados, com retentativa** — o transporte *push*, para quem não
quer manter uma conexão aberta. É ficha dependente desta, e é o que falta para
fechar o ponto de extensão nº 5. Até lá, o stream é o transporte oficial para
fora.
