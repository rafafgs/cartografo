/**
 * D24 gate: no Portuguese survives in a path, anywhere in the tree (t282, t303,
 * t306, t305).
 *
 * The closing sweep of D24's document series, and the one that finally reads
 * the whole repository rather than a slice of it. Its four predecessors each
 * translated CONTENTS — t280 the factory bundles, t281 the wire glossary's
 * prose, t299 the reader-facing documents, t300 the internal record — and every
 * one of them deferred the same thing on the way past: the PATH SEGMENTS. A
 * directory is renamed once and every citation of it, every `path.join`, every
 * relative link and every glob moves with it, so the four tickets that could
 * not afford that fan-out left it here.
 *
 * ## Why this is not `no-portuguese-document-tree`'s job
 *
 * That gate reads names too, and better — it asks the two prose signals of every
 * component. But it asks them of four trees (`docs/`, `notes/`, `schema/`,
 * `specs/`) and of nothing else, because it is a sweep of the DOCUMENT tree, and
 * the names this ticket moved were never all in it: `factory-graphs/` is not a
 * document tree, `scripts/validate-graph.mjs` is a script, and
 * `tests/fixtures/` is a fixture directory. A rename that reached only the trees
 * that gate walks would have left the other three standing.
 *
 * So the two gates read different tracts by different rules, on purpose:
 *
 * - **`no-portuguese-document-tree`** — four trees, two general signals (a
 *   Portuguese diacritic, a Portuguese function word). It catches an unknown
 *   Portuguese word nobody predicted, but only where it walks.
 * - **this gate** — the WHOLE tracked tree, eleven specific stems. It catches
 *   nothing it was not told about, but it catches it everywhere.
 *
 * Neither subsumes the other. `especificacoes` carries no diacritic and is not a
 * function word, so the general signals never saw it in the first place; that is
 * exactly why its carve-out in the sibling gate had to be a hand-written entry
 * with a ticket number on it, and why the entry's teeth were the assertion that
 * the segment still exists rather than any signal at all. This gate is what
 * replaces that arrangement with something that bites on its own.
 *
 * ## The stems, and why stems rather than words
 *
 * Eleven, one per name D24 retired, matched as a SUBSTRING of a path component:
 *
 * | stem              | the names it retires                                       |
 * |-------------------|------------------------------------------------------------|
 * | `fabrica`         | `grafos-de-fabrica/` -> `factory-graphs/`                  |
 * | `especificac`     | `especificacoes/` -> `specs/`                              |
 * | `exemplo`         | `exemplos/` -> `examples/`, and the bets thesis fixture    |
 * | `formato`         | `formatos/` -> `formats/`, under `docs/` and under specs   |
 * | `validar`         | `validar-grafo.mjs` -> `validate-graph.mjs`                |
 * | `tela`            | `packages/tela/` -> `packages/screen/`, bin script too     |
 * | `topografo`       | `packages/topografo{,-custo}/`, and the two spec documents |
 * | `assimetric`      | `bets-assimetricas/` -> `asymmetric-bets/`                 |
 * | `desenvolvimento` | `desenvolvimento-de-software/` -> `software-development/`  |
 * | `notas`           | `notas/` -> `notes/`                                       |
 * | `grafo`           | `grafo.json`, `grafo.schema.json`, `grafo-travessia.json`  |
 *
 * A substring rather than a whole component, because these words inflect and
 * compose: `especificacoes` is the plural of `especificacao`, and
 * `tese-exemplo-bets-assimetricas.json` buries `exemplo` in the middle of a
 * hyphenated name. Matching the stem catches the family; matching the exact
 * spelling would have caught one member of it and let `especificacao/` in.
 *
 * `tela` and `topografo` arrived with t303, which is the separate ticket t282
 * wrote them down for: the package identities were work nobody had started, so a
 * gate that carried their stems on day one would have gone red on a rename that
 * did not exist yet. It exists now — `packages/screen/`, `packages/surveyor/`,
 * `packages/cost-surveyor/` — and the two stems are what stops it coming back.
 *
 * The last two arrived with t306, the same way and for the same reason. t280 and
 * t293 translated the two factory bundles' CONTENTS and left the directories
 * standing, because each basename is also the registered `problem_class` key,
 * and t282 recorded that as the one rename still owed. t306 is it — the two
 * directories are `factory-graphs/asymmetric-bets/` and
 * `factory-graphs/software-development/` now, their `problem_class` values moved
 * with them, and these two stems are what stops either coming back.
 *
 * `topografo` covers the cost package on its own, which is why there is no
 * `custo` stem beside it: the substring rule already reads it inside
 * `topografo-custo`, and `custo` would have bitten the English word `custom`
 * — `packages/core/src/domain/custom-fields.ts` and the frozen
 * `0015_trabalho_campos_customizados.sql` are both real paths in this tree.
 *
 * The final two arrived with t305, and they are the two t282 and t306 both wrote
 * down and deferred. `notas` is the folder of working notes, which t282 left
 * alone because renaming it was outside its declared scope and t306 then
 * recorded as a standing exception; the founder's ruling on t305 is that D24
 * never allowed it — the allowed exceptions are the brand name, a marked
 * verbatim quotation and the frozen migration file names — so the folder is
 * `notes/` now. `grafo` is the harder one and the reason it waited: it was not
 * a path anybody could move on its own. `grafo.json` was the factory-bundle
 * convention `packages/core/src/cli/import.ts` hardcodes, `grafo.schema.json`
 * carried it inside a versioned URN `$id`, and t306's closing note deferred it
 * by name — "renaming them changes a contract... their stems belong in
 * `RETIRED_STEMS` on the day they move". t305 is the day: the family is
 * `graph.json` / `graph.schema.json` / `graph-traversal.json`, the CLI reads the
 * new name, the `$id` is `urn:cartografo:schema:graph:1.0.0`, and the stem is
 * here.
 *
 * `grafo` is safe as a substring in this tree, which is why it can be a stem at
 * all: it does not read inside `graph`, `graphs`, `factory-graphs` or
 * `paragraph`, and no tracked path outside the two exclusions below spells it.
 *
 * ## What is excluded, and why that is a boundary and not a hole
 *
 * Two trees, for two different reasons.
 *
 * `packages/core/migrations/` first. The language convention freezes those file
 * names outright — `0003_trabalho_sessao_evento_pergunta.sql` is Portuguese and
 * stays Portuguese, because a migration's name is its identity in
 * `schema_migrations` and renaming one re-runs it. The exclusion says which tree
 * this gate has authority over first and covers for a match second. Through
 * t303's seven stems it covered for nothing at all — no migration name tripped
 * one. t305's `grafo` changes that: `0002_grafo_versao_proposta.sql` is a real
 * file and it is frozen, so from here the exclusion is load-bearing as well as
 * declarative.
 *
 * `notes/` second, added by t306 as `notas/` and moved by t305 with the folder.
 * This one IS covering for live matches, and they are the FILE names rather than
 * the directory: `notes/2026-08-24-bets-assimetricas-closing-note.md` spells a
 * retired name in its own filename, and `notes/2026-08-15-first-execution.md`
 * and its siblings cite `grafo.json` all through their prose. The working notes
 * are a dated historical record — a note is named for what was true on the day
 * it was written, and rewriting one to match a later rename would falsify the
 * record rather than fix it.
 *
 * What this exclusion is NOT, since t305, is a claim about the directory. The
 * sibling gate `tests/no-portuguese-document-tree.test.mjs` used to carry
 * `notas` in `ALLOWED_SEGMENTS` as a standing exception; that list is empty now
 * and the folder is English. The two concerns were always different — the
 * directory's own name, and the historical filenames under it — and separating
 * them is what let one move while the other stayed frozen.
 *
 * Both are pinned the same way: the test below asserts that each excluded prefix
 * still names a tree that is really there — so the day either directory moves,
 * the exclusion reds rather than going quietly blind.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The Portuguese stems D24 retired, each matched inside one path component. */
