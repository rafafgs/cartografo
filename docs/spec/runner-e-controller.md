# Especificação: runner, lease e controller de despacho

**Versão da API:** `v1` · **Migração:** [`packages/core/migrations/0004_runner_lease.sql`](../../packages/core/migrations/0004_runner_lease.sql)
**Decisão de origem:** [D5](../../DECISOES.md) — "trabalho despachado carrega lease; runner morto expira e o trabalho volta à fila. Registros idempotentes na API"

Um trabalho só pode ter um dono por vez, e o dono pode morrer sem avisar. Essas
duas frases são o problema inteiro desta camada, e a lease é a resposta: um
direito **temporário** sobre um trabalho, que precisa ser renovado para
continuar valendo. Quem para de renovar perde — não por decisão de ninguém, mas
por vencimento de prazo.

O corolário importante é onde o estado mora. O teto de sessões simultâneas e o
prazo das leases vivem no control plane, nunca no runner: só o servidor escreve
no banco ([D1](../../DECISOES.md)), e é isso que faz "no máximo N sessões neste
projeto" valer para o projeto — somando todos os runners — e não para cada
processo isoladamente. O runner é cliente HTTP puro, exatamente como a tela
(D11): ele declara os limites, e obedece à resposta.

---

## 1. As duas entidades

| Entidade | O que é | Muda? |
|---|---|---|
| `runner` | A **identidade** de um processo que executa trabalho. | Só o nome. |
| `lease` | O **direito temporário** de um runner sobre um trabalho, com prazo próprio. | Status, prazo e carimbos de heartbeat/fim. |

```sql
CREATE TABLE runner (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  registered_at TEXT NOT NULL
);

CREATE TABLE lease (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  runner_id         TEXT NOT NULL REFERENCES runner(id),
  job_id            INTEGER NOT NULL, -- solto de propósito (§6)
  project_id        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'released', 'expired')),
  ttl_seconds       INTEGER NOT NULL,
  granted_at        TEXT NOT NULL,
  heartbeat_at      TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  released_at       TEXT,
  expiration_reason TEXT CHECK (expiration_reason IN ('heartbeat_lost', 'ttl_elapsed'))
);

CREATE INDEX idx_lease_runner_status  ON lease (runner_id, status);
CREATE INDEX idx_lease_project_status ON lease (project_id, status);
CREATE INDEX idx_lease_job_status     ON lease (job_id, status);
```

Os três índices são os três caminhos de leitura do despacho, na ordem em que
ele os percorre: o trabalho já tem dono? o runner ainda tem vaga? o projeto
ainda tem vaga?

**O runner não é escopado a um projeto.** O pareamento é só identidade;
`projeto_id` é declarado a cada pedido de lease. Um runner físico pode servir
projetos diferentes ao longo do tempo, e nada nos critérios de aceite pede o
contrário.

Nada é apagado, nem lease morta: ela vira `expirada` com o motivo gravado e
continua na tabela. É o mesmo append-only da [D15](../../DECISOES.md) — e é o
que permite cruzar "runner × leases perdidas" sem ter que reconstruir nada,
agora que a telemetria do `t102` está no lugar (tabela `event`, migração
`0003`) e que a `t196` ligou a emissão: a morte de cada lease está na tabela
**e** no log.

---

## 2. Ciclo de vida da lease

```
                      liberar (o dono terminou, bem ou mal)
   ativa ──────────────────────────────────────────────────▶ liberada
     │
     │ expires_at vence sem heartbeat, e alguém pede trabalho
     ▼
  expirada  (expiration_reason: ttl_elapsed | heartbeat_lost)
```

Uma lease nasce `ativa`, com `heartbeat_at = granted_at` e
`expires_at = granted_at + ttl_seconds`. Cada heartbeat empurra `expires_at`
para frente e carimba `heartbeat_at`.

Só há duas saídas, e nenhuma delas volta:

- **`liberada`** — o dono avisou que terminou. A capacidade volta na hora: o
  próximo pedido do mesmo runner/projeto já não conta esta lease no teto.
- **`expirada`** — o prazo venceu e ninguém renovou.

### O vocabulário de `expiration_reason`

Os dois motivos descrevem óbitos diferentes, e a diferença é operacionalmente
útil — um aponta para trabalho que não começou, o outro para trabalho
interrompido no meio:

| Motivo | Quando | O que significa |
|---|---|---|
| `ttl_elapsed` | `heartbeat_at == granted_at` | A lease **nunca** foi renovada. O runner pode nem ter começado. |
| `heartbeat_lost` | `heartbeat_at > granted_at` | Foi renovada ao menos uma vez e então calou. Runner morreu no meio do trabalho. |

Os dois nomes são exatamente os de `data.reason` em
[`lease.expired.schema.json`](../../especificacoes/eventos/schemas/lease.expired.schema.json):
desde a `t196` cada lease que morre grava o evento com o mesmo motivo que a
coluna guarda, sem tradução — um evento por lease, mesmo quando a varredura
mata várias de uma vez.

### `reason` de recusa ≠ `expiration_reason`

São dois vocabulários distintos e vale não confundi-los. `expiration_reason` é
o nome de fio **e**, desde o quarto filho da D20 (`t229`, que renomeou
`motivo_expiracao`), o da coluna: por que uma lease morreu. `reason` é campo de
resposta de
`POST /v1/leases`: por que um pedido **não virou** lease
(`job_already_leased`, `runner_cap`, `project_cap`).

---

## 3. Conceder é um passo só

`POST /v1/leases` faz cinco coisas, e faz todas dentro de **uma** transação
síncrona, sem nenhum `await` no meio:

```
reivindicar toda lease ativa cujo prazo venceu   ← trabalho de runner morto volta à fila
        ↓
o trabalho já tem dono ativo?     → 200 {lease: null, reason: "job_already_leased"}
        ↓
o runner já bateu runner_cap?     → 200 {lease: null, reason: "runner_cap"}
        ↓
o projeto já bateu project_cap?   → 200 {lease: null, reason: "project_cap"}
        ↓
gravar a lease                    → 201 {lease}
```

**Por que uma transação só.** Entre contar as leases ativas e gravar a nova há
uma janela; se ela existir, N pedidos simultâneos contam todos o mesmo número,
todos se acham dentro do teto, e todos gravam. O teto de concorrência viraria
uma sugestão. A garantia é a mesma — e no mesmo formato, `db.transaction()`
síncrona — que `aplicarProposta` usa no `t101`.

**Provado com dois runners de verdade.** Até a `t164` todo teste de teto
chamava o repositório ou a rota **em processo**, um chamador de cada vez: a
garantia acima era propriedade do código que ninguém tinha visto acontecer.
[`multi-runner-fleet.e2e.test.ts`](../../packages/runner/test/controller/multi-runner-fleet.e2e.test.ts)
põe dois `Controller` independentes, com credencial cada um, disputando a mesma
fila pelo endereço IPv4 real da máquina — e cobra as três consequências: nenhum
trabalho despachado duas vezes, nenhum dos dois runners deixado de fora, e o
teto de projeto sem nunca somar acima do configurado, mesmo sob pedidos
concorrentes de clientes distintos. O teto é do **projeto**, não do runner: a
contagem de `teto_projeto` não filtra por `runner_id`, e é por isso que ela
segura a frota inteira e não cada máquina em separado.

