# Specification: the exported history

**Format:** `cartografo-history/1` · **Command:** `cartografo export-history` ·
**Migration:** none (it reads the `event`, `session` and `input_request` tables
of [`0003`](../../packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql))
**Origin:** RF-41 and RF-42 — "a traversal's history is exportable in an open
format, and nothing in it is deleted by an automatic routine".

This document is the contract for whoever reads a history file. It is
deliberately self-sufficient: a whole reader can be written from it without
opening a line of the control plane's code. It is the offline, portable
counterpart of [the outbound stream](events-stream.md), which serves the
present, and of `GET /v1/executions/:id/events`, which serves one round over
HTTP.

---

## 1. What it is

A **JSON Lines** file: one JSON object per line, each terminated by `\n`, with
no array around them and no comma between them. Line 1 is a **header** with the
scope and the map version; every line after it is one **fact** of the traversal,
in ascending `id` order.

```bash
cartografo export-history --job 41                  # ./job-41.history.jsonl
cartografo export-history --execution 7 --out r.jsonl
```

Exactly one of `--job` and `--execution` is required; neither, both, or an id
that is not an integer is a wrong command line (exit `2`), refused before the
first request. `--project <id|name>`, `--url` and `--token` work as on every
other subcommand.

**Export only.** There is no `import-history`: the log is append-only with
server-assigned ids, so importing one installation's history into another would
mean inventing how to merge two logs — and D1 keeps the control plane the sole
author of its own. A file is a record to read, keep and diff, never a write
back.

**It is a point-in-time snapshot.** Running the command again over the same job
produces a **longer** file, never a different past: what is already written is
append-only, so the lines of the first export are a prefix of the lines of the
second, up to the `exported_at` of the header and to projections that have since
reached a later state (a session that has closed since, a question that has been
answered).

---

## 2. Line 1: the header

```json
{"kind":"header","format":"cartografo-history/1","exported_at":"2026-09-06T19:57:39.882Z",
 "project":{"id":1,"name":"default"},
 "job":{"id":41,"title":"…","current_node_id":"develop","graph_version_id":"sha256:…","…":"…"},
 "graph_version":{"id":"sha256:…","class":"software-development",
                  "problem_class":"software-development","parent":null,"metadata":{"…":"…"}}}
```

| Field | What it is |
|---|---|
| `kind` | always `"header"` — the discriminator every line carries |
| `format` | `"cartografo-history/1"`. A reader that does not know the version refuses the file rather than guessing |
| `exported_at` | when the export ran, ISO-8601 |
| `project` | the `id` and the `name` of the project. Both, because an id alone identifies nothing on the machine the file is read on |
| `job` | `GET /v1/jobs/:id`, **verbatim**. Only on a job-scoped export |
| `execution` | `GET /v1/executions/:id`, **verbatim** — the round's counts and its end. Only on a round-scoped export |
| `graph_version` | the map the scope was travelling, or `null` |

`job` and `execution` are mutually exclusive: exactly one of the two keys is
present, and it is what says which scope the file covers.

### The map, and when it is `null`

`graph_version` is built from `GET /v1/graph-versions/:id` (`id`,
`parent_version` republished as `parent`, `snapshot.problem_class`,
`snapshot.metadata`) plus `GET /v1/graphs/:graph_id` for `class` — the version
carries no class of its own, only its lineage does.

It reads `null`, and a reader must handle it, in four cases:

- the job has no `graph_version_id`;
- the id it has no longer resolves (a version, or its lineage, is gone). This is
  the same "no graph at all" reading the control plane itself gives that case,
  and not a distinct one: an export is never refused over a missing map;
- **round scope**, when the round's jobs do not all share exactly one
  `graph_version_id`. A round can legitimately cross versions — that is why
  `GET /v1/executions/:id/metrics-by-version` groups by version in the first
  place — and one map cannot honestly stand in for two;
- **round scope**, when the round has no job at all.

---

## 3. The body: one line per fact

Every line after the header carries `kind` and `id`. **`id` is the event's id**
on every kind of line, and it is the ordering key of the whole file: strictly
ascending, with no tie, from line 2 to the end.

### `{"kind":"event", …}` — the envelope, untranslated

```json
{"kind":"event","id":7,"type":"job.blocked","project_id":1,"execution_id":9,
 "entity":{"type":"job","id":41},"actor":{"type":"system","ref":"runner"},
 "occurred_at":"2026-09-06T19:57:37.214Z","data":{"reason":"waiting on a decision"}}
```

The event exactly as [the taxonomy](../../specs/events/taxonomy.md) publishes
it, with `"kind":"event"` in front of it and nothing else changed. An event type
this format has never heard of still reaches the file whole.

### `{"kind":"session", …}` — an agent session, enriched

```json
{"kind":"session","id":4,"session_id":1,"job_id":41,"execution_id":9,"node_id":"refine",
 "engine":"claude-code","status":"completed","exit_code":0,"usage":null,"models":null,
 "output":null,"transcript_truncated":false,"transcript_original_size":5,
 "opened_at":"2026-09-06T19:57:36.997Z","finished_at":"2026-09-06T19:57:37.187Z"}
```

