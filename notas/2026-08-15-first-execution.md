# Primeira execução real — jogo da velha (2026-08-15, madrugada)

Registro do primeiro dogfood: o cartografo recém-construído (47 tickets em ~10h
de onda no flowpilot) atravessou o grafo de fábrica 1 inteiro com sessões
`claude` reais e produziu um jogo da velha jogável em `~/jogo-da-velha`
(operador: o planner da onda, como procurador do founder; journal completo e
filmagem em `github.com/rafafgs/cartografo-story`).

**Números**: 5 nós atravessados (refinar → desenvolver → integrar → testar →
implantar), 7 sessões (2 retries, 1 re-despacho pós-resposta), 1 pergunta
humana respondida via API, 6 commits no repo alvo, 12/12 critérios `passou`,
~20 min de trabalho de sessão. Trabalho #1, execução #1, telemetria íntegra no
`.cartografo/cartografo.db` (export em `cartografo-story/game-run/`).

## O que funcionou de primeira

1. **Partida em um comando + bootstrap token (t100/t124)** — `cartografo.ready`
   com a credencial única; toda a rodada autenticada.
2. **Import com pinos de hash (t108/t135/D4)** — grafo de fábrica registrado,
   5 skills no registry, versão por hash canônico.
3. **Lease/tick (t103, D5)** — 7 despachos, zero corrida, lease devolvida em
   toda falha.
4. **Escalação humana ponta a ponta (t106, D9)** — o tester emitiu o bloco
   `input-request`, o trabalho bloqueou sozinho, `PATCH /answer` desbloqueou, e
   o re-despacho com a pergunta+resposta no prompt mudou o comportamento da
   sessão. Primeira rodada real, zero ajuste.
5. **Retry-com-contexto** — a perna 2 do refinar encontrou o SPEC.md órfão da
   perna 1 e concluiu, sem instrução especial.
6. **O manifesto da skill como prompt bastou para o processo emergir** — o nó
   desenvolver fez red→green→doc por conta do contrato (teste vermelho
   commitado antes da implementação), sem que o enunciado pedisse TDD.
7. **Tester com evidência própria (D9)** — caminhou os 12 critérios com harness
   próprio em /tmp, escalou APENAS a prova que não podia produzir (segundo
   navegador, TCC), com avaliação de risco anexa.

## Lacunas e bugs encontrados (por ordem de dor)

1. **A travessia automática era o t109 (cancelado)** — o grafo vive como dado,
   mas o dispatch v0 usa instrução fixa e não puxa a skill do `grafo_versao`
   nem avança nó. A rodada foi hand-cranked pelo operador (um job por nó,
   manifesto injetado manualmente, `POST /transitions` entre nós). É a lacuna
   número um do produto.
2. **Dispatch sem Authorization** — 401 contra o plane autenticado do t124;
   achado 01:4x, ticket t147 no flowpilot, **consertado pelo próprio fluxo
   durante a noite** (surfando pausa de quota). O workaround da rodada foi o
   seam `doFetch`.
3. **Transcript de sessão não persistido** — a perna 1 do refinar morreu com
   exit 1 e trabalho quase pronto, e não há como diagnosticar: o prompt é
   gravado, a saída não. O topógrafo vai precisar do log da sessão.
4. **Porta default colide com a bancada de teste** — o 4317 estava ocupado pelo
   control plane que a bancada do flowpilot mantém vivo. `CARTOGRAFO_PORT`
   resolveu; um default randomizável (porta 0 no ready line) evitaria.
5. **Runner-como-biblioteca exige `--import tsx` do consumidor** — *parameter
   properties* quebram o strip-only do Node; um bin empacotado (como o do core)
   resolveria.
6. **Sem worktree por sessão** — a sessão trabalha no checkout compartilhado; o
   próprio OPERADOR virou escritor concorrente (um `git checkout` de
   verificação sob sessão viva — inócuo por sorte). A lei do flowpilot
   (worktree-per-session, docs/process.md #1-3) vale aqui.
7. Miudezas de contrato: ator aceita `usuario|agente|sistema` ("humano" = 422,
   correto mas surpreende); `POST /v1/executions` não existe (execução é
   projeção; o id no job é livre); evento `sessao.finalizada` não aparece na
   projeção do trabalho (fica na entidade sessão).

## O que a próxima rodada deveria ter

Skill-rendering + avanço de nó automático (o t109 de fato), transcript
persistido, worktree por sessão, bin do runner. Com isso a mesma rodada roda
sem operador — e o topógrafo tem o que ler.
