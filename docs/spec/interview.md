# Specification: the interview, from a description to a draft map

**API version:** `v1` · **Bundle:** [`factory-graphs/map-design/`](../../factory-graphs/map-design)
**Migration:** none — it reuses `session.output`
([`0020`](../../packages/core/migrations/0020_sessao_saida.sql)) and the
input-request tables of [`0003`](../../packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql)
**Founding requirement:** §3.3 (RF-14 to RF-20) — the person describes their
problem, names the class, and is asked **one question at a time**

The [synthesizer](synthesizer.md) turns a declaration into a draft in ONE
session: you write a paragraph, it hands back a topology, and everything you did
not say is something it guessed. The interview is the other half of that
sentence. It asks, waits, and asks again — and what it ends with is a map whose
every step somebody actually decided.

The claim the whole design rests on is §1.2 of the requirements: **the interview
is itself a map, not special code.** There is no chat engine here, no
conversation entity, no second dispatcher. It is a job on the `map-design` class,
travelling a two-node graph, asking through the same escalation grammar every
other node asks through.

---

## 1. Why a traversal, and not a chat

The platform has a hard constraint (§10.2): **there is no session resume.**
`EngineAdapter` v0 does not have it, and pretending otherwise would mean either a
long-lived process holding a model session open across a human's coffee break, or
a second mechanism nobody else uses.

What the platform DOES have is the escalation cycle, and it is exactly the same
shape as a turn of conversation
([human-escalation.md](human-escalation.md) §5, §6):

```
session asks → job blocks ON ITS OWN NODE → somebody answers → job unblocks
             → the next tick redispatches THE SAME NODE, with the whole
               exchange already written into the prompt
```

**Resuming is redispatching.** `buildPrompt`
([`packages/runner/src/dispatch/prompt.ts`](../../packages/runner/src/dispatch/prompt.ts))
has appended a `## What you already asked, and what came back` block to every
redispatch since t106 — the questions in log order, each with the answer that
closed it. A session that ends by asking is a **successful** dispatch, not a
failure (§6), so nothing counts it against the node's failure ceiling.

Which is why the `map-design` graph has **one edge and no self-loop**:

```
interview --always--> deliver
```

Twenty turns of an interview are twenty dispatches of `interview`. The job never
moves while it is asking, so there is nothing for an edge to describe. The single
edge is taken exactly once — on the turn that asks nothing, which is the turn
that says the map is finished.

