/**
 * Acceptance tests for the route surface `docs/spec/tela.md` describes (t183).
 *
 * The alpha round on `t164` found the spec counting its own routes twice and
 * disagreeing with itself: the §1 heading had been moved to `sete` when
 * `GET /runners` arrived, while the dispatch table three dozen lines below
 * still said `seis`. Followed literally, the second sentence describes a screen
 * where the fleet view does not exist — the one thing that ticket had just
 * shipped.
 *
 * So nothing here is compared against a number written out in this file. Both
 * directions are pinned against something that cannot go stale on its own:
 *
 * - the §1 table, against the paths `route()` in `src/router.ts` actually
 *   recognizes — the same shape `inbox-spec-routes.test.ts` uses to keep the
 *   inbox spec honest against `actions.js`;
 * - every count spelled out in the prose, against the number of rows in that
 *   table.
 *
 * A route added to the router without a row, a row without a route, and a
 * sentence whose numeral drifts from either all fail here.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SPEC_PATH = path.join(REPO_ROOT, 'docs', 'spec', 'tela.md');
const ROUTER_PATH = path.join(PACKAGE_ROOT, 'src', 'router.ts');

/** Sections under test, matched by their number and never by their wording. */
const SURFACE_HEADING = '## 1.';
const API_GAPS_HEADING = '## 4.';

/** Method and path in the first cell of a route-table row, as in `GET /board`. */
const TABLE_ROW = /^\|\s*`(GET|POST|PUT|PATCH|DELETE)\s+([^`]+)`\s*\|/;

/** The numerals this spec spells out, and what each one is worth. */
const NUMERALS = new Map([
  ['uma', 1],
  ['duas', 2],
  ['três', 3],
  ['quatro', 4],
  ['cinco', 5],
  ['seis', 6],
  ['sete', 7],
  ['oito', 8],
  ['nove', 9],
  ['dez', 10],
]);

/** A spelled-out count of routes, anywhere in the prose. */
const SPELLED_COUNT = new RegExp(`\\b(${[...NUMERALS.keys()].join('|')}) rotas\\b`, 'gi');

/**
 * The one count in this document that is NOT about the screen's own surface:
 * the additive routes this layer asked of the control plane, whose table is §4.
 *
 * It is taken out of AT2's sweep and checked by AT3 against that table, because
 * an exception nobody verifies is just a second place for the same drift to
 * hide. Anything else that gets written later counts the screen's routes by
 * default — a new mention about something else fails until it is declared here.
 */
const API_GAPS_COUNT = /\b([a-zçãêé]+) rotas novas do lado do core\b/i;

function readSpec(): string {
  assert.ok(existsSync(SPEC_PATH), `spec does not exist: ${SPEC_PATH}`);
  return readFileSync(SPEC_PATH, 'utf8');
}

function readRouter(): string {
  assert.ok(existsSync(ROUTER_PATH), `artifact does not exist yet: ${ROUTER_PATH}`);
  return readFileSync(ROUTER_PATH, 'utf8');
}

/** One section of the spec, from its heading to the next one. */
function section(spec: string, heading: string): string {
  const lines = spec.split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  assert.notEqual(start, -1, `spec has no "${heading}" section`);

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** `METHOD path` for every row of a section's route table. */
function tableRoutes(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const match = TABLE_ROW.exec(line.trim());
    return match === null ? [] : [`${match[1]} ${match[2]}`];
  });
}

/**
 * The document with its line wrapping collapsed.
 *
 * The prose wraps at 80 columns, so a sentence that counts routes is regularly
 * cut in half by a newline; matching a phrase against the raw file would miss
 * exactly the mentions this pin exists to read.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * `METHOD path` for every route `route()` recognizes, with `:id` standing in
 * for each captured segment — read off the router instead of copied from it.
 *
 * Two shapes, and both are load-bearing: `pathname === '/board'` for a fixed
 * path, and a regular expression `.exec(pathname)` for one that carries an id.
 * The `t133` sweep documents the same pair as the reason it masks regex
 * literals in this package.
 */
function routerRoutes(): string[] {
  const source = readRouter();
  const start = source.indexOf('async function route(');
  assert.notEqual(start, -1, 'router.ts no longer declares `route()`; this pin has to follow it');
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, 'router.ts no longer closes `route()` at column 0; this pin has to follow it');

  const found: string[] = [];
  let fixed = 0;
  let parameterized = 0;
  let method = '';

  for (const line of source.slice(start, end).split('\n')) {
    const verb = /method === '([A-Z]+)'/.exec(line);
    if (verb !== null) method = verb[1];

    const literal = /pathname === '([^']+)'/.exec(line);
    if (literal !== null) {
      found.push(`${method} ${literal[1]}`);
      fixed += 1;
    }

    const pattern = /\/\^(.+?)\$\/\.exec\(pathname\)/.exec(line);
    if (pattern !== null) {
      found.push(`${method} ${pattern[1].replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, ':id')}`);
      parameterized += 1;
    }
  }

  assert.ok(
    fixed > 0 && parameterized > 0,
    `the pin read ${fixed} fixed and ${parameterized} parameterized paths out of route(); it no longer recognizes the router's shape`,
  );
  return found;
}

test('t183 AT1 — §1 names exactly the routes the screen serves', () => {
  assert.deepEqual(tableRoutes(section(readSpec(), SURFACE_HEADING)).sort(), routerRoutes().sort());
});

test('t183 AT2 — every spelled-out count of the screen routes agrees with §1', () => {
  const spec = readSpec();
  const expected = tableRoutes(section(spec, SURFACE_HEADING)).length;
  const prose = flatten(spec).replace(API_GAPS_COUNT, '');

  const mentions = [...prose.matchAll(SPELLED_COUNT)];
  assert.ok(
    mentions.length >= 2,
    `only ${mentions.length} spelled-out count(s) found; the spec states its route count in the §1 heading AND in the dispatch table, and this pin is worth nothing if it stops reading both`,
  );

  for (const mention of mentions) {
    assert.equal(
      NUMERALS.get(mention[1].toLowerCase()),
      expected,
      `"${mention[0]}" disagrees with the ${expected} routes §1 lists`,
    );
  }
});

test('t183 AT3 — the count of routes this layer asked of the API agrees with §4', () => {
  const spec = readSpec();
  const mention = API_GAPS_COUNT.exec(flatten(spec));
  assert.ok(mention !== null, 'the spec no longer counts the routes it opened in the core; AT2 has to stop excusing it');

  assert.equal(
    NUMERALS.get(mention[1].toLowerCase()),
    tableRoutes(section(spec, API_GAPS_HEADING)).length,
    `"${mention[0]}" disagrees with the table in §4`,
  );
});
