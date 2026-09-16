/**
 * Acceptance test for the tool catalogue `docs/spec/mcp-server.md` describes (t548).
 *
 * The same pin `packages/screen/test/spec-routes.test.ts` keeps on `screen.md`,
 * pointed at this package: the §1 table's rows against `TOOLS`, the catalogue
 * `tools/list` actually answers. A tool added with no row, and a row naming a
 * tool that does not exist, both fail here.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { TOOLS } from '../src/tools.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SPEC_PATH = path.join(REPO_ROOT, 'docs', 'spec', 'mcp-server.md');

/** The section under test, matched by its number and never by its wording. */
const CATALOGUE_HEADING = '## 1.';

/** A tool row: the first cell is the backticked tool name. */
const TABLE_ROW = /^\|\s*`(cartografo_[a-z_]+)`\s*\|/;

/** One section of the spec, from its heading to the next one. */
function section(spec: string, heading: string): string {
  const lines = spec.split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  assert.notEqual(start, -1, `spec has no "${heading}" section`);

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function documentedTools(): string[] {
  assert.ok(existsSync(SPEC_PATH), `spec does not exist: ${SPEC_PATH}`);
  const rows = section(readFileSync(SPEC_PATH, 'utf8'), CATALOGUE_HEADING)
    .split('\n')
    .flatMap((line) => {
      const match = TABLE_ROW.exec(line.trim());
      return match === null ? [] : [match[1]];
    });
  assert.ok(rows.length > 0, 'mcp-server.md §1 has no tool rows; this pin no longer reads the table');
  assert.equal(new Set(rows).size, rows.length, 'mcp-server.md §1 lists a tool twice');
  return rows.sort();
}

test('t548 AT2 — mcp-server.md §1 documents exactly the TOOLS catalogue', () => {
  const documented = documentedTools();
  const real = TOOLS.map((tool) => tool.name).sort();

  const undocumented = real.filter((name) => !documented.includes(name));
  const invented = documented.filter((name) => !real.includes(name));
  assert.deepEqual(undocumented, [], `tools with no row in mcp-server.md §1: ${undocumented.join(', ')}`);
  assert.deepEqual(invented, [], `rows in mcp-server.md §1 naming no real tool: ${invented.join(', ')}`);
});
