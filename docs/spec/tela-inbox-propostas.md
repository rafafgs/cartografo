# Especificação: inbox de propostas na tela

**Pacote:** [`packages/tela`](../../packages/tela) · **Porta:** `4318`
**Decisões de origem:** [D11](../../DECISOES.md) — "a tela é cliente comum da API
pública" · [D1](../../DECISOES.md) — "só o server escreve no banco" ·
princípio 5 do [README](../../README.md) — "escada de segurança"

A tela é a metade humana da escada de segurança. O topógrafo (`t110`) escreve
hipóteses sobre o grafo; o portão de soundness reprova as que quebrariam a
execução; o que sobra precisa de alguém que olhe a evidência, leia o diff e
decida. Este documento especifica essa caixa de entrada: o que ela mostra, quais
decisões oferece, e como ela alcança o control plane sem ganhar privilégio
nenhum sobre ele.

Uma frase resume a fronteira: **a tela não sabe nada que a API pública não
conte**. Nenhum import de `packages/core`, nenhum driver de SQLite no manifesto,
nenhuma rota privada — a mesma superfície que qualquer outro cliente teria, e um
portão estático (`packages/tela/test/no-privileged-access.test.ts`,
[`scripts/check-single-writer.mjs`](../../scripts/check-single-writer.mjs)) que
reprova o contrário.

---

## 1. O padrão same-origin

O navegador não pode falar direto com o control plane: o core não instala
`@fastify/cors`, e liberar CORS no único escritor do sistema (D1) é decisão bem
maior do que "a tela precisa de dados". Então a tela ganha um servidor HTTP
próprio, de dois trabalhos:

| Caminho | O que acontece |
|---|---|
| `/v1/*` | Proxy **verbatim** para `CARTOGRAFO_URL` — método, caminho, query, corpo e cabeçalhos atravessam inalterados, e o status volta como veio. |
| Qualquer outro | Arquivo estático de `packages/tela/src/public/` (`/` serve `index.html`). |

O navegador fala só com a origem de onde a página veio; a tela continua sendo
mais um cliente HTTP da API pública. Nada na fronteira do core muda.

**Verbatim é literal, e por um motivo.** `409 proposta_nao_pendente` e
`422 grafo_invalido` são **respostas** que o inbox precisa mostrar, não erros que
o proxy possa reescrever em "deu ruim". A única resposta que o proxy inventa é a
do control plane fora do ar:

```json
{ "erro": "control_plane_indisponivel", "mensagem": "não deu para falar com o control plane em http://127.0.0.1:4317 — rode `npx cartografo` primeiro (ou aponte outro endereço com CARTOGRAFO_URL)" }
```

`502`, com o mesmo par `erro` / `mensagem` que toda resposta de erro do core usa
(§6 de [`entidades-versionamento.md`](entidades-versionamento.md)) — a página tem
um jeito só de mostrar falha, em vez de dois. A causa (`ECONNREFUSED`, stack
trace) é descartada de propósito: para quem olha o inbox, o acionável é o
endereço que não respondeu e o comando que sobe o servidor.

Três cabeçalhos não atravessam, porque descrevem o salto que termina aqui:
`host`, `connection` e companhia, mais `content-length` e `accept-encoding` — o
`fetch` recalcula o primeiro e decodifica o segundo, e repassá-los é como um
proxy acaba anunciando um tamanho ou uma codificação que não batem com os bytes
que ele mesmo manda. Na volta, só `content-type` é repassado.

Sem framework de servidor nem de cliente: `node:http` de um lado, HTML e módulos
ES nativos do outro, sem bundler e sem passo de build — o mesmo minimalismo do
resto do repo (uma dependência nova só onde não dá para evitar).

### Configuração

| Variável | Default | Para quê |
|---|---|---|
| `CARTOGRAFO_TELA_PORT` | `4318` | Porta da tela (a do control plane, mais um). |
| `CARTOGRAFO_URL` | `http://127.0.0.1:4317` | Control plane para onde `/v1/*` vai. |
| `CARTOGRAFO_PORT` | `4317` | Porta do control plane no default acima. |

Mesma precedência de [`packages/core/src/cli/url.ts`](../../packages/core/src/cli/url.ts):
`CARTOGRAFO_URL` > `http://127.0.0.1:CARTOGRAFO_PORT` > default. A resolução é
**duplicada** em `packages/tela/src/proxy.ts`, não importada: a tela não declara
dependência do pacote core, e essa é justamente a fronteira que a D11 pede.
Duplicada e pinada por teste, como o validador de grafo de
[`scripts/validar-grafo.mjs`](../../scripts/validar-grafo.mjs).

Escuta em `127.0.0.1`, como o core: a tela não tem autenticação (`t124`) e
proxeia para o único escritor do sistema — expor a interface externa é decisão
da ticket que trouxer autorização.

Subir: `npm start --workspace @cartografo/tela`. Imprime uma linha de prontidão
em stdout, no espírito de `cartografo.pronto`:

```json
{"evento":"cartografo.tela.pronta","url":"http://127.0.0.1:4318","control_plane":"http://127.0.0.1:4317"}
```

---

## 2. Contrato assumido do control plane (`t111`)

A tela **não cria rota nenhuma** em `packages/core`. Ela consome quatro
endpoints; dois já existem, dois são escopo declarado do `t111`
([`entidades-versionamento.md` §7](entidades-versionamento.md)). Quem refinar o
lado do core confere contra esta seção.

