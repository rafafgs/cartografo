# Skill manifest — specification

> A product format of cartografo. The manifest is what makes a capability — a
> skill that does or a skill that gates — enter the registry. Without a valid
> manifest, it does not enter (D4).

**State: a normative specification, with the registry implemented.** The
deliverable of this document is still the contract — a formal schema, examples
that validate and a fixture that is refused — and it is the contract that rules:
when the implementation and the schema disagree, the one that is wrong is the
implementation. What changed is that the registry now exists: the `skill` table
and the routes `POST /v1/skills`, `GET /v1/skills[/:id]` and
`PATCH /v1/skills/:id/:version` persist manifests and hand them back to whoever
queries capabilities. They enter through two paths, and the difference is D4: a
**native** skill (in-repo, already reviewed at the merge) enters together with
the bundle, through `cartografo import <bundle>`; a skill from an **external
repository** enters through the pipeline with a human gate,
`cartografo scan-skill` → `propose-skill` → `register-skill`. In both cases the
registry re-verifies everything on its own account — pin, shape, provenance —
because a human signature is not a verification. Since `t161` the registry is
also **read at execution time**: the runner fetches the exact version the node
pins, refuses the dispatch if the hash does not match the registry's, and renders
`instructions`, `checks` and `permissions` into the session
([`render-skill-instructions.ts`](../../packages/runner/src/dispatch/render-skill-instructions.ts)).
Since `t332` it also renders `command`, for a skill that declares one: a node on
the `shell` engine runs that argv instead of opening a session at all (see
*`command`*).
Since `t204` it also **interpolates** `{{input.<path>}}` inside `instructions`,
failing closed: a path that does not resolve aborts the dispatch before any
session is opened. What still does not exist is whoever **builds** that input —
in its absence the dispatch passes `{}`, and every skill with a placeholder
refuses (see *Rendering and injection*). Since `t215` the registry is a
**lineage**, not a single row: see *Version lineage* below. Still not
implemented: interpolation in `checks[].command`; and reading `budgets` into the
dispatch.

| File | What it is |
|---|---|
| [`skill-manifest.schema.json`](./skill-manifest.schema.json) | JSON Schema draft 2020-12; the normative definition. |
| [`examples/skill-manifest.develop.json`](./examples/skill-manifest.develop.json) | A complete example, `role: "work"` — a behavioural port of flowpilot's `feature-dev`/`development.py`. |
| [`examples/skill-manifest.verify-develop.json`](./examples/skill-manifest.verify-develop.json) | A complete example, `role: "gate"` — a behavioural port of flowpilot's `testing.py`. |
| [`examples/skill-manifest.shell-echo.json`](./examples/skill-manifest.shell-echo.json) | A complete example, `role: "work"` on the **shell** engine — the smallest manifest that declares a `command` instead of being run by a model (`t332`). |
| [`examples/skill-manifest.invalid.fixture.json`](./examples/skill-manifest.invalid.fixture.json) | A negative fixture, test material only: it proves the schema refuses a malformed manifest. |

## Why this format exists

The contract is the load-bearing piece (README, principle 3): without it the
synthesizer composes a graph by hallucination; with it, composing a graph turns
into matching contracts. D9 fixes the shape of the contract — input and output as
JSON Schema, verification as a list of typed checks, each check being either a
deterministic command or an agentic instruction with mandatory evidence. D4 fixes
who enters the registry: a skill with no contract does not enter, and an imported
skill enters pinned by hash and reviewed by a human.

The manifest is the object that carries that contract. It is what the database
stores, what the registry indexes, what the synthesizer reads when it queries
capabilities and what the runner renders into a session.

Two things the format has to carry, and carries in a field rather than in prose:

- **The role changes; the shape of the contract does not.** Everything that
  executes is a skill with a contract; what varies is the role (doing,
  checking). A gate is a skill like the others — what distinguishes it is
  `role: "gate"`, the obligation to have at least one check, and an output with
  `outcome`.
- **A gate verifies with evidence of its own.** Never with the self-report of
  whoever produced the artifact. That is coded into three places of the gate's
  manifest, not only into its text: `required_evidence` on the agentic check, the
  input field `artifact.declared_gates` marked explicitly as a self-report, and
  the deterministic check that runs the suite again instead of reading the
  `gates` the develop session declared.

