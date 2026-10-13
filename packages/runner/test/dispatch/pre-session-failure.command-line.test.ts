/**
 * Acceptance tests for the block reason of a command line the platform cannot
 * spawn (t689, FR10).
 *
 * The reason is what an author reads in the inbox, so it has to carry the six
 * facts that let them fix the manifest without opening a log: the node, the
 * skill, the measured size with its unit, the limit, the argv position, and the
 * placeholder to switch — plus the promise that no session was opened and that
 * a retry changes nothing.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionStartError } from '../../src/engine/types.ts';
import { CommandLineTooLongError } from '../../src/dispatch/command-line-limit.ts';
import { classifyPreSessionFailure } from '../../src/dispatch/pre-session-failure.ts';

const JOB = { current_node_id: 'conferir', graph_version_id: 'sha256:cafe' };

function tooLong(placeholders: string[]): CommandLineTooLongError {
  return new CommandLineTooLongError({
    nodeId: 'conferir',
    skillId: 'shell-step',
    platform: 'win32',
    measured: 33_017,
    limit: 32_000,
    unit: 'characters',
    position: 2,
    placeholders,
  });
}

test('AT6 — the reason names the node, skill, size, unit, limit, position and every placeholder', () => {
  const reason = classifyPreSessionFailure(tooLong(['first_look', 'profile']), JOB);

  assert.ok(reason !== null);
  for (const fact of [
    'conferir',
    'shell-step',
    '33017',
    'characters',
    '32000',
    '2',
    'first_look',
    'profile',
    '{{input_file.first_look}}',
    '{{input_file.profile}}',
  ]) {
    assert.ok(reason.replaceAll(',', '').includes(fact), `names ${fact}: ${reason}`);
  }
  assert.match(reason, /No session was opened/);
  assert.match(reason, /every retry/);
});

test('AT6 — a literal element is told to move its content into a file the command reads', () => {
  const reason = classifyPreSessionFailure(tooLong([]), JOB);

  assert.ok(reason !== null);
  assert.match(reason, /literal/i);
  assert.match(reason, /file/);
  assert.ok(!reason.includes('{{input_file.'), 'there is no placeholder to switch');
});

test('AT6 — bytes are named as bytes on the platforms that count them', () => {
  const reason = classifyPreSessionFailure(
    new CommandLineTooLongError({
      nodeId: 'conferir',
      skillId: 'shell-step',
      platform: 'linux',
      measured: 140_000,
      limit: 131_072,
      unit: 'bytes',
      position: 1,
      placeholders: ['big'],
    }),
    JOB,
  );

  assert.ok(reason !== null);
  assert.ok(reason.replaceAll(',', '').includes('140000'));
  assert.match(reason, /bytes/);
  assert.ok(reason.replaceAll(',', '').includes('131072'));
});

test('AT6 — an unrelated SessionStartError still classifies to null', () => {
  assert.equal(
    classifyPreSessionFailure(new SessionStartError('could not start "node"'), JOB),
    null,
  );
});
