# t109 — uma feature real do vibe-game pelo grafo de software (rodada única)

Data: 2026-08-18, 01:53–02:15 UTC (madrugada de 17→18/08). Operador: plantão (Claude),
autorizado pelo Rafael em 17/08 ~22:40Z ("pode botar o 109 pra implementar 1 nova feature do
jogo no final de tudo antes de desarmar o plantão"). Primeira vez que o grafo
`desenvolvimento-de-software` (grafo de fábrica 1, D14) roda com sessões reais sobre um repo
de software de verdade — o `vibe-game` (brawler ASCII, TypeScript, vitest/biome). O t109 é um
ticket de PoC ("escolher um repo real, atravessar backlog → done com sessões reais, relatório
com números do log"); a aceitação pela régua da D16 é do Rafael, e o ticket fica no quadro
como está.

## Procedência

- `main` do cartografo em `783d4e8` (t239 já mergeado); control plane e runner do checkout
  `~/cartografo`, banco novo (`.cartografo/` da rodada 2 de bets copiado antes para
  `~/cartografo-bets-run/rodada2-db/`).
- **Repo alvo = clone de trabalho** `~/cartografo-jogo-run/repo` (de `~/vibe-game`, `main` em
  `3ab3b31`, t95), **sem remote** — nada pode chegar ao repo principal. Gates verdes no clone
  antes de começar (268 testes).
- **Grafo: variante de bancada** de `desenvolvimento-de-software`
  (`~/cartografo-jogo-run/grafo-jogo/`, gerada por `make-grafo-jogo.py`), versão
  `sha256:e4d93c8f069a950874be279c33454e4b6807bb7a84475832804cc58c9450614a`. Mesmos nós,
  arestas e checks; o que mudou, e por quê (tudo prompt/configuração, nada de código do
  cartografo):
  1. `project` do jogo: `repo` = o clone, `comandos_qualidade` = typecheck/test/lint/build,
     `convencoes` = as regras de `docs/TICKETS.md` em prosa (ticket dono de arquivos inteiros,
     superfícies compartilhadas aditivas, `spawn()`, `world.rng`, números em `tuning.ts`,
     testes primeiro), `documentos_canonicos`.
  2. `project` também carrega `arquivos_de_registro`, `aplicacao`, `banco_de_testes` e
     `referencia`, e `integrar-branch`/`testar-alpha`/`implantar-release` leem esses quatro de
     `input.project.*` — porque nenhum nó nem o executor produz esses valores (mesma classe do
     buraco 5 da nota da rodada 2 de bets: entrada que ninguém produz bloqueia o nó antes de
     abrir sessão).
  3. As cinco skills viraram 1.0.1 com o **schema de saída embutido nas instruções** (buraco 1
     da rodada 2: o modelo é validado contra o schema da skill mas só vê o contrato do nó), e
     `testar-alpha` declara `resultado` no schema (buraco 4: nó roteador com
     `additionalProperties: false` nunca tem relatório aceito).
  4. `lineage` mantida como `base`: o import recusa `variant` ("nasce de
     `POST /v1/graphs/:id/fork`", D13) — não usei o fork para não misturar a rodada com um teste
     dele.
- Trabalho: job **1**, execução **1**, entrada `refinar`. Pedido em
  `~/cartografo-jogo-run/job-feature.json`: **"The rest of the alien family: spawn `alienFast`
  and `alienWide`, and let every strike hit them"** — o próximo ticket que o próprio
  `docs/TICKETS.md` do jogo lista ("Known later tickets"); desenhos e velocidades já existiam,
  faltava spawner e golpes.
- Engine `claude-code` (`claude 2.1.234`; sessões relatam `claude-haiku-4-5` + `claude-fable-5`),
  runner com `--working-dir` = o clone e `--worktrees-root ~/cartografo-jogo-run/worktrees`.

## O que aconteceu, nó a nó

| # | Sessão | Nó | Resultado | Duração | Saída (tokens) | Cache criado / lido | Relatório |
|---|---|---|---|---|---|---|---|
| 1 | 1 | `refinar` | especificação completa, `tier padrao` | 510 s | 40.949 | 106.014 / 1.778.447 | **aceito** |
| 2 | 2 | `desenvolver` | 2 commits em `ticket-1`, 5 gates verdes | 553 s | 43.542 | 181.419 / **5.722.894** | **aceito** |
| 3 | 3 | `integrar` | fast-forward puro, gates verdes na árvore mesclada | 53 s | 2.487 | 12.526 / 250.676 | **aceito** |
| — | — | `testar` | **sessão nunca abriu**: `SessionStartError` (permissão de rede por domínio) | — | — | — | — |
| — | — | `implantar` | não alcançado pelo executor | — | — | — | — |

Caminho: `refinar → desenvolver → integrar → testar` (`sempre`), e aí parou — o job está
bloqueado em `testar` com o motivo registrado (abaixo). **Nenhum portão humano abriu**: as três
sessões não perguntaram nada.

### O que cada nó fez

- **Refinar (8,5 min)**: leu o repo e devolveu uma especificação com superfície de conflito
  declarada em UMA linha (18 arquivos: `tuning.ts`, um `src/sim/kinds.ts` novo, sete sistemas,
  sete arquivos de teste, `docs/TICKETS.md`, `DECISIONS.md`), contexto, ~20 critérios de aceite
  verificáveis um a um (ex.: "`ALIEN_VARIETY_WEIGHTS.alien` estritamente maior que cada um
  dos outros dois"; "com `createWorld(17)` e 3000 steps o conjunto de kinds das chegadas é
  exatamente `ALIEN_KINDS`"; "para cada chegada, `vel.x` no tick de nascimento é
  `-alienSpeedFor(kind, tick)`"), fora de escopo e defaults tomados. Nomeou o que NÃO tocar
  (`types.ts`, `step.ts`, `sprites.ts`, `world.ts`).
- **Desenvolver (9,2 min)**: no worktree isolado, sem rede (`npm ci --offline` do cache do npm),
  commitou **primeiro** os 20 testes de aceite (`45c2abe test(t1): …before any of it exists` —
  12 vermelhos pelo motivo certo), depois feat+docs num commit (`ae41796 feat(t1): the whole
  alien family spawns, walks at its own pace and dies to every strike`). Implementação: uma lista
  compartilhada `ALIEN_KINDS`/`isAlienKind` em `sim/kinds.ts` lida por punch/combat/projectile/
  damage/hazard/muncher/aliens; `ALIEN_VARIETY_WEIGHTS {6, 2, 2}` e `alienSpeedFor` **aditivo**
  sobre a rampa (a diferença entre variedades fica constante e o mais rápido chega a 13, abaixo
  de `PLAYER_SPEED` — um multiplicador passaria); sorteio com `nextFloat(world.rng)` antes de
  y/drift, tick 0 sempre `alien` sem consumir rng; `docs/TICKETS.md` e `DECISIONS.md`
  atualizados no mesmo commit dizendo o que mudou a resposta. Gates declarados e depois
  conferidos por mim: typecheck, test (289), lint, build, `play --ticks 600 --every 100`. Zero
  arquivos inesperados; a superfície é exatamente a da spec.
- **Integrar (53 s)**: `main` (`3ab3b31`) é a merge-base → fast-forward puro; reverificou os
  quatro gates na ponta `ae41796` (289 testes em 32 arquivos), árvore limpa; relatou
  `merge_commit: ae41796…` e o gotcha "o executor pode avançar `main` por fast-forward".
- **Testar — o que travou**: `testar-alpha` declara `network: {allowed: true, domains:
  [127.0.0.1, localhost, ::1]}`; o adapter claude-code não suporta rede por domínio (é regra
  documentada em `packages/runner/src/engine/permission-policy.ts`) → `SessionStartError:
  permission policy unsupported` a cada tick, **sem sessão aberta**, e o runner **em laço**:
  38 `lease.granted` em ~2 min, sem teto — o t265 conta sessões falhas, e aqui nenhuma sessão
  chega a existir. Não há como trocar a skill de um job já pinado na versão (buraco 6 da nota
  de bets). Matei o runner.

### O que o operador fez à mão (e por que isso conta contra a rodada)

1. **Avancei `main` do clone** por fast-forward para `ae41796` antes do `testar` (o papel que a
   skill de integração atribui ao executor — "é ELE quem avança a linha principal" — e que o
   runner **não faz**: depois do integrar, `main` continuava em `3ab3b31`).
2. **Testar, como operador**, no `main` integrado: `npm run typecheck && npm test && npm run
   lint && npm run build` verdes (289 testes); `npm run play -- --ticks 600 --every 100`
   (semente 1) mostra na tela **duas formas** de alien (`Ö`/`╓╫╖` o comum e `Ω`/`╠╬╣` o largo);
   com 1200 ticks e sementes 1/7/17 aparecem as **três** (`Ø`/`╒╪╕` o rápido é o mais raro na
   tela porque cruza a arena depressa). Números em `tuning.ts`, aleatoriedade só de
   `world.rng`, `spawn()`, `entity.dead` — conferido no diff. Critérios de aceite do pedido:
   todos atendidos.
3. **Implantar, como operador**: os dois checks determinísticos da skill — `git rev-parse
   --verify main^{commit}` resolve; `git merge-base --is-ancestor ae41796 main` → 0
   ("publicado"). Isto só é verdade porque eu avancei `main` no passo 1.
4. Bloqueei o job 1 em `testar` com o motivo (`POST /jobs/1/blocks`) para o estado ficar
   honesto no banco.

Ou seja: **3 dos 5 nós por sessão de agente, 2 pelo operador com comandos reais.** A feature
existe, está integrada e verificada no clone (`~/cartografo-jogo-run/repo`, `main` em
`ae41796`; nada foi empurrado para `~/vibe-game` — o clone não tem remote). Aplicar no repo
principal é decisão do Rafael: `git -C ~/vibe-game fetch ~/cartografo-jogo-run/repo main &&
git -C ~/vibe-game merge --ff-only FETCH_HEAD` faz isso em uma linha, depois de ele olhar.

## Topógrafos sobre a execução 1

- **Fluxo** (`npm run surveyor -- 1`): gargalo `desenvolver` (553.401 ms de agente, 0
  perguntas). **Proposta 1** pendente — e desta vez é **estrutural**: `add_node` de um nó
  `escrever-testes` (`role: tester`, "escreve os testes de aceite a partir dos critérios da
  especificação, antes de qualquer implementação, e os entrega já falhando no checkout isolado
  para que o desenvolvimento parta deles"), com `inverse: remove_node`; métrica esperada
  `agent_ms:desenvolver` 553.401 → 442.721. É a primeira proposta do topógrafo que mexe na
  topologia em vez de reescrever uma `description`; se faz sentido separar "escrever testes"
  de "implementar" (o desenvolver já faz os dois, em dois commits) é decisão do Rafael.
- **Custo** (`topografo-custo evaluate --execution 1 --token-cap 200000`, teto dez vezes maior
  do que o das rodadas de bets, ainda assim irreal para sessões reais): **propostas 2–5**
  pendentes — teto estourado em refinar (1.925.466), desenvolver (5.947.961) e integrar
  (265.709); desenvolver a 3× a mediana da versão (proposta 5). Também nunca vi o topógrafo de
  custo dizer "está barato": o teto de tokens por nó no bundle precisa de dono.
- `metrics-by-version` (t264): por nó, sessões/tokens/`agent_ms` — a tabela acima veio daí.
- As cinco propostas estão no banco da rodada, copiado para `~/cartografo-jogo-run/db/`.

## Custo

Preços de lista da API (Fable 5: US$ 10/M entrada, 12,5/M escrita de cache, 1/M leitura de
cache, 50/M saída — referência, não fatura; as sessões correm pelo `claude` CLI):

| Nó | ≈ US$ |
|---|---|
| refinar (s1) — 1,78 M tokens lidos de cache | 5,15 |
| desenvolver (s2) — 5,72 M tokens lidos de cache | 10,17 |
| integrar (s3) | 0,53 |
| **3 sessões** | **≈ 15,9** |
| topógrafo de fluxo (1 sessão) | ≈ 1 |
| **total** | **≈ US$ 17** (teto combinado: ~25) |

Comparação útil: pelo quadro do flowpilot, uma feature deste tamanho no `vibe-game` (t94, t95)
também custa quatro sessões (refino, desenvolvimento, integração, teste); aqui as três
primeiras saíram com o mesmo formato de commit (test → feat) e docs no mesmo commit — o grafo
não perdeu qualidade para o pipeline de referência nesse trecho. O que ele NÃO fez foi o teste
alfa e a implantação, pelos motivos acima.

## Buracos encontrados (nenhum virou ticket — criar ticket é decisão do Rafael)

1. **`testar-alpha` é incompatível com o adapter claude-code por construção** (rede com
   `domains`) — o bundle de fábrica 1 nunca passa do integrar com o único engine que existe de
   verdade. Ou a skill declara `rede` sem `dominios`/fechada, ou o adapter aprende domínio.
2. **Falha pré-sessão que não é reconhecida vira laço de lease infinito** — 38 leases em 2 min,
   sem sessão, sem teto, sem bloqueio. `pre-session-failure.ts` só conhece cinco padrões e o
   t265 só conta sessões falhas; um `SessionStartError` reproduzível devia bloquear o job na
   primeira ocorrência, como a recusa do engine.
3. **O executor não avança `main` depois do integrar** (a skill promete que ele o faz); o
   testar e o implantar leem uma linha principal que não recebeu o trabalho. O operador fez o
   fast-forward à mão.
4. **`aplicacao`, `banco_de_testes`, `referencia`, `arquivos_de_registro`: entrada que ninguém
   produz** (mesma família do buraco 5 de bets) — na bancada vieram de `project`; no fluxo real
   têm de vir do executor (banco de testes = checkout de main integrado; referência = o commit
   da instalação).
5. **Repetem-se aqui, e por isso foram pré-mitigados na variante**: schema da skill invisível ao
   modelo (buraco 1 de bets) e nó roteador com schema estrito sem `resultado` (buraco 4). Com
   a mitigação, os três relatórios foram aceitos de primeira — evidência de que a correção é
   essa mesma (renderizar o schema da skill no prompt).
6. **`import` recusa `lineage: variant`** — variante de projeto só pelo fork (D13). Correto em
   regime; para bancada, o operador acaba mentindo `base`.
7. **Worktrees órfãos**: seis `worktrees/ticket-1-*` para três sessões (um por tentativa de
   despacho, incluindo as que falharam antes de abrir sessão); nenhum é removido ao fim.
8. **O runner faz `npm ci --offline`?** Não — cada sessão fez isso sozinha porque o worktree
   nasce sem `node_modules` e a rede é fechada; funcionou pelo cache do npm. Vale um passo de
   preparo do worktree pelo executor (o flowpilot tem).

## O que a rodada prova e o que não prova

Prova: com um repo real e um pedido do tamanho de um ticket, o grafo de software refina uma
spec executável, implementa no worktree isolado com testes primeiro, integra e reverifica os
gates — três sessões de agente, três relatórios aceitos, código que passa em 289 testes e faz o
que o pedido pede (as três variedades de alien nascem, andam a velocidades próprias e morrem
para soco, chute e tiro; contato de qualquer uma custa vida). Com os buracos 1/4 de bets
mitigados na variante, a projeção levou a saída de um nó ao seguinte sem operador em
`refinar → desenvolver → integrar` (o `ticket.especificacao` e o `artefato.branch` chegaram).
E o topógrafo de fluxo, pela primeira vez, propôs uma mudança de topologia.

Não prova: `testar` e `implantar` por agente (adapter incompatível; feitos à mão); que o
executor conduza o repo (avançar `main`, preparar o banco de testes); custo por feature abaixo
do pipeline de referência (≈ US$ 17 para 3/5 do caminho, dominado por leitura de cache em
refinar/desenvolver — 7,5 M tokens lidos); e a régua da D16 (paridade com o flowpilot), que é
julgamento do Rafael sobre este relatório.

## O que ainda faltou

- Fechar o buraco 1 (permissão do `testar-alpha`) e o 2 (laço de lease) antes de qualquer
  rodada n>1 de software — sem isso o grafo nunca chega ao `implantar` com claude-code.
- Decidir de quem é "avançar `main`" e "preparar o banco de testes" (executor vs. skill vs.
  operador) e implementar; até lá, `testar`/`implantar` são teatro.
- Aplicar (ou não) a proposta 1 do topógrafo (nó `escrever-testes`) e um teto de tokens
  realista por nó — decisões do Rafael.
- Se a feature agradar: fast-forward do `~/vibe-game` a partir do clone (uma linha, acima) e um
  `git push` do repo do jogo — ambos atos do fundador.
