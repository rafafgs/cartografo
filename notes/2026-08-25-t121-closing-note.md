# t121 closing note — the repository, read cold by a stranger

**Subject:** `NOTICE`, `docs/getting-started.md`, the README's pointer and its
invitation, the two Portuguese filenames earlier tickets deferred, and the
disclaimer on the asymmetric-bets bundle.
**Commits:** `5f89457` (the acceptance tests, red), `74ac682` (implementation and
both renames), then this note, on `ticket-121`.
**Written:** 2026-08-25, during development.

This is the ticket the 2026-08-14 body called "open source preparation", held
behind a gate that said not to release before the PoC was accepted against the
D16 bar. **Be exact about how that gate fell**, because the distinction survives
this note: Rafael lifted it himself, by direct instruction on 2026-08-25, and
not by any recorded acceptance. t109 has been `done` since 2026-08-18, closed by
him personally through an authorised direct write. No D16 acceptance record
exists, and nothing here should be read as claiming one does.

---

## What was actually missing

The repository could already be cloned and run before this ticket. t297 made the
README honest and audited every command in it; t303 made every package identity
English; t305, t306 and t307 settled the paths and redacted the notes. What a
stranger still hit was everything after "the server is up".

| Gap | What now closes it |
|---|---|
| No `NOTICE`, under a licence whose appendix presupposes one | `NOTICE`, two lines |
| No document showing how work gets ONTO the graph | `docs/getting-started.md` |
| Nothing pointing a reader at it | One paragraph at the top of "How to run it" |
| A licence grant, never an invitation | One paragraph closing "Origin" |
| A live investment workflow with no disclaimer | One sentence under the bundle's blockquote |
| `docs/o-que-e-o-cartografo.md`, Portuguese-named | `docs/what-cartografo-is.md` |
| The bets closing note, named after a bundle that no longer exists | `2026-08-24-t293-closing-note.md` |

## The document was executed, not reviewed

The founder's instruction was "write it from a cold start and then follow your
own instructions on a fresh clone", and that the execution — not a reading of
the prose — is the acceptance criterion. Both halves happened.

**The manual run.** A fresh `git clone` of this branch into a scratch directory,
`npm install`, then every step of the document in the order it publishes them.
The results, in full:

- `npx cartografo` came up and printed a `cartografo.ready` line carrying
  `database`, `migrationsApplied: 24`, `url` and a `bootstrapToken`. The
  document's example line is that line with the token and the checkout path
  replaced by marked placeholders, and nothing else altered.
- `npx cartografo-screen` came up on its own port against it.
- `npx cartografo import factory-graphs/software-development` printed the block
  the document quotes, byte for byte, `graph_version.id sha256:030c7fdd…`
  included; `npx cartografo status --json` then listed the class at that
  version.
- The `POST /v1/jobs` command, copied out of the document unedited, answered
  `201` with a job standing on `refine` — `current_node_id` equal to the
  `entry_node_id` it declared, `blocked: false`, `block_reason: null`.
- `/board` rendered the job under `refine`; the four other screen routes
  answered `200`; `GET /v1/jobs/1/events` returned the `job.created` entry with
  the data the job was born with.
- `GET /v1/input-requests?status=pending` returned `{"input_requests":[]}`, and
  `CARTOGRAFO_LOG_LEVEL=debug npx cartografo` started clean.

The whole suite is green on the final tree: 1,921 tests across the five
workspace groups and the root group, 0 failures, with `npm run lint` and
`npm run typecheck` clean.

The port used was not the default 4317, because another process on this machine
was already holding it. That is the one deviation, it touched no claim the
document makes — `url` renders whatever port is configured — and the default is
README's, unchanged.

**The automated run.** `packages/core/test/getting-started-doc.e2e.test.ts` is
the same walk, as a gate. It EXTRACTS its inputs from the document rather than
restating them: the bundle path comes out of the import command the document
publishes, and the request body out of its `curl`'s `-d` payload. A test that
hard-coded both would prove the control plane works — which four suites already
prove — and would go on passing after somebody edited the document into
something that does not.

## FR8 — the judgment call on `notes/execution-monitoring-prompt.md`

**Kept.** The founder asked for the call to be made and recorded either way;
this is it, and the reasoning rather than the verdict is the part worth having.

It is an internal operations prompt for a different tool — the flowpilot board
this project's work is scheduled on — and it does read oddly beside the specs.
Four things decided it:

1. **It is already redacted.** t307 swept it the same day: the machine paths are
   generalized, the references are not, and `tests/notes-redaction.test.mjs`
   holds both halves. Whatever should not leave a machine has already left it.
2. **No cold reader falls into it.** Nothing in `README.md`, in
   `docs/getting-started.md` or under `docs/` links a newcomer there. It is
   reachable by looking, which is what `notes/` is for.
3. **Deleting it would reverse a same-day sibling decision rather than build on
   one.** t307's whole design is "redact and keep", and its header says why:
   the notes hold the one record the README leans on as evidence against itself.
   A ticket that deletes one of them a day later is not applying that decision,
   it is quietly overturning it.