**Por que reivindicar é o primeiro passo, e não uma rotina à parte.** Quem pede
trabalho é exatamente quem tem interesse em descobrir que uma lease morreu. Na
mesma transação, o pedido que encontra a lease vencida é o pedido que a
substitui — não existe instante em que o trabalho está livre e ninguém
percebeu. É por isso que não há rota de varredura: um gatilho que rode sem
ninguém pedir trabalho só é útil quando houver consumidor concreto (a tela do
`t107`, ou um projeto com todos os runners ociosos), e aí é aditivo.

**Recusa não é erro.** Teto batido e trabalho com dono devolvem `200` com
`{lease: null, motivo}`, não `409`. Do ponto de vista do runner isso é "agora
não, tenta o próximo candidato" — o caso comum de um pool saudável, não a
exceção.

---

## 4. O controller, do lado do runner

Um `tick()` é uma passada completa do loop de despacho:

```
GET /v1/jobs → filtra bloqueado === false
        ↓
para cada candidato, em ordem: POST /v1/leases
        ↓ (recusa por trabalho_ja_leased: tenta o próximo)
        ↓ (recusa por teto_runner ou teto_projeto: encerra o tick)
lease concedida
        ↓
arma o heartbeat periódico  ─────────────┐
        ↓                                │ POST /v1/leases/:id/heartbeats
   despachar(trabalhoId)                 │ a cada ttl/3
        ↓ (resolve OU rejeita)  ◀────────┘
para o heartbeat + POST /v1/leases/:id/liberacoes
        ↓ (resolveu bloqueado: tenta o próximo candidato, na MESMA passada)
```

Quatro decisões de projeto sustentam esse desenho:

**Nem toda recusa quer dizer a mesma coisa (`t208`).** O `motivo` da recusa é
que decide se o loop continua. `trabalho_ja_leased` é sobre a posse **daquele**
trabalho — outro runner chegou antes —, não diz nada sobre o próximo candidato,
e é a resposta comum de um pool saudável: tenta o seguinte. `teto_runner` e
`teto_projeto` são sobre **capacidade**, e a capacidade é deste runner ou deste
projeto, não deste trabalho: todo candidato restante da mesma passada voltaria
com a resposta idêntica. O tick termina ali. Antes da `t208` ele seguia
perguntando, e um projeto cheio custava um `POST /v1/leases` por candidato para
ouvir de novo o que o primeiro já tinha dito. Encerrar cedo não é desistir — o
loop pergunta de novo no próximo intervalo, e até lá alguma lease pode ter sido
liberada ou vencido.

**A lease é sempre devolvida.** A liberação está em `finally`, não no caminho
feliz: um despacho que estoura devolve a lease exatamente como um que termina
bem, e só então o erro sobe para quem chamou. Lease presa por trabalho que
falhou é capacidade ocupada por ninguém até o TTL vencer — pior que os dois
casos que ela pretendia cobrir.

**Heartbeat que falha não derruba o despacho.** Uma falha isolada de rede é
passageira; a consequência de várias seguidas já é a correta e automática — a
lease expira no server e o trabalho volta à fila. Abortar a sessão na primeira
falha trocaria um soluço de rede por trabalho perdido. O erro fica visível em
`ultimoErroDeHeartbeat`.

**O intervalo default é `ttl/3`**, ou seja, folga para duas batidas perdidas
antes de o servidor dar o runner por morto. Quem passa `intervaloHeartbeatMs`
explícito assume a conta: um intervalo maior que o TTL deixa a própria lease
expirar debaixo do despacho.

`despachar` é um **callback injetado** e é a única costura com o
[`EngineAdapter`](../formatos/engine-adapter.md) (`t104`): esta camada não abre
sessão nenhuma. Quem fechar o ciclo com sessão de verdade (`t106`/`t109`) passa
o adapter por aqui sem tocar no controller.

**Um processo, uma sessão por vez — e a flag diz isso (`t208`).** O `tick()`
pede **uma** lease por passada e espera o despacho inteiro antes de a passada
seguinte existir: um processo de runner nunca segura mais de uma lease ativa.
`--declared-runner-cap` (`teto_runner` no pedido, `runnerCap` nas opções) é o
teto que este runner **declara** ao control plane para o próprio `runner_id`, e
não a concorrência dentro do processo — o server tira o MENOR entre ele e o teto
configurado (`CARTOGRAFO_LEASE_CAP_RUNNER`) e é quem impõe o resultado (D1). Até
a `t208` a flag se chamava `--runner-cap` e o `--help` prometia "simultaneous
sessions of this runner", o que nunca foi verdade. Escalar continua sendo
**horizontal**: mais processos de runner sob o mesmo projeto, disputando o teto
de projeto pela transação do server — o caminho que
[`multi-runner-fleet.e2e.test.ts`](../../packages/runner/test/controller/multi-runner-fleet.e2e.test.ts)
já prova (§3). Rodar N sessões dentro de um processo foi recusado pelo founder
na `t208`, e continua reversível por outra decisão se a necessidade aparecer
concreta.

### Falha antes da sessão bloqueia, não retenta para sempre (`t252`, `t270`, `t272`)

Um despacho faz cinco leituras **antes** de pegar worktree e abrir sessão: o
trabalho, a versão de grafo, a rota do engine, o ambiente de executor e a skill
fixada pelo nó. **Sete** falhas do caminho até a sessão se reproduzem
**idênticas** em toda retentativa:

| Causa | De onde vem |
|---|---|
| `graph_version_id` pendurado | `GET /v1/graph-versions/:id` responde 404 |
| engine sem rota neste runner | tabela `engines` do despacho não tem o nome |
| skill fora do registro | `GET /v1/skills/:id?version=` responde 404 |
| pin que parou de casar | hash registrado ≠ hash declarado pelo nó (D4) |
| placeholder que não resolve | `{{input.<caminho>}}` sem valor na entrada do nó |
| banco de testes ilegível (`t270`) | `git` recusou no caminho configurado |
| política de permissão que o engine não sabe aplicar (`t272`) | `startSession` estoura `SessionStartError` com o prefixo `permission policy unsupported: `, antes do spawn |

A sexta chegou com a `t270`, junto com a leitura que a produz — o ambiente de
executor da seção logo abaixo.

A sétima é a única que acontece **depois** do worktree, dentro do
`startSession` — e é a que a corrida do `t109` colheu ao vivo: o nó
`testar-alpha` declarava `rede` por domínio, o adapter `claude-code` não tem como
expressar isso, e o despacho estourou **38 leases em dois minutos** sem abrir uma
única sessão ([nota](../../notas/2026-08-17-t109-feature-do-jogo.md), buraco 2).
Determinística no sentido forte: a mesma skill, no mesmo hash, pede a mesma
política e recebe a mesma recusa em todo tick. O motivo do bloqueio cita a
mensagem do adapter **literalmente**, porque o campo a corrigir é o que
`engine/permission-policy.ts` nomeia.