export const RETIRED_STEMS = Object.freeze([
  'fabrica',
  'especificac',
  'exemplo',
  'formato',
  'validar',
  'tela',
  'topografo',
  'assimetric',
  'desenvolvimento',
  'notas',
  'grafo',
]);

/**
 * The two trees this gate does not read, as repo-relative prefixes.
 *
 * See the header for both. `packages/core/migrations/` is a statement of
 * authority first: the migration file names are frozen by the convention, and
 * since t305's `grafo` stem it also covers a real match,
 * `0002_grafo_versao_proposta.sql`. `notes/` is a carve-out for live matches and
 * says so — the working notes are a dated record, t306's `assimetric` bites
 * `notes/2026-08-24-bets-assimetricas-closing-note.md` and t305's `grafo` bites
 * nothing in a NAME there but would if a note were ever named after the file it
 * discusses. What moved with t305 is the prefix, not the reasoning: the FOLDER
 * is English now, the historical filenames under it are not, and this entry is
 * about the second.
 */
export const FROZEN_TREES = Object.freeze(['packages/core/migrations/', 'notes/']);

/** One component of a path, matched whole, that carries the given stem. */
function componentCarrying(stem) {
  return new RegExp(`(^|/)[^/]*${stem}[^/]*(/|$)`);
}

