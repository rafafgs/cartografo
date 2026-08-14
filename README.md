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