As outras três causas de `SessionStartError` **não** entram nessa lista: as duas
formas de falha de spawn não carregam nada que distinga um binário que não existe
de um `EMFILE` momentâneo, e a recusa de resume do codex é inalcançável hoje.
Elas caem no teto da subseção abaixo, que é uma afirmação estritamente mais
fraca — e mais segura.

Até a `t252` as cinco primeiras **estouravam**; a sétima, até a `t272`. O erro
subia do despacho, subia do `tick()`, e o loop do `cartografo-runner run` fazia a
única coisa que sabe fazer com um tick que falhou: escrevia uma linha no stderr e
perguntava de novo no intervalo seguinte (`--interval-ms`, dois segundos por
padrão). Como nada tinha marcado o trabalho, `GET /v1/jobs` devolvia o
**mesmo** trabalho na cabeça da fila, a lease era concedida de novo, e o
despacho caía no mesmo erro — para sempre, sem linha em `pergunta`, sem
`bloqueado`, sem nada na caixa de entrada. E, como o `tick()` termina na
primeira lease da passada, nenhum outro trabalho do projeto era tentado
enquanto esse estivesse na frente.

Agora essas sete **bloqueiam o trabalho** com um motivo que nomeia a causa —
`POST /v1/jobs/:id/blocks`, ator `sistema/runner`, o mesmo mecanismo que os dois
bloqueios que o despacho já fazia por conta própria. Nada de novo é inventado:
como `GET /v1/jobs` filtra `bloqueado === false`, um trabalho bloqueado
simplesmente deixa de ser candidato, e é esse filtro — nenhuma escrita a mais —
que transforma "para sempre" em "uma vez". Quem desbloqueia é uma pessoa, pelo
`POST /v1/jobs/:id/unblocks` de sempre, depois de corrigir o que o motivo aponta.

Três limites que fazem parte da decisão:

**Só essas sete.** Qualquer outro erro da mesma janela — 500, 502, 503, timeout
de rede, o 404 da leitura do **próprio trabalho** — continua estourando, e
continua sendo retentado no intervalo seguinte (com teto, desde a `t272`: ver a
subseção abaixo). Um control plane fora do ar passa sozinho; bloquear um trabalho
por causa dele na primeira vez seria pedir a uma pessoa que desfaça um soluço na
mão. É por isso que a classificação é um módulo puro e fechado
(`packages/runner/src/dispatch/pre-session-failure.ts`): a fronteira é o conteúdo
do arquivo, e uma causa nova é decisão de outra ficha — foi exatamente assim que
a sexta entrou (`t270`): uma leitura pré-sessão nova apareceu, a recusa dela se
reproduz em toda retentativa, e causa que ninguém classifica é laço que ninguém
vê.

**O `tick()` segue na mesma passada.** Um bloqueio não é capacidade recusada nem
trabalho feito: a lease já voltou pelo `finally` de sempre, e o candidato
seguinte é tentado imediatamente, sem esperar o próximo intervalo. Se todos os
candidatos bloquearem, a passada devolve `null`, exatamente como a passada que
não ganhou lease nenhuma.

**Nada abre.** O bloqueio das seis primeiras acontece antes de
`worktrees.acquire`, então não há árvore para devolver, não há
`POST /v1/sessions`, não há processo de engine e não há token gasto. A sétima
acontece com a árvore já na mão: ela é devolvida (retida, como em toda saída de
erro) antes de o bloqueio ser postado, e mesmo assim nenhuma sessão existe para
o control plane. Falha **depois** que a sessão subiu é outro assunto — o da seção
seguinte, que a `t265` fechou.

#### E o que ninguém sabe classificar tem teto (`t272`)

O limite acima é honesto e, sozinho, insuficiente: tudo que o classificador
responde `null` continuava retentando **para sempre**. Um 5xx teimoso, um
`git worktree add` que falha porque o disco encheu, um `SessionStartError` de
spawn — nenhum deles se prova permanente, e nenhum deles tinha fim.

Agora as três janelas que podem falhar antes de existir sessão passam por uma
decisão só (`packages/runner/src/dispatch/pre-session-retry.ts`): a leitura
pré-worktree, o `worktrees.acquire` — que até esta ficha não estava sob `catch`
nenhum — e o `SessionStartError` do `startSession`. A regra é a mesma nas três:

1. classificou (as sete acima)? bloqueia na **primeira**, como sempre;
2. não classificou e a sequência está **abaixo** do teto? estoura, e o tick
   seguinte tenta de novo — comportamento idêntico ao de antes;
3. não classificou e **alcançou** o teto? bloqueia com um motivo que nomeia o nó,
   a contagem e a mensagem do erro, que é a única evidência que existe.

O teto é `maxConsecutivePreSessionFailures` nas opções do despacho, **5** por
padrão; valor que não seja inteiro positivo cai no padrão, mesma postura dos
orçamentos de tempo. Uma sessão aberta (`POST /v1/sessions` respondido) zera a
contagem do trabalho: chegar a uma sessão é o sinal de que ele destravou.

**A contagem é do processo do runner, e isso é uma decisão com custo.** Ela vive
num `Map` em memória, dentro do closure que `createClaudeCodeDispatch` devolve, e
**não** é o mesmo fato que `consecutive_failures` do `job.blocked`: aquele conta
**sessões** `failed` do par `(trabalho, nó)` e mora no control plane justamente
porque atravessa leases e processos (`t265`, seção acima). Uma falha pré-sessão
não cria linha em `sessao` nenhuma — não há o que aquela consulta veja —, e
inventar uma faria a tabela mentir sobre o que rodou. Construir um contador
paralelo no core custaria coluna, evento e rota novos para um fato que o
incidente relatado não precisa: o laço medido aconteceu dentro de **um** processo
de runner, em dois minutos.

O que se abre mão está escrito, não varrido para baixo do tapete: a sequência
**não sobrevive a um restart** do runner, e dois runners contam cada um a sua.
Os dois erram para o mesmo lado — o trabalho retenta *mais* que o teto, nunca
menos —, que é a direção segura de errar.

### O ambiente de executor: o que só a máquina sabe (`t270`)

Um despacho monta a entrada do nó a partir de **duas** fontes, e a divisão entre
elas é o assunto inteiro desta seção: quem responde por cada chave.