/**
 * Every tracked path in the repository, as repo-relative paths.
 *
 * Read off `git ls-files` rather than off the filesystem, the reading its two
 * sibling gates already use: an untracked build artefact or an editor backup is
 * not part of the tree this gate makes a claim about, and a rename in a dirty
 * checkout leaves both halves on disk but only one in the index.
 *
 * @returns {string[]} Every tracked path, sorted.
 */
export function trackedPaths() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((entry) => entry.length > 0)
    .sort();
}

/**
 * Every offending path of the given set, with the stem that tripped it.
 *
 * Pure: it reads the strings it is handed and never the disk, which is what
 * lets the bite test below hand it a path that does not exist.
 *
 * Reported whole rather than stopping at the first, and naming the stem rather
 * than just the path: a half-finished rename produces dozens, and the stem is
 * what tells a reader whether they are looking at one missed `git mv` or five.
 *
 * @param {readonly string[]} paths Repo-relative paths to read as names.
 * @returns {string[]} One entry per offending path, `path: stem "x"`.
 */
export function offendersIn(paths) {
  const read = paths.filter((entry) => !FROZEN_TREES.some((tree) => entry.startsWith(tree)));

  return read
    .map((entry) => {
      const stem = RETIRED_STEMS.find((candidate) => componentCarrying(candidate).test(entry));
      return stem === undefined ? null : `${entry}: retired stem "${stem}"`;
    })
    .filter((entry) => entry !== null);
}

test('AT1 — no tracked path carries a retired Portuguese stem', () => {
  const offenders = offendersIn(trackedPaths());

  assert.deepEqual(
    offenders,
    [],
    `a path in this repository is still named in Portuguese:\n${offenders.join('\n')}`,
  );
});

test('AT1 — the sweep reads the whole tree, not a corner of it', () => {
  const paths = trackedPaths();

  assert.ok(
    paths.length >= 400,
    `only ${String(paths.length)} tracked paths read; the sweep is blind`,
  );

  for (const tree of ['docs/', 'notes/', 'packages/', 'schema/', 'scripts/', 'specs/', 'tests/']) {
    assert.ok(
      paths.some((entry) => entry.startsWith(tree)),
      `nothing under ${tree} is read; the whole-tree claim is not resolving`,
    );
  }
});

test('AT1 — the excluded tree still exists, so the exclusion cannot go blind', () => {
  const paths = trackedPaths();

  for (const tree of FROZEN_TREES) {
    assert.ok(
      paths.some((entry) => entry.startsWith(tree)),
      `${tree} is not a tree of this repository any more: an exclusion that outlives ` +
        'its subject is a hole nobody is watching',
    );
  }
});

