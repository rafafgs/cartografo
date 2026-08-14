# Extensão e padrão de qualidade para projeto aberto (2026-08-14)

Iteração com o Rafael: o cartografo como modelo de orquestração aberto, com
alto padrão de qualidade e pontos de extensão para construir em cima.

## Princípio organizador

**Num projeto aberto, os pontos de extensão de verdade são os formatos, não
o código.** Interfaces de código mudam; formatos documentados ficam. Quatro
formatos tratados como produto, com schema versionado e doc de especificação:

1. **Schema do grafo** — nós, arestas, portões, contratos; exportável,
   importável, diffável, publicável.
2. **Manifesto de skill** — contrato + permissões declaradas.
3. **Taxonomia de eventos** — o formato da telemetria é API pública (é o que
   dashboards e topógrafos de terceiros consomem).
4. **Interface do EngineAdapter**.

## Pontos de extensão

1. **EngineAdapter** — plugar CLI novo; qualidade garantida por um **kit de
   conformidade** (suíte que o adapter de terceiro precisa passar).
2. **Skills** — o registro é extensão por natureza; o portão de importação
   (D4) segura a qualidade quando abrir ao mundo.
3. **Portões determinísticos** — test runner, linter, validador de schema;
   superfície de contribuição barata e segura.
4. **Topógrafos plugáveis** — o mais estratégico e inexistente no mercado:
   analisadores (fluxo, custo, qualidade) lendo a mesma telemetria e
   emitindo propostas no mesmo formato. Comunidade escrevendo topógrafos =
   comunidade melhorando o cérebro do sistema.
5. **Eventos para fora** — webhooks/stream de transições; core headless,
   API-first; a tela oficial é só mais um cliente da API, sem privilégios.

## Inegociáveis de qualidade

- **Validação formal de grafo no portão de síntese**: soundness de workflow
  nets (van der Aalst) é verificável mecanicamente — todo nó alcançável,
  terminação garantida, nenhuma aresta sem condição, nenhum nó sem
  skill/contrato. Parte código formal, parte julgamento humano. Frase de
  posicionamento: "verificamos formalmente os grafos que a IA propõe".
- **Reprodutibilidade por event sourcing**: grafo vN + inputs ⇒ execução
  replayável do log (torna bug report de terceiro tratável).
- **Segurança de skill**: permissões no manifesto (filesystem, rede), pin
  por hash, sandbox onde o engine permitir.
- **Partida em um comando** (`npx cartografo`): time-to-first-graph é
  feature de qualidade.
- **Migrações automáticas de banco e API versionada desde o v0**: projeto
  aberto não controla quando os outros atualizam.

## Grafo como artefato compartilhável (efeito de rede)

Grafo + skills + contratos exportam como bundle publicável; a comunidade
contribui **mapas**, não só código. Um atlas comunitário de grafos por
classe de problema é ao mesmo tempo a distribuição viral (funil para
agentsmaestro.dev) e o fosso que player grande não copia absorvendo feature.

## Regra dos dois consumidores

Ponto de extensão desenhado antes de existirem dois consumidores reais nasce
errado. Na prática: dois adapters (Claude Code + um segundo CLI) antes de
congelar o EngineAdapter; dois topógrafos (fluxo e custo) antes de congelar
o formato de proposta; dois grafos (software + segundo domínio) antes de
congelar o schema do grafo. A ordem do MVP (D6) já força quase tudo isso.
