# Primeira execução real do grafo de bets assimétricas (t198)

Data: 2026-08-17, 20:15–21:05 UTC. Operador: plantão (Claude), com autorização do
Rafael. Segunda instância da D14: o grafo `bets-assimetricas` atravessado por uma
tese real, com sessão de agente de verdade — a primeira vez que este grafo roda
fora do fake engine.

## Procedência

- Commit da `main`: `80142cf` (t261 incluído). Control plane e runner subiram do
  checkout `~/cartografo`; banco recriado (`rm -rf .cartografo/`).
- Grafo importado: `bets-assimetricas`, versão
  `sha256:7e95e0015c19ed9bd41ddbbca5fcf278174aae21dee9e9cbaffcc3594f438584`
  (7 skills registradas). Configuração de investidor = o `project` de exemplo do
  próprio `grafo.json` (t260).
- Trabalho: job **2**, execução **1**, nó de entrada `triagem`. (O job 1 foi criado
  sem `execution_id` e bloqueado à mão para ficar fora da rodada.)
- Tese: **Equinox Gold (EQX)** — "mineradoras precificam o ouro muito abaixo do
  fluxo de caixa a US$ 4.400"; hipótese e origem no `body` (Era de Ouro, relatório
  semanal de 2026-08-17, lido pelo Rafael); `fields.asset = EQX`,
  `fields.premise_source` = múltiplos 13x/8x fwd, GDX vs SPY, prêmio da prata na
  China. Entrada completa em `~/cartografo-bets-run/job.json`; candidatas
  alternativas (urânio/CCJ, cobre/FCX, prata/SLV) em
  `scratchpad/teses-metais.json` da sessão.
- Engine: `claude-code` (`claude 2.1.233/2.1.234`, modelo `claude-fable-5`),
  runner com `--working-dir ~/cartografo-bets-run/repo` (repo de rascunho) e
  `--worktrees-root ~/cartografo-bets-run/worktrees`.

## O que aconteceu, nó a nó

| # | Sessão | Nó | Resultado | Saída (tokens) | Cache criado |
|---|---|---|---|---|---|
| 1–4 | 1, 2, 3, 4 | `triagem` | **recusadas pelo modelo** antes de responder (`stop_reason: refusal`, categoria `reasoning_extraction`), exit 1 | 0 | 23.067 cada |
| 5 | 5 | `triagem` | `completed` (exit 0) em ~72 s de sessão (84,5 s de tempo de agente medido pelo topógrafo) | 5.369 | 23.133 |
| — | — | `registro-monitoramento` | nó final: o trabalho foi dado como concluído ao chegar nele; **a skill `registrar-travessia` não rodou** | — | — |

Caminho: `triagem —descartar→ registro-monitoramento` (aresta de descarte). O
portão humano (`decisao`) fica no ramo em que a tese sobrevive; nesta travessia
ele não foi alcançado. Nenhum `input-request` foi aberto.

### O que a triagem decidiu

`resultado: descartar`, `outcome: fail`. Critério a critério, sobre o texto da
entrada:

1. "downside limitado por caixa líquido ou ativo real, não por narrativa" →
   **não atende**: a entrada só oferece reprecificação de múltiplo e um retorno do
   GDX; nenhum dado de caixa, dívida, NAV, reservas ou custo de produção. (Mina é
   ativo real; a tese pode ser reformulada com piso de balanço, mas a entrada não
   o traz.)
2. "evento datado que força a reprecificação em até 12 meses" → **não atende**:
   "prata romper US$ 71" é nível de preço em outro metal, sem data; "ouro a
   US$ 8.000 em dois anos" está fora da janela de 12 meses.
3. "cabe no círculo de competência declarado" → **indeterminado** (não recebido).
4. "cabe no teto de risco da carteira" → **indeterminado**: `project.carteira`
   existe no grafo, mas a skill de triagem não tem placeholder para ela — não
   chegou ao nó.

A sessão devolveu quatro reformulações que reabririam a tese (piso pelo balanço da
EQX; um evento corporativo com data; tamanho pretendido e carteira; círculo de
competência) — exatamente o tipo de saída que o nó existe para produzir.

## Topógrafos sobre a execução 1