test('AT2 — the sweep bites on every name D24 retired', () => {
  const retired = [
    ['grafos-de-fabrica/bets-assimetricas/grafo.json', 'fabrica'],
    ['especificacoes/eventos/taxonomy.md', 'especificac'],
    ['schema/exemplos/graph-valid-minimal.json', 'exemplo'],
    ['docs/formatos/engine-adapter.md', 'formato'],
    ['scripts/validar-grafo.mjs', 'validar'],
    ['tests/fixtures/tese-exemplo-bets-assimetricas.json', 'exemplo'],
    // the singular, which the plural spelling alone would have let through
    ['especificacao/formato/exemplo.md', 'especificac'],
    // the three package identities t303 retired, directory and bin script alike
    ['packages/topografo/bin/topografo.mjs', 'topografo'],
    ['packages/tela/bin/tela.mjs', 'tela'],
    // one stem, not two: `topografo` already reads inside `topografo-custo`,
    // and a `custo` stem would have bitten the English word `custom`
    ['packages/topografo-custo/bin/topografo-custo.mjs', 'topografo'],
    // the two factory-bundle directories t306 retired, and the `problem_class`
    // key each basename doubles as: `grafo.json` and the manifests move with them
    ['factory-graphs/bets-assimetricas/grafo.json', 'assimetric'],
    ['factory-graphs/bets-assimetricas/skills/red-team-thesis.json', 'assimetric'],
    ['factory-graphs/desenvolvimento-de-software/grafo.json', 'desenvolvimento'],
    // the folder t305 retired, and the graph-document family that moved with it
    ['notas/2026-08-18-action-plan.md', 'notas'],
    ['factory-graphs/software-development/grafo.json', 'grafo'],
    ['schema/grafo.schema.json', 'grafo'],
    ['packages/runner/test/fixtures/grafo-travessia.json', 'grafo'],
    ['software-development.grafo.json', 'grafo'],
  ];

  for (const [dead, stem] of retired) {
    assert.deepEqual(
      offendersIn([dead]),
      [`${dead}: retired stem "${stem}"`],
      `${dead} is a name D24 retired and the sweep walked past it`,
    );
  }
});

test('AT2 — the sweep spares the names that replaced them', () => {
  const living = [
    'factory-graphs/asymmetric-bets/graph.json',
    'factory-graphs/asymmetric-bets/skills/red-team-thesis.json',
    'factory-graphs/software-development/graph.json',
    'specs/events/taxonomy.md',
    'specs/formats/examples/skill-manifest.develop.json',
    'schema/examples/graph-valid-minimal.json',
    'docs/formats/engine-adapter.md',
    'scripts/validate-graph.mjs',
    'tests/fixtures/bets-asymmetric-thesis-example.json',
    // the three package identities that replaced the ones above (t303)
    'packages/surveyor/bin/surveyor.mjs',
    'packages/screen/bin/screen.mjs',
    'packages/cost-surveyor/bin/cost-surveyor.mjs',
    // the graph-document family t282 and t306 both deferred and t305 moved: the
    // `grafo` stem must not read inside any of these English spellings
    'schema/graph.schema.json',
    'packages/runner/test/fixtures/graph-traversal.json',
    'notes/2026-08-25-t305-closing-note.md',
    'docs/spec/graph.md',
    'scripts/validate-graph.mjs',
  ];

  assert.deepEqual(
    offendersIn(living),
    [],
    'the sweep bit on a name that is supposed to survive the rename',
  );
});

test('AT2 — a stem only counts inside a path component, not across one', () => {
  assert.deepEqual(
    offendersIn(['docs/formats/example.md']),
    [],
    '"formato" must not be read out of "formats/example": the slash is a boundary',
  );

  assert.deepEqual(
    offendersIn(['packages/core/migrations/0003_trabalho_exemplo.sql']),
    [],
    'the frozen migration names are outside this gate, whatever they spell',
  );
});

test('AT2 — the working notes are outside this gate, retired name and all', () => {
  assert.deepEqual(
    offendersIn(['notes/2026-08-24-bets-assimetricas-closing-note.md']),
    [],
    'a note is named for what was true the day it was written: t306 retired the ' +
      'directory and did not rewrite the record of the ticket that built it, and ' +
      't305 moved the folder without touching the filenames under it',
  );

  assert.deepEqual(
    offendersIn(['docs/2026-08-24-bets-assimetricas-closing-note.md']),
    ['docs/2026-08-24-bets-assimetricas-closing-note.md: retired stem "assimetric"'],
    'the exclusion is a prefix and nothing wider: the same filename one directory ' +
      'over is read like any other path',
  );

  assert.deepEqual(
    offendersIn(['notas/2026-08-24-t280-closing-note.md']),
    ['notas/2026-08-24-t280-closing-note.md: retired stem "notas"'],
    'the exclusion moved with the folder: the old prefix is not excluded any more, ' +
      'it is the thing the new stem catches',
  );
});
