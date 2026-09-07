# Artifacts: the files a session produces

A session runs in a worktree and leaves things behind — a build log, a report, a
screenshot, a bundle. This document is how those leave the worktree: through a
storage interface with one local implementation, with the database keeping a
reference and never a path (RF-38), and with nothing ever deleting either half
(RF-42).

## Two different words, one spelling

**`docs/spec/graph.md` already uses the word "artifact" for something else**, and
the two senses are unrelated:

- there, an artifact is a node contract's `produces`/`consumes` **bucket** — a
  small JSON object passed from node to node through the job's custom fields. It
  never touches a disk;
- here, an artifact is a **stored file**: bytes, a media type, a name, and a row
  in the `artifact` table.

Neither is renamed, because both names are already in use where they are. When a
document means the bucket it says "the `produces` bucket"; when it means the file
it says "a stored artifact" or names this document.

## The interface

`packages/core/src/artifacts/store.ts` declares the whole of it:

```ts
interface ArtifactStore {
  put(source: Buffer, meta: { name: string; mediaType: string }): Promise<{
    ref: string;
    sha256: string;
    size: number;
  }>;
  open(ref: string): Readable;
  exists(ref: string): boolean;
}
```

Three properties are the contract, and everything else is an implementation
detail:

- **`ref` is opaque.** It is a content address, meaningful to the store that
  produced it and to nothing else. No caller reads it, splits it, or joins it
  onto a root. `packages/core/test/artifact-paths-guard.test.ts` enforces that by
  reading the source: a string literal containing `artifacts/` in a
  path-building position anywhere under `packages/core/src`, outside the local
  store itself, fails the suite.
- **The store is content-addressed.** Identical bytes are one stored object,
  whoever uploaded them and whatever they were called. `put` of content that is
  already there writes nothing and answers the same triple — dedupe is a
  consequence of the addressing, not a feature somebody maintains.
- **There is no way to remove anything.** No `delete`, no `expire`, no `prune`,
  on the interface or on the table. See below.

The app receives its store at construction (`AppOptions.artifactStore`,
`packages/core/src/server.ts`), built once at startup
(`packages/core/src/index.ts`). A second implementation — object storage, say —
is a different value passed there, and touches no route and no repository. It
stays unwritten until there is a real second consumer, which is this project's
standing rule for an extension point.

### The local implementation

`packages/core/src/artifacts/local-store.ts` stores files beside the database:

```
<dirname of the database file>/artifacts/<sha256[0:2]>/<sha256>
```

Two levels, the way git stores objects, for the same reason. `ref` is the sha256
hex digest itself. A new file is written to a temporary name inside the same
directory and `rename`d into place, so a crash mid-write can never leave a
partial file at a content address other readers are already using. Every entry
point validates the ref against `^[0-9a-f]{64}$` before touching the filesystem —
defense in depth, since a ref only ever originates from this module's own hash.

An operator who moves `CARTOGRAFO_DB_PATH` moves the artifacts with it, and a
copy of the directory is a copy of both halves.

## The table

`packages/core/migrations/0030_artifacts.sql`:

| column | what it holds |
|---|---|
| `id` | the artifact's id on `/v1` |
| `session_id` | the session that produced it |
| `name` | the name the producer gave the file |
| `media_type` | what the producer said it is |
| `size` | bytes, as stored |
| `sha256` | hex digest of the content |
| `storage_ref` | the store's own opaque address |
| `created_at` | when the row was written |

There is **no `project_id`**: the table inherits the partition through
`session_id`, which is D25's rule for a table hanging off a partitioned one. The
project of a session is read off its own `session.opened` event, exactly as
`GET /v1/sessions/:id/transcript` already reads it.

There is **no paired event**, because there is no state transition to record: the
table is append-only by construction, and the row *is* the fact that the artifact
was created.

`storage_ref` is the one column that never reaches `/v1`. Publishing it would tie
the wire contract to whichever `ArtifactStore` is configured, and a client that
learned to read a digest out of it would break the day a second implementation
answers something else.

## The HTTP surface

| route | answers |
|---|---|
| `POST /v1/sessions/:id/artifacts` | `201` with the artifact. Raw body; `content-type` is the media type and the `x-artifact-name` header is the name — `400` without either, `404` for an unknown session, `413` over the size cap |
| `GET /v1/artifacts/:id` | `200` with the artifact's metadata |
| `GET /v1/artifacts/:id/content` | `200` with the bytes, `content-type` and `content-length` from the stored row |
| `GET /v1/sessions/:id/artifacts` | `200` with `{artifacts: [...]}` |

The three reads are scoped to the caller's project, resolved through the owning
session. An artifact of another project answers the **same `404`** an unknown id
answers, and never a distinct "forbidden" code: a reference may not cross a
project boundary, so from outside it does not exist — and a second code would
leak which ids are taken elsewhere.

The upload's ceiling is `CARTOGRAFO_ARTIFACT_SIZE_CAP_BYTES`, a positive integer
of bytes, defaulting to 32 MiB. It is enforced as the route's body limit, so an
over-sized upload is refused before a byte is buffered.

None of the four routes is on the runner credential's allowlist
(`RUNNER_SURFACE`, `packages/core/src/auth.ts`). A runner that needs to upload
gets that decision taken explicitly, in the ticket that writes the caller.

## Nothing ever deletes an artifact

**No route, no repository function and no store method removes an artifact, and
none is planned** (RF-42). An artifact is the evidence of what a session did, and
evidence that can be removed is evidence nobody can rely on: a graph the surveyor
proposes to change, a gate that failed, a cost that surprised somebody — all of
those are re-read long after the session that produced them ended. The row is
append-only and the bytes are content-addressed, which means even overwriting is
not a thing that can happen: the same address always holds the same content.

Disk is therefore monotonic. An operator who has to reclaim space does it
deliberately, from outside this system, knowing what they are dropping.

## An artifact is stored exactly as it was received

The disclosure `README.md` makes about session transcripts extends, word for
word, to whatever an artifact holds. Nothing redacts, scrubs or masks the bytes
on the way in: a log that echoed a credential is at rest in the artifact
directory, under a name derived from its own content. Treat that directory the
way you treat `.cartografo/cartografo.db`, a shell history or a CI log.

The control plane cannot do better than that and should not pretend to: it does
not know what a secret looks like in an arbitrary file format, and a redaction it
performed badly would be worse than the honest statement — it would make people
believe the file was safe to share.
