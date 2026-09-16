/**
 * Acceptance test for the subcommand surface `docs/spec/cli.md` describes (t548).
 *
 * D26 makes the CLI the operator's surface, and a spec that is the declared
 * behaviour of that surface has to be pinned the way `screen.md` is pinned
 * against `router.ts` (`packages/screen/test/spec-routes.test.ts`): both
 * directions against something that cannot go stale on its own.
 *
 * - the §1 table, one row per subcommand, whose first cell's first word is the
 *   subcommand (`job <id>` and `job create` are both rows of `job`);
 * - `API_SUBCOMMANDS` in `src/cli/index.ts`, plus the literal `up`, read off the
 *   source as text — the array is not exported, and this pin is not a reason to
 *   change the router.
 *
 * A subcommand added to the router without a row, and a row naming a subcommand
 * the router does not know, both fail here.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SPEC_PATH = path.join(REPO_ROOT, 'docs', 'spec', 'cli.md');
const ROUTER_PATH = path.join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');

/** The section under test, matched by its number and never by its wording. */
const SURFACE_HEADING = '## 1.';

/** A subcommand row: the first cell opens with a backticked command line. */
const TABLE_ROW = /^\|\s*`([a-z][a-z-]*)[^`]*`[^|]*\|/;

/** The one subcommand that is not an HTTP client, and so not in the array. */
const UP = 'up';

/** One section of the spec, from its heading to the next one. */
function section(spec: string, heading: string): string {
  const lines = spec.split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  assert.notEqual(start, -1, `spec has no "${heading}" section`);

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function documentedSubcommands(): string[] {
  assert.ok(existsSync(SPEC_PATH), `spec does not exist: ${SPEC_PATH}`);
  const rows = section(readFileSync(SPEC_PATH, 'utf8'), SURFACE_HEADING)
    .split('\n')
    .flatMap((line) => {
      const match = TABLE_ROW.exec(line.trim());
      return match === null ? [] : [match[1]];
    });
  assert.ok(rows.length > 0, 'cli.md §1 has no subcommand rows; this pin no longer reads the table');
  return [...new Set(rows)].sort();
}

function routerSubcommands(): string[] {
  const source = readFileSync(ROUTER_PATH, 'utf8');
  const match = /const API_SUBCOMMANDS = \[([^\]]*)\];/.exec(source);
  assert.ok(match !== null, 'index.ts no longer declares `API_SUBCOMMANDS` as an array literal; this pin has to follow it');

  const names = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  assert.ok(names.length > 0, 'read no names out of `API_SUBCOMMANDS`');
  return [...new Set([...names, UP])].sort();
}

test('t548 AT1 — cli.md §1 documents exactly API_SUBCOMMANDS plus up', () => {
  const documented = documentedSubcommands();
  const real = routerSubcommands();

  const undocumented = real.filter((name) => !documented.includes(name));
  const invented = documented.filter((name) => !real.includes(name));
  assert.deepEqual(undocumented, [], `subcommands with no row in cli.md §1: ${undocumented.join(', ')}`);
  assert.deepEqual(invented, [], `rows in cli.md §1 naming no real subcommand: ${invented.join(', ')}`);
});