- **Fluxo** (`npm run surveyor -- 1`): sessão real de análise; gargalo `triagem`
  (84.554 ms de agente, 0 perguntas); **proposta 1** pendente: reescrever a
  `description` do nó `triagem` para "portão rápido: confronta contra a lista fixa
  de critérios e responde só aprofundar/descartar com uma frase de motivo por
  critério; não pesquisa, não define escopo" — métrica esperada
  `tempo_agente_ms:triagem` cai de 84.554 para 67.643. Aplicar é decisão humana.
- **Custo** (`topografo-custo evaluate --execution 1 --token-cap 20000`):
  **proposta 2** pendente: teto de tokens do nó `triagem` estourado (120.928
  observados em 5 sessões contra 20.000 declarados) — inflado pelas 4 recusas.

## Custo da rodada

Sessões do nó: 5 (4 recusadas + 1 boa) ≈ 115 k tokens de cache criado + 5,4 k de
saída ≈ US$ 2,3. Sessão do topógrafo de fluxo ≈ US$ 1. Diagnóstico da recusa
(bissecção com `claude -p`, 8 chamadas) ≈ US$ 4. Total ≈ **US$ 7–8** para uma
tese reprovada na primeira etapa — o caminho barato do grafo, e o correto para
esta tese.

## Buracos encontrados (cada um virou ticket, em backlog — liberar é decisão do Rafael)

1. **O preâmbulo genérico de escalação no topo do system prompt fazia o modelo
   recusar a sessão** (5/5 determinístico; movido para o fim, passa) — t261,
   já corrigido no meio da rodada (`80142cf`).
2. **Nó final com skill de trabalho nunca roda**: `registro-monitoramento` tem
   `registrar-travessia`, mas o trabalho é dado como concluído ao chegar no nó
   final. Ou o registro é um nó que roda e só então conclui, ou a skill é
   decorativa — hoje é o segundo, em silêncio. → **t262**
3. **`execution.finished` não disparou** (t245): a execução 1 tem seu único job
   concluído e `finished_at` continua `null` em `GET /executions`. → **t264**
4. **Evento `job.transitioned` com `from_node_id: null`** na transição
   `triagem → registro-monitoramento`. → **t264**
5. **Recusa do engine tratada como falha genérica e retentada 4×** (~US$ 1,9 no
   mesmo erro determinístico) — não entrou no t261: o adaptador não distingue `stop_reason: refusal` de
   uma falha qualquer, e o core não tem teto de sessões falhas seguidas por job —
   o executor re-alugaria o trabalho para sempre. → **t265**
6. **`carteira` não chega à triagem**: t260 pôs `carteira` em `project`, mas a
   skill `triar-tese` só lê `input.project.criterios_de_triagem` — dois critérios
   saem "indeterminado" por falta de dado que o grafo tem. → **t263**
7. **Evidência do topógrafo de fluxo ainda com chaves em português**
   (`fonte`, `execucao_id`, `no_id`, `tempo_agente_ms`…) — resto do fio (D20). → **t264**
8. `metrics-by-version` mostra só `jobs`/`events` por versão — sem tokens/tempo
   por nó (a lente de custo tem que recomputar das sessões). → **t264**

## O que a rodada prova e o que não prova

Prova: o mapa recebe uma tese pelo trabalho, projeta a entrada do primeiro nó a
partir de job + project + campos (t253/t259/t260), abre uma sessão real, o nó
julga contra os critérios do investidor com evidência estruturada, devolve a
saída no contrato, o executor segue a aresta correta e os dois topógrafos
produzem propostas a partir da telemetria — o ciclo "rodar → medir → propor",
inteiro, numa tese real. E a triagem reprovou pelos motivos certos: era um bom
trade e não uma bet assimétrica pelos critérios do mapa.

Não prova: os seis nós depois da triagem (coleta com rede aberta, análise de
assimetria, red team, dimensionamento, portão humano, registro) — a tese não
chegou lá. Uma tese que passe na triagem (a do urânio/Cameco, ou a EQX
reformulada com piso de balanço e evento datado, como a própria triagem sugeriu)
é o próximo teste; e a rodada com n>1 continua sendo o t239.
