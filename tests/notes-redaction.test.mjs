/**
 * Publication gate: the notes carry the record, not the positions behind it
 * (t307, AT1-AT6).
 *
 * The founder read the repository through before sharing it and found two
 * things that must not leave his machine: the identity of every live security
 * the asymmetric-bets graph was crossed with, and the absolute path of every
 * sibling repository the rounds were run from. He chose explicitly to KEEP the
 * notes rather than delete them, because they hold the one record the README
 * leans on as evidence against itself — that the learning loop never got past
 * n=1 (`README.md`, and `tests/readme-status-claims.test.mjs` AT7 pins the
 * citation). Deleting the notes would have deleted the honesty.
 *
 * So this gate is two-sided by construction, and that is the whole design:
 *
 * - **AT1/AT2 are the subtraction.** No ticker, issuer, tender counterparty,
 *   filing reference or third-party source anywhere under `notes/`; no
 *   outside-repository absolute path either.
 * - **AT3/AT4 are the addition, and they are the reason the gate is not just a
 *   blocklist.** A redaction that quietly softened "the round has n=1 and no
 *   A/B" into "the round was inconclusive" would pass any blocklist ever
 *   written and would be exactly the failure the founder was guarding against.
 *   So the mechanical record is pinned as literal substrings: the node names,
 *   the verdict, the cost figures, the n=1 admission.
 *
 * ## What AT6 asserts, and what it used to (t304)
 *
 * As t307 wrote it, AT6 read `git diff --name-only $(git merge-base main HEAD)`
 * whole and required every path in it to be in {@link TOUCHABLE}. That is a
 * claim about ONE ticket's diff — that t307 touched only what t307 declared —
 * and a claim about a diff does not survive as a standing test. Once t307
 * merged, the diff on `main` was empty and the assertion proved nothing; on
 * every branch cut afterwards it compared THAT branch's work against t307's
 * file list and failed. t304 was the first ticket to land behind it and the one
 * that had to clear it; the scope check the assertion stood for had already
 * been performed, by the review t307 came from.
 *
 * So AT6 now judges governance instead of branch size. It is an undeclared edit
 * when a path is BOTH something the redaction has standing over — a file that
 * already existed under `notes/` when the redaction ran, or one of
 * {@link NON_NOTE_FILES} — AND absent from {@link TOUCHABLE}. Nothing was
 * weakened to make a build pass: what AT1-AT5 guarantee is untouched, and the
 * standing property AT6 is worth having for is the one it keeps. A ticket that
 * edits a redacted note without declaring it still fails, which the fixture
 * beside it pins and a manual edit of `notes/2026-08-18-action-plan.md`
 * confirmed. What no longer fails is writing a NEW note, which every closing
 * ticket does, or touching a file this redaction never governed.
 *
 * ## Why the sweep reads RAW text
 *
 * The sibling Portuguese gates blank fenced blocks and backtick spans before
 * scanning, because a code span there is data and not prose. Here the opposite
 * holds: `` `fields.asset = EQX` `` identifies the position exactly as well as
 * a sentence does, and a reader of a public repository does not care which side
 * of a backtick the ticker sat on. Nothing is blanked.
 *
 * ## Why bare `~/cartografo` is exempt, and why the exemption is asserted
 *
 * `~/cartografo` with no suffix names THIS repository's own checkout, which is
 * not a path outside it — redacting it would remove a true and harmless fact.
 * The trap is that a careless `s|~/cartografo[^ ]*||g` removes it too, and the
 * result still passes a blocklist. AT2 therefore asserts the exemption was
 * APPLIED: bare `~/cartografo` must still be somewhere in the tree. Only the
 * `-`-suffixed forms (`~/cartografo-bets-run`, `~/cartografo-bench`,
 * `~/cartografo-jogo-run`, `~/cartografo-plantao`) are outside-repo paths.
 *
 * ## Why `flowpilot` the word survives while `~/flowpilot` the path does not
 *
 * flowpilot is a documented behavioural reference (D17) cited by name across
 * the specs; hiding the word would make those citations unreadable for no
 * confidentiality gain. What must go is the machine path. AT5 holds both halves
 * at once on the five non-note files: neither `~/flowpilot` nor
 * `~/bootstrap-core` survives, and each file still says `flowpilot` — which is
 * what proves the reference was generalized rather than deleted.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The tree AT1 and AT2 sweep, end to end. */
