# Atlas and bundle — v0 specification

> **Status:** v0 exercised end to end against both factory graphs, **not
> frozen**. The rule of two consumers
> (`notas/2026-08-14-extension-and-quality.md:57-63`) demands two real consumers
> before a format is locked, and today there is **one** atlas: the mirror of this
> very repository. Until the second one exists, what is written here is a
> convention with an automated gate, not a frozen contract.
>
> **This document's gates:**
> [`scripts/publish-atlas-bundle.test.mjs`](../../scripts/publish-atlas-bundle.test.mjs)
> (the publication step: refusal, copy, idempotency, a multi-class atlas) and
> [`packages/core/test/cli-atlas-publish.test.ts`](../../packages/core/test/cli-atlas-publish.test.ts)
> (the whole round trip: publish → commit → clone → import, with the same
> `graph_version.id` and the same pin per skill). Architectural judgement is a
> human gate.

## Why this document exists

[`docs/spec/graph.md`](../spec/graph.md) §7 ends exactly where this one begins:
"one graph, one file, self-contained". The graph document is already the minimal
exportable bundle — but a graph on its own does not run, because every node pins
a skill by version and by hash (D4), and the pin only closes if the manifest
travels with it. What is left to specify is the packaging of **several graphs,
each with its manifests**, crossing the border into a repository that is not this
one.

That packaging has a name in the project: D14 calls the factory library the "seed
of the shareable atlas", and the extension note
(`notas/2026-08-14-extension-and-quality.md:50-56`) treats the atlas as the
product's network effect — the community contributes **maps**, not only code. The
atlas is the file form of that sharing.

## The layout

An atlas is a directory — in practice, a git checkout — with **one subdirectory
per problem class**:

```
atlas/
  desenvolvimento-de-software/
    grafo.json
    skills/
      desenvolver-ticket.json
      implantar-release.json
      integrar-branch.json
      refinar-ticket.json
      testar-alpha.json
  bets-assimetricas/
    grafo.json
    skills/
      analisar-assimetria.json
      ...
```

Three rules, and nothing beyond them:

1. **The directory's name is the `classe`** of the graph document, exactly as the
   file spells it. The class is the map's identity (D8) and the versioning root;
   the directory adds no identity at all, it only reflects the one that already
   exists.
2. **Every subdirectory is a bundle**, in the shape
   [`docs/spec/graph.md`](../spec/graph.md) and
   [`especificacoes/formatos/skill-manifest.md`](../../especificacoes/formatos/skill-manifest.md)
   already define: one `grafo.json` and one `skills/` holding a manifest per
   file, whose name is the skill's `id`.
3. **There is no index file, catalogue or atlas manifest.** The directory is the
   index. An index would be a second place where the truth lives, and it would go
   out of date exactly when it matters — on a third party's contribution, which
   is the atlas's whole use case.

That is why `grafos-de-fabrica/<class>/` in this repository and
`<atlas>/<class>/` in an atlas checkout are **the same thing**, and
interchangeable inputs to the same command:

```sh
cartografo import grafos-de-fabrica/desenvolvimento-de-software   # from here
cartografo import ../atlas/desenvolvimento-de-software            # from the atlas
```

An atlas may carry files that are not a bundle — `README.md`, a licence, a CI
workflow. The importer never reads them; the publisher never touches them.

## Integrity: two hashes that already exist

This format **introduces no new hash**. The end-to-end verification is done with
the two mechanisms the system already has, and that is precisely why it is
verifiable without trusting whoever published it:

| What | Where it lives | What it proves |
|---|---|---|
| `graph_version.id` | computed in the control plane, the canonical hash of the whole document (`docs/spec/entities-versioning.md` §2) | that the map that went in is byte for byte the one that came out — reimporting has to reproduce the same id |
| `skill_ref.hash` of every node | inside `grafo.json`, pinning the manifest's content (D4) | that the manifest beside it is the manifest the graph's author reviewed |
| `hash` of every manifest | inside `skills/*.json` itself | that the manifest was not edited without going past the pin |

The manifest hash procedure is the format specification's: `sha256` of the
canonical JSON of `{instrucoes, entrada, saida, checks, permissoes}`. Touch a
line of `instrucoes`, loosen a check or open a permission, and the hash moves,
the node's pin stops closing and the bundle stops validating — which is exactly
the change D4 wants to bring back to the human gate.

The check happens in three independent places, and the first two run **before any
network**:

- [`scripts/validate-factory-bundle.mjs`](../../scripts/validate-factory-bundle.mjs)
  — the reference validator, with no server at all, in `npm test`. It is the one
  the publication step uses, and it is the acceptance criterion for the bundle as
  a repository artifact;
- `cartografo import` — redoes the three checks locally and aborts without
  sending anything to the control plane if any of them fails. The manifest check
  here covers the subset of schema rules the pin depends on, not the whole
  schema: `especificacoes/` is outside the package's publishable tree, and full
  conformance is still the reference validator's work;
