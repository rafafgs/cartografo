---
name: feature-dev
description: Orchestrates new feature development following the full 4-phase protocol
user_invocable: true
---

# Feature Development Orchestrator — FlowPilot

You are the feature development orchestrator for FlowPilot. Follow this protocol exactly.
Reference [DECISIONS.md](../../../DECISIONS.md) for architectural decisions — especially
§9.4 (quality loop) and §3.4 (execution adapter isolation).

**TDD is the default protocol** (DECISIONS §9.4 build gate). Acceptance tests are written and
confirmed red before any implementation begins. Exceptions (pure migrations, wiring,
docs-only) must be stated explicitly in the development plan.

## Scope — when this skill applies

This is the MANUAL process (DECISIONS §15): it governs interactive Claude Code sessions
working on FlowPilot itself, over the file-based **F-tickets** in `workflow/`. Since
self-hosting, the **t-series** tickets live in the product's own DB and are developed by the
embedded flow-engine skills (`app/services/flow/skills/`) — those agent sessions never read
this file. Use this skill for an F-ticket, or when the founder wants a piece of work driven
interactively instead of through the product's flow.

## Input

A refined ticket in `workflow/wip/` (move it there via `git mv` when starting), or a feature
description for tight follow-up work.

## Phase 1: Classify & Read

### Step A: Classify Scope

This skill handles **new functionality**. If the task is fixing a defect → use `/bugfix`.

### Step B: Architecture Checks (CRITICAL)

- **Execution engine involved?** Anything that runs agent sessions goes through the
  execution adapter interface — nothing above the adapter may reference Claude specifics
  (model names, CLI flags, token env vars). See DECISIONS §3.4.
- **New table?** SQLite-first dual-dialect discipline (rules/backend.md rule 7). No
  multi-tenancy concepts, ever.
- **New background job?** APScheduler registration gated by `SCHEDULER_ENABLED`; jobs must
  be idempotent and safe to re-run.
- **User-facing strings?** i18n en (default) + pt-BR in lockstep from the first commit.

### Step C: Read Required Docs

1. `.claude/rules/backend.md` + `.claude/rules/frontend.md` — non-negotiable conventions
2. `docs/*.md` Known Gotchas tables (those that exist) — the learning-gate injection:
   read the gotchas relevant to the layers you will touch
3. DECISIONS.md sections related to the ticket

### Step D: Classify Complexity

| Type | Criteria | Execution Path |
|------|----------|----------------|
| **Standard** | Entity/endpoint/page following an existing reference pattern | Builder agents with the reference named |
| **Complex** | Custom business logic, state machines, controller/adapter work | Plan carefully; builder agents with detailed contracts |
| **Non-CRUD** | Dashboard, background job, integration, wizard step | Sub-agents directly |

## Phase 2: Plan & Validate

### Step E: Present Development Plan

Present this plan to the user and WAIT for explicit approval before writing code:

```
## Development Plan: [Feature Name] (F{NNN})

### Complexity: [Standard | Complex | Non-CRUD]

### Layers to Implement
1. Model — [...]
2. Migration — [dual-dialect notes]
3. Repository — [...]
4. Schema — [...]
5. Service — [...]
6. Routes — [...]
7. Frontend Service — [...]
8. Pages/Components — [shadcn components]
9. i18n — [en + pt-BR keys]
10. Tests — [service + route + frontend]

### Acceptance Tests (written FIRST)
- [test 1: behavior/scenario] — file: tests/test_X.py::TestY::test_z
- [...]

### TDD Exceptions (if any)
- [layer — reason per DECISIONS §9.4]

### Risks / Notes
- [adapter isolation, dialect concerns, shared-file impacts, responsive considerations]
```

### Step F: Get Approval

Do NOT proceed until the user explicitly approves the plan.

## Phase 2.5: Write Failing Tests (Red Gate — MANDATORY)

1. Write each acceptance test from the plan.
2. Run them (`make test` / `make test-front` or targeted paths).
3. **Confirm the failures are for the right reason** — missing implementation, NOT import
   errors, fixture problems, or typos. A test failing for the wrong reason is not a valid red.
4. Recommended: commit the red tests separately — `test(F{NNN}): add acceptance tests (red)`.

**Gate:** do NOT proceed until all acceptance tests exist, fail for the right reason, and the
output was shown to the user.

## Phase 3: Execute

Delegate construction to the builder agents (keeps strong-model sessions for planning):

- **Backend**: `Agent` tool with `subagent_type=backend-builder` — name the failing test paths,
  the modifications needed, and the reference pattern to follow. The agent runs the tests
  first to see the contract and implements until green. It must NOT modify the tests.
- **Frontend**: `Agent` tool with `subagent_type=frontend-builder` — same contract
  (shadcn/Tailwind, not MUI).
- **Parallel**: if backend and frontend are independent, launch both in one message.

## Phase 4: Verify & Document

### Step G: Run the full gates

```bash
make test
make test-front
make typecheck
make lint
```

If any acceptance test from the plan still fails, the feature is NOT done — return to Phase 3.

### Step H: Feature Checklist

- [ ] All layers implemented in order
- [ ] Migration applies on SQLite (and Postgres if configured)
- [ ] Backend + frontend tests pass; typecheck + lint clean
- [ ] i18n keys added in en AND pt-BR (lockstep test green)
- [ ] Routes registered; navigation entry added if user-facing
- [ ] UX Quality Bar (rules/frontend.md) if UI was touched: states designed, 3 viewports
- [ ] No anti-patterns introduced (rules files)
- [ ] Adapter isolation preserved (if execution engine touched)

### Step I: Update Documentation (documentation contract — DECISIONS §9.4, part of DoD)

1. Update/create the relevant `docs/*.md` for what this ticket introduced (new subsystem →
   new doc; existing area → extend it).
2. If this ticket establishes a new canonical pattern (first entity of its kind), add its
   "canonical reference files" block to `.claude/rules/backend.md` / `frontend.md`.
3. Docs are part of DoD — a feature without its documentation is NOT done.

### Step J: Capture Learnings (learning gate — MANDATORY)

Fill the ticket's "Gotchas to capture" section and run `/capture-learning` for each
non-obvious fix, quirk, or wrong assumption discovered. This is part of DoD, not optional.

### Step K: Commit + Move Ticket + Report

```bash
git mv workflow/wip/F{NNN}-{name}.md workflow/done/
git add -A && git commit -m "feat(F{NNN}): <short description>"
```

**Committing is part of completion, not optional** — a ticket left green-but-uncommitted in
the working tree is NOT done (F003 acceptance lesson: acceptance had to commit on the dev
session's behalf). The red-tests commit (Phase 2.5) + the feat commit are the minimum
history evidence of the TDD contract.

Report: files created/modified, test counts, docs updated, learnings captured, commit hash.
