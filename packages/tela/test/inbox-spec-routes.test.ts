/**
 * Acceptance tests for the route table of the inbox spec (t130).
 *
 * `docs/spec/tela-inbox-propostas.md` §2 is the contract whoever builds the
 * core side of `t111` reads: it says which endpoints this screen calls. The
 * alpha round found it still naming the pre-D18 Portuguese paths
 * (`/v1/propostas/:id/aprovar`) after `t127` renamed the `/v1` surface to
 * English — a document that, followed literally, would produce routes the
 * screen never calls.
 *
 * So the table is not compared against a list written out here: it is compared
 * against the code that does the calling, `LIST_URL` in `inbox.js` and the
 * `route` of each descriptor in `actions.js`. A spec that drifts from the
 * client it specifies fails here, in either direction.
 *
 * Same reason the proxy's URL resolution is duplicated and pinned by test
 * instead of imported (§1 of the spec): the pin is what keeps two copies of one
 * fact honest.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ActionsModule from '../src/public/actions.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SPEC_PATH = path.join(REPO_ROOT, 'docs', 'spec', 'tela-inbox-propostas.md');
const INBOX_PATH = path.join(PACKAGE_ROOT, 'src', 'public', 'inbox.js');

/** Heading of the section under test, matched by its number, not its wording. */
const CONTRACT_HEADING = '## 2.';

/** `| \`GET\` | \`/v1/proposals\` | ... |` — method and path of one table row. */
const TABLE_ROW = /^\|\s*`(GET|POST|PUT|PATCH|DELETE)`\s*\|\s*`([^`]+)`\s*\|/;

/** Markdown link target, with any `#anchor` dropped. */
const LINK = /\]\(([^)\s#]+)(?:#[^)]*)?\)/g;

/**
 * Route segments that `t127` renamed under D18.
 *
 * Written with the leading slash on purpose: `propostas` and `proposta` are
 * still the keys of the response envelope (D18 leaves data-format keys out),
 * and the spec is right to keep naming them.
 */
const RENAMED_SEGMENTS = ['/v1/propostas', '/aprovar', '/rejeitar', '/aplicar', '/reverter'];

function readSpec(): string {
  assert.ok(existsSync(SPEC_PATH), `spec does not exist: ${SPEC_PATH}`);
  return readFileSync(SPEC_PATH, 'utf8');
}

async function loadActions(): Promise<typeof ActionsModule> {
  return (await import(new URL('../src/public/actions.js', import.meta.url).href)) as typeof ActionsModule;
}

/**
 * The list endpoint, read from the source instead of copied.
 *
 * `inbox.js` keeps it in a module-private constant and touches the DOM at
 * `mount`, so the literal is taken from the file rather than imported.
 */
function listUrlFromInbox(): string {
  assert.ok(existsSync(INBOX_PATH), `artifact does not exist yet: ${INBOX_PATH}`);
  const match = /const LIST_URL = '([^']+)'/.exec(readFileSync(INBOX_PATH, 'utf8'));
  assert.ok(match !== null, 'inbox.js no longer declares LIST_URL as a literal — this pin has to follow it');
  return match[1];
}

/** §2 of the spec, from its heading to the next one. */
function contractSection(spec: string): string {
  const lines = spec.split('\n');
  const start = lines.findIndex((line) => line.startsWith(CONTRACT_HEADING));
  assert.notEqual(start, -1, `spec has no "${CONTRACT_HEADING}" section`);

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** `METHOD path` for every row of the contract table. */
function routesOf(section: string): string[] {
  return section.split('\n').flatMap((line) => {
    const match = TABLE_ROW.exec(line.trim());
    return match === null ? [] : [`${match[1]} ${match[2]}`];
  });
}

test('AT1 — the contract table names exactly the routes the screen calls', async () => {
  const { ACTIONS } = await loadActions();
  const list = listUrlFromInbox();

  const expected = [
    `GET ${list}`,
    `GET ${list}/:id`,
    ...Object.values(ACTIONS).map((action) => `POST ${list}/:id/${action.route}`),
  ];

  assert.deepEqual(routesOf(contractSection(readSpec())).sort(), [...expected].sort());
});

test('AT2 — no route segment renamed by t127 survives anywhere in the spec', () => {
  const spec = readSpec();

  for (const segment of RENAMED_SEGMENTS) {
    assert.ok(
      !spec.includes(segment),
      `spec still names the pre-D18 route segment "${segment}"`,
    );
  }
});

test('AT3 — every relative link in the spec points at a file that exists', () => {
  const directory = path.dirname(SPEC_PATH);

  for (const [, target] of readSpec().matchAll(LINK)) {
    if (/^[a-z]+:/.test(target)) continue;
    assert.ok(
      existsSync(path.resolve(directory, target)),
      `spec links to a file that does not exist: ${target}`,
    );
  }
});
