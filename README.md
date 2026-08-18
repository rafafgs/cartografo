# cartografo

> Um framework que desenha, executa e evolui grafos de trabalho por classe de
> problema. Você declara o problema; o sistema desenha o mapa.

**Estado: ideia registrada, pré-protótipo.** Origem: conversa de 2026-08-14
sobre graph engineering, durante a produção do artigo O001 da newsletter
(repo `substack-agentes`). Ideia do Rafael; refinada na discussão.

## A ideia em um parágrafo

A pessoa declara o problema que quer resolver. O sistema consulta um registro
de capacidades (skills com contrato), sintetiza um grafo de etapas para
aquela classe de problema, valida esse grafo num portão, e executa o trabalho
com o caminho congelado: as únicas decisões em voo são as dos portões
(passou, falhou, escala para humano). Depois da execução, um avaliador lê o
log (onde formou fila, onde o humano foi puxado, onde o trabalho ciclou) e
propõe mudanças no grafo para a próxima rodada. O sistema se melhora sozinho
entre execuções, com o humano trabalhando nas exceções.

## Como rodar

Do checkout limpo ao primeiro grafo registrado, em três comandos:

```bash
npm install                                                            # 1
npx cartografo                                                         # 2 (deixe rodando)
CARTOGRAFO_TOKEN=<o token do passo 2> \
  npx cartografo import grafos-de-fabrica/desenvolvimento-de-software  # 3 (outro terminal)
```

O passo 1 é `npm install` porque um checkout de trabalho é onde o lockfile
muda. Já uma instalação **reproduzível** — o CI, ou qualquer máquina que precise
do mesmo `node_modules` de novo — pede `npm ci`: ele instala exatamente o que o
`package-lock.json` diz e **falha** quando lockfile e `package.json` discordam,
em vez de acomodar a diferença em silêncio. Foi um `node_modules` velho, mais
antigo que uma dependência recém-adicionada, que derrubou 314 testes e o
`typecheck` num checkout sem ninguém entender por quê.

O passo 2 é o control plane inteiro em um comando: cria `.cartografo/cartografo.db`,
aplica as migrações pendentes, sobe o HTTP e imprime a linha `cartografo.ready`.
Na PRIMEIRA partida contra um banco novo, essa linha traz também um
`bootstrapToken`: é a credencial de operador, e é a única vez que ela aparece —
o banco guarda só o hash dela. Toda rota `/v1/*` exige essa credencial; `/health`
não exige nenhuma, porque é sonda de infraestrutura. Perdeu o token? Apague
`.cartografo/` e suba de novo, que outro é emitido. Um segundo `npx cartografo`
contra o mesmo banco sai com 1 e uma linha só, dizendo o pid do que já está
rodando e o arquivo `<banco>.lock` que ele segura — só o servidor escreve no
banco (D1), e isso vale entre processos, não só dentro de um.

> **Subindo de uma versão anterior à t235? Apague `.cartografo/`.** A D20 traduziu
> para inglês o vocabulário do log de eventos (`job.created` no lugar de
> `trabalho.criado`, `data.title` no lugar de `dados.titulo`), o das operações
> de proposta (`add_node` no lugar de `adicionar_no`, `{type, node_id, field,
> from, to, inverse}` no lugar de `{tipo, no_id, campo, de, para, inversa}`) e o
> do próprio banco — os nomes de tabela e de coluna (`job`, `graph_version`,
> `created_at`) e também os VALORES que eles guardam (`status = 'pending'` no
> lugar de `'pendente'`, `entity_type = 'job'` no lugar de `'trabalho'`,
> `role = 'work'` no lugar de `'fazer'`). Tudo isso é dado gravado que não se
> reescreve — o log é append-only, uma proposta guardada é o registro do que
> alguém propôs, e uma linha antiga não passa pelo `CHECK` novo. Como não existe
> dado de produção, a resposta da própria decisão é **recriar** o banco de
> desenvolvimento, não migrá-lo — `rm -rf .cartografo/` e `npx cartografo` de
> novo. Não existe migração de renomeação para rodar: as dezenove migrações
> nascem em inglês, e um banco antigo não é atualizado por elas.
>
> **O que a t279 acrescenta é proteção para a próxima vez, não conserto para
> esta.** Desde a `0023`, `schema_migrations` guarda o `checksum` do conteúdo de
> cada migração aplicada, e toda partida confere: uma migração já aplicada que
> foi editada no lugar — ou que sumiu do disco, porque alguém a renomeou — faz
> `npx cartografo` parar na hora, dizendo o nome dela, em vez de subir limpo e
> morrer depois no meio de uma requisição com um `no such column`. Isso não
> alcança os bancos que a D20 já quebrou: as linhas deles foram gravadas antes de
> existir checksum, então não há com o que comparar, e o runner só registra o que
> encontra hoje (avisando no stderr). Para esses, a resposta continua sendo
> exatamente a de cima — `rm -rf .cartografo/`.

