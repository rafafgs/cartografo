/**
 * t258's gate: §6 of `intake.md` promises the HTTP surface the routes write.
 *
 * The alpha round on t255 read the route table of
 * [`docs/spec/intake.md`](../../../docs/spec/intake.md) §6 next to
 * `src/routes/intake.ts` and found two documents. The table still answered
 * `400 itens_invalidos`, `400 campo_obrigatorio_ausente`, `404 grafo_desconhecido`,
 * `404 rascunho_desconhecido` and `409 rascunho_nao_pendente`; the code has
 * answered `invalid_items`, `missing_required_field`, `unknown_graph`,
 * `unknown_draft` and `draft_not_pending` since t226. The same cells named the
 * bodies `{rascunho}`/`{rascunhos}`/`{rascunho, trabalhos}` and the filters
 * `classe`/`projeto_id`, all of which are `draft`/`drafts`/`draft, jobs` and
 * `class`/`project_id` on the wire. The table dates to t122 and neither t226's
 * migration nor t231's citation sweep touched it.
 *
 * t231's sweep could not have caught it. `glossary-wire-docs.test.ts` reads the
 * glossary's §2.1, §5.1 and §5.2 — event names, screen routes, CLI flags — and
 * an API error code lives in §1.4, on rows nothing reads. Widening THAT gate is
 * not what this ticket does: §1.4 also fails documents it does not own
 * (`entities-versioning.md` §5's own error table, `intake-generation.md`), and a
 * gate landed half-green is a gate somebody turns off.
 *
 * ## The oracle is the route, not the glossary
 *
 * A glossary row says what a name BECAME; the route says what a client really
 * receives, and a table of statuses is a promise about the second one. So every
 * citation of §6 is resolved against the handlers themselves:
 *
 * - **`400 invalid_items`** against the `refusal(reply, 400, 'invalid_items')`
 *   calls, status and code TOGETHER. A right code under the wrong status is as
 *   wrong as a retired code, and only the pair is checkable.
 * - **`201 {draft, jobs}`** against the keys of the object literals the handlers
 *   return.
 * - **`filters \`class\``** against the query parameters the collection handler
 *   reads.
 *
 * `validation_failed` is the one code of the table no handler of the file writes:
 * the confirmation borrows its envelope from `withValidation`
 * (`src/routes/common.ts`), so that file's default status and code are read too.
 * Nothing else in the table comes from outside the route.
 *
 * Only §6 is read. The problem codes of §2 are `domain/intake.ts`'s report and
 * carry no status, and the rest of the document is prose — English since D24,
 * Portuguese before it; a sweep that judged those would have to be turned off to
 * be usable.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { requireArtifacts } from './support.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** The document this gate reads, repository-relative. */
const SPEC = path.join('docs', 'spec', 'intake.md');

/** The numbered section of it that promises the HTTP surface. */
const SECTION = '6';

/** The handlers, and the shared envelope one of them borrows. */
const ROUTES = 'src/routes/intake.ts';
const COMMON = 'src/routes/common.ts';

/** One thing a table cell claims, and the line a reader finds it on. */
interface Citation {
  line: number;
  value: string;
}

/** Replaces a span with same-length blanks, so line numbers stay honest. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/** Any second-level heading, which is what closes a numbered section. */
const HEADING = /^##\s/;

/**
 * The document with everything outside one numbered section blanked out.
 *
 * Blanks rather than drops for the usual reason: a failure has to quote the line
 * of the file, not the line of a slice of it. The heading itself is blanked too —
 * `## 6. The HTTP surface` is a title, and titles claim nothing about the wire.
 *
 * @param document The file's contents.
 * @param number The section number, as the heading writes it.
 * @returns The same text, same length, with only that section's lines kept.
 */
export function sectionOnly(document: string, number: string): string {
  const opens = new RegExp(`^##\\s+${number}\\.\\s`);
  let inside = false;

  return document
    .split('\n')
    .map((line) => {
      if (inside && HEADING.test(line)) inside = false;
      else if (!inside && opens.test(line)) {
        inside = true;
        return blank(line);
      }
      return inside ? line : blank(line);
    })
    .join('\n');
}

/** Every backtick span of a text, with the line it sits on. */
function spans(text: string): Citation[] {
  const found: Citation[] = [];

  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      found.push({ line: index + 1, value: match[1] });
    }
  });

  return found;
}

/** `400 invalid_items` — a status the document pairs with a code. */
const CITED_REFUSAL = /^\d{3} [a-z_]+$/;

