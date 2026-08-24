# Second real feature of the vibe-game through the software graph — facing direction (t109, round 2)

Date: 2026-08-18, 13:03–13:18 UTC. Operator: the plantão (Claude), under Rafael's mandate of
2026-08-18 ("implementar uma nova feature simples do jogo novamente conforme sugerido").
Written in English by rule. Round 1: `notas/2026-08-17-t109-game-feature.md`.

The question of this round: **after the sprint, does the software graph traverse all five
nodes by agent, with the executor driving the repository, without the operator?** In round 1
three nodes ran by agent and two by hand.

## Provenance

- cartografo `main` at `4217673` (t267–t285 included), run from a **separate clone**
  `~/cartografo-bench` (lesson of the bets round 3: the flowpilot integrator fast-forwards
  `~/cartografo`, so nothing runs from there any more).
- **Bundle from `main`, no skill patch at all**: `grafos-de-fabrica/desenvolvimento-de-software`
  (skills 1.0.0, `testar-alpha` 1.0.4 after t271/t277), only the graph's `project` replaced by
  the game's (`make-grafo-jogo.py`: repo, conventions from `docs/TICKETS.md`, four gates,
  `comando_instalacao: npm ci`, `arquivos_de_registro`, static `aplicacao` per t270). Version
  `sha256:2171942af8518a38df4b8ea9bcb20d54686a3731a00e8b1b46a014a8a70dd7fb`, imported via the
  CLI (skills first → contract state `checked`, t278/t283).
- **Target repo** `~/cartografo-jogo-run/repo2`: clone of the clone Rafael validated in round 1
  (`main` at `ae41796`, alien family), no remote — nothing can reach `~/vibe-game`.
- Runner: `--working-dir repo2 --worktrees-root worktrees2 --test-bench-path repo2
  --bench-install-command "npm ci" --reference-mode ponta_do_principal` (t270/t273 flags),
  engine `claude-code`.
- Job **1**, execution **1**, entry `refinar`: **"Facing direction: the player remembers which
  way he is looking, and punch, kick and shot read it instead of guessing from velocity"**
  (`job-feature-2.json`) — the next item of the game's own `docs/TICKETS.md`.

## What happened, node by node

| # | Session | Node | Result | Duration | Output tokens | Cache created / read | Report |
|---|---|---|---|---|---|---|---|
| 1 | 1 | `refinar` | spec: 13 files, 20 verifiable criteria, `tier padrao` | 333 s | 24,858 | 70,818 / 1,486,294 | **accepted** |
| 2 | 2 | `desenvolver` | 2 commits on `ticket-1` (tests first `037ab5c`, feat `04c2975`), 7 gates green | 218 s | 14,449 | 88,632 / 2,285,087 | **accepted** |
| 3 | 3 | `integrar` | fast-forward, gates green on the merged tree | 50 s | 2,261 | 14,902 / 188,662 | **accepted** |
| — | executor | after `integrar` | **`main` of the bench advanced to `04c2975`, `npm ci` run** (t273) | — | — | — | — |
| 4 | 4 | `testar` | `aprovado` — 5/5 criteria `passou`, 0 bugs, UX unchanged | 240 s | 15,900 | 48,032 / 951,280 | **accepted** |
| 5 | 5 | `implantar` | `publicado` — both deterministic checks exit 0 | 14 s | 751 | 11,451 / 40,866 | **accepted** |

Path: `refinar → desenvolver → integrar → testar —aprovado→ implantar` → `completed: true`,
`execution.finished` at 13:18:26Z. **Five nodes by agent, five reports accepted at the first
attempt, no human gate opened, no operator action.** The whole traversal took 15 minutes.

### What each node did

- **Refine**: read the repo, produced a spec with a one-line conflict surface (13 files:
  `types.ts` and `world.ts` as one-field additive shared-surface edits, `movement`/`punch`/
  `combat`/`projectile` systems, five test files, the two docs), 20 criteria written as
  assertions (W1: `findPlayer(createWorld(1)).facing === "right"`; M2: one tick of
  `walk({moveX:-1})` → `"left"`; M4: vertical-only movement keeps the previous facing; the
  projectile test "left, left, stop, shoot" → negative x-velocity; …).
- **Develop**: in the isolated worktree, tests first (`037ab5c … before any of it exists`),
  then the feature and the docs in one commit (`04c2975`); gates: typecheck, test, lint,
  build, `play --ticks 300 --every 60` with an empty before/after frame diff for a run that
  never strikes after turning (determinism), `play --ticks 120`, clean tree.
- **Integrate**: `main` was the merge-base → fast-forward; re-verified the four gates on the
  tip; reported `merge_commit 04c2975`. **Then the executor did what round 1 lacked**: it
  fast-forwarded the bench's `main` to `04c2975` and ran `npm ci` in it before letting the job
  off the node (t273).