## The fields

### Identification: `id`, `version`, `hash`

- **`id`** — a stable identifier, `kebab-case` (`^[a-z0-9]+(-[a-z0-9]+)*$`),
  unique in the registry. It is the key a node of the graph points at the skill
  by.
- **`version`** — semver. It moves with every diff approved at the human gate; it
  is the version chain that answers "why is the skill like this?" with a log
  instead of archaeology.
- **`hash`** — D4's content pin, in the form `sha256:<64 hex>`.

The hash is computed over the canonical JSON serialization (keys sorted, no
insignificant whitespace — RFC 8785) of the subset
`{instructions, input, output, checks, permissions, budgets, command}`:

```bash
node -e '
const fs=require("fs"),c=require("crypto");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const canon=v=>Array.isArray(v)?v.map(canon):(v&&typeof v==="object"
  ?Object.keys(v).sort().reduce((o,k)=>(o[k]=canon(v[k]),o),{}):v);
const sub={instructions:m.instructions,input:m.input,output:m.output,
           checks:m.checks,permissions:m.permissions,budgets:m.budgets,
           command:m.command};
console.log("sha256:"+c.createHash("sha256")
  .update(JSON.stringify(canon(sub)),"utf8").digest("hex"));
' specs/formats/examples/skill-manifest.develop.json
```

(The three examples of this directory carry the real hash: the command above
reproduces the value recorded in each of them, and
[`skill-manifest.test.mjs`](./skill-manifest.test.mjs) checks that on every
`npm test`, along with the five validation commands of the *How to validate*
section.)

What is **inside** the hash is behaviour: the text that will be injected into the
session, the data contract, what the skill may touch and for how long it may run.
What is **outside** it (`id`, `version`, `description`, `origin`) is catalogue
metadata. Renaming the skill or correcting the description does not invalidate
the pin; changing a line of the instructions, loosening a check, opening a
permission or stretching a budget moves the hash — which is exactly the change D4
wants to hold. A manifest whose hash does not match its own content is a tampered
manifest: it does not run.

Growing the subset is cheap on purpose: an absent field serializes to nothing
(`JSON.stringify` drops a key whose value is `undefined`), so only a manifest that
starts declaring the new field changes hash. That is how `budgets` entered
without touching the pin of any manifest already registered, and how `command`
entered after it (`t332`) — the field where this rule matters most, because on a
shell skill the argv is not a declaration about the behaviour, it **is** the
behaviour.

### Version lineage (D22)

The registry keeps one row per `(id, version)`, not one per `id`: the versions of
a skill **coexist**, like the versions of a graph (D15). `id` is the lineage,
`version` is a point on it, and that is what lets a skill's instructions improve
without breaking any graph pinned to the version that was running.

Four rules, and none of them is about the format — all of them are about the
registry, which is what enforces them:

- **Re-sending the same `(id, version)` with the same `hash` writes nothing.**
  `POST /v1/skills` answers `200` with the row that already exists, its
  registration stamp unchanged. It is what makes re-importing a bundle cheap
  instead of an error — and it is deliberately not an UPDATE: what is outside the
  hash (`description`, `origin`) keeps the value it entered with.
- **Re-sending the same `(id, version)` with a different `hash` is `409`.** One
  version cannot name two contents: every graph pinned to it would start running
  text nobody approved, which is exactly what pinning by hash exists to prevent
  (D4). The way forward is to raise the `version`.
- **A node never resolves "the latest one".** The runner fetches
  `GET /v1/skills/:id?version=<the one the node pins>`; what answers with the
  last living version is the read with no query, and it exists for whoever is
  *choosing* what to pin. Moving a node's pin is a proposal, like any change to
  the map (D15), and it is refused at application time if the registry does not
  carry that hash.
- **Retiring a version (`PATCH /v1/skills/:id/:version`) does not remove it.** It
  leaves "the latest one" and nothing else: it goes on resolving by `?version=`
  and by `?hash=`, and it goes on dispatching. Nothing is erased (D15), and a
  lineage whose versions have all been retired still answers — deprecating can
  never look like "this skill stopped existing".

Raising the `version` without changing the content is legal, and the registry does
not police it: the hash excludes `id` and `version` on purpose, so two versions
can carry the same hash. It is useless, it is not dangerous, and it is a matter of
human discipline.