export const TREE = 'notes/';

/**
 * Every identity string AT1 refuses, built from what was really in the tree.
 *
 * Four groups, and the grouping is the argument for each entry rather than
 * decoration: an auditor re-reading this list has to be able to tell why a
 * three-letter string is here.
 *
 * The tickers are matched on word boundaries, case-insensitively. A bare
 * substring sweep for `EMO` would fire on "REMOVE" in a heading and a bare
 * sweep for `BTX` would fire on nothing at all today but on the first URL
 * tomorrow; a boundary keeps the gate honest without keeping it noisy.
 */
export const IDENTITIES = Object.freeze([
  // Round 3 / the n=3 round: the closed-end fund, its issuer, its counterparty.
  'NFJ',
  'Virtus',
  'Saba',
  // Round 1: the gold miner and the newsletter the thesis came from.
  'EQX',
  'Equinox Gold',
  'Era de Ouro',
  // Round 2: the uranium producer, and the two facts that name it even unnamed
  // (its subsidiary and the state producer whose guidance was the dated event).
  'CCJ',
  'Cameco',
  'Kazatomprom',
  'Westinghouse',
  // Filing references and precedent tickers — an EDGAR form type plus a date is
  // a lookup, and the six precedent tenders name the counterparty by their set.
  'SC TO-C',
  'SC TO-I',
  'EDGAR',
  'VPV',
  'VTN',
  'FMN',
  'BMEZ',
  'BTX',
  'EMO',
  // Third-party sources: naming who published the premise names the premise.
  'Seeking Alpha',
  'cefconnect',
  'Crux Investor',
  'The Deep Dive',
  'Sprott',
]);

/**
 * Every outside-repository path prefix AT2 refuses.
 *
 * `~/cartografo` is deliberately NOT here — see the header. The four
 * `cartografo-` entries are, because a suffix after the dash makes it a
 * different repository on the same disk.
 */
export const OUTSIDE_PATHS = Object.freeze([
  '~/cartografo-bets-run',
  '~/cartografo-bench',
  '~/cartografo-jogo-run',
  '~/cartografo-plantao',
  '~/vibe-game',
  '~/flowpilot',
  '~/jogo-da-velha',
  '~/bootstrap-core',
]);

/** The exemption of FR5, and the string AT2 requires to have survived. */
export const OWN_CHECKOUT = /~\/cartografo(?![-\w])/;

/** Any `~/name` home-directory path, whatever its name. The shape of FR3. */
const HOME_PATH = /~\/[A-Za-z][\w.-]*/g;

/** The five non-note files that quoted a real sibling-repository path. */
export const NON_NOTE_FILES = Object.freeze([
  'specs/formats/skill-manifest.md',
  'specs/events/taxonomy.md',
  'tests/graph-schema.test.mjs',
  'packages/core/test/cli-skill-import.test.ts',
  'packages/core/src/cli/skill-import.ts',
]);

/** The two machine prefixes AT5 refuses in those five files. */
export const MACHINE_PREFIXES = Object.freeze(['~/flowpilot', '~/bootstrap-core']);