It **replaces** the `session.opened` event, at that event's id, with the whole
`Session` projection `GET /v1/sessions` answers — as it stands at export time.
So a session still running when the export ran simply reads `status:"open"`,
`finished_at:null`; nothing is missing and nothing is invented.

The one field left out is **`transcript`**: unredacted text of unbounded size,
which would make a history unreadable to carry. Its size and its truncation flag
ride along, and the text itself stays a per-session fetch at
`GET /v1/sessions/:id/transcript`.

### `{"kind":"input_request", …}` — a question, enriched

```json
{"kind":"input_request","id":6,"input_request_id":1,"input_request_kind":"question",
 "job_id":41,"session_id":null,"execution_id":9,"node_id":"refine","question":"ship it?",
 "options":null,"recommendation":null,"default_answer":null,"auto_approvable":false,
 "status":"answered","answer":"yes","answered_by":"rafael","source":"user",
 "created_at":"2026-09-06T19:57:37.214Z","answered_at":"2026-09-06T19:57:37.394Z"}
```

Same rule: it **replaces** the `input_request.created` event with the whole
`InputRequest` projection, answer included.

### The renamed fields, and why there are exactly three

`kind` and `id` belong to the line. A projection field of the same name is
republished **prefixed with the line's kind** rather than dropped or allowed to
win — which moves exactly three fields in this whole format:

| Projection field | On the line |
|---|---|
| a session's `id` | `session_id` |
| an input request's `id` | `input_request_id` |
| an input request's `kind` (`"question"`, …) | `input_request_kind` |

Both ids are facts a reader needs — one to fetch the transcript, the other to
cite the decision — and the third says what was being asked.

### What is dropped, and why nothing is lost

`session.finished`, `input_request.answered` and `input_request.auto_resolved`
do **not** appear in the file: their facts are already in the enriched line
above, which carries the projection's current state. That is what makes the id
sequence a strict subsequence of the log's own order — no line is ever added,
only enriched or removed, so "ascending by id" holds with no tie to break.

The rule is one algorithm for both scopes, which matters most for round scope:
`GET /v1/executions/:id/events` really does carry those three endings, and
without the fold the file would state the same fact twice under two shapes.

### One known gap

`session.permission_denied` carries no `job_id` in its payload, so a
**job-scoped** export cannot see it — the same limitation `session.finished` has
on `GET /v1/jobs/:id/events`. A **round-scoped** export over the same session
does see it, as an ordinary `{"kind":"event", …}` line. Closing the gap means
changing that event's own contract, which is a different piece of work.

---

## 4. Reading the file

```javascript
import { readFileSync } from 'node:fs';

// Every line but the last is complete: a file cut mid-write ends in a partial
// line with no `\n`, and dropping the tail of the split is what leaves it out.
const lines = readFileSync('job-41.history.jsonl', 'utf8').split('\n').slice(0, -1);

const [header, ...facts] = lines.map((line) => JSON.parse(line));
console.log(header.project.name, header.graph_version?.class ?? 'no map');
for (const fact of facts) {
  console.log(`#${fact.id} ${fact.kind} ${fact.type ?? fact.status ?? ''}`);
}
```

Zero dependencies, like [`events-stream.md`](events-stream.md) §8's own
consumer. The whole reader is: **for each complete line, `JSON.parse`.**

**A partial file stays readable.** The writer emits one line per write and never
assembles the file as one string, so a line is never split across two writes: a
file interrupted by a full disk, a `Ctrl-C` or a killed process is a valid
history up to its last complete line. `jq` reads such a file line by line for
the same reason, and so does `head -n`.

---

## 5. What is deliberately not in it

- **Import.** See §1.
- **Filtering and redaction.** The export is the record as stored. Session
  output and the questions asked are kept **unredacted** — the same caveat the
  README makes about transcripts applies to everything here, and a file that
  leaves the machine leaves with it.
- **The raw transcript text** (§3), and any artifact content: this codebase has
  no artifact or attachment entity, so there is nothing of the kind to reference.
- **Pagination.** One scope fits one file, the same choice
  `GET /v1/executions/:id/events` already made for one round in one response.

---

## 6. RF-42: nothing is deleted

Nothing in the history is removed by any automatic routine of this phase, and
the guarantee is one of code rather than of convention: no module of
`packages/core/src/` may issue a `DELETE` against `event`, `session` or
`input_request`, and
[`packages/core/test/no-history-deletion.test.ts`](../../packages/core/test/no-history-deletion.test.ts)
sweeps the tree for it. `UPDATE` on `session` and `input_request` is not
guarded, and must not be: closing a session and answering a question are
legitimate writes on those two projections. `event` keeps the stricter rule of
[`event-append-only.test.ts`](../../packages/core/test/event-append-only.test.ts)
— there, an update would be a fact rewritten.
