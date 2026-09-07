# Specification: the interview page

**Package:** [`packages/screen`](../../packages/screen) · **Port:** `4318` ·
**Pages:** `/interview`, `/interview/:id`, `/graphs/:class`
**Founding requirements:** §3.3 (RF-15, RF-16, RF-20's extension, RF-21 to
RF-25), §1.4's *sugere, nunca instala*, and RNF-04 ·
**Founding decisions:** [D11](../../DECISIONS.md) — "the screen is a client of
the public API, with no privileges" · [D4](../../DECISIONS.md) — "a skill is
pinned by content, and agent-authored content is an injection vector"

The [interview](interview.md) has existed since t360 and had no door. It is a
job on the `map-design` class, asking one question per turn through the ordinary
escalation grammar, and the only way to hold a conversation with it was the
generic queue at `/input-requests` — which shows a question and says nothing at
all about the map being drawn on the other side of it.

This is the page that closes that: **a chat on the left, the growing map on the
right**, and, once it is over, the two things a person can do with what it drew.

One sentence sums up the boundary, and it is the one this ticket was designed
around: **the page reads the [conversation projection](interview.md#3-the-conversation-projection)
and never a job, a session or an input request by name.** Today the mechanism
under it is one dispatch per question (`interview.md` §1's recorded plan A); if
the latency of that proves unbearable, the recorded plan B is a dedicated chat
session with `resumeFrom` — and swapping one for the other costs this page
nothing, because the page never saw the mechanism.

---

## 1. Starting one

`GET /interview` is a form with **two fields**: a title and a free-text
description of the problem. Nothing else, and in particular not the name of the
class the map will register as — that is the interview's own FIRST question
(RF-14, [D8](../../DECISIONS.md), `interview.md` §2), and a form that asked for
it would be asking for something it is about to be asked anyway.

**Finding one already running (t459).** Above the form, this page also lists
the interviews **still open**: every job whose `entry_node_id` is `interview`
(written once at creation and never changed afterwards) and whose `completed`
flag is still `false` — a finished interview, arrived at `deliver`, never
appears here. This is one of two doors t459 opened; the other is `/board`'s
own card, which now links to `/interview/:id` instead of the ordinary job
console whenever a job's `entry_node_id` reads `interview`. Before this
ticket nothing on the whole screen linked back to an interview in flight, and
the generic queue at `/input-requests` showed a bare question with none of
the map being drawn beside it.

Ordering is `/board`'s own: the six-state derivation first (`awaiting_you`,
`blocked_unasked`, `running`, `unowned`, `completed`, `queued`), oldest wait
first within a state — never by when the interview was started. An item whose
state is `awaiting_you` or `blocked_unasked` carries the same left-edge
attention bar `/board` draws, for the same reason
(`docs/spec/design-system.md` §8): it is the one state this product exists to
make noticeable, and an interview waiting on an answer is exactly that.
Twelve or fewer render as cards; past that the list becomes a table, one row
per interview — the same threshold and the same reasoning as `/board`'s own
row mode (`docs/spec/design-system.md` §7.7). With none open, the list still
renders, carrying an explicit line rather than silence, so a person — or a
test — can tell "checked, none open" apart from "this feature isn't there".

Each item is a link to `/interview/:id` and nothing more: no block/unblock
form, no demo badge — those are job-console actions with no place in this
page's own vocabulary (§2 below).

`POST /interview` reads `GET /v1/graphs/map-design` for the class's
`current_version_id` and creates an ordinary job:

```json
{"title": "…", "body": "…", "entry_node_id": "interview", "graph_version_id": "sha256:…"}
```

Both constants come straight off
[`factory-graphs/map-design/graph.json`](../../factory-graphs/map-design/graph.json)
and neither is a choice offered to whoever filled the form: there is no fork or
variant entry point here, and the version is the class's **current** one asked
for at submit time, so an interview always starts on the map the control plane
is actually serving.

A blank title, or a blank description, is refused with **400 before either
network call** — the same convention every other write of this screen uses. An
interview with no description is an interview whose first question has nothing
to work from.

**When the class is not there.** `cartografo up` imports that bundle on the
first startup of a database that does not have it, before it announces itself
(`interview.md` §6), so a missing class means the import failed. `GET /interview`
says exactly that and points at the control plane's own startup log, instead of
translating the upstream 404 into the generic "the control plane does not know
this address" — and it draws no still-open list at all in that case: no
interview job can exist for a class the control plane never registered.

---

## 2. The page itself

`GET /interview/:id` reads `GET /v1/jobs/:id/conversation` — the whole of what
it draws — and renders two columns. Since t373 there is one read beside it,
`GET /v1/settings`, and it decides nothing about the conversation: it says which
engine's `mcp add` spelling §6's suggestions are written in, and a failure to get
it falls back to the default engine rather than failing the page.

**The left column, in this order of precedence:**

| State | What is drawn |
|---|---|
| every closed turn | question and answer, oldest first, in the order the log recorded the questions |
| `pending` is set | the open question with its context, recommendation and default, one button per option, and an answer `<textarea>` with a visible `<label>` tied by `for`/`id` |
| `done` is true | the closing state, carrying the two actions of §4 |
| anything else | what the step is writing right now (`conversation.partial`), or "thinking" when it has written nothing yet |

**What the last row draws changed with t465.** For the whole of a turn that can
take minutes it said the one word "thinking" while the step was writing the map
the entire time. It now shows that writing: the runner decodes the lines it has
buffered so far — with the very function the finished transcript is decoded by,
so nothing redraws when the turn ends — and sends them, throttled to the poll's
own three seconds, to `PATCH /v1/sessions/:id/partial-text`. The projection
reports the text as `Conversation.partial`, under exactly the condition
`thinking` holds, and the page renders it in place of the static line, in its
own `.partial` element. `null` — nothing running, nothing written yet, or a
question waiting — is still the placeholder, unchanged.

The last row is wider than `conversation.thinking` and deliberately so. The
projection sets that flag only when a session is actually open, which leaves a
fourth case it allows and does not name: nothing pending, not done, and no
session yet — every interview between the moment it is started and the moment a
runner picks it up. To the person waiting, that reads as "working on it", so
"thinking" is the default and not a state of its own.

**The right column** is `renderMapDocument(draft.graph, draft.skills)` — the
same [map document](../../packages/screen/src/map-document.ts) `/graphs/:class`
draws, with no second renderer anywhere. A `draft` that is `null`, or that
carries no graph, renders "nothing to draw yet".

One consequence worth naming, because it looks like a bug and is not:
**RF-20's external-I/O line never appears mid-interview.** That line is drawn
from a manifest matched to a step's `skill_ref` on all three of id, version and
hash (D4), and a draft's manifests carry no `hash` at all — computing the pin
belongs to whoever registers (`interview.md` §5). So the line appears on
`/graphs/:class`, where the pins are closed, and nowhere else.

**The vocabulary.** Every string a person reads on these pages says *interview*,
*map*, *step*, *question* and *answer* — never *job*, *runner* or *input
request*. The rule is about what is READ: the route paths, the `data-*` markers
and the class names are identifiers and are outside it.
`packages/screen/test/interview.test.ts` sweeps every page this specification
describes for the three forbidden words.

---

## 3. The poll, and what it may not break

`GET /interview/:id/fragment` answers:

```json
{"chat": "<article …>…", "map": "<ol>…</ol>", "done": false}
```

`chat` and `map` are **the exact inner-HTML strings the full page rendered into
its two columns**, computed by the same two functions
([`interview.ts`](../../packages/screen/src/interview.ts)) — which is why the
page and the poll cannot come to say different things. It is asked for by that
page's own script and linked from nowhere.

**Pre-escaped HTML and not the raw conversation.** The island assigns what comes
back to `innerHTML`, so `escapeHtml` has to stay on the server's side of the
wire: a page assembling markup out of an agent's words itself is exactly the
injection vector D4 names.

| The contract | Value |
|---|---|
| interval | 3000 ms |
| first poll | one interval after the page loads, never immediately |
| stops | the first response whose `done` is `true` |
| never starts | when the page's own initial `done` is already `true` |
| on failure | this tick is dropped and the next one is scheduled |

**The poll can now animate content, not only toggle between fixed states**
(t465). `chat` used to change only when the interview did — a question arrived,
an answer landed, the interview ended — so two consecutive polls of a step that
was thinking returned the same bytes. Since the thinking state carries the text
being written, consecutive polls of one unchanged state legitimately differ.
Nothing about the contract above moves: same interval, same stop condition, same
focus rule, same `{chat, map, done}` shape, and `interview.js` is untouched —
the swap has always handled arbitrary HTML inside `#chat`.

**Focus preservation.** Before each swap the island looks at what has focus; if
it is inside `#chat` and the incoming HTML still declares an element with that
`id`, the typed value goes back in and so does the focus. The **id** is the
handle and not the `name`, and that is the whole reliability of the rule: the
answer field is `answer-<question id>`, so a new question is a new id and
nothing is carried over — while `name` is always `answer` and would happily
carry one question's half-typed answer onto the next.

**It is pure progressive enhancement** (RNF-04). With
[`interview.js`](../../packages/screen/src/public/interview.js) absent, blocked
or failing to load, the whole page still works — the start form, the chat, the
answer form and both closing buttons are plain HTML — and reloading is the
update, exactly as on every other view of this screen. Its only effect is that
nobody has to. It is the second of the two self-refreshing pages `screen.md` §1
names, and the narrower one: one script, one page, only while the interview is
running, swapping the inner HTML of two elements and nothing else.

---

## 4. Answering, registering, exporting

All four writes of these pages carry `isTrustedScreenOrigin` **before anything
else** — before the id is even parsed — exactly like every other write of this
screen (t192).

**`POST /interview/:id/answer`.** The question is not named in the form and does
not have to be: an interview has at most one open question by construction
(`createInputRequest` blocks the traveller in the same transaction), so the
route re-reads the projection and answers whatever is open. That is also what
makes a stale tab harmless — it can only ever answer the question actually being
asked. A blank answer is a 400 before the network. It redirects (303) to
`/interview/:id`, which is reread from the API: the question disappears because
the state changed, not because the form hid it.

**The draft is re-read at write time, never taken from the POST body.** It can
be arbitrarily large, and it is not this form's to edit — the interview is the
only way to shape the map (`interview.md` §5) — so a draft arriving from a
browser would be a second, forgeable author of the one write this screen makes
with real consequences.

Both actions refuse, with **400 and before any further call**, when
`conversation.done` is false or `conversation.draft` is `null`.

**`POST /interview/:id/register`** then hands the draft to
[`register-map.ts`](../../packages/screen/src/register-map.ts), which closes
every pin and walks `cartografo import`'s own order: manifests one at a time,
the graph only after every one of them was accepted. The status mirrors what
actually failed, and never collapses onto one code:

| Where it stopped | Answer |
|---|---|
| a pin does not close (`stage: 'pin'`) | **422**, listing every `PinProblem` |
| the registry refused a manifest (`stage: 'skill'`) | the upstream status and body, verbatim, naming the step |
| the registry refused the graph (`stage: 'graph'`) | the upstream status and body, verbatim |
| accepted | **303** to `/graphs/<the draft's own class>` |

The success redirect closes the loop into this page's other half: somebody who
just registered a map wants to be looking at it.

**`POST /interview/:id/export`** calls
[`export-bundle.ts`](../../packages/screen/src/export-bundle.ts) and answers the
bytes directly — `application/zip`, `content-disposition: attachment;
filename="<class>.bundle.zip"` — so a plain form POST triggers a download with
no script involved. `buildBundleZip`'s own refusal becomes a 422 listing every
problem, the same shape the pin refusal takes.

A refusal renders the screen's ordinary ad hoc error page, the same convention
`submitAnswer` and `submitFlag` already use for their 400s. A friendlier
in-page failure — flash messages, keeping the rest of the form's state — is a
future ficha if it turns out to matter.

---

## 5. The read-only map

`GET /graphs/:class` needs **no new route on the core's side**: a lineage's `id`
IS its `problem_class` (D8), so `GET /v1/graphs/<class>` already answers.

Three reads: the lineage, then its `current_version_id`'s snapshot, then — in
parallel — `GET /v1/skills/:id?hash=<the step's pinned hash>` for every step's
`skill_ref`. Those manifests are the `manifests` argument `renderMapDocument`
takes for its RF-20 line. A pin that fails to resolve, for any reason, degrades
to "no manifest for that step" and never to a page that refuses to draw the
other eleven — the grace `map-document.ts` already documents.

A class never registered, or one with no current version, answers the screen's
ordinary **404**.

---

## 6. When the machine has no server for the step

RF-20's question asks which server a step reaches outside through, offering the
names the engine actually reports (`interview.md` §2). When the answer is "none
of those", the turn writes one line into the question's own `context` —
`NEEDS_MCP_SERVER: <capability>`, the convention
[`interview.md`](interview.md#needs_mcp_server--the-one-machine-readable-line-in-a-freeform-turn)
specifies and an agentic check enforces — and this page turns it into up to
three candidates from the public registry.

**It suggests and it never installs** (§3.3 of the requirements, and §1.4's
*sugere, nunca instala*). That is a statement about the markup and is asserted
directly on it: the suggestion block contains **no `<form>`, no `<button>`, and
no `href` whose target is anything but the candidate's own `homepage`**. The way
a person gets the server is that they read the command, run it themselves on
their engine, and press **Check again** — t401/t402's recheck, untouched here.
The next probe reports the new server, `environment.mcp_servers` carries it on
the interview's next redispatch, and the turn after that stops asking.

### The catalogue

[`mcp-catalog.ts`](../../packages/screen/src/mcp-catalog.ts), an ordinary HTTP
client with no new dependency — global `fetch` and `AbortController`, the same
posture `client.ts` keeps.

```ts
interface McpServerSuggestion {
  name: string; description: string; homepage: string | null;
  install: { claude_code: string | null; codex: string | null };
}
interface McpCatalog { search(query: string): Promise<McpServerSuggestion[]> }
```

`officialRegistry()` asks
`GET https://registry.modelcontextprotocol.io/v0/servers?search=<capability>&limit=3`
and reads the envelope that address actually returns (measured 2026-09-07):
`{"servers": [{"server": {…}, "_meta": {…}}], …}`, where `search` is a substring
match on the server's `name`. Per entry:

| Field | Read from |
|---|---|
| `name` | `server.name`, verbatim — it is also the local add name |
| `description` | `server.description` |
| `homepage` | `server.websiteUrl`, else `server.repository.url`, else `null` |
| `install.*` | derived from `server.packages[]`, and only for two `registryType`s |

**The two runtimes, and no third.** An `npm` package becomes `npx -y
<identifier>` and a `pypi` one `uvx <identifier>`, each wrapped as
`claude mcp add <name> -- <command>` or `codex mcp add <name> -- <command>` —
the only two `mcp add` shapes this repository has evidence for
([`packages/mcp/README.md`](../../packages/mcp/README.md) and t400's captured
`codex mcp add` in [`engine-adapter.md`](../formats/engine-adapter.md)). Every
other case — a `remotes`-only entry, a `docker`/`oci`/`nuget` package, no
packages at all — leaves **both** `install` fields `null`, and the card says
"no known add command; see its homepage" instead. Inventing a flag for those
would put an unverified command beside a measured one with the same authority,
which is the failure t402 already named and refused once here.

**The result is sliced to three** on this side, whatever `limit` came back with.

**The failure posture is the same one this page already takes toward a control
plane that is down: a registry that does not answer in time renders the question
with no suggestions, never an error.** `search()` **never rejects.** A network
failure, a non-2xx, a three-second timeout, a body that does not parse and a body
that parses into a shape nobody expected all resolve `[]`, and the question
renders whole — its context, its recommendation, its answer form — with zero
cards and no error text anywhere on the page.

### The cache, and why its two TTLs differ

`cachedCatalog()` wraps it in an in-process `Map` keyed by the exact query,
built **once at server construction** and never per request.

| What came back | Reused for |
|---|---|
| one or more candidates | 5 minutes |
| nothing — which, per above, includes every failure | 30 seconds |

The asymmetry is the point, and it is a lesson this product already paid for
once: t434 found `discoverMcpServers()` on the runner's startup path costing
2.1–3.3s because nothing bounded a repeat call. One layer up, §3's three-second
poll would re-attempt a down registry — timeout and all — twenty times a minute.
Thirty seconds is ten polls: often enough that a registry coming back is noticed
promptly, rare enough that one that is down costs almost nothing. The figure is a
judgement, not a measurement.

### What the page renders

`GET /interview/:id` and `GET /interview/:id/fragment` each read the conversation
and `GET /v1/settings` **in parallel**, and consult the catalogue only when
`conversation.pending` exists AND its `context` carries the hint — so an ordinary
question, which is nearly every question, costs not one extra request. A settings
read that fails degrades to the default engine rather than failing the page; the
only thing riding on it is which of two spellings a command is shown in.

Both routes call the SAME resolver and the same renderer, which is how t433's
"the page and the poll can never disagree" keeps holding over this new content.

The block sits between the question's `<dl>` and its answer form, and each card
carries, in order: the candidate's `name`, its `description` (escaped — it is
somebody else's prose), the add command for the engine in force in a
`<pre><code>` (or the "no known add command" line), a plain link to its
`homepage` when it published one, and then, once per card and verbatim:

> not reviewed by anyone on your side; configure its credentials on the engine,
> not here.

An `engine` setting this product does not recognize renders the same
"no known add command" line as an unrecognized runtime does — to the person
reading, "we do not know your CLI" and "we do not know this server's runtime" are
one instruction, which is to go and read its homepage.

---

## 7. What this page does not do yet

Every item is another ficha's declared scope, not an oversight:

- **Session resume, or any transport other than the three-second poll.** The
  recorded plan B of `interview.md` §1 stays future work, and the whole point of
  building against the conversation projection is that adopting it later costs
  this page nothing.
- **Editing the drafted map's steps before registering.** The interview is the
  only way to shape it (`interview.md` §5), unchanged.
- **A dedicated `/interviews` route, or a history of finished ones.** t459 gave
  this page the still-open list of §1 and gave every interview's `/board` card
  the right link — `entry_node_id: "interview"` always resolves to
  `/interview/:id`, whether the job is still running or sits in the
  `completed` band — but a new page for a handful of rows the board already
  bands correctly was explicitly rejected (`docs/spec/design-system.md` §7.7).
  A finished interview is found the same way any other arrived job is: on
  `/board`.
- **Deleting or abandoning an interview.** Already true with no action at all:
  an abandoned interview simply never reaches §4, and leaves no `graph` row and
  no `skill` row behind.
- **Starting on a class other than `map-design`, or on a version other than its
  current one.** There is no fork or variant entry point here (D13).
- **A second catalogue** beside §6's official registry — Smithery, a private
  index. `McpCatalog` is the seam that makes one a new implementation instead of
  a new branch, and nothing beyond `officialRegistry` is built.
- **Installing, running or configuring an MCP server**, or holding any credential
  for one. The person runs the shown command themselves, on the engine, outside
  cartografo — §6 is the whole of what this page does about it.
- **Suggesting *skills*** from any catalogue. `interview.md` §5 already lists that
  as something the interview does not do, and §6 does not change it: what is
  suggested is a server for a step, never a step.