- **Alpha test (own evidence)**: headless play byte-identical to the pre-change tree; a replay
  recorded on the previous tree (seed 7, 600 ticks, no strikes) reproduces identically on the
  integrated tree; its own probe through `step()` confirms "left, left, stop, shoot" launches
  the projectile with `vel.x = −24` (before: `+24`), `facing` is born `"right"` for every kind,
  flips on the sign of `moveX` (diagonal and fractional included), is preserved when idle and
  on vertical movement, and punch/kick read it through the whole strike window; `types.ts` /
  `world.ts` edits are additive only. 5/5 `passou`, no bugs, UX unchanged (no render surface
  touched). Routed `aprovado`.
- **Deploy verification**: `git rev-parse --verify 04c2975^{commit}` → 0;
  `git merge-base --is-ancestor 04c2975 <reference>` → 0 → `publicado`, `implantado_em
  2026-08-18T13:18:18Z`, reference mode `ponta_do_principal`.

The feature is on `main` of `~/cartografo-jogo-run/repo2` (`04c2975`, 13 files, +272/−32),
served for validation at **http://localhost:5181/** (round 1's build stays at :5180). Nothing
was pushed to `~/vibe-game`; if Rafael wants it: `git -C ~/vibe-game fetch
~/cartografo-jogo-run/repo2 main && git -C ~/vibe-game merge --ff-only FETCH_HEAD`.

## Surveyors on execution 1

- **Flow**: bottleneck `refinar` (333,027 ms). Proposal 1 pending: change `refinar`'s
  description to "a lean spec: functional requirements, verifiable acceptance criteria and
  negative scope; do not map files nor read the source — the touched-files survey belongs to
  whoever implements" — expected `agent_ms:refinar` 333,027 → 266,422. Debatable: the file map
  is what made the developer's conflict surface exact in both rounds; the surveyor is trading
  refine time for develop risk. Rafael decides.
- **Cost** (`--token-cap 300000`): proposals 2–4 — `desenvolver` 2,388,228 tokens,
  `refinar` 1,582,026, `testar` 1,015,252 over the cap; the two big ones are cache reads of
  the repo (2.3 M and 1.5 M). The cap is still an operator number.
- Both DBs and proposals kept: `~/cartografo-jogo-run/db2/cartografo.db`.

## Cost

List prices (Fable 5) — reference, not invoice:

| Node | ≈ US$ |
|---|---|
| refinar (s1) — 1.49 M cache read | 3.61 |
| desenvolver (s2) — 2.29 M cache read | 4.12 |
| integrar (s3) | 0.49 |
| testar (s4) — 0.95 M cache read | 2.35 |
| implantar (s5) | 0.22 |
| **5 sessions** | **≈ 10.8** |
| flow surveyor | ≈ 1 |
| **total** | **≈ US$ 12** (cap 25) |

Round 1 spent ≈ US$ 17 for 3/5 of the path (plus the operator); this round ≈ US$ 12 for
5/5 with nobody. Per feature of this size, the graph costs about the same as four flowpilot
sessions and delivers the same commit shape (test → feat, docs in the same commit).

## Holes found (none became a ticket)

1. **None that stopped the round.** Everything round 1 listed as a hole (t271 permission,
   t272 lease loop, t273 main not advanced/bench not prepared, t270 executor environment,
   t267/t269 schema and label) held under a real run.
2. Small: `implantar`'s reference in `ponta_do_principal` mode is the bench's own tip, so the
   ancestry check compares the merge commit with itself — true by construction. It proves the
   plumbing, not a deployment; a real installation reference (`instalacao_em_uso`) is the
   next thing to exercise when there is one.
3. Cost is dominated by cache reads of the repo in `refinar`/`desenvolver`/`testar` (4.7 M
   tokens for a 13-file feature). The flow proposal attacks the wrong end (skip the file
   map); the right lever is probably scoping what each session reads.

## What the round proves and what it does not

Proves: **the software graph runs a real feature end to end without the operator** — spec,
tests-first implementation, integration, executor advancing the main line and preparing the
bench, alpha test with its own evidence, deterministic deploy check — on the bundle as
shipped, with claude-code, in 15 minutes for ≈ US$ 12. Both factory graphs have now closed a
real traversal on their own on the same day (bets round 3, this round). That was the bar of
the action plan §3.

Does not prove: a `retrabalho` loop (the test passed first time), a real deployment
reference, the surveyor's proposal improving anything (n=3), or cost efficiency (hole 3).

## What is still missing

- Rafael's validation of the feature at :5181 and the merge into `~/vibe-game`, if he likes
  it (founder act).
- t109 acceptance against the D16 bar (parity with the flowpilot pipeline) — this round is
  the evidence; the ticket stays as it is on the board for him.
- The n=3 round (bets, proposal 1 of round 3) — next step of the plan.
