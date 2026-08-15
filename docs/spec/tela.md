# Especificação: tela mínima de observabilidade

**Versão da API consumida:** `v1` · **Pacote:** [`packages/tela`](../../packages/tela)
**Comando:** `npx cartografo-tela` · **Porta default:** `4318`
**Decisão de origem:** [D11](../../DECISOES.md) — "observabilidade + inbox primeiro; a
tela é cliente comum da API pública, sem privilégio" · Critério de PoC da
[D16](../../DECISOES.md)

A tela responde três perguntas e mais nenhuma: **onde está cada trabalho**,
**quem está esperando uma decisão minha**, e **para onde foi o tempo de um
trabalho**. Tudo o que ela mostra saiu de uma rota pública documentada; tudo o
que ela escreve foi um `PATCH` na mesma API que qualquer outro cliente usa.

O corolário, que é a D11 inteira: **a tela não tem privilégio nenhum**. Não abre
o banco, não importa nada de `packages/core`, não declara driver de SQLite e não
conhece o caminho do arquivo. Ela sobe em outra porta, em outro processo, e pode
morrer sem o control plane notar. Se ela precisa de algo que a API não dá, o bug
é da API — foi assim que esta camada nasceu com três rotas novas do lado do
core, e não com três atalhos do lado dela (§4).

A regra é verificada estaticamente por
[`scripts/check-single-writer.mjs`](../../scripts/check-single-writer.mjs), que
roda no `npm run lint`, e travada por
[`packages/tela/test/no-privileged-access.test.ts`](../../packages/tela/test/no-privileged-access.test.ts).

---

## 1. As sete rotas

| Rota | O que mostra | O que lê da API |
|---|---|---|
| `GET /quadro` | O quadro: todos os trabalhos, agrupados por `no_atual`, com o motivo do bloqueio quando há. | `GET /v1/jobs` |
| `GET /execucoes` | Uma linha por execução, com trabalhos, bloqueados e perguntas pendentes. | `GET /v1/executions` |
| `GET /execucoes/:id` | O recorte de uma rodada: quadro, sessões e perguntas pendentes na mesma página. | `GET /v1/jobs?execucao_id=`, `GET /v1/sessions?execucao_id=`, `GET /v1/input-requests?status=pendente&execucao_id=` |
| `GET /perguntas` | A fila de escalação, cada pergunta inteira e com formulário inline. | `GET /v1/input-requests?status=pendente` |
| `GET /runners` | A frota: um runner por linha, com leases ativas, último heartbeat e a última lease que ele perdeu para o TTL. | `GET /v1/runners` |
| `POST /perguntas/:id/resposta` | Nada: escreve e redireciona (303) para `/perguntas`. | `PATCH /v1/input-requests/:id/answer` |
| `GET /trabalhos/:id` | A linha do tempo do trabalho, em três baldes, mais os totais. | `GET /v1/jobs/:id`, `GET /v1/jobs/:id/events`, `GET /v1/sessions?trabalho_id=`, `GET /v1/input-requests?trabalho_id=` |

Cada view renderiza **no request**. Não há polling, websocket nem
auto-refresh: recarregar a página é a atualização, e o estado da tela é sempre
o estado que a API acabou de contar.

**Execução não é entidade.** `execucao_id` é agrupador opaco (não existe tabela
`execucao` na v1), então `/execucoes/99` sem nada dentro responde **200 com
página vazia**, nunca 404 — mesma leitura que o control plane já faz em
`GET /v1/executions/:id/metrics-by-version`. Trabalho, esse sim, é entidade:
`/trabalhos/424242` responde **404**.

### O pacote tem duas metades, e uma porta só

A D11 pede duas coisas da tela: observabilidade e inbox. Elas chegaram em
fichas diferentes — esta e a `t111` — e dividem o mesmo pacote, o mesmo
processo e a mesma porta. Um handler só
([`packages/tela/src/servidor.ts`](../../packages/tela/src/servidor.ts)) decide
entre elas, nesta ordem:

| Caminho | Quem responde |
|---|---|
| `/v1/*` | Proxy **verbatim** para o control plane, para o inbox poder falar same-origin (§1 de [`tela-inbox-propostas.md`](tela-inbox-propostas.md)). |
| Arquivo de `src/public/` — `/`, `/inbox.js`, `/style.css`, … | O inbox de propostas: página estática e módulos ES nativos. |
| Qualquer outro | As sete rotas desta especificação, renderizadas no servidor. |

A ordem é o contrato. O estático vem antes do render porque `resolveStaticFile`
só devolve caminho para extensão conhecida, e é justamente o `null` dele que
entrega `/execucoes` e `/trabalhos/7` às views em vez de 404-á-los como arquivo
faltando.