- the control plane's skill registry — recomputes the hash on its own account and
  refuses a tampered manifest, because whoever verifies cannot believe the
  self-report of whoever published.

**The round trip that closes the proof.** Publishing both factory graphs into a
git repository, committing, cloning into a clean directory and importing the
clone produces the **same `graph_version.id`** and the **same hash per skill** as
importing `grafos-de-fabrica/<class>/` straight from here. That is what
[`packages/core/test/cli-atlas-publish.test.ts`](../../packages/core/test/cli-atlas-publish.test.ts)
runs on every `npm test`; if the crossing moved one byte, the hash would move
with it and the test would go red.

## Publishing

```sh
node scripts/publish-atlas-bundle.mjs <bundle-dir> <atlas-dir>
```

What the command does, in order:

1. **Validates the whole bundle** with the reference validator's `validateBundle`
   — the same code `npm test` runs, imported and not reimplemented.
2. **Refuses whole.** A bundle that does not validate exits non-zero and writes
   **zero files** into the atlas. Half a map published with a broken pin is worse
   than no map: whoever imports it has no way of knowing it is half there.
3. **Copies** `grafo.json` and everything under `skills/` to
   `<atlas-dir>/<class>/`, creating the directory if needed.
4. **Revalidates the copy** at the destination. What comes out of this script is
   a bundle that validates from its new place, or the script fails.

Three properties that count as contract:

- **Idempotent.** Republishing an unchanged bundle rewrites the same bytes.
- **Additive across classes.** Publishing two classes into the same atlas leaves
  both subdirectories intact; neither class sees or deletes the other.
- **A mirror inside the class.** A `skills/*.json` the bundle no longer carries
  is removed from the destination, and the removed file is named in the output.
  Without that, a renamed skill would leave the old manifest in the atlas for the
  next `cartografo import` to register — the one case where copying over
  silently creates content nobody wrote. Nothing outside `<atlas-dir>/<class>/`
  is touched.

**The command does not call `git`.** Committing and pushing the populated
checkout is the caller's work — CI or a person. That is D15 applied to the
letter: git enters at the edges, as an interchange format, and never becomes a
dependency of anything in here. The script is pure file-system work, with no
network and no repository.

For the same reason, publishing is **not** a subcommand of `cartografo`: every
CLI subcommand is an HTTP client of the control plane (D1, D11), and this step
talks to no API at all. It lives in `scripts/`, beside the other validators.

## Importing

```sh
cartografo import <atlas>/<class>
```

The importer reads `<class>/grafo.json` and — if a sibling `skills/` exists —
verifies the whole bundle **before** any request; then it registers the manifests
(`POST /v1/skills`, each one revalidated by the server) and only then sends the
graph (`POST /v1/graphs`). A manifest the registry refuses aborts the import, and
the graph does not go up.

## The D4 boundary this document does not cross

The path above registers the bundle's manifests **automatically**, and that is
deliberate for content this repository wrote: a factory bundle is in-repo
content, reviewed in code review, and asking a human to re-approve five manifests
they already approved at merge buys no safety at all — it buys an empty registry
and a graph whose nodes pin a capability the synthesizer cannot find.

**That does not hold for a third party's bundle.** D4 exists against exactly that
case: a skill instruction nobody here wrote is a prompt-injection vector, and its
gate is `cartografo scan-skill` → `propose-skill` → `register-skill`, with a
human signature in the middle. A community atlas is, by definition, external
content.

What is built today, and what is not:

| Bundle origin | Path | State |
|---|---|---|
| From this repository (the factory graphs), mirrored into an atlas of its own | `cartografo import` registers the manifests directly | **built** and covered by the tests above |
| From an external contributor | has to go through D4's human approval gate | **not built** — a named gap, not a silent one |

The ticket that closes the second row waits for a second real atlas contributor
to exist — the same rule of two consumers that keeps this document at v0. Until
then, importing a third party's bundle down the fast path is use outside the
specification: the hash check proves the content **has not changed since it was
published**, not that it is trustworthy.

## Out of scope (v0)

- **Cryptographic signing** of a bundle or of the atlas. The hashes above prove
  integrity across the crossing; proving *authorship* is another problem, and it
  only starts to be worth it once the atlas has a contributor that is not this
  repository.
- **An index, catalogue or atlas manifest** — see rule 3 of the layout.
- **`cartografo export` in full-bundle mode** (`grafo.json` + `skills/`) for
  graphs that exist only in the database (variants, non-factory classes). Today
  `export` writes the graph document, which is the minimal bundle; both factory
  maps already exist as files.
- **A public atlas repository.** D7 keeps this repository private until it works;
  the round-trip proof uses a local git repository as a stand-in.
- **A format version inside the file.** The graph document already carries its
  own in `metadata.versao_schema`, and the atlas has no file of its own to put
  one in — nor will it, while rule 3 of the layout holds.
