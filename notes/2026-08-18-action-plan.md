# Action plan — 2026-08-18 (recorded by the on-duty agent at Rafael's request)

Origin: the three real-execution notes (`2026-08-17-first-bets-run.md`,
`2026-08-17-second-bets-run.md`, `2026-08-17-t109-game-feature.md`) and an external review of
the repository read on the 18th (numbers checked: 143 `coluna AS campo_pt` aliases, a
migration ledger with no checksum, the anti-Portuguese sweep duplicated per package, two
contracts per node/skill boundary). Rafael's decision on the 18th: "go ahead with the
suggested plan" and, in the afternoon, "record this action plan and create the two tickets".

The ruler: **one round of each graph has to close with no operator.** Everything below serves
that; whatever does not serve it waits.

## 1. Sprint A+B (in progress, t267–t273) — the plumbing between nodes, and the adapter
- t267 the prompt renders the input's values + the skill's schema (done)
- t268 a refused report holds the job, re-dispatch/block (done)
- t269 the `resultado` label × a strict schema
- t270 traversal metadata (`input.traversal`) + the executor's environment
  (`banco_de_testes`, `referencia`, `aplicacao` static in `project`)
- t271 `testar-alpha` × the claude-code adapter (done)
- t272 an unrecognised pre-session failure = a lease loop
- t273 the executor advances `main` and prepares the test bench after the integration

## 2. Two fixes from the review, small and high-return (tickets t278/t279)
- **A static contract-matching check at import**: every required input of a node has a
  producer — an ancestor (`contract.produces`), the `project`, the control plane's projection
  (`job`, `traversal`, `perguntas_respondidas`) or the executor — otherwise the import
  refuses with the list of what is missing and who ought to produce it. It depends on the
  "which schema holds" decision (t267/t269).
- **A checksum for the migrations** in the ledger (refuse to come up when an applied file has
  diverged) and the recording, in the decision ledger (the text proposed in the ticket;
  Rafael is the one who records it), that the Portuguese migration file names are permanent
  keys.

## 3. Proving the ruler — rounds with no operator
- **Round 3 of bets** with a thesis that survives the red team, the bundle from `main`, up to
  the `decisao` gate; a note.
- **A second game feature** through the software graph (the next one in `docs/TICKETS.md`:
  the direction the player is looking — `facing`), with the executor driving the repository
  (t270/t273), with no skill variant; a note. If a node stalls on a hole the sprint should
  have closed: stop and record it, do not load the input by hand.
- **t239's n=3** on the bets graph: 3 A traversals → the topografo's proposal → **Rafael
  applies it on the screen** → 3 B traversals → `measure-executions`/`close-outcome`; a note.
  Judge by whether the mechanism closes with no operator; the numbers at n=3 are an
  illustration.
- If it closes: the map works. If not: stop with the honest answer.

## 4. Freeze the platform meanwhile (do not cut it)
No new ticket for the screen, webhooks, intake, the synthesizer, tiers, a second engine,
OpenAPI (t240–t244) or packaging (t216, t248–t251) until step 3 closes. Dead code stays where
it is.

## 5. The clean-up — only after step 3, and only if it closes
- The 143 `coluna AS campo_pt` aliases + `toWire`: rename the internal types to the column's
  English name and delete the round-trip layer (one ticket, an empty board, no migration).
- The seven copies of the anti-Portuguese sweep → one in `packages/test-support`, with a
  single, current exception list.
- The root test that failed 1 in 7: hunt it in a loop, fix whatever it is.
- After that, and only then: the packaging work already on the backlog (t216).

## From Rafael (clicks)
Close/delete t214; accept or repeat t109; ship the game feature (round 1) or not; the n=3 gate
on the screen; the two ticket "go aheads" already given on the afternoon of the 18th.

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
on-duty agent's own notes are English from now on.

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