| Método | Rota | Estado | O que a tela usa |
|---|---|---|---|
| `GET` | `/v1/propostas` | **assumida** | Lista para as duas seções. Idealmente filtrável por `?status=`; a tela hoje pede tudo e separa no cliente. |
| `GET` | `/v1/propostas/:id` | **assumida** | Detalhe: `operacoes`, `evidencia`, `metrica_esperada`, `resultado`, `motivo_reversao`, `motivo_rejeicao`. |
| `POST` | `/v1/propostas/:id/aprovar` | **assumida** | `pendente` → `aprovada`. Sem corpo. |
| `POST` | `/v1/propostas/:id/rejeitar` | **assumida** | `{motivo}` obrigatório → `rejeitada`. |
| `POST` | `/v1/propostas/:id/aplicar` | existe | Executa o fluxo do §5 de `entidades-versionamento.md`. |
| `POST` | `/v1/propostas/:id/reverter` | existe | `{motivo}` obrigatório; move o ponteiro de volta. |

Envelope de resposta que a tela espera — e como ela se protege de estar errada:

- lista: `{propostas: [...]}` (um array cru também é aceito);
- detalhe e ações: `{proposta: {...}}` (a proposta crua também é aceita), mais
  `{grafo_versao: {id}}` no `aplicar`, que é o que a linha passa a exibir;
- erro: `{erro, mensagem}`, em qualquer status não-2xx.

**A incompatibilidade que o `t111` precisa resolver.** Hoje
[`routes/propostas.ts`](../../packages/core/src/routes/propostas.ts) exige
`status === 'pendente'` para aplicar, porque o estado `aprovada` ainda não
existe. Esta tela assume o contrário: `pendente` só oferece Aprovar/Rejeitar, e
Aplicar aparece em `aprovada`. Enquanto o `t111` não mudar essa guarda, aplicar
pela tela devolve `409 proposta_nao_pendente` — que a tela mostra inline, sem
quebrar, mas o ciclo completo só fecha com os dois lados no mesmo vocabulário.

---

## 3. As duas seções, e o estado → ações

A lista sai em duas seções: **Pendentes** (`pendente`, `aprovada` — o que espera
decisão humana) e **Histórico** (`aplicada`, `revertida`, `rejeitada`). Proposta
rejeitada não some: é conhecimento negativo para o topógrafo
([`notas/2026-08-14-aprendizado.md`](../../notas/2026-08-14-aprendizado.md)), e o
lugar dela é o histórico, somente leitura.

Cada proposta oferece exatamente as ações válidas para o status em que está:

| Status | Ações | Motivo obrigatório? |
|---|---|---|
| `pendente` | Aprovar, Rejeitar | só Rejeitar |
| `aprovada` | Aplicar | não |
| `aplicada` | Reverter | sim |
| `revertida`, `rejeitada` | — (somente leitura) | — |
| qualquer outro | — (somente leitura) | — |

A última linha é a que importa mais: o core é dono do vocabulário de status e vai
crescê-lo (`t112` escreve `resultado`). Status desconhecido **falha seguro** —
vira leitura, nunca exceção no meio da renderização. Um botão que aparece e
volta `409` ensina a pessoa a desconfiar da tela, o que é pior que um botão a
menos.

A regra mora em uma função pura, `resolveActionsForStatus`
([`src/public/actions.js`](../../packages/tela/src/public/actions.js)), testada
em Node mesmo rodando no navegador.

Depois de uma ação bem-sucedida **só aquela linha muda** — status novo e, no
`aplicar`, a `grafo_versao` retornada. Nada de recarregar a página. Uma ação
malsucedida mostra `erro: mensagem` na própria linha; a lista inteira só recarrega
no botão "Atualizar" (não há polling nem websocket nesta fase).

---

## 4. O diff em prosa

D15 escolheu diff **semântico** em vez de diff de linha justamente para que uma
proposta pudesse ser **julgada** ("acrescenta um portão de red team antes de
implantar") em vez de apenas aprovada sem ser entendida. Despejar o JSON da
operação na página jogaria isso fora. Uma linha legível por operação, no
vocabulário do §3 de [`entidades-versionamento.md`](entidades-versionamento.md):

| Operação | Linha |
|---|---|
| `adicionar_no` | `+ nó "red_team" (tipo portao)` |
| `remover_no` | `- nó "revisar_manual"` |
| `adicionar_aresta` | `+ aresta testar → red_team (condição: aprovado)` |
| `remover_aresta` | `- aresta testar → implantar` |
| `alterar_campo_no` | `~ nó "implementar": campo "papel" de "fazer" para "conferir"` |
| tipo desconhecido | `? operação de tipo desconhecido ("mover_no")` |
| entrada malformada | `? operação malformada` |
| `operacoes` vazio/ausente | `nenhuma alteração` |

Valor de objeto (um `contrato` inteiro em `alterar_campo_no`) sai como JSON
compacto truncado em 60 caracteres: é o **valor** que muda, não a operação, e
escondê-lo tornaria `alterar_campo_no` não julgável.

Nada aqui lança. As operações vêm de um topógrafo que esta tela nunca viu, e uma
linha estranha é um render ruim — uma exceção é a página inteira em branco.
Implementação e formato pinados em
[`src/public/diff.js`](../../packages/tela/src/public/diff.js) e
`packages/tela/test/diff.test.ts`.

---

## 5. O que esta tela ainda não faz

Cada item é escopo declarado de outra ticket, não esquecimento:

- **Tela de observabilidade** (execuções, sessões, event log) — a outra metade do
  conteúdo da D11.
- **Impedir reproposição de proposta rejeitada** — comportamento do topógrafo
  (`t110`); aqui o histórico é só leitura.
- **Autenticação/autorização**, na tela e no proxy (`t124`).
- **Paginação ou virtualização** da lista — aceitável na escala da PoC.
- **Atualização em tempo real** (websocket, polling) — a lista anda por ação do
  usuário.
- **Linhagens variantes** (D13) — a tela mostra o `grafo_id` que a proposta tem,
  sem tratamento especial (`t118`).
