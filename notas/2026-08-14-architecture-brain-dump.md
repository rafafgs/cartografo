# Architecture — brain dump (2026-08-14)

Rafael's brain dump, organised in conversation. Nothing here is a closed
decision, except where it confirms a principle already recorded in the README.

## Inherited from flowpilot

- **Telemetry as a first-class citizen.** flowpilot's trio of tables
  (`ticket_events` append-only, `agent_sessions`, `input_requests` with a
  user/auto `answer_source`) proved its worth; take the format.
- **LLM independence through an abstraction of the CLI.** The `engine` field
  becomes an interface: EngineAdapter (open a session with
  prompt/workdir/skills/timeout, follow the output, collect the exit). Claude
  Code is the first adapter, not a dependency.
- **Human escalation as an entity** (input_requests), not as a special case.
- **Per-session skill injection.** The node's instructions come out of the
  database and are injected into the session by the runner (the engine's
  flag/stdin/ephemeral file). No dependency on CLAUDE.md and none on resident md
  files in the target repository; the contract lives in the database and is
  rendered per engine.

## Topology

- **Control plane (a Node server).** Runs on any machine; the first execution
  installs the embedded database (SQLite). It keeps the telemetry, the structure
  of the graphs, the projects and the remaining entities. It exposes an API for
  current states, registered graphs, executions, sessions — everything a
  configuration and observability screen needs. **Only the server writes to the
  database** (single writer); everybody else speaks to the API.
- **Runner (the same process or a separate one).** The one that fires workflows
  and opens CLI sessions, recording everything on the remote server it is
  registered with. Deployable anywhere with access to the engine's CLI; the
  runner is stateless, a client of the API.
- **Controller (inside the runner).** It evaluates a directory (local mode) or
  queries the API (distributed mode) to pick up released work. Maximum control of
  sessions: a concurrency ceiling per runner and per project. A WIP limit is not
  a concern right now.

## The database's minimal entities

project → graph (versioned) → nodes (with a skill/contract) and edges (with a
condition) → execution → ticket/job → session → event → input_request →
improvement proposal (points at a graph version, has a diff and a status:
proposed / approved / applied / reverted).

## Flows

1. **Registering a graph:** the user describes the problem; an agent structures
   the graph and registers it in the database as a graph inside a project (it
   passes through the README's validation gate, principle 1).
2. **Skills:** the user can scan known skill repositories and look for the best
   ones for the task; an imported skill gets a contract before entering the
   registry (see the tensions).
3. **Intake and breakdown:** the mechanism for breaking work down and defining
   the path through the graph. Distinguish two acts: synthesizing a topology (the
   design of a problem class) and breaking work into travellers (per execution).
   The breakdown produces tickets, not nodes — the path is frozen during the
   execution (principle 2).
4. **Execution:** the controller releases, the runner dispatches sessions with
   the skill injected, telemetry flows to the server.
5. **Optimization:** every execution ends with an evaluation step that proposes
   improvements; the proposal stays recorded and only applies when a user wants
   it to (principle 5, the safety ladder — confirmed in the dump).

## Decisions implicit in the dump (to be confirmed)

- The server owns the database; the runner never touches SQLite directly.
- The graph is versioned from day 1 (the improvement-proposal entity demands it).
- A node's skill comes from the database, rendered per engine (not from the
  target repository).
- The runner is registered with the server (explicit pairing), not magical
  discovery.

## Tensions and open questions

- **The supply chain of skills.** Scanning public repositories and injecting into
  a session is an attack vector (prompt injection, packaged). The registry needs
  a version/hash pin and a review gate at import: a skill is an artifact with a
  contract, validated before use — the same philosophy as the graph.
- **The contract of an imported skill.** A public SKILL.md rarely declares
  input/output/verification; the import needs a step that derives and records the
  contract, or principle 3 breaks silently.
- **A distributed runner.** With N runners, it needs a lease with a heartbeat
  (the work of a dead runner goes back to the queue) and idempotency in the
  records.
- **SQLite in the control plane.** It handles a single writer fine; if the server
  ever scales horizontally, the embedded database becomes the first thing to
  swap. Acceptable: it is exactly the kind of decision the execution log will
  justify swapping, or not.
- **The MVP in the right order (the README's starting condition).** Control plane
  + one EngineAdapter + ONE fixed graph ported from flowpilot, before the
  synthesizer. The synthesizer is the last piece, not the first.