### `role`

`work` (produces an artifact) or `gate` (checks another node's artifact).

There is no third role of "routing": routing is a consequence of a gate's
`outcome`, read by the executor to choose the edge, not a capability apart (D3,
and principle 2 of the README — the only in-flight decisions are the gates').

`role: "gate"` obliges `checks` to have at least one item, and the schema
enforces that. A gate with no check is a decorative gate — the honest limit of
principle 6.

### `description`

One line. It is what the synthesizer reads when it queries the capability
registry, so it describes what the skill **does**, not how.

### `input` and `output`

JSON Schema documents, embedded. The manifest's schema validates that they are
objects; validating them as JSON Schema is done separately, against the official
meta-schema, at the registry's door (the manifest's schema does not carry the
whole meta-schema inside itself).

`input` is what the node receives: the projection of the state that node needs,
never the whole context window (principle 4). `output` is what the session has to
return for the job to be considered finished.

**The gate's rule:** a manifest with `role: "gate"` declares in `output` an
`outcome` field with the enum `["pass", "fail", "escalate_human"]` — the three
results the executor knows how to interpret. That rule is verified at the
registry's door, along with the validation of `input`/`output` as JSON Schema;
this format's schema does not enforce it structurally (see *Known limits*).

### `preconditions`

A list of sentences: what has to be true of the state **before** dispatching the
session. The executor checks it before opening a session; an unsatisfied
precondition does not become a session that fails, it becomes a job that is not
released.

They are conditions about the state, not about the result — "isolated worktree
created" is a precondition; "green suite" is a check.

### `checks`

D9's typed verification. Every check has an `id` (stable within the skill — it is
what the telemetry aggregates by), a `description` and a `type`:

- **`deterministic`** demands `command`: one line of shell. Exit 0 = passed,
  anything else = failed. `timeout_s` optional. It is the preferred form whenever
  possible — running tests, validating a schema, building.
- **`agentic`** demands `instruction` **and** `required_evidence` (a non-empty
  array). It exists only where there is judgement no command resolves ("were the
  acceptance criteria met?").

`required_evidence` lists the artifacts the verdict has to cite. It is not
decoration: it is what stops an agentic check from concluding by reading code or,
worse, by reading the report of whoever produced the artifact. An agentic check
with no such list is the silent failure this directory's negative fixture exists
to catch.

**A check on a `work` skill is a self-check.** `develop`'s checks (green suite,
clean tree) are what the session runs before declaring itself ready — a
declaration, not a proof. What proves is the gate, with evidence of its own. That
is why the verification gate runs the suite **again**, instead of reading the
`gates` field the develop session filled in.

### `permissions`

`filesystem` (`read`, `write`) and `network` (`allowed`, `domains` optional).
Both required: the absence of a declaration is never read as "may do anything".

- Path patterns are globs. A **relative** glob is resolved from the root of the
  session's workspace; an **absolute** glob is literal (the example gate uses
  `/tmp/cartografo/**` as a scratch area precisely because it cannot write in the
  checkout it is judging).
- An empty array means **no access**, not "unrestricted".
- `network.allowed: false` closes the network; `domains` is ignored in that case.
- `network.allowed: true` **without** `domains` declares an unrestricted network.
  That is legal for a native skill, and it is refused at import (see *The import
  rule*).

**Declaring is not enforcing** — but, since `t161`, declaring reaches the
dispatch. This specification defines the declaration; t125 built the enforcement
in the adapter, and t161 connected the two: the runner resolves the registered
skill's `permissions` into the session, and what the skill declared is what the
session receives. Every axis also goes on holding as a reviewable contract and as
the basis of the permission diff between versions — a skill that opens a new
permission changes hash and comes back to the human gate.

**What the adapter cannot express, it refuses.** An axis the engine does not know
how to enforce opens no session at all: `claude-code` expresses "all writing or
none" and "network open or closed", and nothing in between, so `write` with a
glob halfway or `network.allowed: true` **with** `domains` make `startSession`
refuse before spending anything
(`packages/runner/src/engine/permission-policy.ts`). It is the right behaviour —
a session that silently enforces less than was declared is the one outcome a
permission system cannot have — and it is a real restriction on what a manifest
can declare today and still run.