/** `201 {draft, jobs}` — a status the document pairs with a body's keys. */
const CITED_BODY = /^\d{3} \{([a-z_, ]+)\}$/;

/** The cell that lists what the collection route filters by. */
const CITED_FILTERS = /\|\s*filters ([^|]*)\|/;

/** Every `<status> <code>` §6 promises. */
export function refusalCitations(section: string): Citation[] {
  return spans(section).filter((span) => CITED_REFUSAL.test(span.value));
}

/** Every key of a success body §6 promises, one citation per key. */
export function bodyKeyCitations(section: string): Citation[] {
  return spans(section).flatMap((span) => {
    const body = CITED_BODY.exec(span.value);
    if (body === null) return [];
    return body[1].split(',').map((key) => ({ line: span.line, value: key.trim() }));
  });
}

/** Every query parameter §6 says the collection route filters by. */
export function filterCitations(section: string): Citation[] {
  const found: Citation[] = [];

  section.split('\n').forEach((line, index) => {
    const cell = CITED_FILTERS.exec(line);
    if (cell === null) return;
    for (const match of cell[1].matchAll(/`([^`]+)`/g)) {
      found.push({ line: index + 1, value: match[1] });
    }
  });

  return found;
}

/** `refusal(reply, 404, 'unknown_draft'` — however the call is wrapped. */
const REFUSAL_CALL = /refusal\(\s*reply,\s*(\d{3}),\s*'([a-z_]+)'/g;

/** Every `<status> <code>` one file really refuses with. */
export function writtenRefusals(source: string): Set<string> {
  return new Set([...source.matchAll(REFUSAL_CALL)].map((call) => `${call[1]} ${call[2]}`));
}

/** The status `withValidation` refuses with when no route overrides it. */
const BORROWED_STATUS = /invalidStatus = (\d{3})/;

/** The code it refuses with. */
const BORROWED_CODE = /return \{ error: '([a-z_]+)'/;

/**
 * The one refusal the confirmation route answers without writing it.
 *
 * Read out of `routes/common.ts` instead of pinned here, so the day
 * `withValidation` changes status or code the document is asked to follow.
 *
 * @param source Contents of `src/routes/common.ts`.
 * @returns The single `<status> <code>` pair, as a set.
 */
export function borrowedRefusals(source: string): Set<string> {
  const status = BORROWED_STATUS.exec(source);
  const code = BORROWED_CODE.exec(source);
  assert.ok(
    status !== null && code !== null,
    `${COMMON} no longer declares withValidation's default status and code; this gate cannot read them`,
  );
  return new Set([`${status[1]} ${code[1]}`]);
}

/** A handler's success body: an object literal returned with nothing nested. */
const RETURNED_LITERAL = /return \{([^{}]*)\}/g;

/** Every key the handlers of one file put in a success body. */
export function returnedKeys(source: string): Set<string> {
  const keys = new Set<string>();

  for (const literal of source.matchAll(RETURNED_LITERAL)) {
    for (const key of literal[1].matchAll(/([a-z_]+):/g)) keys.add(key[1]);
  }

  return keys;
}

/** `query.project_id` — every query parameter one file reads. */
const QUERY_READ = /query\.([a-z_]+)/g;

/** Every query parameter one file reads off the request. */
export function readQueryParameters(source: string): Set<string> {
  return new Set([...source.matchAll(QUERY_READ)].map((read) => read[1]));
}

/**
 * Every citation that names something the code does not do.
 *
 * @param cited What the document promises.
 * @param written What the code answers.
 * @returns One `line: value` entry per stale promise, in line order.
 */
export function strayCitations(
  cited: readonly Citation[],
  written: ReadonlySet<string>,
): string[] {
  return cited
    .filter((citation) => !written.has(citation.value))
    .map((citation) => `${citation.line}: ${citation.value}`);
}

/** The §6 of the real document, with a floor so a renumbering is not a pass. */
function httpSection(): string {
  const absolute = path.join(REPO_ROOT, SPEC);
  assert.ok(existsSync(absolute), `${SPEC} does not exist`);

  const section = sectionOnly(readFileSync(absolute, 'utf8'), SECTION);
  assert.ok(
    section.includes('/v1/intake'),
    `${SPEC} has no §${SECTION} naming the routes; this gate is reading the wrong section`,
  );
  return section;
}

/** One of the two source files, read from the package. */
function sourceOf(relative: string): string {
  requireArtifacts(relative);
  return readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8');
}

/** Every refusal the intake surface answers with, borrowed one included. */
function everyRefusal(): Set<string> {
  return new Set([...writtenRefusals(sourceOf(ROUTES)), ...borrowedRefusals(sourceOf(COMMON))]);
}

test('t258 — every refusal §6 promises is one the intake routes really write', () => {
  const cited = refusalCitations(httpSection());
  assert.ok(
    cited.length >= 8,
    `§${SECTION} parsed to only ${cited.length} refusals; the table is not being read`,
  );

  const stray = strayCitations(cited, everyRefusal());
  assert.deepEqual(
    stray,
    [],
    `${SPEC} §${SECTION} promises a refusal no handler writes:\n${stray.join('\n')}`,
  );
});

test('t258 — every success body §6 promises is one the intake routes really return', () => {
  const cited = bodyKeyCitations(httpSection());
  assert.ok(
    cited.length >= 6,
    `§${SECTION} parsed to only ${cited.length} body keys; the table is not being read`,
  );

  const stray = strayCitations(cited, returnedKeys(sourceOf(ROUTES)));
  assert.deepEqual(
    stray,
    [],
    `${SPEC} §${SECTION} names a response key no handler returns:\n${stray.join('\n')}`,
  );
});

test('t258 — the filters §6 lists are the query parameters the route reads', () => {
  const cited = filterCitations(httpSection());
  assert.ok(
    cited.length >= 3,
    `§${SECTION} parsed to only ${cited.length} filters; the table is not being read`,
  );

  const stray = strayCitations(cited, readQueryParameters(sourceOf(ROUTES)));
  assert.deepEqual(
    stray,
    [],
    `${SPEC} §${SECTION} filters by a query parameter the route never reads:\n${stray.join('\n')}`,
  );
});

test('t258 — the gate bites on the pre-t226 table it was written for', () => {
  const stale = [
    '# A planted ticket',
    '',
    '## 5. Previous section',
    '',
    '`400 itens_invalidos` outside the section is no promise of this table.',
    '',
    '## 6. The HTTP surface',
    '',
    '| Route | Response | Errors |',
    '|---|---|---|',
    '| `POST /v1/intake` | `201 {rascunho}` | `400 campo_obrigatorio_ausente` · `400 itens_invalidos` |',
    '| `GET /v1/intake` | `200 {rascunhos}` | filters `status`, `classe`, `projeto_id` |',
    '',
    '## 7. Next section',
    '',
    '| `PATCH /v1/intake/:id` | `200 {rascunho}` | `409 rascunho_nao_pendente` |',
  ].join('\n');

  const section = sectionOnly(stale, SECTION);
  const routes = sourceOf(ROUTES);

  assert.deepEqual(
    strayCitations(refusalCitations(section), everyRefusal()),
    ['11: 400 campo_obrigatorio_ausente', '11: 400 itens_invalidos'],
    'the two retired codes of the planted table have to be caught, and only those',
  );
  assert.deepEqual(
    strayCitations(bodyKeyCitations(section), returnedKeys(routes)),
    ['11: rascunho', '12: rascunhos'],
    'the retired body keys have to be caught',
  );
  assert.deepEqual(
    strayCitations(filterCitations(section), readQueryParameters(routes)),
    ['12: classe', '12: projeto_id'],
    'the retired filters have to be caught, and `status`, which did not change, must not be',
  );
});

test('t258 — the gate does NOT bite on the table the code really writes', () => {
  const current = [
    '## 6. The HTTP surface',
    '',
    '| Route | Response | Errors |',
    '|---|---|---|',
    '| `POST /v1/intake` | `201 {draft}` | `400 missing_required_field` · `404 unknown_graph` |',
    '| `GET /v1/intake` | `200 {drafts}` | filters `status`, `class`, `project_id` |',
    '| `GET /v1/intake/:id` | `200 {draft}` | `404 unknown_draft` |',
    '| `POST /v1/intake/:id/confirmations` | `201 {draft, jobs}` | `409 draft_not_pending` · `400 validation_failed` |',
    '',
    '## 7. Next section',
  ].join('\n');

  const section = sectionOnly(current, SECTION);
  const routes = sourceOf(ROUTES);

  assert.deepEqual(strayCitations(refusalCitations(section), everyRefusal()), []);
  assert.deepEqual(strayCitations(bodyKeyCitations(section), returnedKeys(routes)), []);
  assert.deepEqual(strayCitations(filterCitations(section), readQueryParameters(routes)), []);
});