**Por que o quadro é `/quadro` e não `/`.** A raiz já era o `index.html` do
inbox quando esta metade chegou, e trocar isso quebraria os testes de aceite da
`t111` sem ganho funcional: as duas metades se alcançam pela navegação, que
ambas as páginas trazem no topo. É layout, não fronteira — mudar de ideia custa
uma linha em cada lado.

---

## 2. A regra dos três baldes

A linha do tempo é o "tempo genérico" do `t81` do flowpilot
([`notas/2026-08-14-aprendizado.md`](../../notas/2026-08-14-aprendizado.md)):
o tempo total de um trabalho não diz nada; o que diz é como ele se reparte.

| Balde | Intervalo | Fonte |
|---|---|---|
| `agente_trabalhando` | `[aberta_em, finalizada_em]` | uma sessão |
| `esperando_humano` | `[criada_em, respondida_em]` | uma pergunta |
| `fila` | o **complemento**: todo intervalo sem sessão aberta e sem pergunta pendente | as transições |

Quatro regras fecham a definição:

1. **Uma transição corta a fila em dois**, mesmo sem nada acontecer no meio.
   "Parado dois dias no refinamento e uma hora na implementação" e "parado dois
   dias e uma hora" são diagnósticos diferentes, e o primeiro é o útil.
   Bloqueio e desbloqueio **não** cortam: são bandeira, não movimento — o
   trabalho não sai do nó, e a espera continua sendo a mesma espera.
2. **O que não terminou fica aberto** (`fim: null`) e **não entra nos totais**.
   Fechar um segmento com o relógio de quem abriu a página inventaria um fato
   que o log não tem.
3. **Trabalho concluído é o `concluido` do servidor**, mais o que só a tela sabe.
   O campo vem de `GET /v1/jobs/:id` e responde a uma pergunta que a tela não
   teria como responder sozinha: o nó atual do trabalho está entre os
   `nos_finais` da versão de grafo dele (e ele não está bloqueado). É o único
   sinal terminal que este sistema tem — não existe evento `trabalho.concluido`
   na taxonomia, e `nos_finais` mora no snapshot do grafo, longe de qualquer
   resposta que a tela leia. Sobre esse campo a reconstrução ainda exige **nada
   aberto e nada bloqueado**: uma sessão aberta ou uma pergunta pendente
   seguram o trabalho por mais terminal que seja o nó. É esse critério
   composto — e só ele — que fecha o último segmento de fila.

   Até o `t152` a regra era só "nada aberto e sem bloqueio", porque campo
   terminal não havia. Ela dava por **concluído** todo trabalho recém-criado:
   com um único `trabalho.criado` no log, nada está aberto porque nada começou.
   Um trabalho parado entre duas sessões caía na mesma armadilha — justamente
   a espera que esta linha do tempo existe para tornar visível. Um trabalho
   bloqueado e parado, esse, continua acumulando fila, em aberto; é exatamente
   o tempo que ninguém quer ver crescendo sem explicação.
4. **A reconstrução é uma função pura** e não olha o relógio
   ([`timeline.ts`](../../packages/tela/src/timeline.ts)): as mesmas entradas —
   as três respostas e o `concluido` da regra 3 — produzem a mesma linha do
   tempo hoje e daqui a um mês. É o que a torna testável sem tempo real.

### Por que três fontes, e não uma

Porque `GET /v1/jobs/:id/events` **exclui de propósito**
`sessao.finalizada`, `pergunta.respondida` e `pergunta.auto_resolvida`: os
payloads desses eventos não carregam `trabalho_id` — o vínculo foi declarado na
abertura, e repeti-lo seria dado duplicado no log
([`packages/core/src/db/events.ts`](../../packages/core/src/db/events.ts)).
"Quem quer o fim da sessão pergunta pela sessão", diz o comentário de lá. Esta
tela é o primeiro consumidor a fazer essa pergunta, e por isso é esta ficha que
abriu por onde fazê-la (§4).

O cabeçalho da página vem de uma quarta leitura, `GET /v1/jobs/:id`, e não
do log: `trabalho.emendado` grava só o **nome** do campo alterado, de modo que
reconstruir o título a partir dos eventos daria o título antigo.

---

## 3. Responder é escrita de verdade

`POST /perguntas/:id/resposta` chama `PATCH /v1/input-requests/:id/answer` no
control plane real e devolve **303** para `/perguntas` — 303 e não 302 porque
depois de um POST a volta é um GET, e é isso que impede o navegador de reenviar
a resposta em um recarregamento. A pergunta some da fila porque a fila é relida
da API, **não** porque o formulário a escondeu localmente. O teste de aceite
cobra essa diferença com uma leitura independente no control plane depois do
submit.