/**
 * Every file the redaction declared, and so the only governed paths AT6 lets
 * through (see this file's header for what "governed" narrowed to in t304).
 *
 * Nine notes carried a thesis identity, an outside path or both; five non-note
 * files quoted one machine path each. The last two are this gate itself and the
 * closing note the Definition of Done requires — the Code Changes table names
 * neither, because a ticket's file table lists the work and not the record of
 * it, and a gate that failed on its own existence would be a strange gate.
 *
 * ## Why a later ticket adds to this list, and what that costs (t121)
 *
 * Declaring is the mechanism. AT6 asks whether a governed path is on this list,
 * and the header says in as many words that a ticket which edits a governed
 * note WITHOUT declaring it still fails — so a ticket that edits one and DOES
 * declare it is this gate working, not this gate being loosened. t121 is the
 * first to need that, and it is worth being exact about what it cost.
 *
 * What AT6 governs is "every file that existed under `notes/` when the
 * redaction ran", which is deliberately wider than "every file the redaction
 * CHANGED": the wider set is what makes an undeclared edit visible at all. The
 * five notes below sit in the gap between the two. t307 read every one of them
 * and left every one of them alone — none carried a position, a filing or a
 * machine path — so what this addition removes AT6's cover from is five files
 * that never held redacted content. AT1-AT5 are untouched and still sweep the
 * whole tree, including these five, on every run: nothing here can put a ticker
 * or a home-directory path back.
 *
 * What t121 did to them was mechanical and is the reason they are here: it
 * renamed `docs/o-que-e-o-cartografo.md` and the bets closing note, and these
 * five cited one or the other. A citation left pointing at a path that no
 * longer exists is the exact failure `tests/notes-rename-integrity.test.mjs`
 * was written for, so leaving them alone was not an option either.
 */
export const TOUCHABLE = Object.freeze([
  'notes/2026-08-15-first-execution.md',
  'notes/2026-08-17-first-bets-run.md',
  'notes/2026-08-17-second-bets-run.md',
  'notes/2026-08-17-t109-game-feature.md',
  'notes/2026-08-18-game-feature-2.md',
  'notes/2026-08-18-n3-round.md',
  'notes/2026-08-18-third-bets-run.md',
  'notes/2026-08-24-t299-closing-note.md',
  'notes/execution-monitoring-prompt.md',
  ...NON_NOTE_FILES,
  'notes/2026-08-25-t307-closing-note.md',
  'tests/notes-redaction.test.mjs',
  // t121: the five notes whose citation of a renamed file had to move with it.
  // None of them was redacted by t307; see the note above this list.
  'notes/2026-08-24-t281-closing-note.md',
  'notes/2026-08-25-t282-closing-note.md',
  'notes/2026-08-25-t303-closing-note.md',
  'notes/2026-08-25-t305-closing-note.md',
  'notes/2026-08-25-t306-closing-note.md',
  // Incident fix, 2026-08-26, direct on main: three Portuguese quotations this
  // note keeps ON PURPOSE were flagged by the document-tree gate, because the
  // backtick spans marking them WRAPPED and that matcher is line-scoped. Each
  // quotation now sits on one line; not one character of quoted text changed,
  // and nothing redacted was reintroduced. See the SPAN comment in
  // `tests/no-portuguese-document-tree.test.mjs` for why the matcher was not
  // widened instead.
  'notes/2026-08-25-t309-closing-note.md',
  // t326: the five notes whose citation of the wire glossary had to move with
  // the file, the same mechanical reason as the t121 block above. None was
  // redacted by t307, and t326 changed nothing in them but the one filename
  // inside a path citation — the document itself was renamed, not edited.
  'notes/2026-08-17-english-thread.md',
  'notes/2026-08-25-t296-closing-note.md',
  'notes/2026-08-25-t300-closing-note.md',
  'notes/2026-08-26-t311-closing-note.md',
  'notes/2026-08-26-t316-closing-note.md',
  // t328: the same incident as the t309 entry above, one note later. The
  // quotation of `docs/spec/graph.md`'s stale edge — the finding t328 was
  // partly built on — was marked with backtick spans that WRAPPED, so the
  // line-scoped matcher never saw the mark and `para` was read as prose. The
  // quotation now sits on one line. Not one character of quoted text changed,
  // and nothing redacted was reintroduced.
  'notes/2026-08-26-t314-closing-note.md',
]);

/** Every `.md` under `notes/`, repo-relative, in directory order. */
export function notes() {
  return readdirSync(path.join(ROOT, TREE))
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => `${TREE}${entry}`);
}