**What this costs, and the recorded plan B.** One dispatch per question is one
process start per question. If that latency proves unbearable in real use, the
recorded alternative is a dedicated chat with `resumeFrom` — and the page reads
[the projection below](#3-the-conversation-projection) rather than the mechanism,
precisely so that swapping one for the other is not a rewrite of the screen.

---

## 2. What the interview produces, turn by turn

Every turn, the session prints its report **whole** — never a patch:

```
```resultado
{"done": false, "draft": {"graph": {…}, "skills": [{…}]}}
```
```

`interview` declares `contract.produces: "interview"`, so each turn's report
merges into the `input.interview` bucket in closing order
([`domain/context.ts`](../../packages/core/src/domain/context.ts)). Shallow merge,
last writer wins — so the LAST turn's `{done: true, draft}` is what `deliver`
reads at `input.interview.draft`. That is also why the draft is reported whole:
what a turn does not report is not there next turn.

There is **no routing key** in the block. The interview→deliver edge is
`always`, so there is nothing to label, and the whole payload is the report —
the same convention `skill-do-crossing.json` set (t259,
[`parse-node-result.ts`](../../packages/runner/src/dispatch/parse-node-result.ts)).

### The questions, in order

Per step, and one per session:

| Question | Where the answer lands | Requirement |
|---|---|---|
| what it needs before it can start | `contract.input_schema` | RF-19 |
| what it produces, and the labels its exits carry | `contract.output_schema`, and the `condition` of the edges leaving it | RF-19 |
| how you know it went well | `contract.checks` | RF-19 |
| **what usually goes wrong there** | `contract.checks` | RF-18 |
| whether it reaches outside, and through which server | the step's description, from `input.environment.mcp_servers` — plus, when nothing on that list fits, one `NEEDS_MCP_SERVER:` line in the question's own `context` | RF-20 |

RF-19 is **two** questions and not one: the output *schema* and the *checks* are
different fields and different judgements, and asking them together gets one
answer that half-fills both.

### `NEEDS_MCP_SERVER:` — the one machine-readable line in a freeform turn

RF-20's question has an extension (§3.3 of the requirements, and §1.4's *sugere,
nunca instala*): when the person names something **none** of the discovered
servers covers, the screen offers up to three candidates from the public MCP
registry, each with the command that would add it —
[`screen-interview.md`](screen-interview.md#6-when-the-machine-has-no-server-for-the-step)
is where that page is specified.

The signal it reads **cannot be a branch in code.** Every turn of this interview
is one freeform LLM dispatch (§1), so nothing in `packages/core` or
`packages/runner` is in a position to decide "this question is about a capability
nobody has". So the mechanism is the skill's own instructions asking for it: when
nothing on `environment.mcp_servers` covers what was just described — **including
when the list is `null`**, since "this engine cannot answer" is not "there is
nothing" — the turn puts one line, by itself, inside the question's `context`:

```
NEEDS_MCP_SERVER: <a short capability phrase>
```

Three things about it, and each one is a decision:

- **It names a capability, never a product.** `calendar`, not the brand of the
  one the model happens to know: the phrase is fed to a registry search, and a
  brand name narrows that search to a choice nobody asked for.
- **It is one more line inside `context`, and `context` is not typed by it.**
  That field has always been free text carrying prose — `cli/skill-import.ts`
  already puts a JSON blob in it beside its own — and this convention adds no
  schema, no new field and no change to the projection of §3, which passes
  `context` through verbatim.
- **It is enforced the way this skill's other rule is: by an agentic check.**
  `mcp-suggestion-hint-when-unmatched` (`skills/interview.json`'s `checks`, and
  the matching entry in the node's `contract.checks`) reads the turn's own
  question and the server list it was dispatched with, and confirms the line is
  there exactly when it should be — present for a step nothing covers, absent for
  one something does. Whether a model reliably gets that right is not something a
  deterministic test can pin, which is precisely what an agentic check is for
  (§4, and the check that already guards "one question, a whole draft").

Nothing about the line changes the draft, and nothing anywhere installs anything:
the person runs the command themselves, on their engine, and the next probe is
what tells the interview they now have it.

The class name comes first (RF-14, [D8](../../DECISIONS.md)): the person names
it, and a scoring class from `input.environment.similar_classes` is offered as
the *recommendation* — never as a decision. Every question carries a
`recommendation`, which is the value a person accepts in one click (RF-16), and
another answer is always possible.

### The skills they already have (the RF-14 extension, t440)

Right after the class name, and before the walk of the steps, the interview asks
one more thing: **do you already have skills or prompts you use for this kind of
work, and where?** A folder on this machine, or a git URL. Most people do — the
prompt they have been carrying between projects is the map they have already
half-drawn — and starting from it beats starting from nothing.

A "no" changes nothing at all: `skill_source` goes unreported and the interview
walks on. A "yes" is reported **beside** `done`/`draft`, never inside the draft:

```json
{"done": false, "draft": {…},
 "skill_source": {"kind": "path", "location": "/Users/somebody/skills"}}
```

`kind` is `path` for a folder and `git` for a URL. It is reported **once**: the
bucket merge of §2 is shallow and last-writer-wins *per key*, so a key no later
turn repeats keeps its value — which is exactly why the draft, whose whole
content is one key, has to be reported whole every time and this does not.

What the runner does with it is
[`resolve-skill-source.ts`](../../packages/runner/src/dispatch/resolve-skill-source.ts):
a folder is walked, a repository is cloned `--depth 1` into a scratch directory
beside the worktrees, read, and deleted. Every `SKILL.md` it finds goes through
the same derivation `cartografo scan-skill` uses (`deriveSkillDraft`, t439) and
comes back to the next turn at `input.environment.skill_drafts`, one draft
manifest each, with the format's placeholders where a human decision belongs.

Four rules, and each one is a decision:

- **Nothing at the source is ever executed**, and nothing from it is registered.
  A draft is a proposal a session adapts; it becomes a skill when a person runs
  Register (t432/t433), which is [D4](../../DECISIONS.md)'s gate and the only one
  anything imported crosses.
- **Adaptation is not a shortcut.** The instructions ask the session to start
  each step's manifest from the closest draft *and still ask every contract
  question* — what it needs, what it produces, how you know it went well, what
  usually goes wrong, which server. A manifest that carries the draft's own
  schema placeholder or its derived commands verbatim is a step nobody was asked
  about, and the new agentic check `skill-draft-adaptation-not-a-shortcut` is
  what reads the turn and says so.
- **`permissions` are never widened** past the safe default an imported skill is
  born with — read the workspace, write nothing, no network
  ([`skill-manifest.md`](../../specs/formats/skill-manifest.md)). Widening is a
  human decision at the import gate, and a draft is not that gate.
- **A source that will not read is relayed, not retried.**
  `environment.skill_drafts_error` carries the message — a folder that is not
  there, a workspace whose `allow_git_clone` is off (t439), a repository nobody
  could reach — and the interview puts it verbatim into its next question's
  `context` and moves on. Nothing loops on it.

Cloning is governed by the project's `allow_git_clone` setting, seeded `'true'`;
a runner reads it once, at the first source it is asked to resolve. The clone
uses whatever credential helper the machine already has — nothing is added for
authentication, so a private repository with none configured simply refuses like
any other unreachable URL.

**One manifest per step.** The draft carries a skill manifest for every node —
instructions, contract, permissions — so a map for a new domain has something to
pin. They are emitted **without `hash`**: computing the pin belongs to whoever
registers the bundle, and a hash the interview invented is a pin that will not
close ([D4](../../DECISIONS.md)).

### `input.environment`, and where it comes from

Two of the values the interview reads cannot be graph data, for the same reason
the test bench's path cannot be: they are facts about **this machine and this
installation**, and a graph version storing them would be wrong for every other
runner. So they arrive through the executor-environment seam
([runner-and-controller.md](runner-and-controller.md#the-executor-environment-what-only-the-machine-knows)):

- `environment.mcp_servers` — the servers this engine names, discovered **once
  per runner process** and shared with the operator probe. `null` — never `[]` —
  when the engine implements no discovery at all, because "I cannot answer" and
  "I found none" are different facts (t400 FR7).
- `environment.similar_classes` — the registered classes whose current version
  reads like this job's own title and body, best first, scored per dispatch.
- `environment.skill_drafts` / `environment.skill_drafts_error` — the drafts
  derived from the folder or repository this person named, and the reason there
  are none (t440). Resolved **once per job and per source**, for the reason the
  MCP list is resolved once per process: an interview is twenty dispatches, and
  re-cloning the same repository twenty times would be twenty reads of an answer
  that did not change.

The third of them is the reason this seam grew a parameter. `mcp_servers` and
`similar_classes` are facts about the machine and about the job's own words;
`skill_drafts` is derived from a fact a previous TURN reported, which lives
inside the control plane's projection at `input.interview.skill_source` and
nowhere else. So `createMergedInputResolver` computes the projection first and
passes it to the executor half as a third argument, rather than letting that half
fetch the same context route a second time — one read of one fact, and no race
with itself.

---

## 3. The conversation projection

`GET /v1/jobs/:id/conversation`

```json
{
  "turns": [{"question": "…", "answer": "…", "answered_by": "rafael", "at": "…"}],
  "pending": {"id": 7, "question": "…", "context": "…",
              "recommendation": "…", "options": ["…"], "default": "…"},
  "thinking": false,
  "draft": {"graph": {…}, "skills": [{…}]},
  "done": false
}
```

Assembled by [`domain/conversation.ts`](../../packages/core/src/domain/conversation.ts)
out of four reads the route already has cheap access to. It is **not** a second
door onto the input-request queue: `GET /v1/input-requests` still owns that, and
this route answers one page's whole question instead.

| Field | Where it comes from |
|---|---|
| `turns` | `input_request.created` events, in log order, each matched by entity id against the ANSWERED rows |
| `pending` | the single open row, with `default_answer` renamed to `default` |
| `draft` | the `draft` of the LAST completed session's `output` |
| `done` | `job.completed`, already derived |
| `thinking` | nothing pending, not done, and a session is `open` |

**Order from the log, answer from the projection.** `input_request.answered`
carries no `job_id`, so a job's timeline structurally cannot show it; `created`
is right there in id order. The same idiom `prompt.ts` uses to build the
redispatch block — and the two agreeing is what makes the page show what the next
session will be told.

**`default` and not `default_answer`.** The one rename on this wire, and it is
local to this projection: a chat page renders the vocabulary the fenced block
itself uses. `GET /v1/input-requests` is untouched.

**What `thinking` deliberately does not cover.** A lease granted with no session
open yet. That window is sub-second, and closing it would mean a new filter on
the lease table to describe a moment nobody observes on a page that refreshes
when somebody clicks.

Scoped like every other job read: absent `project_id` means project 1, and a job
of another project answers the same `404 not_found` an unknown id gets (t410).

**Consumed by the screen's `/interview/:id`** (t433), which renders it as a chat
beside the map it is drawing and reads nothing else — see
[`screen-interview.md`](screen-interview.md). The projection's own contract is
unchanged by that page: it was written for it.

---

## 4. The ladders

- **Asking is never a failure.** A session that ends with a question ended
  successfully (§6), and `max_consecutive_failures` is untouched by it. What that
  ceiling does cover is the session that ends with **neither** a question nor a
  draft.
- **Twenty questions.** The skill's own instructions bound the interview: past
  that, it closes with what it has and says in the draft which steps are still
  rough. A person who has answered twenty questions has given enough.
- **`escalation_policy: "always"`.** The `interview` node declares it, because
  asking IS the work it does — it is the one node in the repository where
  escalating is not a last resort.

---

## 5. What it does NOT do

| Does not do | Why |
|---|---|
| Register the draft | An abandoned interview leaves **no** `graph` row and **no** `skill` row. Registering is a person's act, at the screen (RF-25). |
| Compute the pins | `hash` belongs to whoever registers; a draft that pinned itself would pin content nobody approved (D4). |
| Resume a session | There is none to resume: redispatching with the history in the prompt is the mechanism (§10.2). |
| Change the input-request grammar | It asks through the grammar every other node already asks through. |
| Suggest skills from the REGISTRY | `similar_classes` is about the CLASS (D8). Composing a map out of the registry's own capabilities is still its own ticket — what t440 added reads a folder or a repository the person named, and touches the registry not at all. |
| Register what it derived | A draft derived from somebody's `SKILL.md` is a proposal in one session's report, exactly like every other draft here. D4's human gate is unchanged by it. |

---

## 6. Where it comes from

`up` imports the bundle on the first startup of a database that does not have it
([`cli/up.ts`](../../packages/core/src/cli/up.ts)), through the ordinary
`cartografo import` pipeline — the same local bundle check, the same manifests,
the same graph, re-verified by the registry on the way in. Nobody is going to
type an import command before their first interview, because nobody knows the
bundle exists.

It happens **before** the readiness line: a supervisor that reads that line and
starts using the control plane at once must not find the class missing. A second
startup finds the class registered and sends nothing. A bundle that will not
read is one line on stderr and a product that comes up anyway — a broken bundle
in some future release may not be the reason somebody's control plane will not
start.

The crossing itself is
[`factory-graph-map-design.e2e.test.ts`](../../packages/runner/test/controller/factory-graph-map-design.e2e.test.ts):
four scripted turns against a real control plane, a real `Controller` and real
leases, ending with a draft that `scripts/validate-graph.mjs` accepts — short of
the pin, which nobody has computed yet.