| Chave | Quem fornece | Por quê |
|---|---|---|
| `input.job`, `input.project`, os baldes de `produces`, `input.perguntas_respondidas`, `input.traversal` | **control plane**, por `GET /v1/jobs/:id/context` | Tudo isso é projeção de tabelas que só o escritor único escreve (D1). |
| `input.project.aplicacao`, `input.project.arquivos_de_registro` | **`project` do grafo** | Configuração **estática** da classe: versionada com o documento, proponível e reversível como qualquer outra parte dele ([grafo.md](grafo.md)). |
| `input.banco_de_testes.*`, `input.referencia.*` | **runner**, por [`resolve-executor-environment.ts`](../../packages/runner/src/dispatch/resolve-executor-environment.ts) | Um caminho de sistema de arquivos e um commit vivo. Nenhum dos dois é dado de grafo, e nenhum dos dois sobrevive a ser armazenado. |

A terceira linha é a que a `t270` abriu. `banco_de_testes.caminho` nomeia um
diretório de **uma** máquina — gravado numa versão de grafo, estaria errado para
todo runner menos um — e `referencia.commit` é ponteiro vivo, velho no instante
em que qualquer coisa o guarda. Então os dois vêm do processo que está prestes a
abrir a sessão, por uma costura ao lado da `resolveInput`
(`ClaudeCodeDispatchOptions.executorEnvironment`), e são fundidos na entrada
resolvida logo antes de o manifesto renderizar:

```
input = { ...projetado_pelo_control_plane, ...ambiente_do_executor }
```

**O executor ganha na colisão**, e isso não é desempate por conveniência: ele é
verdade local sobre um sistema de arquivos e um `HEAD` que a projeção não tem, e
uma projeção que carregasse a mesma chave estaria carregando cópia velha dela.
Ausente contribui `{}` e não muda nada — que é o caso comum: um runner de bets
não tem banco de testes, nem tem qualquer implantação que ainda não montou um.

Os dois modos de `referencia.modo` são vocabulário do manifesto
(`implantar-release.json`), não invenção do runner, e cada um é lido de um jeito:

- **`instalacao_em_uso`** — `git rev-parse HEAD`, **uma vez**, memoizado pela
  vida do processo. É afirmação sobre ESTE processo, e reler depois afirmaria
  algo sobre um processo que já não existe. O `lido_em` é memoizado junto: o
  campo diz quando a referência foi lida, e recarimbá-lo reclamaria um frescor
  que o valor não tem.
- **`ponta_do_principal`** (padrão) — `git rev-parse <--main-branch>`, **a cada
  chamada**. É fato sobre o repositório, e ele anda a cada integração.

Quatro flags configuram tudo isso, nenhuma obrigatória: `--test-bench-path`
(padrão: o mesmo `--working-dir`), `--reference-mode` (padrão
`ponta_do_principal`), `--reference-repo` (padrão: o banco) e `--main-branch`
(padrão `main`).

**Leitura, e só leitura — desta camada.** Nada em
`resolve-executor-environment.ts` escreve no banco de testes, avança branch nem
prepara checkout: `git rev-parse` e mais nada. Ela assume um caminho e um commit
que já existem e apenas os lê. Um `git` que recusa aqui bloqueia o trabalho com
motivo (a sexta causa da tabela acima) em vez de resolver um valor plausível: uma
sessão que verificasse contenção contra um commit que ninguém escolheu é pior que
uma que não abriu. Quem mantém esse banco **verdadeiro** — quem avança a linha
principal para dentro dele e quem o prepara — é a `t273`, na seção logo abaixo:
até ela, essa leitura observava um diretório que ninguém nunca movia.

### Advancing the main line into the bench (`t273`)

*(This subsection is in English per the 2026-08-18 language rule; the sections
around it are the pre-existing Portuguese of this document.)*

`integrar-branch`'s manifest has always promised this — "você nunca executa o
merge final; ... é o executor quem avança a linha principal" — and until `t273`
nobody kept the promise. The t109 game run is the evidence: the session reported
`merge_commit ae41796` with every gate green, the bench's `main` stayed on the
commit before it, and a person typed `git merge --ff-only ticket-1` by hand
before `testar` could open
([nota](../../notas/2026-08-17-t109-feature-do-jogo.md), gap 3).

**What triggers it is the shape of the report, never a node id.** Any node whose
ACCEPTED report carries a non-empty `merge_commit` advances the bench — the field
is the contract (D9), so a second graph whose integration node declares the same
output is covered with no runner change at all. The gate is the same one the
transition already runs under: a resolved node, a session that completed, no
question pending, no retained worktree, and a report the control plane took.