### `budgets`

Optional, and every axis inside it too: `timeout_s` (wall clock) and `silence_s`
(seconds with no output at all). Both integers, minimum 1 — a budget of zero is
not a budget, and the schema refuses it.

They are two **independent** watchdogs, because they measure different things: a
session can stay alive and productive for an hour, and another can stall in two
minutes with the process still standing. The wall clock answers "this has already
cost too much"; the silence clock answers "this stopped happening". The silence
one restarts on every output of the process, so a session that talks is never
killed by it.

**Declaring shortens, never lengthens.** What the skill does not declare inherits
the server's ceiling; what it does declare holds if it is SMALLER than that
ceiling, and is ignored if it is larger (`resolveBudget`,
`packages/runner/src/engine/resolve-budget.ts`). A skill does not loosen its own
safety net — neither by accident nor on purpose — and that is why `budgets` goes
into the hash alongside `permissions`: both are declarations of behaviour, and a
change of behaviour comes back to the human gate.

**The state today, without make-up:** nothing reads a registered skill's
`budgets` into a dispatch. The reason stopped being "the rendering pipeline does
not exist" — `t161` built it, and `instructions`, `checks` and `permissions`
already cross over (see *Rendering and injection*) — and became simply that
`budgets` was left out of that ficha. What exists is the contract here, the
ceiling mechanism in the runner, and the enforcement in both adapters (case C9 of
the conformance kit). Until somebody connects the field, every session runs with
the server's ceilings.

### `instructions`

The Markdown body that will be injected into the session. It may contain
`{{input.<path>}}` placeholders, resolved by the runner against the validated
`input` before the dispatch.

The path is one or more parts of `[a-zA-Z0-9_]+` separated by `.`, walked one at
a time inside the `input`. A value that is a string enters **literally**, with no
escaping at all — the manifest was reviewed at the import gate (D4), and escaping
here would be the runner rewriting reviewed text. Any other JSON value (a number,
a boolean, `null`, a list, an object) enters as a compact `JSON.stringify`.

**Failing closed, and implemented since `t204`:** a path that does not resolve —
a missing key, or a path that walks through something that is not an object —
does not become text in the session. The dispatch is refused before a session is
opened (`UnresolvedPlaceholderError`, with every missing path at once), in the
same window where a divergent hash already refused. A body with no `{{input.` at
all renders byte for byte what it always rendered.

By convention, the same interpolation holds in `checks[].command` — it is what
lets a deterministic check be stable and still run the test command of the
project in question (`{{input.project.test_command}}` in both examples). That
half is **not implemented yet**, and not by oversight: no code executes a check's
`command` today, so there is nowhere to connect it. The rule holds identically for
when there is — a command that still contains `{{` is never executed.

### `command`

Optional, and what a **shell** skill runs instead of opening a session (`t332`).
A skill that declares none is every skill written before this field existed, and
every skill whose node runs on an agent engine.

```json
{
  "command": {
    "argv": ["/usr/local/bin/radar", "promote", "--since", "{{input.date}}"],
    "env_allowlist": ["RADAR_LEDGER"]
  }
}
```

- **`argv`** (required, at least one element) is the program and its arguments,
  spawned with **no shell in between**: no quoting, no globbing, no variable
  expansion, and exactly one element per argument. That is what lets a path with
  a space in it, a `$`, a backtick or a whole JSON document travel as data
  without anybody thinking about escaping — and it is why `argv[0]` is a program
  and never a command line.
- **`env_allowlist`** (optional) names variables of the **runner's own**
  environment the command may read. Absent or empty means the child inherits
  **nothing** — including no `PATH` — so a skill either spells an absolute path
  in `argv[0]` or allowlists `PATH` itself.

Two decisions that look arbitrary and are not:

- **`instructions` stays required, and its meaning is unchanged.** For a shell
  skill it documents the command for whoever reads the registry; it is not
  rendered into anything that executes, because there is nothing there to render
  into. Making it optional would have removed the one place a human reviewing an
  imported skill finds out what the argv does (D4's gate reviews text, not
  behaviour it has to infer from an argv).
