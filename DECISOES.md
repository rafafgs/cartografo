# DECISOES — cartografo

Registro incremental; fonte da verdade das decisões do projeto. Cada decisão
tem data e pode ser revertida por outra decisão registrada.

## D1 (2026-08-14) — Só o server escreve no banco

O control plane é dono do SQLite; runner é cliente stateless da API e nunca
toca o banco direto. É o que mantém o banco embarcado viável (single writer)
e o runner deployável em qualquer lugar.

## D2 (2026-08-14) — Grafo versionado desde o dia 1

A entidade "proposta de melhoria" aponta para uma versão de grafo e carrega
um diff. Sem versionamento desde o início, a evolução entre rodadas não tem
onde se apoiar; não é aparafusável depois.

## D3 (2026-08-14) — Sintetizar topologia e quebrar trabalho são nós separados

Dois atos distintos no meta-processo: sintetizar a topologia (uma vez por
classe de problema, no design) e quebrar o trabalho em viajantes (a cada
execução, no intake). A quebra produz tickets, não nós; o caminho fica
congelado durante a execução (princípio 2 do README).

## D4 (2026-08-14) — Importação de skill passa por portão

Skill de repo externo é vetor de prompt injection. Registro com pin por
versão/hash, revisão na importação, e um passo que deriva e registra o
contrato (entrada, saída, verificação) quando o SKILL.md de origem não
declara. Skill sem contrato não entra no registro.

## D5 (2026-08-14) — Runner distribuído usa lease com heartbeat

Trabalho despachado carrega lease; runner morto expira e o trabalho volta à
fila. Registros idempotentes na API.

## D6 (2026-08-14) — Ordem do MVP

Control plane + um EngineAdapter + um grafo fixo portado do flowpilot,
rodando ponta a ponta com telemetria, antes de qualquer sintetizador. O
sintetizador é a última peça, não a primeira.

## D7 (2026-08-14) — Estratégia de publicação

Repo privado até funcionar. Validar em 2–3 domínios diferentes (condição de
partida do README). Depois de pronto: repo vira público junto com artigo na
newsletter, como alavanca de crescimento de subscribers; o README público
carrega convite para seguir e acompanhar agentsmaestro.dev.
