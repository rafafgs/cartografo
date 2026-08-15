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

O passo 2 é o control plane inteiro em um comando: cria `.cartografo/cartografo.db`,
aplica as migrações pendentes, sobe o HTTP e imprime a linha `cartografo.ready`.
Na PRIMEIRA partida contra um banco novo, essa linha traz também um
`bootstrapToken`: é a credencial de operador, e é a única vez que ela aparece —
o banco guarda só o hash dela. Toda rota `/v1/*` exige essa credencial; `/health`
não exige nenhuma, porque é sonda de infraestrutura. Perdeu o token? Apague
`.cartografo/` e suba de novo, que outro é emitido.

O passo 3 registra o grafo de fábrica 1 (D14) como linhagem base — conferindo
antes, localmente, os pinos de hash das skills do bundle (D4) — e imprime a
`grafo_versao.id` que ficou gravada. Ao final, `GET /v1/classes` lista
`desenvolvimento-de-software`.

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

Os outros dois subcomandos, para conferir e levar o grafo embora:

```bash
npx cartografo status                                   # servidor e projetos registrados
npx cartografo status --json                            # o mesmo, para script
npx cartografo export desenvolvimento-de-software       # grava ./desenvolvimento-de-software.grafo.json
```

O arquivo que `export` grava é o mesmo documento que `import` aceita de volta:
importá-lo em outro control plane produz a mesma `grafo_versao.id`, porque o id
de uma versão é o hash canônico do documento. `npx cartografo --help` lista tudo.

E, para ver o que está acontecendo:

```bash
npx cartografo-tela                                     # http://127.0.0.1:4318
```

Um comando, as duas metades da tela que a D11 pede. Em `/`, o **inbox de
propostas**: o diff semântico, a evidência e as quatro decisões
([`docs/spec/tela-inbox-propostas.md`](docs/spec/tela-inbox-propostas.md)). Em
`/quadro`, a **observabilidade mínima**: o quadro de trabalhos agrupado por nó,
as execuções, as sessões, a fila de perguntas pendentes — com resposta inline,
que escreve de verdade na API — e a linha do tempo de qualquer trabalho,
separada em fila, agente trabalhando e esperando humano
([`docs/spec/tela.md`](docs/spec/tela.md)).

As duas são cliente comum da API pública, sem privilégio nenhum sobre o control
plane: outro processo, outra porta, nenhum acesso ao banco.

Configuração: `CARTOGRAFO_PORT`, `CARTOGRAFO_DB_PATH` e `CARTOGRAFO_HOST` na
partida — o último decide o endereço de escuta, e o default segue sendo
`127.0.0.1`, porque abrir a porta para a rede é decisão de quem opera, não do
comando; `CARTOGRAFO_LEASE_CAP_RUNNER` e `CARTOGRAFO_LEASE_CAP_PROJECT`
(default 50 cada) para o teto de leases simultâneas que o servidor impõe — o
runner declara o teto que quer e vale o MENOR dos dois, porque quem decide
concorrência é o control plane, não o pedido (D1); `CARTOGRAFO_URL` (ou `--url`)
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
