# Plano de ação — 2026-08-18 (registrado pelo plantão a pedido do Rafael)

Origem: as três notas de execução real (`2026-08-17-first-bets-run.md`,
`2026-08-17-second-bets-run.md`, `2026-08-17-t109-game-feature.md`) e um review
externo do repo lido em 18/08 (números conferidos: 143 apelidos `coluna AS campo_pt`, ledger de
migração sem checksum, varredura anti-português duplicada por pacote, dois contratos por
fronteira nó/skill). Decisão do Rafael em 18/08: "siga com o plano sugerido" e, à tarde,
"registre esse plano de ação e crie os dois tickets".

Régua: **uma rodada de cada grafo tem de fechar sem operador.** Tudo abaixo serve a isso; o que
não serve, espera.

## 1. Sprint A+B (em curso, t267–t273) — o encanamento entre nós e o adapter
- t267 prompt renderiza valores de entrada + schema da skill (done)
- t268 relatório recusado segura o job, redespacho/bloqueio (done)
- t269 etiqueta `resultado` × schema estrito
- t270 metadados de travessia (`input.traversal`) + ambiente do executor (`banco_de_testes`,
  `referencia`, `aplicacao` estático em `project`)
- t271 `testar-alpha` × adapter claude-code (done)
- t272 falha pré-sessão não reconhecida = laço de lease
- t273 executor avança `main` e prepara o banco de testes após o integrar

## 2. Dois consertos do review, pequenos e de alto retorno (tickets t278/t279)
- **Check estático de casamento de contratos no import**: todo input obrigatório de um nó tem
  produtor — um ancestral (`contract.produces`), o `project`, a projeção do control plane
  (`job`, `traversal`, `perguntas_respondidas`) ou o executor — senão o import recusa com a
  lista do que falta e quem deveria produzir. Depende da decisão "qual schema vale" (t267/t269).
- **Checksum das migrações** no ledger (recusar subir quando o arquivo aplicado divergir) e o
  registro, nas DECISOES (texto proposto no ticket; quem grava é o Rafael), de que os nomes de
  arquivo de migração em português são chaves permanentes.

## 3. Provar a régua — rodadas sem operador
- **Rodada 3 de bets** com tese que sobreviva ao red team, bundle da `main`, até o portão
  `decisao`; nota.
- **Segunda feature do jogo** pelo grafo de software (a próxima do `docs/TICKETS.md`: direção
  para onde o jogador olha — `facing`), com o executor conduzindo o repo (t270/t273), sem
  variante de skill; nota. Se um nó travar por buraco que o sprint devia ter fechado: parar e
  registrar, não carregar entrada à mão.
- **n=3 do t239** no grafo de bets: 3 travessias A → proposta do topógrafo → **Rafael aplica na
  tela** → 3 travessias B → `measure-executions`/`close-outcome`; nota. Julgar pela mecânica
  fechar sem operador; os números com n=3 são ilustração.
- Se fechar: o mapa funciona. Se não: parar com a resposta honesta.

## 4. Congelar a plataforma enquanto isso (não cortar)
Nenhum ticket novo de tela, webhooks, intake, sintetizador, tiers, segundo engine, OpenAPI
(t240–t244) ou empacotamento (t216, t248–t251) até o passo 3 fechar. Código morto fica parado.

## 5. Faxina — só depois do passo 3, e só se ele fechar
- Os 143 apelidos `coluna AS campo_pt` + `toWire`: renomear os tipos internos para o nome inglês
  da coluna e apagar a camada de ida-e-volta (um ticket, quadro vazio, sem migração).
- As sete cópias da varredura anti-português → uma em `packages/test-support`, lista de
  exceções única e atual.
- O teste da raiz que falhou 1 em 7: caçar em loop, consertar o que for.
- Depois disso, e só então: produto / empacotamento (t216).

## Do Rafael (cliques)
t214 fechar/apagar; t109 aceitar ou repetir; feature do jogo (rodada 1) subir ou não; portão do
n=3 na tela; os dois "pode" de tickets já dados em 18/08 à tarde.

## Addendum (2026-08-18, afternoon — written in English on purpose)

Rafael's instruction after reviewing the language state of the repo: **English only, everywhere** —
every file, folder, structure, configuration and anything else — and **nothing new is born in
Portuguese**. This supersedes the D18 exemptions (DECISIONS.md, notas/, docs/o-que-e, README).
Measured before acting: 12 skill manifests fully in Portuguese (instructions, class keys, check
ids), 68 tracked paths with Portuguese names outside notas/ (packages `tela`, `topografo`,
`topografo-custo`; folders `grafos-de-fabrica`, `especificacoes`, `schema/exemplos`,
`docs/formatos`; the 16 `docs/spec/*.md`), README and all specs in Portuguese, agent commit
messages in Portuguese.

Done immediately: the LANGUAGE convention added to `.flowpilot/profile.yml` (read by the
board's agents at every session — it is the mechanism for "nothing new in Portuguese"); the
plantão's own notes are English from now on.

Tickets (after the n=3 round, one at a time, board empty): **t280** bundles → English,
**t281** documents/specs/schemas/DECISOES/notas → English + ONE repo-wide sweep over every
tracked file (content and paths) + commit-message check, **t282** folders/packages/bins/scripts
→ English with the path allowlist reduced to the frozen migration names (t279).

Proposed decision text for Rafael to record (D24): "English is the only language of the
project: code, identifiers, commit messages, tickets, specs, docs, notes, decisions, bundles
(instructions, keys, checks), file/folder/package/bin/script names, configuration. Portuguese
survives only in the brand name `cartografo`, in verbatim quotations marked as such, and in the
frozen migration file names. Supersedes the exemptions of D18. Enforced by a repo-wide sweep
in the root test suite and by the LANGUAGE convention in the project profile."