**The bench moves before the work does**, and the two live in one function
([`report.ts`](../../packages/runner/src/dispatch/report.ts)'s `advance`) so that
the order is structural rather than remembered: there is no way to transition a
job whose bench did not move. The step itself is
[`advance-main-line.ts`](../../packages/runner/src/dispatch/advance-main-line.ts),
and it is exactly three commands, in this order:

| # | Command | When |
|---|---|---|
| 1 | `git -C <banco> rev-parse --abbrev-ref HEAD` | always — it has to be on the main branch, and a detached `HEAD` is refused by the same comparison |
| 2 | `git -C <banco> fetch <--working-dir> <merge_commit>` | only when the bench is not the working directory itself: the commit lives in the object store of the repository the session's worktree was cut from |
| 3 | `git -C <banco> merge --ff-only <merge_commit>` | always |

Then, and only then, one optional shell command in the advanced bench —
`--bench-install-command`. Absent it contributes nothing, the same posture
`comandos_de_dados` already has; the class declares its own spelling of it in the
graph's `project.comando_instalacao` (`npm ci` for this repository), and the flag
is where an operator points the runner at it. It comes from the command line and
never from a graph document: it runs with the runner's own privileges.

**Fast-forward or nothing.** A bench on another branch, a history that diverged
and an install command that exits non-zero all fail closed, and none of them is
worked around: no rebase, no `--force`, no picking a side, and — a project-wide
rule that applies doubly to a directory every integration touches — never a
`git stash`. Reconciling two histories is `integrar`'s job, in a worktree of its
own, with a session behind it.

**A refusal stops the work; it does not throw.** Same reading `t252` and `t265`
wrote down: a `git` that refuses here refuses identically on every retry, so a
throw would buy the same answer every couple of seconds forever with nothing in
anybody's inbox. The runner posts `POST /v1/jobs/:id/blocks` with the command and
what it printed (`blockForMainLineAdvanceFailure`, the sixth block of
[`blocks.ts`](../../packages/runner/src/dispatch/blocks.ts)), the job stays on
its node, and the dispatch resolves `{blocked: true, reason}`.

### Falha depois que a sessão subiu também para (`t265`)

A `t198` levou uma tese real ao nó `triagem` do grafo de bets e colheu **quatro
sessões recusadas em sequência** antes de a quinta funcionar: `stop_reason:
"refusal"`, `stop_details.category: "reasoning_extraction"`, saída 1, zero
tokens de saída e ~23k tokens de cache queimados em cada uma
([nota](../../notas/2026-08-17-primeira-execucao-bets.md)). Nada no sistema
contava nada: o trabalho voltava para a fila, ganhava lease de novo e abria a
sessão seguinte. Quem parou o laço foi o operador olhando o log.

São **dois** buracos, e eles se fecham de lados diferentes da API.

**A recusa é reconhecida, e para na primeira.** O adapter passou a ler
`stop_reason`/`stop_details.category` do frame `result` terminal e a reportar
`failureKind: 'engine_refusal'` + `refusalCategory` no `SessionFinishDetail` —
campos ao lado do status, e não um sétimo `SessionStatus`: a interface está
congelada em v1 e a forma já existia (`timed_out` + `timeout_reason`). O
despacho, ao ver esse `failureKind`, chama `blockForEngineRefusal`
(`packages/runner/src/dispatch/blocks.ts`) e devolve `{blocked: true, reason}` em
vez de estourar `DispatchError`. É decisão **do runner**, tomada sem leitura
nenhuma, porque o `onFinished` já entregou o fato — mesma postura das cinco
falhas pré-sessão acima. Recusa é determinística: retentar compra a mesma
resposta de novo.

**A falha comum tem teto, e quem conta é o control plane.** Uma sessão que
morreu não tem sinal nenhum que a distinga de uma que morreria de novo, então
ela continua estourando e continua sendo retentada — o que mudou é que a
**sequência** agora tem fim. Ao fechar uma sessão `failed`,
`PATCH /v1/sessions/:id/finish` conta, dentro da sua própria transação, as
sessões finais do par `(trabalho, nó)` da mais recente para trás, parando na
primeira que não falhou; alcançado o teto, o trabalho é bloqueado com o motivo
nomeando o nó e a contagem, e o evento `job.blocked` carrega
`consecutive_failures`. Isso mora no control plane (`repositories/job.ts`) e não
no runner porque a sequência **atravessa leases e processos** — o runner que
despacha a quarta tentativa pode nunca ter visto as três primeiras (D1).

O teto é do documento de grafo: `max_consecutive_failures` na raiz, ausente
significando **3** (`docs/spec/grafo.md` §1). Três detalhes que fazem parte da
decisão:

- **Uma sessão que funcionou zera a sequência.** A contagem é de cauda: falhou,
  falhou, funcionou, falhou é *uma* falha atrás de si, não três.
- **Recusa não entra na conta.** Ela já foi bloqueada pelo runner na primeira
  ocorrência, e contá-la aqui também colocaria dois donos na mesma bandeira —
  que é como um trabalho acaba bloqueado sem nada pendente.
- **Trabalho já bloqueado não é bloqueado de novo.** O motivo que a pessoa está
  lendo é o primeiro; sobrescrevê-lo esconderia a causa atrás de um sintoma.

O que continua em aberto, e está registrado como fora de escopo: se o runner
morrer entre o `PATCH /finish` e o `POST /blocks` da recusa, o trabalho fica
arrendável por mais uma sessão — que, sendo recusada também, bloqueia pela
**própria** primeira ocorrência. O custo é uma sessão a mais, não o laço
infinito.

### Relato recusado pelo control plane segura o trabalho no nó (`t268`)

A terceira forma de um despacho parar um trabalho por conta própria, e a
primeira cujo fato **vem de uma leitura**: as outras duas o runner decide
sozinho, com o que já tem na mão.

Desde a `t253` o `PATCH /v1/sessions/:id/finish` confere o `output` relatado
contra o schema `output` da skill que o nó pina — resolvendo `no_id` + o
`graph_version_id` do trabalho até a linha `(id, version)` do registro — e,
quando recusa, grava `null` na coluna e a lista de motivos em
`output_schema_error` no evento. Fechar a sessão nunca é impedido por isso: o
auto-relato de um nó de trabalho nunca foi evidência, e perder o **fim** da
sessão por causa dele deixaria a sessão aberta para sempre.

O que ninguém fazia era **ler esse veredito**. O runner descartava a resposta do
`/finish` — só a falha de escrita sobrevivia — e decidia a rota reparseando, por
conta própria, o mesmo bloco `` ```resultado `` que o control plane acabara de
julgar. Duas leituras do mesmo relato, nunca comparadas: um relato recusado
movia o trabalho pela aresta assim mesmo, e o nó seguinte recebia uma projeção
de `input` sem nada dentro — o buraco 2 da
[segunda travessia de bets](../../notas/2026-08-17-segunda-execucao-bets.md).

**O veredito passou a viajar na resposta.** `PATCH /finish` responde a projeção
da sessão mais `output_accepted` (sempre) e `output_schema_error` (só na
recusa). Só essa resposta: `GET`/`POST /v1/sessions*` continuam devolvendo o que
`toWireSession` monta, porque *por que* um relato foi recusado é telemetria do
log e não parte da sessão — o que mudou é a única pergunta que alguém precisa
responder **de forma síncrona**, no instante em que decide se o trabalho anda.
Não há coluna nova e não há migração: o veredito é calculado onde a conferência
já acontecia e entregue a quem precisa dele.

**E o despacho obedece.** Com `output_accepted: false`, ele chama
`blockForOutputSchemaRefusal` (`packages/runner/src/dispatch/blocks.ts`) e não
chama `advance` — vale igual para nó de saída única e para portão, porque o que
é barrado é a chamada inteira e não a escolha de aresta dentro dela. O motivo do
bloqueio nomeia o nó, a sessão e **todos** os problemas do schema, pela mesma
razão que `output_schema_error` carrega a lista inteira: quem desbloqueia tem de
arrumar o relato, e uma lista cortada é uma segunda rodada da mesma conversa.

**Para na primeira recusa**, como a recusa de engine acima. O que foi recusado é
a **forma** do relato, e uma segunda sessão recebendo exatamente o mesmo prompt
está sendo convidada a produzir a mesma forma de novo. Retentar com os problemas
anexados ao prompt é alternativa real e é ficha de outro dono: pede contagem de
tentativas atravessando despachos e uma segunda decisão sobre quantas bastam.

**Um dono por bandeira, e uma ordem entre os dois bloqueios.** Nenhum dos dois
dispara sobre um trabalho que uma pergunta já parou — escalação ordinária já é
bloqueio, posto pelo control plane na mesma transação de `input_request.created`.
E
entre eles a recusa vem primeiro: relato recusado é o fato mais fundamental que
árvore suja — não há resultado sobre o qual commitar coisa alguma —, e a mesma
regra que proíbe um segundo dono proíbe postar os dois.

O que fica em aberto, e está registrado como fora de escopo: o rótulo de rota
(`resultado`) e o vocabulário do schema `output` da skill (`outcome`,
`evidencia`) continuam sendo duas palavras para um conceito só — é a `t269`; e
`announceFinishedExecution` (`t262`) segue anunciando uma rodada terminada só
por `current_node_id` contra `final_nodes`, sem olhar o veredito.

### Toda chamada tem prazo (`t193`)

O control plane fora do ar responde, e cada método do cliente já sabe o que
fazer com a resposta. O caso que faltava é outro: um control plane que **aceita
a conexão e não escreve nada** — um processo travado, um proxy que segurou a
requisição. Sem prazo, a chamada espera para sempre, e com ela o `tick()` que a
fez, o loop que espera o tick e o desligamento que espera o loop.

Desde a `t193` existe um único mecanismo HTTP para todo cliente do runner
([`http-client.ts`](../../packages/runner/src/controller/http-client.ts)), e ele
faz três coisas: põe um prazo em toda requisição, lê o **status antes** de
decodificar o corpo (a disciplina da `t156`, agora num dono só — quem responde
um erro nem sempre é o control plane, e um 502 em HTML não pode virar
`SyntaxError` cru) e devolve o erro que **quem chamou** construiu.

| Prazo | Default | Quem configura |
|---|---|---|
| Qualquer chamada ao control plane | 30 s | `--request-timeout-ms` |
| Batida de heartbeat | o próprio intervalo do heartbeat (`ttl/3`) | derivado, não configurável |

O heartbeat tem prazo mais curto porque tem uma janela natural: quem o arma sabe
de quanto em quanto tempo a próxima batida vence, e uma batida ainda no ar
quando a seguinte vence já não renova nada. Pela mesma razão, **uma batida que
não voltou é pulada, nunca sobreposta** — senão um control plane travado
acumularia uma requisição aberta por intervalo, a sessão inteira. Pular custa
uma batida, e o TTL já tolera duas.

Chamada que estoura o prazo rejeita com o `TimeoutError` do
`AbortSignal.timeout`, sem tipo novo para ninguém capturar. Nada é retentado
aqui: o tick falho é registrado e o loop pergunta de novo no próximo intervalo,
que é o mecanismo de retentativa que já existia.

### Parar sempre termina, e não deixa sessão órfã (`t193`)

Parar um runner é um pedido, e ele tem três estágios:

1. **Primeiro SIGINT/SIGTERM.** O loop para de **agendar**: nenhum tick novo
   nasce. O despacho em voo continua — matar uma sessão viva de fora deixaria um
   processo escrevendo na worktree sem ninguém para relatar o que ele fez.
2. **A carência.** `--shutdown-grace-seconds` (default **120 s**) é quanto esse
   despacho tem para terminar sozinho. Esgotada, a sessão viva é cancelada.
3. **Segundo SIGINT/SIGTERM.** Não espera nada: cancela na hora.

Cancelar reusa o caminho que o despacho já tinha para um fim conduzido pelo
adapter — `cancelled` vira `travada` na taxonomia, a **worktree é preservada**
(sessão cancelada não concluiu), a lease volta pelo `finally` do controller e o
erro final é o `DispatchError` que o loop já registra. Nada novo é escrito sobre
"como uma sessão cancelada é encerrada": só passou a existir mais um chamador do
que já existia.

Abaixo disso, cada adapter registra um `process.on('exit')` enquanto tem sessão
viva e sinaliza SIGTERM ao grupo do processo na saída. É a rede de segurança
para as saídas que os três estágios acima não cobrem — uma exceção não capturada
em outro lugar, um `process.exit()` seco. É SIGTERM e só: `'exit'` é o último
turno síncrono do processo, não sobra event loop para escalar para SIGKILL cinco
segundos depois.

**O limite honesto continua limite:** um `SIGKILL` no próprio runner não roda
JavaScript nenhum, o `'exit'` não dispara, e nada dentro deste processo impede
esse órfão. O que existe contra ele é a lease vencendo no server e o trabalho
voltando para a fila (D5).

### Zero acesso ao banco

Nada em `packages/runner` importa driver de SQLite ou qualquer módulo de
`packages/core/src/db`. A regra é verificada estaticamente por
[`scripts/check-single-writer.mjs`](../../scripts/check-single-writer.mjs), que
roda no lint sobre o repositório inteiro, e é exercida no teste fim a fim: o
control plane sobe como **processo separado**, e a única superfície entre os
dois é a porta HTTP.

E, desde a `t143`, em outra **máquina**: [`cross-machine-dispatch.e2e.test.ts`](../../packages/runner/test/controller/cross-machine-dispatch.e2e.test.ts)
sobe o binário com `CARTOGRAFO_HOST=0.0.0.0`, alcança-o pelo endereço IPv4 real
da interface (não `127.0.0.1`) e roda o ciclo inteiro — concessão, heartbeat,
liberação — apresentando **só** a credencial que o pareamento emitiu. É o que
transforma o `CARTOGRAFO_HOST` configurável da `t124` em caminho provado, e não
em opção que ninguém nunca exercitou. Onde a máquina não tem interface IPv4
externa, o teste pula em vez de falhar: o que ele reportaria ali é a ausência de
rede, não uma regressão.

---

## 5. Endpoints

Todos sob `/v1` e, desde a `t124`, todos exigem `Authorization: Bearer <token>`
— o runner apresenta uma credencial em toda chamada, como qualquer outro cliente
da API. Desde a `t196`, conceder grava `lease.granted` e cada lease que a
varredura mata grava um `lease.expired`, ambos na transação que escreve a linha.
O que continua sem rastro é a **liberação** normal, e por falta de tipo na
taxonomia — o item que sobrou na §7.

Desde a `t143` a credencial do runner é **dele**, emitida no pareamento, e a
coluna "quem chama" abaixo é contrato, não convenção: quem pareia, revoga e
enxerga a frota inteira é o operador (credencial `usuario`), e o runner só
alcança as quatro rotas do próprio despacho mais `GET /v1/jobs`. A lista de
rotas do runner é literal ([`auth.ts`](../../packages/core/src/auth.ts)): rota
nova nasce fora dela, e é assim que `GET /v1/runners` é do operador sem que
nada tenha sido escrito para recusá-la — pela mesma porta por onde
`GET /v1/executions` e `GET /v1/sessions` já ficam de fora.

| Método | Rota | Quem chama | O que faz |
|---|---|---|---|
| `POST` | `/v1/runners` | operador | Pareia um runner. `201` na primeira vez — com `token`, a credencial do runner, devolvida uma única vez —, `200` (idempotente) com `token: null` se o `id` já existe. |
| `GET` | `/v1/runners` | operador | Lista a frota com a saúde de cada runner: `active_leases`, `last_heartbeat` (o maior `heartbeat_at` de **qualquer** lease que ele já teve) e `last_expiration` (`{job_id, expires_at, expiration_reason}` da última que venceu, ou `null`). Tudo derivado da tabela `lease`; não existe ping de runner. |
| `POST` | `/v1/runners/:id/revocations` | operador | Revoga toda credencial viva daquele runner. `200 {revoked: <quantas>}`, inclusive `0`: chamar de novo não é erro. |
| `POST` | `/v1/leases` | runner ou operador | Reivindica expiradas e tenta conceder. `201` com a lease, ou `200` com `{lease: null, reason}`. |
| `POST` | `/v1/leases/:id/heartbeats` | runner ou operador | Renova o prazo. Corpo opcional `{ttl_seconds}`; sem ele, mantém o TTL da lease. |
| `POST` | `/v1/leases/:id/releases` | runner ou operador | Encerra a lease e devolve a vaga na hora. |
| `GET` | `/v1/leases` | runner ou operador | Lista, com filtros `project_id`, `runner_id` e `status`. Sem paginação nesta fase. |

### O escopo da credencial de runner

A credencial nasce em `POST /v1/runners` (`201`), no formato do token de
bootstrap: 32 bytes aleatórios em hex, devolvidos uma vez, guardados só como
digest SHA-256. Ela é recusada com `403 out_of_scope_credential` em duas
situações, e a diferença entre elas importa:

- **Fora da lista de rotas** — a lista é literal, em
  [`auth.ts`](../../packages/core/src/auth.ts), e vale para todo o resto da
  `/v1`: propostas, importação de skill, mutação de grafo, o stream de eventos.
  Rota nova não entra por prefixo; entra porque alguém a escreveu ali.
- **Fora da própria identidade** — dentro daquelas rotas, a credencial vale por
  **um** `runner_id`. Pedir lease para outro runner, bater heartbeat ou liberar
  a lease de outro, ou listar as leases de outro, são `403`. `GET /v1/leases`
  sem filtro é preenchido em silêncio com o runner da credencial; com o filtro
  apontando para outro, é recusado.

Revogar (`POST /v1/runners/:id/revocations`) carimba `revogada_em` e nada mais:
o token morto cai no `401 invalid_credential` já na requisição seguinte, junto
com os tokens que nunca existiram. Não há reemissão sob o mesmo `id` — recuperar
o acesso de um runner revogado é pareá-lo com um `id` novo.

Corpo de `POST /v1/leases`:

```json
{
  "runner_id": "runner-a",
  "project_id": 3,
  "job_id": 42,
  "runner_cap": 2,
  "project_cap": 4,
  "ttl_seconds": 30
}
```

Os dois tetos chegam **como parâmetro em cada pedido**, não como configuração
persistida: nenhuma ficha do board cria ainda uma tabela de configuração de
projeto, e inventar uma aqui seria escopo não pedido. O dia em que existir, o
default passa a vir dela e o parâmetro vira sobreposição.

Códigos de erro:

| Situação | Código | `error` |
|---|---|---|
| `id` de runner ausente ou vazio | `400` | `id_required` |
| Campo de pedido ausente ou de tipo errado | `400` | `invalid_body` (com `field`) |
| Filtro de listagem inválido | `400` | `invalid_filter` (com `field`) |
| `runner_id` não pareado (pedido de lease ou revogação) | `404` | `unknown_runner` |
| Lease inexistente | `404` | `unknown_lease` |
| Credencial de runner fora das rotas dela, ou agindo por outro runner | `403` | `out_of_scope_credential` |
| Heartbeat ou liberação sobre lease não `ativa` | `409` | `lease_not_active` (com `status`) |

Recusa por teto ou por trabalho já leased **não** aparece nesta tabela: é `200`
com `motivo`, pelas razões do §3.

Implementação: [`routes/runners.ts`](../../packages/core/src/routes/runners.ts),
[`routes/leases.ts`](../../packages/core/src/routes/leases.ts),
[`auth.ts`](../../packages/core/src/auth.ts),
[`repositories/runners.ts`](../../packages/core/src/repositories/runners.ts),
[`repositories/leases.ts`](../../packages/core/src/repositories/leases.ts),
[`repositories/credentials.ts`](../../packages/core/src/repositories/credentials.ts),
[`controller/`](../../packages/runner/src/controller). Só `src/db/` toca o driver
do SQLite (D1); repositórios e rotas recebem o banco já aberto.

---

## 6. `job_id` é um inteiro opaco

`POST /v1/leases` **não lê a tabela `job`** e não tem FK para ela. A razão
original foi ordem de build (a tabela era entrega do `t102`, que já aterrissou
na migração `0003`), mas o corte permanece pelo motivo de desenho — a mesma
escolha que o `t102` fez para `graph_version_id`. Apertar a FK depois é aditivo, e
cabe à ficha que ligar os dois lados.

A divisão de responsabilidade que isso produz é, aliás, a correta:

- **elegibilidade** (o trabalho está bloqueado? em que nó está?) é decidida por
  `GET /v1/jobs`, consultada pelo controller **antes** de pedir a lease;
- **exclusividade e capacidade** são decididas por `POST /v1/leases`.

---

## 7. O que esta camada ainda não faz

Cada item aqui é escopo declarado de outra ticket, não esquecimento:

- **Nenhum evento para a liberação.** A emissão de
  [`lease.granted`](../../especificacoes/eventos/schemas/lease.granted.schema.json)
  e [`lease.expired`](../../especificacoes/eventos/schemas/lease.expired.schema.json)
  está ligada desde a `t196` — as colunas já carregavam tudo que os dois eventos
  pedem (`runner_id`, `job_id`, `expires_at`, `expiration_reason`), e foi
  mapeamento direto. **O que sobrou é o gap maior:** a taxonomia do `t98` não
  declara `lease.released`, e o reducer de referência
  ([`reconstruir-estado.mjs`](../../especificacoes/eventos/reducers/reconstruir-estado.mjs))
  projeta `leases` só com `active`/`expired`. A tabela tem três estados, então
  ou a taxonomia ganha um `lease.released`, ou a projeção por eventos fica
  cega para o encerramento normal — que é o caso mais comum de todos. Crescer a
  taxonomia é decisão de outra ficha; a `t196` ligou os dois tipos que já tinham
  contrato e não mexeu nela.
- **Abrir sessão de verdade** pelo `EngineAdapter` — `despachar` é callback
  injetado (`t106`/`t109`). **Construído pela `t106`:**
  [`createClaudeCodeDispatch`](../../packages/runner/src/dispatch/dispatch.ts)
  é uma implementação desse callback — abre a sessão, grava `session.opened` e
  `session.finished`, e transforma um pedido de escalação em pergunta pela
  API ([escalacao-humana.md](escalacao-humana.md)). O controller continua sem
  saber que engine existe: nada neste arquivo mudou para isso acontecer, que
  era o ponto da costura. **Fechado pela `t161`:** a instrução do nó vem do
  grafo registrado, não mais de um literal —
  [`resolve-node.ts`](../../packages/runner/src/dispatch/resolve-node.ts) lê o
  snapshot uma vez por despacho e
  [`render-skill-instructions.ts`](../../packages/runner/src/dispatch/render-skill-instructions.ts)
  busca a skill pinada, confere o hash (pin que não bate não despacha, D4) e
  renderiza instruções, contrato do nó, checks e permissões para dentro da
  sessão. As **permissões** declaradas pelo manifesto passaram a valer no
  mesmo movimento. **Fechado pela `t259`:** os dois buracos que sobravam nessa
  mesma costura — a `resolveInput`, que resolvia `{}` e fazia todo placeholder
  falhar fechado, agora lê a projeção de verdade
  ([`GET /v1/jobs/:id/context`](../../packages/core/src/domain/context.ts), pela
  [`resolve-input.ts`](../../packages/runner/src/dispatch/resolve-input.ts)), e
  o nó de trabalho, que recebia um `output_schema` no prompt e nunca era
  ensinado a devolver nada nele, agora fecha o turno com um bloco
  `resultado` ([`result-protocol.ts`](../../packages/runner/src/dispatch/result-protocol.ts))
  que o despacho manda no `/finish` como `output` — que é justamente o que a
  projeção do nó seguinte lê. **Corrigido pela `t267`:** o que uma sessão recebe
  hoje são quatro coisas, e cada uma com o seu rótulo — o corpo do manifesto já
  interpolado, os **valores** que o `input` da skill nomeia (bloco
  `### Valores de entrada`, cortado em 16 KB com marcador e ponteiro para
  `GET /v1/jobs/:id/context`,
  [`render-input-values.ts`](../../packages/runner/src/dispatch/render-input-values.ts)),
  o `contrato` do nó rotulado como documentação, e o `output` da skill pinada
  rotulado como o que o `/finish` confere (D9). Antes disso a sessão via só os
  placeholders que o manifesto tinha lembrado de citar, e era apresentada ao
  `saida_schema` do nó como se fosse o validador — que não é
  ([grafo.md](grafo.md)). O que segue pendente pelo mesmo buraco é o **orçamento
  declarado pela skill**: a `t163` deu à sessão dois cães de guarda (relógio de
  parede e silêncio), com o manifesto declarando `orcamentos` e o runner
  resolvendo pelo menor dos dois
  ([`resolveBudget`](../../packages/runner/src/engine/resolve-budget.ts)), mas
  quem despacha ainda usa o teto do runner — o campo existe no manifesto e
  ninguém o lê para dentro do despacho. É uma linha na mesma costura que a
  `t161` abriu, e cabe à ficha que sentir a dor.