/** A blocklist entry as a case-insensitive, boundary-anchored pattern. */
function pattern(needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const open = /\w/.test(needle[0]) ? '\\b' : '';
  const close = /\w/.test(needle.at(-1)) ? '\\b' : '';
  return new RegExp(`${open}${escaped}${close}`, 'i');
}

/**
 * Every line of every note that matches one of `needles`.
 *
 * @param {readonly string[]} needles Blocklist entries, matched as patterns.
 * @returns {string[]} One `file:line: needle — text` per hit, ready to print.
 */
export function hitsIn(needles) {
  const patterns = needles.map((needle) => ({ needle, expression: pattern(needle) }));

  return notes().flatMap((relativePath) =>
    readFileSync(path.join(ROOT, relativePath), 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        patterns
          .filter((entry) => entry.expression.test(line))
          .map(
            (entry) =>
              `${relativePath}:${String(index + 1)}: ${entry.needle} — ${line.trim().slice(0, 120)}`,
          ),
      ),
  );
}

test('AT1 — no note names a security, an issuer, a filing or a source', () => {
  const swept = notes();

  assert.ok(
    swept.length >= 25,
    `only ${String(swept.length)} notes read; the sweep is not seeing the tree`,
  );

  const found = hitsIn(IDENTITIES);

  assert.deepEqual(
    found,
    [],
    `a note still identifies a real position:\n${found.join('\n')}`,
  );
});

test('AT1 — the sweep really bites, and reads inside a code span', () => {
  assert.ok(pattern('EQX').test('`fields.asset = EQX`'), 'a ticker in a code span is not caught');
  assert.ok(pattern('The Deep Dive').test('sources: The Deep Dive'), 'a source name is not caught');
  assert.equal(pattern('EMO').test('every trace REMOVED'), false, 'a ticker fires inside a word');
});

test('AT2 — no note carries an outside-repository absolute path', () => {
  const found = hitsIn(OUTSIDE_PATHS);

  assert.deepEqual(
    found,
    [],
    `a note still points at a repository on the author's disk:\n${found.join('\n')}`,
  );
});

test('AT2 — no note carries a home-directory path other than this checkout', () => {
  const strays = notes().flatMap((relativePath) =>
    readFileSync(path.join(ROOT, relativePath), 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        (line.match(HOME_PATH) ?? [])
          .filter((found) => !OWN_CHECKOUT.test(found))
          .map((found) => `${relativePath}:${String(index + 1)}: ${found}`),
      ),
  );

  assert.deepEqual(strays, [], `a home-directory path of a shape nobody listed:\n${strays.join('\n')}`);
});

test('AT2 — bare ~/cartografo survived: the exemption was applied, not over-redacted', () => {
  const keepers = notes().filter((relativePath) =>
    OWN_CHECKOUT.test(readFileSync(path.join(ROOT, relativePath), 'utf8')),
  );

  assert.ok(
    keepers.length > 0,
    'no note says `~/cartografo` any more: this repository\'s own checkout was redacted ' +
      'along with the outside paths, which FR5 says it must not be',
  );
});

test('AT3 — round 3 keeps its mechanics: the nodes, the verdict, the cost', () => {
  const contents = readFileSync(path.join(ROOT, 'notes/2026-08-18-third-bets-run.md'), 'utf8');

  for (const node of [
    'triagem',
    'coleta-fundamentos',
    'analise-assimetria',
    'red-team',
    'registro-monitoramento',
  ]) {
    assert.ok(contents.includes(node), `the node \`${node}\` is gone from round 3's table`);
  }

  assert.ok(contents.includes('morta'), "round 3's verdict is gone");
  assert.ok(
    contents.includes('accepted by the skill schema at the first attempt'),
    'the claim that every report was accepted first time is gone — it is the round\'s result',
  );
  assert.ok(contents.includes('US$ 6'), "round 3's cost figure is gone");
});