- **The environment is closed by default**, which is the opposite of what an
  agent session gets. `README.md` records, as a known and accepted risk, that a
  session inherits the operator's whole shell environment; that is a
  compatibility decision about sessions that predate the risk being written down.
  A shell node has no such history, so it starts from nothing.

`{{input.<path>}}` is resolved in every element of `argv`, by the same resolver
and under the same fail-closed rule as `instructions` — an unresolved path aborts
the dispatch before any process is spawned. It is **not** resolved inside
`env_allowlist`: those are variable names, and which of the operator's variables
a command may read is not a decision a node's input gets to take.

`command` is inside the hash, alongside `permissions` and `budgets` and for the
same reason taken to its limit: an edit to the argv that left the pin standing
would be a skill whose whole executed behaviour moved under a version somebody
already approved.

This is unrelated to `checks[].command`, and the two stay independent: a check's
command **gates** an artifact after the fact, and this one **is** the node's
execution.

### `origin`

Provenance. `type: "native"` (written inside the project) or `type: "imported"`,
and in that case the schema starts demanding `repo`, `ref`, `imported_by`,
`imported_at` and `reviewed_by` — D4's gate signature, in a required field, so
that "it was reviewed" is nobody's recollection.

## Rendering and injection

The manifest lives in the database. It is not a file in the target repository,
and the system depends neither on `CLAUDE.md` nor on any resident markdown there:

1. The executor releases the node; the runner fetches from the API the manifest
   of that node's skill, at the version the graph pins (`id` + `version` +
   `hash`).
2. The runner asks the control plane for that node's context projection
   (`GET /v1/jobs/:id/context`) and receives the `input` ready — explicit state
   and the event log, never a shared window (principle 4). What builds it is the
   control plane, not the runner (D1: the one who writes to the database is the
   one who has the rows at hand without a second trip to the network).
   Validating the assembled `input` against the manifest's `input` schema —
   "invalid input does not become a session" — is the piece that is missing.
3. The runner checks the `hash` against the content received. Diverged, it does
   not run.
4. The runner renders `instructions`, interpolating `{{input.<path>}}`, and
   resolves the `command` of the deterministic checks the same way.
5. The runner hands the rendered text to the EngineAdapter, which opens the
   session. **How** the text reaches the CLI — a flag, stdin, an ephemeral file —
   is each adapter's decision and is outside the scope of this document (it is
   t99's interface).
6. The session returns a structured result; the runner sends it to the API at
   `PATCH /v1/sessions/:id/finish`, and it is the **control plane** that checks it
   against the registered skill's `output` schema before storing it. Only the
   server writes to the database (D1), and the same argument decides who judges:
   it is the one with the registry's row within reach, and it is the one that
   cannot accept an event it is unable to justify.

A consequence worth spelling out: because the contract lives in the database and
is rendered per engine, changing engine loses neither skill nor learning — what
was learned is in the versioned manifest, not in the context of a session.

**How much of that runs today (`t253`):** steps 1, 3 and 5 are implemented and
covered by tests. Step 4 really interpolates `instructions`, failing closed — a
placeholder that does not resolve refuses the dispatch before any session — and
does not resolve the checks' `command` (see `checks` and *Known limits*).

**Step 6 started really checking (`t253`).** `PATCH /finish` accepts an `output`
field, resolves the skill the session's node pins — the node id + the job's
`graph_version_id` → the snapshot → the `skill_ref` → the `(id, version)` row of
the registry — and validates the report against its `output`. A session with no
job, with no graph, or on a node the snapshot does not carry stores the report as
it came: there is nothing to check it against, and that is ordinary, not a
defect. A divergence **never** prevents the closing: `status`, `exit_code`,
`usage`, `models` and `transcript` are recorded as always, the row's `output` goes
to null and the `session.finished` event carries `output_schema_error` in place of
the value. The reason is this very document's — a work node's self-report was
never evidence, a gate verifies with evidence of its own — and losing the session
over it would leave the session open forever, with no route at all to close it.

**Step 2 came to exist in the control plane (`t253`).**
`GET /v1/jobs/:id/context` builds the `input` of the node the job is on: the
job's identity at `input.job` plus the class's `custom_fields` at the top level,
the graph's `project` object at `input.project`, the structured output of every
finished session in the bucket that node's `contract.produces` names (or at the
top level when it names none), and the escalations already answered at
`input.perguntas_respondidas`. The two new fields of the graph document —
`contract.produces` and `project` — are in
[`docs/spec/graph.md`](../../docs/spec/graph.md) and are additive: a graph
written before them holds and dispatches unchanged.