- **Avanço de nó e fim de travessia** — também fechados pela `t161`, e citados
  aqui porque os dois eram lacunas desta camada. Uma sessão que termina limpa e
  não escala faz o próprio POST de transição pela aresta que o grafo manda:
  saída única segue direto, portão com duas ou mais saídas lê o bloco cercado
  `resultado` que a sessão emitiu, e um resultado que não casa com aresta
  nenhuma vira pergunta para gente (`ator.tipo: "sistema"`) em vez de falha. E `listarTrabalhosLiberados` passou a filtrar por `concluido` além de
  `bloqueado`: o campo sai de `GET /v1/jobs` desde a `t152`, derivado do
  `current_node_id` contra os `nos_finais` da versão, e sem lê-lo um trabalho que
  pousava no nó final continuava candidato para sempre — o controller o
  redespachava para o mesmo nó a cada tick.
- **Higiene de ciclo de vida do runner** — **fechada pela `t207`**, e citada
  aqui porque as três metades eram lacunas desta camada. (1) Cada
  `EngineAdapter` solta o estado pesado da sessão assim que ela termina —
  `ChildProcess`, listener do chamador, buffers e timers — guardando só o
  `SessionStatus` terminal por id, que é o que o invariante 3 do contrato
  congelado (`getStatus` responde depois do `onFinished`) exige de fato; um
  runner de vida longa parou de crescer com cada trabalho despachado. (2)
  `GitWorktreeManager.release()` roda `git status --porcelain` antes de
  remover: sessão que termina **concluída mas com árvore suja** tem a árvore
  **retida** e o trabalho **bloqueado** por
  [`POST /v1/jobs/:id/blocks`](../../packages/runner/src/dispatch/dispatch.ts)
  com o caminho da árvore no motivo, e não avança — a premissa antiga ("o que
  foi commitado já vive no histórico do branch") só valia enquanto a sessão
  commitasse, e nada obriga que ela commite. Nenhum campo novo no `/finish`: o
  vocabulário daquela rota é da `t213` (D20). (3)
  [`cartografo-runner prune`](../../packages/runner/src/cli/prune.ts) recolhe o
  que sobra — diretórios `ticket-<id>-<hex>` que o `git worktree list`
  reconhece e branches `ticket-<id>` —, perguntando por trabalho ao control
  plane se ele está `concluido` (D1: o runner pergunta, nunca adivinha).
  `bloqueado` **não** é sinal de fim: trabalho desbloqueado continua do mesmo
  nó, com árvore nova. Branch sai com `git branch -d` e nunca `-D` —
  `concluido` diz que a travessia chegou a um nó final, e não diz nada sobre os
  commits terem sido mergeados —, e uma recusa por "não mergeado" é resultado
  ordinário, reportado e sem efeito no código de saída. **O que continua fora:**
  TTL/expiração para o mapa de status terminais dos adapters, reconciliar
  sozinho uma sessão suja (commitar ou descartar em nome de alguém), saída
  `--json` do `prune` e agendamento embutido dele — quem opera arma o cron por
  fora, mesma postura do resto deste CLI. E `git worktree prune`, do próprio
  git, continua sendo outro comando: ele reconcilia registro órfão de
  diretório apagado à mão, que este aqui não faz.
- **Modo local** (avaliar um diretório sem control plane): não tem schema nem
  critério de aceite escrito em lugar nenhum do repo. Revisitar quando houver
  caso de uso concreto.
- **Tabela de configuração de teto** por runner ou por projeto (§5).
- **Varredura de expiradas dissociada do despacho** (§3). O que a `t164` fechou
  aqui não é o gatilho e sim a **visibilidade**: `GET /v1/runners` (§5) e a
  página `/runners` da tela mostram, por runner, quantas leases ele segura,
  quando foi ouvido pela última vez e qual trabalho perdeu para o TTL — e
  [`multi-runner-fleet.e2e.test.ts`](../../packages/runner/test/controller/multi-runner-fleet.e2e.test.ts)
  cobra o ciclo inteiro com um runner que para de bater. Uma rotina que varra
  sem ninguém pedir trabalho continua sendo escopo de outra ficha.
- **Sinal de vida independente da lease.** `ultimo_heartbeat` e
  `ultima_expiracao` saem só da tabela `lease`: um runner pareado que nunca
  pegou trabalho é, para este control plane, indistinguível de um que está
  fora do ar. Um ping de runner é aditivo, e cabe à ficha que sentir a dor.
- **WIP limit por estágio do grafo** — aqui só existe o teto bruto de sessões
  concorrentes.
- **Reemissão de credencial para um `id` já pareado.** A `t143` fechou a
  emissão no pareamento e a revogação (§5), mas só o caminho do `201` emite:
  runner revogado ou que perdeu o token volta pareando um `id` novo. Uma rota de
  rotação é aditiva, e cabe à ficha que sentir a dor na prática.
- **Escopo por projeto ou por nó do grafo.** O escopo da credencial de runner
  para em "esta família de rotas, como este runner". Um runner pareado continua
  podendo disputar trabalho de qualquer `projeto_id` que ele declare.
- **Limite de tentativas** (rate limiting, bloqueio depois de N credenciais
  inválidas ou fora de escopo). Nada nesta camada conta tentativas.