test('AT4 — the n=3 note still admits n=1, no A/B, and US$ 9.3 for nothing', () => {
  const contents = readFileSync(path.join(ROOT, 'notes/2026-08-18-n3-round.md'), 'utf8');

  for (const claim of ['n=1 on version A', 'no A/B measurement exists', 'US$ 9.3 for nothing usable']) {
    assert.ok(
      contents.includes(claim),
      `"${claim}" is gone: the redaction softened the record it was meant to preserve`,
    );
  }
});

test('AT5 — the five non-note files lost the machine path and kept the reference', () => {
  for (const relativePath of NON_NOTE_FILES) {
    const full = path.join(ROOT, relativePath);

    assert.ok(existsSync(full), `${relativePath} is not on disk`);

    const contents = readFileSync(full, 'utf8');

    for (const prefix of MACHINE_PREFIXES) {
      assert.equal(
        contents.includes(prefix),
        false,
        `${relativePath} still quotes \`${prefix}\`, a path on the author's machine`,
      );
    }

    assert.match(
      contents,
      /flowpilot/i,
      `${relativePath} no longer says "flowpilot": the citation was deleted rather than ` +
        'generalized, and D17 makes the name itself a documented reference',
    );
  }
});

/**
 * The changed paths that are an undeclared edit of a governed file, sorted.
 *
 * Two filters, and the order of them is the rule: a path counts only if the
 * redaction has standing over it, and then only if {@link TOUCHABLE} does not
 * declare it. Anything else on the branch — a new note, a new module, another
 * ticket's whole diff — is not this gate's business and never was.
 *
 * @param {readonly string[]} governed Paths this gate has standing over.
 * @param {readonly string[]} changed Paths the working branch changed.
 * @returns {string[]} One entry per undeclared edit of a governed file.
 */
export function undeclaredEdits(governed, changed) {
  const standing = new Set(governed);
  return [...new Set(changed)]
    .filter((entry) => standing.has(entry) && !TOUCHABLE.includes(entry))
    .sort();
}

test('AT6 — no file the redaction governs changes without being declared', () => {
  let base;
  try {
    base = execFileSync('git', ['merge-base', 'main', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return; // No `main` to compare against: nothing this gate can honestly claim.
  }

  const paths = (args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((entry) => entry !== '');

  // What the redaction has standing over: the files that were already there
  // when it ran. An untracked path is not read at all — it cannot be an EDIT of
  // a file that existed, which is the only thing this gate judges.
  const governed = paths(['ls-tree', '-r', '--name-only', '-z', base]).filter(
    (entry) => entry.startsWith(TREE) || NON_NOTE_FILES.includes(entry),
  );

  const strays = undeclaredEdits(governed, paths(['diff', '--name-only', '-z', base]));

  assert.deepEqual(
    strays,
    [],
    `a file the redaction governs changed without being declared:\n${strays.join('\n')}`,
  );
});

test('AT6 — the rule reads governance, not the size of the branch', () => {
  const REDACTED = 'notes/2026-08-18-third-bets-run.md';
  const UNDECLARED = 'notes/2026-08-18-action-plan.md';
  // What the tree held when the redaction ran: two notes it declared, one it
  // read and left alone, and the five non-note files.
  const governed = [
    REDACTED,
    'notes/execution-monitoring-prompt.md',
    UNDECLARED,
    ...NON_NOTE_FILES,
  ];

  assert.deepEqual(
    undeclaredEdits(governed, [REDACTED]),
    [],
    'a redacted note that IS declared is the whole point of the list',
  );
  assert.deepEqual(
    undeclaredEdits(governed, [UNDECLARED]),
    [UNDECLARED],
    'a note that existed at the merge and is not declared is exactly what this gate is for',
  );
  assert.deepEqual(
    undeclaredEdits(governed, ['notes/2026-08-25-t304-closing-note.md']),
    [],
    'a note that did not exist at the merge is a new note, and writing one is routine',
  );
  assert.deepEqual(
    undeclaredEdits(governed, ['packages/runner/src/controller/control-plane-client.ts']),
    [],
    'a file this redaction never governed is not this gate\u2019s business',
  );
});