Duas escolhas de fronteira:

- **Resposta em branco é recusada pela tela** (400), antes da rede. O schema de
  `pergunta.respondida` aceita string vazia; gravar um fato sem conteúdo
  poluiria a auditoria com uma decisão que não decide nada.
- **`respondido_por` cai em `"tela"`** quando o campo vem vazio. A `t124`
  autenticou a API, mas a tela carrega UMA credencial de serviço e não pede
  nenhuma ao navegador: o token prova posse, não pessoa. Registrar honestamente a
  porta por onde a resposta entrou segue sendo tudo o que o sistema de fato sabe;
  inventar um usuário seria pior, porque `pergunta.respondida` é evento de
  auditoria.

O campo de resposta tem `<label>` visível amarrado ao `<textarea>` por
`for`/`id`, e não apenas placeholder — placeholder é dica, some no primeiro
caractere digitado e não é nome acessível confiável, e este é o único campo
obrigatório da página. O id sai do id da pergunta, que já é a chave única do
cartão. É a mesma regra que o inbox de propostas segue no campo de motivo
([`tela-inbox-propostas.md`](tela-inbox-propostas.md) §3); pinada em
[`packages/tela/test/questions-answer-field.test.ts`](../../packages/tela/test/questions-answer-field.test.ts),
que resolve o nome como um leitor de tela resolveria.

**Quem desbloqueia o trabalho não é a tela.** O wiring pergunta → bloqueio →
resposta → desbloqueio → retomada da sessão é do `t106`, e mora no control
plane: criar a pergunta bloqueia o trabalho na mesma transação, e responder
desbloqueia com o ator de quem respondeu
([`packages/core/src/repositories/input-request.ts`](../../packages/core/src/repositories/input-request.ts),
contrato em [`escalacao-humana.md`](escalacao-humana.md)). A tela escreve o
fato e mais nada; o ciclo acontece do outro lado do HTTP. Foi escrita antes do
`t106` existir e não mudou uma linha quando ele chegou — que era exatamente a
aposta.

---

## 4. As três lacunas de API que esta camada fechou

D11 manda tratar "a tela precisa de algo que a API não dá" como bug da API. As
três são aditivas e simétricas a filtros que já existiam:

| Rota | O que faltava |
|---|---|
| `GET /v1/executions` | Não havia como **descobrir** quais execuções existem: só existia `GET /v1/executions/:id/metrics-by-version`, que exige já saber o id. Devolve `{execucoes: [...]}` com `execucao_id`, `trabalhos`, `trabalhos_bloqueados` e `perguntas_pendentes`, em ordem crescente e com o grupo `null` por último (mesma convenção de `metricsByVersion`). |
| `GET /v1/sessions?trabalho_id=` | Só havia filtro por execução; sem este, não dá para pedir "as sessões deste trabalho" — e sem elas não há fim de sessão na linha do tempo. |
| `GET /v1/input-requests?trabalho_id=` | Simétrico ao anterior, pela mesma razão: o fim das esperas. |

Os filtros se somam em **AND** com os que já existiam, e um filtro inválido é
**400**, nunca um filtro ignorado em silêncio.

---

## 5. Configuração

| Variável | Default | O que é |
|---|---|---|
| `CARTOGRAFO_TELA_PORT` | `4318` | Porta em que a tela escuta. |
| `CARTOGRAFO_URL` (ou `--url`) | `http://127.0.0.1:4317` | Control plane que ela lê. |

Precedência do endereço: `--url` > `CARTOGRAFO_URL` > default — a mesma da CLI
do core ([`packages/core/src/cli/url.ts`](../../packages/core/src/cli/url.ts)),
para que subir o control plane em outra porta não exija configurar duas coisas
em dois vocabulários. A tela escuta em **loopback**, como o control plane e pela
mesma razão: não há autenticação nesta fase.

Ao subir, imprime uma linha JSON de prontidão em stdout — mesmo contrato da
partida do control plane:

```json
{"evento":"cartografo.tela.pronta","url":"http://127.0.0.1:4318","control_plane":"http://127.0.0.1:4317"}
```

**Quando o control plane está fora do ar**, toda página responde **502** com o
comando que resolve (`npx cartografo`), nunca um 200 com quadro vazio. Um 404 da
API vira 404 na tela; qualquer outro erro do control plane vira 502 — quem
falhou foi o servidor de trás, e o navegador precisa saber que não foi ele.

---

## 6. Sem framework, sem build