**The other half of that ficha was connected (`t259`).** The dispatch still
exposes the seam (`resolveInput`, in
[`dispatch.ts`](../../packages/runner/src/dispatch/dispatch.ts)), and its
production default is now that route
([`resolve-input.ts`](../../packages/runner/src/dispatch/resolve-input.ts)): what
`GET /v1/jobs/:id/context` returns under the `input` key is exactly the object
`{{input.<path>}}` resolves against. And the producer of the `output` the
projection reads came to exist too — every session whose node declares an output
schema is instructed to close the turn with the fenced block the section below
shows, and the dispatch sends the object on to `/finish`. The software factory
bundle declares `produces` and `project` and crosses `refine` → `develop` →
`integrate` alive. Still missing is `contexto_falha`, which is only filled in on a
rework cycle and is waiting for the ficha that exercises `test → develop` end to
end.

Besides the five fields the rendering cites, the runner injects into the session
the **node's own contract** (the input schema, the output schema and the checks,
which live in the graph and not in the manifest) and — since `t259`, on every
node that declares an output schema, gate or not — the reporting protocol: ONE
fenced block with the object that schema asks for, opened like this:

```resultado
{...exactly what this node's output schema declares}
```

On a node with two or more exits, the routing key goes INSIDE that same object,
naming the `condition` of the edge chosen, and not in a second block beside it.
The routing vocabulary is the **graph's**, never the `outcome` of the skill's
output — they are two different enums, on purpose
([`docs/spec/graph.md`](../../docs/spec/graph.md)).

**The routing key is reserved by the protocol (`t269`).** It travels in the same
object because the block is a single one, but it does not belong to this skill's
vocabulary: when it arrives as a usable label — a non-empty string after `trim` —
`PATCH /v1/sessions/:id/finish` takes it out before checking the report against
the pinned skill's `output`, and also before storing (`session.output` and the
`session.finished` event's `data.output` end up without it). Its name is the
graph's and is written down in [`docs/spec/graph.md`](../../docs/spec/graph.md);
here it does not appear between backticks on purpose, because there is no
manifest field by that name — the manifest's was renamed to `outcome` in `t178`.
Two consequences for whoever writes a manifest:

- **closing the `output` is safe.** `additionalProperties: false` without
  declaring the routing key — which is what `derrubar-tese@1.0.0` does — accepts
  the report of a node that routes. That was exactly the case the second
  traversal of the bets graph refused on every session, and a refused report
  **blocks** the node since `t268`;
- **declaring the routing key as a property of the `output` is not legal.** It is
  never checked and never stored, so declaring it describes a field that does not
  exist on the skill's side. A skill serves more than one graph, and a routing
  label belongs to a single graph.

A routing key that is present but is not a label (a number, an object, a blank
string) is not taken out: it stays in the object and a closed `output` refuses it
exactly as it always refused.

## The import rule (D4)

A public `SKILL.md` almost never declares input, output or verification. Without
a step that **derives and records** the contract, principle 3 breaks silently:
the skill enters the graph with nobody knowing what it consumes, what it produces
or how what it did is checked.

The reference case is concrete. The frontmatter of
flowpilot's `.claude/skills/feature-dev/SKILL.md` declares three things — `name`,
`description`, `user_invocable` — and nothing else: no input, no output, no
checks, no permissions. Eleven of the manifest's twelve required fields do not
exist at the origin.

The import is, then, a pipeline of assisted derivation with a human gate. Field by
field of the schema's `required`:

