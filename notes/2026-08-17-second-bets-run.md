# The second real execution of the asymmetric-bets graph (round 2 — the uranium thesis)

Date: 2026-08-18, 00:09–00:46 UTC (the night of the 17th in Rafael's time zone).
Operator: the on-duty agent (Claude), with Rafael's authorization. The second real
traversal of the `bets-assimetricas` graph, with a thesis that passes the triage — the
first time the nodes after the triage (collection with a network, asymmetry analysis, red
team, record) open a real session. Round 1's note:
`notas/2026-08-17-first-bets-run.md`.

## Provenance

- Commit on `main`: `d38835b` (group 1 closed: t262, t263, t264, t265, plus t266 opened by
  t264's test). The control plane and the runner from the `~/cartografo` checkout; the
  database recreated.
- Graph imported: a **project variant** of `bets-assimetricas`
  (built in a scratch clone outside this repository), version
  `sha256:5c3a20ff1eb62432668b167dc6b1735c8beca1734c6850873dcf2a1100797d98`.
  Two differences from the bundle on `main`, both the operator's choice and recorded here
  because they change what the round tested:
  1. `project.circulo_de_competencia` gained a line ("metals and mining — gold, silver,
     uranium, copper…"). t263 put a circle of ports/logistics/net cash/corporate events in
     the example; against that one this thesis would fail criterion 3 by construction, and
     the point of this round was to test the nodes that follow. It is the intended use of a
     "project variant" (D13, and the bundle's own `project.description` says so).
  2. `triar-tese` 1.0.1: one more sentence in "What to return" giving the exact shape of
     `tese_triada` (`escopo_de_pesquisa` = a list of strings). The reason is in hole 1
     below — without it, attempt 1 stalled at the second node.
  The nodes, the edges, the criteria, the portfolio and the other six skills are `main`'s.
- Job: job **1**, execution **2**, entry node `triagem`. Thesis: **a listed uranium
  producer** — "the market prices uranium at spot, but the contract book is already well
  above it" (the second of the metals candidates drafted in the scratch clone; the input in
  a job file beside it). `fields`: `asset` = the producer's ticker, `premise_source` (three
  third-party research outlets and one of the company's own filings),
  `tamanho_pretendido = 3` (% of capital — a new field from t263, required at the
  triage).
- Engine `claude-code` (`claude 2.1.234`; the sessions report `claude-haiku-4-5` +
  `claude-fable-5`), the runner with `--working-dir` and `--worktrees-root` pointing into a
  scratch clone outside this repository.
- There was an **attempt 1** (00:10–00:13 UTC, version `sha256:90d0e812…`, with only
  difference 1 above) that died at the second node — it is in hole 1. Its artefacts are
  kept in that scratch clone (database, events, transcript, the triage's
  output). Since the import refuses a second version of the same class
  (`class_already_registered` — a new version is the proposal flow), attempt 2 restarted
  with a fresh database; execution 2 below is attempt 2 only.

## What happened, node by node (attempt 2)

| # | Session | Node | Result | Duration | Output (tokens) | Cache created / read | Report |
|---|---|---|---|---|---|---|---|
| 1 | 1 | `triagem` | `completed`, `aprofundar` (4 criteria `atende`) | 83 s | 6,465 | 9,200 / 14,918 | **accepted** |
| 2 | 2 | `coleta-fundamentos` | `completed`, 13 premises, refutes the central number | 696 s | 36,980 | 104,363 / **4,589,323** | refused by the schema (`premissas[i]` with no `confianca`) |
| 3 | 3 | `analise-assimetria` | `completed` without analysing: the input never arrived → **question 1** (a human gate) | 43 s | 2,527 | 9,896 / 84,131 | — |
| 4 | 4 | `analise-assimetria` (re-dispatched after the answer) | `completed`, ratio 0.82 | 206 s | 16,629 | 24,317 / 66,431 | **accepted** |
| 5 | 5 | `red-team` | `completed`, `morta` | 402 s | 31,212 | 28,613 / 90,850 | refused by the schema (`additionalProperties`) |
| 6 | 6 | `registro-monitoramento` (a final node with a skill) | `completed`, `arquivado` | 86 s | 6,490 | 33,501 / 236,491 | **accepted** |

The path: `triagem —aprofundar→ coleta-fundamentos → analise-assimetria → red-team —morta→
registro-monitoramento` → `completed: true`, and `execution.finished` fired at 00:46:19Z.
The `dimensionamento-risco` and `decisao` nodes (the human gate of the bet) were **not**
reached: the red team killed the thesis and the `morta` edge leads straight to the record.
The only human gate that opened was a **question** (`kind: question`) from the analysis
node, answered by the on-duty agent (below).

### What each node decided

- **Triage (`aprofundar`)**: all four criteria `atende` — a floor of the right kind (a
  signed contract book + a low-cost mine, with a named filing behind it), an event within 12
  months (a state-owned peer's guidance update and the company's own next two quarterly
  reports — "a window, not a date", with a caveat), the circle (the variant's metals line)
  and the size (3% against 62.5% and 7 positions). A research scope on five fronts: the
  contract book in numbers; costs, production and the non-mining affiliate; supply/demand in
  a primary source; valuation against the floor; dated catalysts.
- **Collection (open network, ~12 min)**: it downloaded and read the company's last two
  quarterly reports and its latest annual one with `pdftotext`, a state-owned peer's
  releases, the text of the import-ban statute and an industry body's pages. **It refuted
  the thesis's central number using the source the thesis cites**: a realised price roughly
  a quarter below the term price in the last reported half-year, guidance for the year no
  better, and a sensitivity table whose top of range still sat under the thesis's number at
  a spot well above the current one (price ceilings plus spot purchases cap it). 13 premises
  (6 with a primary source, 7 with `fonte: null`), gaps, a note. It issued no verdict ("the
  asymmetry judgement belongs to the next node").
- **Asymmetry analysis (session 4)**: an asset floor at ≈ 45% of the market price (the
  contract book under a stressed spot, plus a large minority stake in a private
  nuclear-services affiliate, plus a sliver of net cash — the affiliate stake being roughly
  three quarters of the whole floor) → 55% downside; a target at +45%; **a ratio of 0.82** —
  below 1: "for every US$ 1 of real floor at risk, the target pays US$ 0.82". Four scenarios
  (the thesis dies 30%/−40; sideways 45%/+8; right 20%/+45; euphoria 5%/+90), a weighted
  expected +5.1%. Five unsourced premises weigh on the arithmetic, and the central one is
  refuted. Two honesties recorded: the overhead and the floor's multiple are an estimate;
  the largest piece of the floor is that stake carried at a headline number that is "an IPO
  trigger and not a valuation" (on an earnings multiple instead, the floor falls by a
  further −72%).
- **Red team (`morta`)**: 10 objections (4 high, 5 medium, 1 low), 15 items of
  counter-evidence of its own — from the model's knowledge, network closed, marked "verify
  before reusing". O1 (high, unanswered): the book is not where the thesis puts it and never
  was — the base rate over two decades says the company realises a wide band of spot in bull
  cycles; the contractual floor protects the realised price and never protected the share
  (three past drawdowns of 40–80%, the last of them with the term price rising); the "spot
  doubles on an import ban" trigger has neither a date nor a mechanism (the statute covers a
  different enriched product, with fixed waivers running past the thesis's window). An
  alternative explanation for the price: a nuclear-renaissance premium on the affiliate,
  over a uranium segment capped by price ceilings.
- **Record (`arquivado`)**: `metricas_processo` — `red_team_executado: true`,
  `fracao_premissas_com_fonte: 0.4615` (6/13, counted one by one),
  `decisao_humana_id: null` ("there was no human decision", not "not found"),
  `desfecho_final: arquivado`; `como_reconhecer_se_voltar` and
  `o_que_uma_tese_reformulada_teria_de_provar` (a floor for the SHARE and not for the
  realised price; a dated corporate event — an IPO of the affiliate at a known valuation, or
  the removal of ceilings; a sum-of-the-parts; a primary source for supply/demand). No P&L
  (D14).

### The human gate that opened, and what the on-duty agent answered

Question 1 (session 3, `analise-assimetria`, `auto_approvable: true`): "This node's input
never arrived: the prompt brought only the text of the thesis, with no `entrada.fundamentos`,
`entrada.premissas` and no `entrada.tese_triada` […] how do you want me to proceed?" — with
three options: re-dispatch with the input rendered; authorize reading the run's state in the
parent directory; analyse with the text of the thesis alone (provisional, it would fail the
check). The session saw that the worktree was empty, saw that the parent directory had
the job file and attempt 1, and **did not read** because `filesystem.read = []` — it
refused to invent and refused to work around a permission. Exemplary behaviour; it is what
one wants from a node.

The on-duty agent's answer (00:32:54Z,
`answered_by: plantão (Claude), com autorização do Rafael`): **option 2, with the material
placed in the worktree by the operator** — I extracted from session 2's transcript the
collection's `resultado` block and the triage's accepted output, committed them to
`entrada/triagem.json` and `entrada/coleta-fundamentos.json` on the `ticket-1` branch of the
scratch repository (`df6b4eb`), explicitly authorized reading those two files and only
those, said to treat them as `entrada.tese_triada/fundamentos/premissas`, explained the
reason (the collection's report refused by the schema; the skill only interpolates
`tese_triada.*`) and asked that it record this in the `nota` without downgrading the
verdict, and that it not choose option 3. Session 4 did exactly that. Because the answer
belongs to the job and not to the node, sessions 5 and 6 also saw it in the prompt and read
`entrada/` (the red team recorded that it did **not** have `assimetria`, because its
worktree was created before I managed to commit the analysis's file; the record did find all
four files and a `LEIA-ME.md`).

No other human decision: the graph's `decisao` gate was not reached.

## Topographers over execution 2

- **Flow** (`npm run surveyor -- 2`): 27 events under the version; the bottleneck at
  `coleta-fundamentos` (695,786 ms of agent time, 3,099 ms of queue, 0 questions);
  **proposal 1** pending: rewrite `coleta-fundamentos`'s `description` to "gather ONLY the
  fundamentals of the closed scope handed over by the triage […] a gap is not chased: it is
  recorded and you move on; the analysis decides whether it blocks; finish as soon as every
  item of the scope has a fact, a premise or a gap" — the expected metric
  `agent_ms:coleta-fundamentos` 695,786 → 556,629. This time the proposal has a plausible
  mechanism (the collection spent 4.6 M tokens read from cache sweeping PDFs), but the "to"
  is still a number with a precision n=1 does not support. The evidence now carries `lens`,
  `execution_id`, `node_id`, `agent_ms`, `blocked_ms`, `queue_ms`, `total_ms`,
  `input_requests`, `event_ids`, `by_node` (t264) — `fonte` was left over, and the proposal
  still exposes `gargalo`/`evidencia`/`metrica_esperada{nome,direcao,de,para}`.
- **Cost** (`topografo-custo evaluate --execution 2 --token-cap 20000`): **proposals 2–7**
  pending — the 20,000-token ceiling blown on all five nodes (triage 30,585; analysis
  203,945; red team 150,683; record 276,498; collection **4,730,790**) and the collection at
  23.2× the version's median (proposal 7: "a candidate for a cheaper tier or for a split
  into smaller nodes"). The 20 k ceiling is the parameter I passed, inherited from round 1;
  with real sessions it is unrealistic — the lens works, it is the ceiling that needs an
  owner.
- `GET /executions/2/metrics-by-version` now brings, per node, `sessions`,
  `tokens {input, output, cache_read, cache_creation}` and `agent_ms`, plus
  `input_requests_by_node` (t264 item 4) — the table above came from there and from
  `/sessions`.
- Applying any proposal is Rafael's decision. All seven are in the round's database, copied
  to a `cartografo.db` kept in the scratch clone.

## The round's cost

API list prices (Fable 5: US$ 10/M input, 12.5/M cache write, 1/M cache read, 50/M output;
the sessions run through the `claude` CLI, so this is a reference estimate, not an invoice):

| Node | ≈ US$ |
|---|---|
| triagem (s1) | 0.45 |
| coleta-fundamentos (s2) — 4.6 M tokens read from cache | 7.74 |
| analise-assimetria (s3 question + s4 analysis) | 1.53 |
| red-team (s5) | 2.01 |
| registro-monitoramento (s6) | 0.98 |
| **the traversal (6 sessions)** | **≈ 12.7** |
| attempt 1 (1 triage session) | 0.67 |
| the flow topografo (1 session) | ≈ 1 |
| **the round's total** | **≈ US$ 14–15** |

For comparison: round 1 ≈ US$ 7–8 to fail at the triage; round 2 ≈ US$ 14–15 to cross five
nodes and kill the thesis at the red team with a primary source. Of that total, ~60% is a
single node (the collection), and most of that is cache reading while sweeping PDFs — it is
what proposals 1 and 7 aim at.

## Holes found (none of them became a ticket — creating a ticket is Rafael's decision)

1. **The model is validated against a schema it never sees.** The prompt shows the NODE's
   contract (`grafo.json`, where `tese_triada` is only `{type: object}`), but the report is
   checked against the SKILL's `output` schema (`escopo_de_pesquisa: string[]`;
   `premissas[].confianca` required). Attempt 1: the triage returned the fronts as
   `{frente, pergunta, documento}` — richer and more useful than strings — and was refused.
   Attempt 2: the collection refused for a missing `confianca`. Either the prompt renders the
   skill's schema, or the node's is what holds, or the validation becomes a warning; today it
   is the worst of the three: silent and with no way out.
2. **The report is refused and the job advances anyway.** The runner routes on its own
   reading of the block (`aprofundar`, `morta`) while the control plane records
   `output: null`. The job arrives at the next node with an empty projection — on attempt 1
   it blocked (the `tese_triada.*` placeholders with no value); on attempt 2 it opened a
   session with no data (node 3). A refused report should hold the job at the node (a block
   carrying the schema error, then a re-dispatch), not push it on.
3. **The VALUES of the input never reach the model — only the interpolated placeholders and
   the SCHEMA.** `analisar-assimetria`, `derrubar-tese` and `dimensionar-risco` interpolate
   only `tese_triada.*` and say "everything you need arrived in `entrada.fundamentos` and
   `entrada.premissas`" — it did not, and it would not even with a full projection. It is
   structural: either the runner renders the whole `input` (or per key declared in the
   skill's `input`), or every skill interpolates what it uses. It is what session 3 pointed
   out, word for word.
4. **A routing node with a strict schema never has its report accepted.** The protocol puts
   `resultado` (the edge) inside the same block the skill's schema validates;
   `derrubar-tese` has `additionalProperties: false` and does not declare `resultado` →
   "output must NOT have additional properties", always. `triar-tese` declares `resultado`,
   which is why it passes. Either the parser separates the label from the report before
   validating, or every routing node's schema declares `resultado`.
5. **`registrar-travessia` asks for input nobody produces**: `nos_executados` and
   `data_de_registro` are the executor's metadata, not a node's output. t262 worked (the
   final node with a skill was NOT finished on arrival and tried to dispatch), and it stalled
   here. The operator unstalled it through `PATCH /jobs/1` `fields` — which accepts only
   scalars, so `nos_executados` became a comma-separated string, and the projection does not
   validate the input against the skill's `input` (it only resolves placeholders), so it
   passed. Two sub-holes: traversal metadata should be projected by the control plane; and
   "assemble the node's input", which the blocking message tells you to do, has no path to an
   object or a list.
6. **There is no cheap operator path to fix a skill between attempts.** The import refuses a
   second version of the same class (`class_already_registered`; a new version = an applied
   proposal), the job stays pinned to its version, `fields` is scalar. Fixing one sentence of
   a prompt required a fresh database. The proposal flow is the right one in steady state;
   for a real-round bench what is missing is a shortcut ("import as a child version of this
   one") or the proposal flow itself used by hand — I did not try, so as not to mix the round
   with a test of `apply`.
7. **Vocabulary leftovers** (D20): the flow's evidence with `fonte`; the proposal with
   `gargalo`, `evidencia`, `metrica_esperada{nome, direcao, de, para}`; the `actor` of the
   job routes demands `{type: user|agent|system, ref}` (I found out through a 422 — it is not
   in the runbook, and now it is here).
8. **`from_node_id: null` on the first transition** is deliberate (`alreadyWalked`; t264
   recorded that it was never a defect) — kept here only so that a reader of note 1 does not
   go looking.
9. **Bench dirt**: a control plane from the `ticket-266` checkout (pid 70402, port 62474)
   stayed alive after t266's test — the on-duty agent cleans up at closing time.

## What the round proves and what it does not

It proves: with a thesis that passes the triage, the graph opens a real session at five
nodes, the collection goes to the primary source and **knocks down the thesis's central
number with the document the thesis itself cited**, the analysis measures the asymmetry with
a floor and scenarios tied to the collection's numbers and returns a ratio < 1, the red team
kills the thesis with unanswered objections and an alternative mechanism for the price, and
the final node records the process (the fraction of premises with a source, the closing
path, what a reformulation would have to prove). The final node with a skill now runs
(t262), `execution.finished` fires and `metrics-by-version` gives tokens and time per node
(t264), and `carteira`/circle/size reach the triage (t263). And the product insight is real:
the uranium thesis, as stated, **is not an asymmetric bet** — the floor is one of realised
price, not of the share; the market already pays for the term book plus the affiliate.

It does not prove: that the projection carries one node's output to the next without an
operator (holes 1–5: at three of the five nodes the input was loaded by hand by the on-duty
agent, with the authorization recorded at a gate); that `dimensionamento-risco`, `decisao`
(the bet's gate) and the `sobrevive` branch work — no thesis has got there yet; that an
applied topografo proposal improves any metric (that is t239). t265 (the failure ceiling /
refusal) was not exercised: no session failed and none was refused in this round.

## What was still missing

- A thesis that **survives the red team**, to exercise `dimensionamento-risco` → `decisao`
  (a real human gate) → the record along the `aprovado/recusado` branch. Round 1's thesis
  reformulated with a balance-sheet floor and a dated event, or this one rewritten as "a
  floor for the share by sum-of-the-parts + a dated IPO of the affiliate", are candidates —
  the record itself listed
  what they would have to prove.
- Closing holes 1–5 before round 3, or round 3 repeats the operator loading input by hand
  (which invalidates the flow topografo's measurement, since it measured agent time with a
  human gate in the middle).
- A realistic token ceiling per node in the bundle (the cost topografo measured against 20 k
  because that is what I passed) and an owner for the collection's cost (proposals 1/7).
- Re-verify the red team's counter-evidence CE-01–CE-15 over the network before reusing it
  outside the test: it is the model's knowledge, marked as such.