O passo 3 registra o grafo de fábrica 1 (D14) como linhagem base — conferindo
antes, localmente, os pinos de hash das skills do bundle (D4) — e imprime a
`graph_version.id` que ficou gravada. Ao final, `GET /v1/classes` lista
`desenvolvimento-de-software`.

As skills do bundle vão para o registro antes do grafo, e o registro guarda uma
versão por linha (D22): reimportar o mesmo bundle não reescreve nada, e
reimportá-lo depois de subir a `version` de uma skill registra só aquela versão —
a linha `skills  1 registered, 4 already in the registry` é o que o comando
imprime. Editar o conteúdo de uma skill SEM subir a `version` é o caso que o
`import` recusa, antes de mandar o grafo: uma versão não pode nomear dois
conteúdos.

E do grafo registrado ao trabalho andando, um quarto comando:

```bash
CARTOGRAFO_TOKEN=<o token do passo 2> \
  npx cartografo-runner --project 1 \
    --working-dir ~/proj --worktrees-root ~/proj-worktrees              # 4 (outro terminal)
```

O passo 4 sobe um runner: ele se pareia com o control plane, imprime a linha
`cartografo.runner.ready` e, a partir daí, pede trabalho liberado, toma a lease
e despacha uma sessão de agente para cada trabalho que pegar — um tick a cada
`--interval-ms` (default 2000), até um SIGINT ou SIGTERM, que espera a sessão em
voo terminar antes de sair. Um engine por processo
(`--engine claude-code|codex`, default `claude-code`), e é o CLI desse engine,
já instalado e autenticado na máquina, que roda de fato.

Cada sessão trabalha num `git worktree` só dela, num branch `ticket-<id>`:
`--working-dir` é o repositório de onde esse worktree é cortado (default: o
diretório atual) e `--worktrees-root` é onde ele é criado. O segundo é
**obrigatório e não tem default** — onde uma sessão pode escrever é decisão de
quem opera, nunca palpite do código — e tem que ser **irmão** do primeiro, nunca
um diretório dentro dele: worktree criado dentro do repositório de onde saiu
aparece como conteúdo não rastreado no `git status` desse repositório. Sem a
flag, ou com as duas se sobrepondo, o comando sai com 2 e uma linha, antes de
falar com o control plane. `npx cartografo-runner --help` lista o resto.

Sessão que termina limpa tem o worktree removido; sessão que falha, estoura o
relógio ou é cancelada tem o dela **retido**, porque é o único lugar onde ainda
existe o que ela fez — e desde a t207 uma sessão que termina bem mas deixa
trabalho **não commitado** também retém a árvore e **bloqueia o trabalho** com
o caminho dela no motivo, em vez de apagar em silêncio. Isso acumula
diretórios e branches, e quem recolhe é o `prune`:

```bash
npx cartografo-runner prune --working-dir ~/proj \
  --worktrees-root ~/proj-worktrees --dry-run     # lista o que recolheria
npx cartografo-runner prune --working-dir ~/proj \
  --worktrees-root ~/proj-worktrees               # recolhe de verdade
```

Ele varre duas fontes — os diretórios `ticket-<id>-<hex>` sob
`--worktrees-root` que o `git worktree list` reconhece, e os branches
`ticket-<id>` do repositório — e pergunta ao control plane, por trabalho, se
ele está **concluído**. Só o que está concluído é recolhido: `bloqueado` não é
estado terminal (um trabalho desbloqueado continua do mesmo nó, com uma árvore
nova). O branch sai com `git branch -d`, **nunca `-D`** — concluído quer dizer
que a travessia chegou a um nó final do grafo, o que não diz nada sobre os
commits terem sido mergeados; branch não mergeado é recusado, reportado e não
muda o código de saída. `--older-than <dias>` restringe a recolha ao que já
está parado há esse tempo, e qualquer diretório que o comando não reconheça é
reportado e nunca tocado. `npx cartografo-runner prune --help` lista o resto.

Os outros dois subcomandos do `cartografo`, para conferir e levar o grafo
embora:

```bash
npx cartografo status                                   # servidor e projetos registrados
npx cartografo status --json                            # o mesmo, para script
npx cartografo export desenvolvimento-de-software       # grava ./desenvolvimento-de-software.grafo.json
```

O arquivo que `export` grava é o mesmo documento que `import` aceita de volta:
importá-lo em outro control plane produz a mesma `graph_version.id`, porque o id
de uma versão é o hash canônico do documento. `npx cartografo --help` lista tudo.