4. **It is a true record of how this project actually ran.** A repository
   published as a conceptual example is more useful, not less, for showing the
   operating discipline behind it — including the rule that said this very
   ticket stays put until Rafael released it himself.

## The two renames, and the sentences that could not simply be repointed

Both files' citations moved with them. Two sites did not take a mechanical
repoint, and the reason is the same in both: their SUBJECT is the retired
spelling.

- t282's closing note, item 6, said "`docs/o-que-e-o-cartografo.md` is still
  Portuguese-named".
- t305's closing note said the `FROZEN_TREES` entry was about the historical
  filenames under the folder, and named the bets note as the live example.

Repointing either sentence would have made it false. Repointing neither would
have left a path resolving to nothing, which is the exact failure
`tests/notes-rename-integrity.test.mjs` exists to catch. So both keep the name
they were written about, drop the dangling `notes/` prefix that made it look
like a live path, and gain the pointer to where the file is now. A dated note
records what was true that day; falsifying one to satisfy a rename would be the
opposite of the repair.

The bets note itself is the one exception to that discipline, and by the
founder's own reading rather than by a rule: `bets-assimetricas` names a bundle
that has existed nowhere in this tree since t306, and the note's own subject is
that translation — so the filename was a dangling reference, not a record. Its
H1 already said `t293 closing note`.

## Files touched outside the ticket's declared surface

Two, both worth knowing about.

**`tests/notes-redaction.test.mjs`** — required, not optional. Its AT6 governs
every file that existed under `notes/` when t307's redaction ran, and FR4/FR5
edit five of them (t281, t282, t303, t305, t306) to repoint a citation. The
gate's only mechanism for a legitimate edit is its `TOUCHABLE` list — its own
header says a ticket that edits a governed note **without** declaring it still
fails — so the five are declared there with the reasoning beside them. Worth
being precise about the cost: AT6 governs a wider set than the redaction
CHANGED, and all five sit in that gap. t307 read every one of them and left
every one of them alone. AT1–AT5 still sweep them on every run, so nothing here
can put an identity or a machine path back.

**`tests/readme-onboarding-claims.test.mjs`** — new. AT3 asks for "a new or
extended prose-claims test (modelled on `tests/readme-status-claims.test.mjs`)"
and the Code Changes table names no home for it. A new file was the choice: it
leaves a shared gate untouched, and the two claims it holds — the pointer, and
the invitation — are a different subject from the status line's honesty.

## Gotchas

- **A paragraph assertion has to join its lines first.** The disclaimer
  assertion went red against a disclaimer that was there: this repository wraps
  at eighty columns, so "is not investment advice" arrived split across a line
  break and no expression looking for it in the raw block could match.
  `tests/readme-status-claims.test.mjs` had already recorded this and its
  `paragraphsOf` joins on a space. Copy that reading, not the shape of it.
- **`git diff --name-only` reports a rename as its NEW path only.** That is why
  AT6 of the redaction gate never flagged either `git mv` here, and only flagged
  the five content edits. A gate reading a diff for governance is reading
  post-rename-detection names, which is the right answer here and would be the
  wrong one for a gate asking "what was removed".
- **The `notes/` exclusion in the path-segment sweep now covers nothing.** After
  the rename no tracked path under `notes/` trips a retired stem. It is kept and
  its header says so in as many words: what it protects is the next dated note,
  and whether any particular filename is a record or a dangling reference is a
  judgment the founder makes ticket by ticket — not one a stem sweep can make.
- **`npx cartografo` refuses a second start against the same database, and 4317
  is a busy port on a machine running more than one checkout.** Nothing is
  wrong; set `CARTOGRAFO_PORT`. It cost a confused minute here.
- **The screen still announces itself in Portuguese.** Its readiness event is
  `cartografo.tela.ready` and its board renders `<title>quadro · cartografo`.
  Runtime strings, outside every gate this ticket touches and outside its
  surface — but the first thing a stranger sees when they follow step 2 of the
  new walkthrough, so it is worth its own ticket.

## Seen and deliberately left

- **D18's amendment now reads oddly.** `DECISIONS.md` still says the file this
  ticket renamed "stays in Portuguese"; it has been English inside since t299
  and is English-named since this ticket. Only its citation was repaired here.
  Rewriting the claim would be amending a recorded decision, which stays
  Rafael's act — and t305 set exactly that precedent on this exact file.
- **`docs/getting-started.md` is not in the reader-document sweep's list.**
  `tests/no-portuguese-reader-documents.test.mjs` reads a hand-written set plus
  two directories, and a new top-level `docs/` file joins neither. It is not a
  hole: `tests/no-portuguese-document-tree.test.mjs` content-sweeps the whole
  `docs/` tree with the same two signals and reads this file today. Widening the
  first list is a tidy-up, not a repair.
- **`package.json`'s `description` is still Portuguese**, in the root manifest
  and in three of the workspaces. The ticket puts it out of scope by name. It is
  the field npm shows first, so it belongs to whichever ticket publishes.
- **Nothing was published.** Creating the public repository, the announcement,
  npm, Docker and the release automation are Rafael's act and frozen (t216,
  t248–t251). This ticket makes the repository worth reading; it does not make
  it public.
