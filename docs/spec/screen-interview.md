# Specification: the interview page

**Package:** [`packages/screen`](../../packages/screen) · **Port:** `4318` ·
**Pages:** `/interview`, `/interview/:id`, `/graphs/:class`
**Founding requirements:** §3.3 (RF-15, RF-16, RF-21 to RF-25) and RNF-04 ·
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
this address".

---

## 2. The page itself

`GET /interview/:id` reads **one route** — `GET /v1/jobs/:id/conversation` —
and renders two columns.

**The left column, in this order of precedence:**

| State | What is drawn |
|---|---|
| every closed turn | question and answer, oldest first, in the order the log recorded the questions |
| `pending` is set | the open question with its context, recommendation and default, one button per option, and an answer `<textarea>` with a visible `<label>` tied by `for`/`id` |
| `done` is true | the closing state, carrying the two actions of §4 |
| anything else | "thinking" |

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

## 6. What this page does not do yet

Every item is another ficha's declared scope, not an oversight:

- **Session resume, or any transport other than the three-second poll.** The
  recorded plan B of `interview.md` §1 stays future work, and the whole point of
  building against the conversation projection is that adopting it later costs
  this page nothing.
- **Editing the drafted map's steps before registering.** The interview is the
  only way to shape it (`interview.md` §5), unchanged.
- **An "interview history" or "in-flight interviews" list.** Finding one you
  started earlier is unchanged: `/board` and `/jobs/:id` already show it, like
  any other traveller.
- **Deleting or abandoning an interview.** Already true with no action at all:
  an abandoned interview simply never reaches §4, and leaves no `graph` row and
  no `skill` row behind.
- **Starting on a class other than `map-design`, or on a version other than its
  current one.** There is no fork or variant entry point here (D13).