Depois de uma rodada, para a lente de custo ler a telemetria dela:

```bash
CARTOGRAFO_TOKEN=<o token do passo 2> \
  npx topografo-custo evaluate --url http://127.0.0.1:4317 \
    --execution 7 --token-cap 200000
```

O `topografo-custo` é um topógrafo: lê sessões e trabalhos daquela execução pela
API pública, agrega custo por `(versão do grafo, nó)` e **deposita uma proposta
pendente** por candidata — nunca aplica nenhuma, porque aplicar é decisão humana
no portão (princípio 5). Sem `--token-cap` nem `--second-cap` a política de
teto não roda: não há o que ultrapassar. `npx topografo-custo --help` lista o
resto.

E, para não ter de digitar o id de cada rodada, um observador que faz isso
sozinho:

```bash
npx cartografo-topografo watch --url http://127.0.0.1:4317 --token <o token do passo 2>
```

Ele assina o stream de eventos, espera o control plane declarar uma execução
terminada e roda as **duas** lentes sobre ela — a de fluxo (uma sessão de agente
de verdade, um diff semântico) e a de custo (agregação determinística) —,
escrevendo uma linha JSON por desfecho: `posted`, `deduped`, `nothing` ou
`error`. `--lens flow|cost` roda só uma delas; `--dry-run` diz o que rodaria e
não gasta nada. Rodar duas vezes sobre a mesma execução não duplica proposta:
quem deduplica é o control plane, por `(lente, versão-alvo, operações)`.

O que ele **não** faz: aplicar. Continua nascendo tudo `pending` e esperando
você no portão (princípio 5) — o que virou automático foi propor, não decidir.
Ele também não se liga sozinho: não há serviço, cron nem passo de partida que o
suba, e ligá-lo é decisão de quem opera ([D21](DECISOES.md)).

E, para ver o que está acontecendo:

```bash
npx cartografo-tela                                     # http://127.0.0.1:4318
```

Um comando, as duas metades da tela que a D11 pede. Em `/`, o **inbox de
propostas**: o diff semântico, a evidência e as quatro decisões
([`docs/spec/tela-inbox-propostas.md`](docs/spec/tela-inbox-propostas.md)). Em
`/board`, a **observabilidade mínima**: o quadro de trabalhos agrupado por nó,
as execuções, as sessões, a fila de perguntas pendentes — com resposta inline,
que escreve de verdade na API — e a linha do tempo de qualquer trabalho,
separada em fila, agente trabalhando e esperando humano
([`docs/spec/tela.md`](docs/spec/tela.md)).

As duas são cliente comum da API pública, sem privilégio nenhum sobre o control
plane: outro processo, outra porta, nenhum acesso ao banco.

Configuração: `CARTOGRAFO_PORT`, `CARTOGRAFO_DB_PATH` e `CARTOGRAFO_HOST` na
partida — o último decide o endereço de escuta, e o default segue sendo
`127.0.0.1`, porque abrir a porta para a rede é decisão de quem opera, não do
comando; `CARTOGRAFO_LOG_LEVEL` (default `info`, valores `trace`, `debug`,
`info`, `warn`, `error`, `fatal`, `silent`) para o nível do log JSON do control
plane — é por ele que saem as falhas de tick dos despachantes e os 500
inesperados, cuja resposta ao cliente não diz mais do que `{error, message,
request_id}`: o `request_id` é o `reqId` da linha de log correspondente, e é o
que liga um relato de suporte ao que de fato quebrou; não há log por
requisição, de propósito; `CARTOGRAFO_LEASE_CAP_RUNNER` e
`CARTOGRAFO_LEASE_CAP_PROJECT`
(default 50 cada) para o teto de leases simultâneas que o servidor impõe — o
runner declara o teto que quer em `--declared-runner-cap` e vale o MENOR dos
dois, porque quem decide concorrência é o control plane, não o pedido (D1); esse
número declarado não muda o que um processo de runner faz, que é despachar **uma
sessão por tick**, qualquer que seja o valor: mais vazão é mais processos de
runner sob o mesmo projeto; `CARTOGRAFO_URL` (ou `--url`)
para apontar os outros subcomandos — e a tela, e o runner — a um control plane
que não esteja no default `http://127.0.0.1:4317`;
`CARTOGRAFO_TOKEN` (ou `--token`) para a credencial que os subcomandos e o
runner apresentam; `CARTOGRAFO_TELA_PORT` para mudar a porta da tela e
`CARTOGRAFO_TELA_TOKEN` para dar à tela uma credencial própria — sem ela, a tela
usa a do `CARTOGRAFO_TOKEN`. A tela apresenta essa credencial ao control plane em
toda chamada e não pede nenhuma ao navegador: ela é cliente sem privilégio da API
(D11), e é por isso que escuta em loopback.

