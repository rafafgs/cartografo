# DECISIONS — cartografo

Incremental record; the source of truth for the project's decisions. Every
decision carries a date and can be reversed by another recorded decision.

**Who records (rule since 2026-08-16):** preferably Rafael. Anybody else, agent
or person, records only with his explicit authorization — case by case ("you may
write down D20") or in batches ("write these four down"). Without that
authorization an agent does not write here: it delivers the text of the decision
as a proposal (in the ticket or in the conversation) and escalates. Every entry
recorded by somebody else says who authorized it.

## D1 (2026-08-14) — Only the server writes to the database

The control plane owns the SQLite; the runner is a stateless client of the API
and never touches the database directly. That is what keeps the embedded
database viable (single writer) and the runner deployable anywhere.

## D2 (2026-08-14) — The graph is versioned from day 1

The "improvement proposal" entity points at a graph version and carries a diff.
Without versioning from the start, the evolution between rounds has nothing to
stand on; it cannot be bolted on later.

## D3 (2026-08-14) — Synthesizing the topology and breaking down the work are separate nodes

Two distinct acts in the meta-process: synthesizing the topology (once per
problem class, at design time) and breaking the work into travellers (once per
execution, at intake). The breakdown produces tickets, not nodes; the path stays
frozen during the execution (principle 2 of the README).

## D4 (2026-08-14) — Skill import goes through a gate

A skill from an external repository is a prompt-injection vector. It is
registered pinned by version and hash, reviewed at import time, and passes a step
that derives and records the contract (input, output, verification) when the
source `SKILL.md` does not declare one. A skill with no contract does not enter
the registry.

## D5 (2026-08-14) — A distributed runner uses a lease with a heartbeat

Dispatched work carries a lease; a dead runner's lease expires and the work goes
back to the queue. Writes to the API are idempotent.

## D6 (2026-08-14) — The order of the MVP

Control plane plus one EngineAdapter plus one fixed graph ported from flowpilot,
running end to end with telemetry, before any synthesizer. The synthesizer is the
last piece, not the first.

## D7 (2026-08-14) — Publication strategy

Private repository until it works. Validate it in 2–3 different domains (the
README's starting condition). Once it is ready: the repository goes public
together with an article in the newsletter, as a lever for growing subscribers;
the public README carries an invitation to follow along at agentsmaestro.dev.

## D8 (2026-08-14) — The problem class is named by the user (MVP)

The one who names the class is the user, in the problem declaration; the
synthesizer only suggests an existing class when it recognizes a resemblance
("this looks like such-and-such a class, want to use its map?"). The class
identity is the versioning root of the graph and the aggregation unit of the
telemetry.

## D9 (2026-08-14) — The contract format

Input and output as JSON Schema; verification as a list of typed checks, each
check being either a deterministic command (run a test, validate a schema) or an
agentic instruction with mandatory evidence. The contract is the common spine of
a skill, a gate and the formal validation of the graph.

## D10 (2026-08-14) — The synthesizer is a copilot in the MVP

It proposes the graph, the user edits it, and that edit is the whole validation
gate. Automating it piece by piece comes later, starting with the formal
soundness checks.

## D11 (2026-08-14) — Screen: observability and the proposal inbox first

Configuration through files and the CLI at the beginning; an editing screen
later. Rafael's condition: architected to be easy to extend and to change —
guaranteed by being API-first (the screen is a client of the public API, with no
privileges, in a package separate from the headless core).

## D12 (2026-08-14) — Apache-2.0 licence

Explicit patent protection, the standard for open infrastructure. The public name
("cartografo" or another) is validated against collisions and domains before the
announcement.

## D13 (2026-08-14) — Graph lineage: a class base plus per-project variants

Every problem class has a base graph; a project may have a variant, which is a
fork of the base with its diff and lineage recorded (branch semantics). Learning
flows both ways, always through a gate: a variant diff that beats the base
becomes a promotion proposal for the base; an improvement in the base is offered
to the variants, never forced on them. The fork itself is born of a proposal from
the topografo carrying evidence of systematic divergence in the telemetry, not of
an a-priori decision.

## D14 (2026-08-14) — Two validation instances, with factory graphs

Two instances, and that is enough (this amends the "2–3 domains" of D7 and of the
README):

1. **Software development** — the flowpilot graph, ported.
2. **Asymmetric bets (investment thesis)** — triage → gathering fundamentals →
   asymmetry analysis (limited downside, large upside) → red team (a role
   dedicated to knocking the thesis down) → risk sizing → decision (a mandatory
   human gate, always) → recording and monitoring. The topografo learns about
   process metrics (did the red team run? are the assumptions sourced? is the
   estimation error falling?); P&L is slow, long-term validation, never a metric
   of a round — in markets, an outcome does not validate a process.

Derived product requirement: the system ships **ready-to-use predetermined
graphs** (a factory library holding those two maps; it is the seed of the
shareable atlas).

## D15 (2026-08-14) — Graph versioning: in the database, with git's ideas

We version the way git thinks, without git installed in the core. Entities: graph
(the lineage: class, variant, pointer to the current version), graph_version (id
= hash of the snapshot, parent, the full JSON snapshot, origin) and proposal
(target version, typed semantic operations plus their inverses, evidence,
expected metric, status, outcome). Applying a proposal = apply the ops → validate
soundness on the result → write a new version → move the pointer; rollback = move
the pointer back; nothing is ever deleted (append-only). The reasons: the
topografo crosses version×telemetry with a join; proposals demand a semantic diff
(not a line diff); a single source of truth (D1). Git enters at the edges: any
version exports as a bundle of files (atlas, backup, a mirror in the user's own
repository; a future approval surface via PR, with no dependency in the core).

## D16 (2026-08-14) — Acceptance criterion and boundary of the PoC

The PoC is accepted when a real software project crosses the ported graph end to
end with: the graph living as data in the database (not as code), sessions
dispatched by the Claude Code EngineAdapter, human questions flowing through the
API, complete queryable telemetry and a minimal observability screen. The
synthesizer and the topografo are explicitly outside the PoC (later milestones,
in D6's order). The PoC proves parity with flowpilot on the new architecture;
beating flowpilot is the next milestone (the topografo's first proposal with
evidence).

## D17 (2026-08-14) — Relationship with flowpilot, and the stack

The port is a reimplementation: flowpilot (Python) is a behavioural reference and
the source of factory graph 1, with no code dependency; migrating away from or
replacing flowpilot is a future decision, out of scope. The stack is settled:
TypeScript, a REST/JSON API, SQLite (D1), the screen as a separate package (D11).

## D18 (2026-08-14) — The language of the code: English

All of the product's code is in English: identifiers, file and package names,
comments, docstrings, test names, API route paths and commit messages from here
on. The reason: D12 (Apache-2.0) and the open-source preparation make the code
the project's public surface, and the audience is global. The protocol vocabulary
was already English (session status and so on) and stays that way. The
repository's documents (DECISIONS.md, README, notas/) stay in Portuguese until a
decision of their own during the open-source preparation. Code written before
this decision is regularized by a dedicated refactor ticket.
Left out, as a separate decision not yet taken: the KEYS of the data formats,
which are in Portuguese (skill manifest, graph bundle) — changing a format key is
changing a specification (t96–t99), not a matter of code style.

**Amendment (2026-08-15, Rafael):** the separate decision has been taken. The
keys of the data formats, the skill manifests (instructions, file names), the
content of the factory bundles and the rest of the product surface (CLI
subcommands, entity names in the API) also converge on English; tickets and
specifications produced on the board, likewise. Changing a format key is a change
of specification: the dedicated ticket amends t96–t99 and regularizes the
bundles. These stay in Portuguese: the brand name cartografo, the repository's
internal documents (DECISIONS.md, notas/) and docs/o-que-e-o-cartografo.md (the
EN version is born during the open-source preparation, t121).

## D19 (2026-08-15) — Living functional documentation

`docs/o-que-e-o-cartografo.md` explains the product in plain language and is a
living document: every delivery that changes visible product behaviour updates
the file in the same delivery (it counts as an implicit acceptance criterion of
those tickets). The *(under construction)* markers come off as the features
arrive.

## D20 (2026-08-16) — The wire speaks English too

D18 and its amendment took the code, the keys of the frozen formats (graph
schema, skill manifest), the CLI subcommands and the entity names in the API
paths to English. What stayed in Portuguese, frozen as a wire format, is the rest
of the public vocabulary: the fields and query parameters of the API's JSON
(`classe`, `grafo_id`, `versao_corrente_id`, `execucao_id`…), the enumeration
values (`pendente`, `teto_runner`…), the two error envelopes (`{erro, mensagem}`
and `{error, details}`), the event names and envelope (`trabalho.transicao`,
`pergunta.criada`…), the proposal operations (`adicionar_no`…), the database
tables and columns, the screen routes (`/quadro`, `/perguntas`…), the CLI flags
(`--classe`, `--teto-*`) and the validation report (`estrutura.erros`,
`soundness.violacoes`).

Decision: all of it migrates to English, with a glossary on the record
(`docs/spec/glossario-wire.md`), **before the repository opens (D7)** and before
the tickets that touch those surfaces (t196, t197, t200), so that the work is not
done twice. Existing development databases are **recreated** (there is no
production data; a data migration only if data worth keeping shows up).
Documentation, notes and this file stay in Portuguese. Umbrella ticket: t213
(split by surface, in this order: glossary → API/errors → events → operations →
database → routes/flags/report → docs and gate).
Recorded by the agent with Rafael's authorization (2026-08-16).

## D21 (2026-08-16) — The ladder's first step: the topografo runs on its own, applying stays human

At the end of every execution the control plane declares the execution finished
(a fact only it asserts, D1) and an unprivileged observer (D11) runs the flow and
cost lenses, depositing proposals in the inbox — deduplicated: a repeated signal
reinforces the pending proposal (it adds evidence) instead of cloning it.
Approving and applying stay a human decision. Auto-applying low-risk changes with
rollback (principle 5 of the README) only arrives after ~10 real rounds of
history, by a decision of its own. This amends the "firing is a decision of its
own" in the flow topografo's spec and comes after t198 (the second instance of
D14, and a round with n>1), so that the trigger is calibrated against real data.
Ticket: t214. Recorded by the agent with Rafael's authorization (2026-08-16).

## D22 (2026-08-16) — A skill is a lineage, like the graph

A skill has a stable id and versions (semver plus a content hash); a version
never changes content — new content is a new version. A node stays pinned by hash
(D4) and never resolves "the latest one"; moving a node's pin to another version
is a proposal like any other change to the map (D15), refused if the hash does
not exist in the registry. Reimporting a bundle registers what is new and is
idempotent about what already exists; different content under the same version is
refused before any write. Retiring a version hides it from "the latest", and
never breaks a graph pinned to it. Ticket: t215. Recorded by the agent with
Rafael's authorization (2026-08-16).

## D23 (2026-08-16) — One package, three commands, and a container for the control plane

The cartografo is published on npm as a single package `cartografo` carrying the
commands `cartografo`, `cartografo-tela` and `cartografo-runner` (and the cost
topografo once it gets a bin); the D1/D11 boundaries are boundaries of process,
not of package. The control plane and the screen have an official Docker image;
the runner runs on the machine where the authenticated engine CLI and the target
repository are — it does not go in a container. The name is validated and
reserved on npm before the announcement (D12; on 2026-08-16 `cartografo` was
free). **Releasing this work for development, and the publication itself, are
Rafael's explicit decision, case by case**: ticket t216 stays blocked until he
himself unblocks it, and if it takes off by mistake it goes back to blocked.
Recorded by the agent with Rafael's authorization (2026-08-16).
