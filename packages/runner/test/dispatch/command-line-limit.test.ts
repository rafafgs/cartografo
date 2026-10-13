/**
 * Acceptance tests for the command-line ceiling (t689, FR8–FR9).
 *
 * Windows limits ONE command line to 32,767 UTF-16 units, counting the program
 * and a separator per element; Linux limits ONE argument to 128 KiB. The guard
 * is pure, takes the platform as data, and reports which element is the culprit
 * and which placeholders built it, so a block reason can tell an author what to
 * switch.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARGUMENT_LIMIT_BYTES,
  CommandLineTooLongError,
  WIN32_COMMAND_LINE_LIMIT,
  checkCommandLine,
} from '../../src/dispatch/command-line-limit.ts';

/** An argv of two elements whose measured win32 size is exactly `total`. */
function win32Argv(total: number): string[] {
  // sum(length) + one separator per element: 'a' (1+1) + the rest (n+1).
  return ['a', 'x'.repeat(total - 3)];
}

test('AT3 — the constants are the ones the ticket fixed', () => {
  assert.equal(WIN32_COMMAND_LINE_LIMIT, 32000);
  assert.equal(ARGUMENT_LIMIT_BYTES, 131072);
});

test('AT3 — win32: 30,000 and 32,000 pass; 32,001 and 33,000 are refused', () => {
  for (const total of [30_000, 32_000]) {
    const argv = win32Argv(total);
    assert.equal(checkCommandLine(argv, argv, 'win32'), null, `${String(total)} passes`);
  }
  for (const total of [32_001, 33_000]) {
    const argv = win32Argv(total);
    const violation = checkCommandLine(argv, argv, 'win32');
    assert.ok(violation !== null, `${String(total)} is refused`);
    assert.equal(violation.measured, total);
    assert.equal(violation.limit, 32000);
    assert.equal(violation.unit, 'characters');
    assert.equal(violation.platform, 'win32');
  }
});

test('AT3 — win32 counts argv[0] and one separator per element, in characters', () => {
  // 3 elements of 10,666 = 31,998 + 3 separators = 32,001.
  const argv = ['x'.repeat(10_666), 'y'.repeat(10_666), 'z'.repeat(10_666)];
  const violation = checkCommandLine(argv, argv, 'win32');
  assert.ok(violation !== null);
  assert.equal(violation.measured, 32_001);

  // 20,000 `é` are 20,000 characters, not 40,000 bytes: 'a' (2) + 20,001 passes.
  const accented = ['a', 'é'.repeat(20_000)];
  assert.equal(checkCommandLine(accented, accented, 'win32'), null);
});

test('AT3 — linux: the limit is per element, in bytes', () => {
  const at = ['tool', 'x'.repeat(131_072)];
  assert.equal(checkCommandLine(at, at, 'linux'), null, '131,072 bytes passes');

  const over = ['tool', 'x'.repeat(140_000)];
  const violation = checkCommandLine(over, over, 'linux');
  assert.ok(violation !== null);
  assert.equal(violation.measured, 140_000);
  assert.equal(violation.limit, 131_072);
  assert.equal(violation.unit, 'bytes');

  const under = ['tool', 'x'.repeat(100_000)];
  assert.equal(checkCommandLine(under, under, 'linux'), null);

  // 70,000 `é` are 70,000 characters and 140,000 bytes.
  const accented = ['tool', 'é'.repeat(70_000)];
  const refused = checkCommandLine(accented, accented, 'linux');
  assert.ok(refused !== null);
  assert.equal(refused.measured, 140_000);

  const many = ['tool', ...Array.from({ length: 10 }, () => 'x'.repeat(100_000))];
  assert.equal(checkCommandLine(many, many, 'linux'), null, 'many elements under the per-element limit pass');
});

test('AT3 — darwin follows the non-win32 rule', () => {
  const over = ['tool', 'x'.repeat(140_000)];
  const violation = checkCommandLine(over, over, 'darwin');
  assert.ok(violation !== null);
  assert.equal(violation.unit, 'bytes');
  assert.equal(violation.platform, 'darwin');
});

test('AT3 — the violation names the LONGEST element and the input placeholders of its declared template', () => {
  const templates = ['tool', '--short', '--profile={{input.profile}} {{input.other}} {{input.profile}}', '{{input_file.doc}}'];
  const argv = ['tool', '--short', 'p'.repeat(140_000), '/tmp/doc.json'];

  const violation = checkCommandLine(argv, templates, 'linux');

  assert.ok(violation !== null);
  assert.equal(violation.position, 2);
  assert.deepEqual(violation.placeholders, ['profile', 'other'], 'in order, deduplicated');

  const literal = checkCommandLine(['tool', 'x'.repeat(140_000)], ['tool', 'x'.repeat(140_000)], 'linux');
  assert.ok(literal !== null);
  assert.equal(literal.position, 1);
  assert.deepEqual(literal.placeholders, [], 'a literal element names no placeholder');

  const file = checkCommandLine(['tool', 'f'.repeat(140_000)], ['tool', '{{input_file.profile}}'], 'linux');
  assert.ok(file !== null);
  assert.deepEqual(file.placeholders, [], '{{input_file.…}} is not listed');
});

test('AT3 — a single placeholder is listed by its path', () => {
  const violation = checkCommandLine(['t', 'v'.repeat(33_000)], ['t', '{{input.profile}}'], 'win32');
  assert.ok(violation !== null);
  assert.deepEqual(violation.placeholders, ['profile']);
  assert.equal(violation.position, 1);
});

test('AT3 — the error carries every field of the violation plus the node and skill', () => {
  const error = new CommandLineTooLongError({
    nodeId: 'conferir',
    skillId: 'shell-step',
    platform: 'win32',
    measured: 33_000,
    limit: 32_000,
    unit: 'characters',
    position: 2,
    placeholders: ['big'],
  });

  assert.ok(error instanceof Error);
  assert.equal(error.name, 'CommandLineTooLongError');
  assert.equal(error.nodeId, 'conferir');
  assert.equal(error.skillId, 'shell-step');
  assert.equal(error.platform, 'win32');
  assert.equal(error.measured, 33_000);
  assert.equal(error.limit, 32_000);
  assert.equal(error.unit, 'characters');
  assert.equal(error.position, 2);
  assert.deepEqual(error.placeholders, ['big']);
});