Servidor `node:http` puro, HTML montado no request, **zero dependência de
runtime**. O único JavaScript que vai ao navegador são as oito linhas que copiam
uma opção clicada para o campo de resposta; sem elas, digitar a resposta
continua funcionando.

É escolha de escala, não de gosto: a tela é um cliente HTTP de leitura com um
formulário, e um pipeline de front-end custaria mais manutenção do que a coisa
toda que ele serviria. É também reversível — a fronteira que a D11 congela é o
contrato HTTP entre a tela e o core, não o que a tela usa por dentro.

### Os marcadores `data-*` são contrato

Existem para que os testes de aceite afirmem sobre **estrutura** — o que está
dentro de qual grupo, em que ordem — sem congelar a marcação inteira. Mudar um
deles é mudar o contrato; mudar classe de CSS não é.

| Marcador | Onde | Valor |
|---|---|---|
| `data-no-atual` | grupo do quadro | id do nó |
| `data-trabalho` | cartão de trabalho | id do trabalho |
| `data-execucao` | linha da lista de execuções | id, ou vazio no grupo `null` |
| `data-campo` | célula de contagem ou de campo derivado | `trabalhos`, `trabalhos_bloqueados`, `perguntas_pendentes`, `nome`, `leases_ativas`, `ultimo_heartbeat`, `ultima_expiracao` |
| `data-runner` | linha da tabela de runners | id do runner |
| `data-sessao` | linha da tabela de sessões | id da sessão |
| `data-transcricao` | link da célula de transcrição, na tabela de sessões | id da sessão (o `href` é `/v1/sessions/:id/transcript`) |
| `data-pergunta` | cartão de pergunta | id da pergunta |
| `data-segmento` | item da linha do tempo | `fila`, `agente_trabalhando`, `esperando_humano` (com `data-inicio` e `data-fim`; `data-fim` vazio = em aberto) |

A célula de transcrição é um link cru para a rota da API, e não uma vista
renderizada: quem clica cai na resposta JSON do control plane, servida pelo
proxy **verbatim** de `/v1/*` (§1). É de propósito — a tela não ganha rota nova
nem privilégio nenhum (D11), e decodificar `stream-json` na tela é outra ficha.

Todo dado que entra em HTML passa por `escapar`. Título de trabalho, texto de
pergunta e motivo de bloqueio vêm de fora, por uma API que ainda não autentica
ninguém.

---

## 7. O que esta tela ainda não faz

Cada item é escopo declarado de outra ficha, não esquecimento:

- **Tela de edição/configuração de grafo** — D11 fixa a ordem: observabilidade
  primeiro, edição depois; por ora, arquivos e CLI.
- **Inbox de aprovação de propostas** (entidade `proposta`, distinta de
  `pergunta`) — é a outra metade do pacote, entregue pela `t111` e servida em
  `/` ([`tela-inbox-propostas.md`](tela-inbox-propostas.md)).
- **Login no navegador** — a `t124` autenticou a API e deu à tela uma credencial
  de serviço (`CARTOGRAFO_TELA_TOKEN`, com `CARTOGRAFO_TOKEN` de reserva), que ela
  apresenta em toda chamada ao control plane. O navegador continua chegando à tela
  sem credencial nenhuma, a tela segue em loopback e `respondido_por` cai em
  `"tela"`: pela D11 a tela é cliente sem privilégio da API, não uma segunda
  fronteira de identidade.
- **Retomada de verdade da sessão ao responder** — do control plane, pela
  `t106` (§3); a tela só escreve o fato.
- **Rótulo de nó com `papel`/`descricao` do snapshot do grafo** — o quadro
  mostra `no_atual` cru; buscar o grafo para rotular é aditivo.
- **Paginação** — nenhuma rota da API pagina hoje, e não é esta ficha que
  inventa o que a API não tem.
- **Atualização ao vivo** (polling/websocket) — cada view renderiza no request.
- **Tempo relativo** ("há 3 minutos") em `/runners` ou em qualquer outra data:
  a tela mostra o instante cru que a API gravou. Rótulo relativo calculado na
  renderização, numa página sem auto-refresh, começa a mentir no segundo
  seguinte.
- **Saber se um runner ocioso está vivo.** `/runners` mostra o que o control
  plane de fato registra, e ele registra leases: `ultimo_heartbeat` e
  `ultima_expiracao` são derivados da tabela `lease`
  ([`runner-e-controller.md`](runner-e-controller.md) §5). Um runner pareado
  que nunca pegou trabalho aparece com os três campos vazios, igual a um que
  está fora do ar. Inventar aqui um sinal de vida que a API não tem seria
  exatamente o atalho que a D11 proíbe.