| Field | What the origin usually brings | How it is filled in at import |
|---|---|---|
| `id` | the frontmatter's `name` | Normalized to `kebab-case`; if it collides with an id already registered, it takes a prefix from the origin. A human decision when there is a collision. |
| `version` | nothing (a SKILL.md rarely versions) | Assigned on the spot: `0.1.0` for a new import. The origin's real reference lives in `origin.ref`, not here. |
| `hash` | nothing | Computed at the registry, over the **derived** manifest — never over the SKILL.md of origin. It is the pin D4 demands: any later edit to the imported text moves the hash and goes back to the gate. |
| `role` | implicit in the body | Inferred by reading and **confirmed by a human**. `feature-dev` is `work`. A mistake here is expensive: a doing skill registered as a gate becomes a gate that checks nothing. |
| `description` | the frontmatter's `description` | The one field that usually serves almost directly; reviewed to describe what the skill does, not how. |
| `input` | prose ("Input: a refined ticket in `workflow/wip/`") | Derived by assisted reading and written as JSON Schema by the reviewer. Where the prose does not say, the reviewer decides and records it — nothing is ever inferred silently. |
| `output` | prose ("Report: files created/modified, test counts, commit hash") | Likewise. For `role: "gate"`, the reviewer **has** to include `outcome` with the three values of the enum, or the executor does not know how to route. |
| `preconditions` | scope sections ("Scope — when this skill applies") | Extracted from those sections and rewritten as conditions about the state, verifiable before the dispatch. |
| `checks` | almost never exists in typed form | The most critical point. Commands cited in the body (`make test`, `make lint`) become deterministic checks; whatever judgement is left becomes an agentic check **with** `required_evidence`. If no check can be written at all, the skill does not enter: principle 6, without verification there is no gate. |
| `permissions` | never | **Never inferred from the text.** They enter with the safe default below, and are only widened by a recorded human decision. |
| `instructions` | the body of the SKILL.md | The body, **reviewed as an injection vector**: remove any reference to a file resident in the target repository (the manifest does not depend on `CLAUDE.md`), to an external document the origin controls, and any instruction that asks for a credential, an exfiltration or the execution of downloaded content. Paths and commands specific to the origin become `{{input.<field>}}` placeholders, or go. |
| `origin` | the URL it came from | `type: "imported"` plus `repo`, `ref` (a commit or a tag, not a branch — a branch moves), `imported_by`, `imported_at`, `reviewed_by`. The schema makes all five required when the type is `imported`. |

### The safe permission default for `origin.type: "imported"`

Every imported skill is born with:

```json
{
  "filesystem": { "read": ["**"], "write": [] },
  "network": { "allowed": false }
}
```

Read the session's workspace, write nothing, do not talk to the network. Widening
any of the three is an explicit human decision, recorded at the import gate, and
it moves the hash — which is to say, it comes back at the review of the next
version. In particular, `network.allowed: true` **without** a list of `domains`
is refused at import: a third-party skill with an unrestricted network and
instructions nobody wrote is the definition of the supply-chain vector D4 exists
to close.

### What the human reviewer signs

That the `role` is right; that `input`/`output` describe what the skill really
consumes and produces; that there is at least one check and that the agentic one
demands evidence of its own; that the `permissions` are the minimum necessary;
and that the reviewed `instructions` carry no hostile instruction. Signed, the
manifest enters the registry pinned by hash. Unsigned, it does not enter.

## How to validate

The artifacts of this specification are verifiable today, with no project
scaffolding, using `ajv-cli` through `npx`. From the root of the repository:

```bash
# 1. the schema is a valid JSON Schema (draft 2020-12)
npx --yes ajv-cli@5 compile -s specs/formats/skill-manifest.schema.json --spec=draft2020

# 2. the "work" skill example validates against the schema
npx --yes ajv-cli@5 validate -s specs/formats/skill-manifest.schema.json \
  -d specs/formats/examples/skill-manifest.develop.json --spec=draft2020

# 3. the "gate" skill example validates against the schema
npx --yes ajv-cli@5 validate -s specs/formats/skill-manifest.schema.json \
  -d specs/formats/examples/skill-manifest.verify-develop.json --spec=draft2020

# 4. the "shell" skill example validates against the schema
npx --yes ajv-cli@5 validate -s specs/formats/skill-manifest.schema.json \
  -d specs/formats/examples/skill-manifest.shell-echo.json --spec=draft2020

# 5. the negative fixture is REFUSED (a non-zero exit is the expected result here)
npx --yes ajv-cli@5 validate -s specs/formats/skill-manifest.schema.json \
  -d specs/formats/examples/skill-manifest.invalid.fixture.json --spec=draft2020
```

The first four exit 0; the fifth exits with something other than 0 — that is
what proves the schema is not too permissive.