## O buraco que ele ocupa

Hoje existem dois modos de graph engineering: desenhar a topologia na mão,
caso a caso (LangGraph e afins), ou fixar um grafo único por domínio
(flowpilot, para entrega de software). Falta a camada do meio: um sistema que
**gera e evolui** grafos por classe de problema, com a mesma governança que o
grafo fixo oferece.

## Princípios (registrados da conversa de origem)

1. **Meta-processo fixo, grafo-objeto dinâmico.** O gerador de topologia é um
   agente, ou seja, um trabalhador que erra. Se o grafo que governa o
   trabalho fosse produzido por um trabalhador não governado, a meta-camada
   reintroduziria o problema que o grafo resolve. Por isso o pipeline
   declarar → consultar capacidades → sintetizar → **validar o grafo** →
   executar → avaliar → propor mutação é fixo; o que ele produz por classe de
   problema é que varia. Analogia: compilador. A declaração do problema
   compila para uma topologia; o compilador não muda a cada programa.
2. **Dinâmico entre execuções, congelado durante.** Nó não escolhe caminho
   livremente em runtime (isso seria um loop enfeitado, sem reprodutibilidade
   nem auditoria). Sintetiza → congela → atravessa → aprende do log → muta a
   versão seguinte. Grafo versionado, com diff entre rodadas.
3. **O contrato é a peça de sustentação.** Cada capacidade declara entrada,
   saída, pré-condições e como se verifica o que ela produz. Sem contrato, o
   sintetizador compõe por alucinação; com contrato, compor grafo vira casar
   contratos. (MCP já é meio caminho: ferramenta com schema.)
4. **Contexto compartilhado = estado explícito, nunca janela comum.** O que
   se compartilha é o quadro e o event log; cada nó recebe uma projeção do
   estado. Janela de contexto comum recria a degradação de sessão longa.
5. **Evolução com escada de segurança.** O avaliador primeiro só sugere; a
   mudança passa por portão humano; com histórico acumulado, mutações de
   baixo risco auto-aplicam com rollback. Humano nas exceções da execução e
   no portão de mutação, no começo.
6. **Limite honesto: densidade de verificação.** O framework se adapta a
   qualquer problema onde dá para escrever o contrato de cada etapa. Onde não
   há verificação intermediária possível, não há portão; sem portão, o grafo
   é decorativo. O teto é densidade de verificação, não inteligência.

## Peças

- **Registro de capacidades** — skills com contrato (entrada, saída,
  pré-condições, método de verificação).
- **Sintetizador de topologia** — do problema declarado ao grafo proposto.
- **Portão de validação de grafo** — o grafo é artefato com contrato; alguém
  confere antes de rodar.
- **Executor** — travessia com portões, filas, escalação para humano.
- **Avaliador (topógrafo)** — process mining do log; propostas de mutação.
- **Memória de processo** — grafos versionados por classe de problema.

## Linhagem e vizinhos

ADAS (busca automática de designs agênticos), DSPy (otimização de pipelines a
partir de métricas), process mining (van der Aalst), LangGraph (topologia
autoral por caso de uso), flowpilot (grafo fixo por domínio — a primeira
instância). O diferencial desta ideia: **grafo persistente por classe de
problema que evolui entre rodadas** — a retrospectiva de um time virando
código.

## Condição de partida (a regra do teto)

Não construir a meta-camada a priori. A generalização se extrai de
instâncias: começar com grafos fixos funcionando em domínios diferentes.
Decidido (D14): duas instâncias — desenvolvimento de software (grafo do
flowpilot portado) e bets assimétricas (tese de investimento) — entregues
como grafos de fábrica, prontos para uso.

## Protótipo barato

Os primitivos do Claude Code já são metade do framework: skills com descrição
= registro de capacidades; workflow scripts = grafos congelados; logs de
sessão = event log. O sintetizador seria um agente que escreve workflow
scripts. Testável num fim de semana, antes de decidir se vira produto, artigo
ou os dois.

## Nome

`cartografo`: quem desenha um mapa por território — um grafo por classe de
problema, redesenhado conforme o território é explorado. Considerados:
`topografo` (ficou para o avaliador, que mede o terreno), `graphsmith` (EN).

## Plano

Fazer funcionar → validar nas duas instâncias da D14 (software e bets
assimétricas) → publicar artigo na newsletter com o repo público (só depois
de pronto), como alavanca de subscribers. O README público carregará o convite para seguir
agentsmaestro.dev. Decisões em [DECISOES.md](./DECISOES.md); notas em
`notas/`.