All five run automatically on `npm test`, through
[`skill-manifest.test.mjs`](./skill-manifest.test.mjs), with `ajv` imported
directly instead of through `npx`: a gate that needs the network is a gate that is
red on a plane. The file also checks what no `ajv` would check — that the `hash`
recorded in each example reproduces its own content, and that this document's
hash recipe and the pinned subset have not drifted apart.

### The negative fixture

`examples/skill-manifest.invalid.fixture.json` is **not** an example of a
manifest: it is test material. It is a gate manifest that is valid in everything
else, with **one** deliberate violation — the `criteria-met` check has
`type: "agentic"` and does not declare `required_evidence`. A single, isolated
violation on purpose: the error ajv emits points at the exact rule, instead of
getting lost in a pile of missing fields.

```
instancePath: '/checks/0'
schemaPath:   '#/$defs/check/allOf/1/then/required'
keyword:      'required'
params:       { missingProperty: 'required_evidence' }
```

It is the rule that matters most to close: an agentic check with no mandatory
evidence is exactly the gate that concludes from the self-report of whoever did
the work.

## Known limits

What the schema does **not** guarantee, and is therefore verified at the
registry's door or left to another ticket:

- **`input`/`output` being real JSON Schema.** The schema only demands that they
  be objects. Validating against the official meta-schema is a step of the
  registry. A practical consequence since `t253`, when the control plane started
  compiling the `output` to check a session's report: an `output` that is an
  object but not a compilable schema is read as "there is nothing to check
  against", and the report is stored as it came. The alternative — refusing the
  report — would throw away a legitimate self-report because of somebody else's
  manifest.
- **The assembled `input` checked against the `input` schema.** The projection has
  existed since `t253` (`GET /v1/jobs/:id/context`), and "invalid input does not
  become a session" is still the eventual behaviour: it is the same ajv pointed at
  the other side of the contract, and it entered as a separate ficha so as not to
  open two validation surfaces at once.
- **`outcome` in a gate's output.** The rule is documented and the examples obey
  it, but it is not enforced structurally — enforcing it would require the
  manifest's schema to navigate inside an arbitrary JSON Schema document.
- **The `hash` matching the content.** The schema validates the form (`sha256:` +
  64 hex), not the value. Recomputing and comparing is the registry's job, at
  import and on every reading of the manifest by the runner.
- **A declared permission being an enforced permission.** Enforcement is t125, and
  `t161` connected the declaration to the dispatch. The limit that remains is
  another one, and it is the adapter's: an axis it cannot express refuses the
  session instead of enforcing it halfway (see `permissions`).
- **Interpolation in `checks[].command`.** The one in `instructions` has existed
  since `t204` and fails closed; the one in the checks' commands does not, because
  no code executes a `command` today — a check is declarative, read by a human
  reviewer and by a gate mechanism that does not exist yet. The limit that remains
  on the `instructions` one is whoever feeds it: the per-node context projection
  already exists in the control plane since `t253`, but the dispatch does not
  fetch it yet, so it passes `{}` and a skill with a placeholder refuses (see
  *Rendering and injection*).
- **Placeholder syntax validated at the registry's door.** The registry checks no
  `{{input.…}}` at all when it accepts a manifest; what catches a broken
  placeholder is the dispatch, which refuses. An earlier check would be better
  diagnostics, not more safety.
- **A new `version` changing the content.** The registry refuses the opposite —
  different content under an unchanged version is `409` (see *Version lineage*) —
  but accepts a new version whose hash equals an earlier one's. It is legal and
  useless, and policing it is human judgement, not a registry invariant.
- **A tooling detail:** the `origin.imported_at` field uses an ISO date `pattern`
  instead of `"format": "date"`. ajv in strict mode treats an unknown format as a
  compilation error when no formats plugin is loaded, and this document's
  validation command loads none — a `pattern` holds the same restriction without
  depending on a plugin.

## Versioning of this format

The manifest is a product format: a versioned schema and a specification
document, like the graph schema, the event taxonomy and the EngineAdapter
interface. The rule of two consumers holds — it does not freeze before two real
consumers exist (the control plane that persists, and an importer that derives a
manifest from an external source). Until then, a change of field is a change of
document plus a change of schema, in the same commit, with the examples
revalidated.
