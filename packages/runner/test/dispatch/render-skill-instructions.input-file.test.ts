/**
 * Acceptance tests for `{{input_file.<path>}}` through the render (t689, FR1–FR4).
 *
 * The existing `render-skill-instructions.test.ts` is past 1200 lines, so the new
 * cases live beside it. What is proven: the argv and the instructions share ONE
 * plan, the render stays pure (nothing exists on disk afterwards), and a missing
 * directory fails closed instead of leaving a token in the text.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ControlPlaneClientError } from '../../src/controller/control-plane-client.ts';
import type { GraphEdge, ResolvedNode } from '../../src/dispatch/resolve-node.ts';
import {
  renderSkillInstructions,
  UnresolvedPlaceholderError,
  type ReadSkill,
} from '../../src/dispatch/render-skill-instructions.ts';

const SKILL_HASH = `sha256:${'b'.repeat(64)}`;
const EDGES: GraphEdge[] = [{ from: 'conferir', to: 'publicar', condition: 'aprovado' }];
const DIR = path.join(path.sep, 'definitely', 'not', 'there', 'job-3', 'fedcba9876543210');

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'shell-step',
    version: '1.0.0',
    hash: SKILL_HASH,
    role: 'work',
    description: 'A shell step.',
    input: { type: 'object' },
    output: { type: 'object' },
    preconditions: [],
    checks: [],
    permissions: {
      filesystem: { read: ['**'], write: [] },
      network: { allowed: false },
    },
    instructions: 'Runs the command.',
    ...overrides,
  };
}

function node(): ResolvedNode {
  return {
    versionId: 'sha256:cafe',
    node: {
      id: 'conferir',
      role: 'tester',
      node_type: 'work',
      description: 'A step.',
      skill_ref: { id: 'shell-step', version: '1.0.0', hash: SKILL_HASH },
      contract: { input_schema: { type: 'object' }, output_schema: { type: 'object' }, checks: [] },
    },
    edges: EDGES,
  };
}

function reader(body: Record<string, unknown>): ReadSkill {
  return (route) => {
    if (!route.includes('shell-step')) {
      return Promise.reject(new ControlPlaneClientError(`GET ${route} answered 404`, 404, {}));
    }
    return Promise.resolve(body as unknown as Awaited<ReturnType<ReadSkill>>);
  };
}

test('AT2 — an argv mixes input (the string) and input_file (an absolute path); the plan carries the content and nothing is on disk', async () => {
  const rendered = await renderSkillInstructions(
    node(),
    reader(manifest({ command: { argv: ['tool', '{{input.x}}', '{{input_file.y}}'] } })),
    { x: 'plain', y: { big: 'document' } },
    { inputFilesDir: DIR },
  );

  assert.ok(rendered !== null);
  const file = path.join(DIR, 'y.json');
  assert.deepEqual(rendered.command?.argv, ['tool', 'plain', file]);
  assert.ok(path.isAbsolute(file));
  assert.deepEqual(rendered.inputFiles, [
    { placeholderPath: 'y', filePath: file, content: '{"big":"document"}' },
  ]);
  assert.equal(existsSync(DIR), false, 'rendering writes nothing');
});

test('AT2 — a file token in instructions renders the same path and shares the plan entry with the argv', async () => {
  const rendered = await renderSkillInstructions(
    node(),
    reader(
      manifest({
        instructions: 'Read the document at {{input_file.y}} first.',
        command: { argv: ['tool', '{{input_file.y}}'] },
      }),
    ),
    { y: 'document' },
    { inputFilesDir: DIR },
  );

  assert.ok(rendered !== null);
  const file = path.join(DIR, 'y.json');
  assert.ok(rendered.instructions.includes(`Read the document at ${file} first.`));
  assert.deepEqual(rendered.command?.argv, ['tool', file]);
  assert.equal(rendered.inputFiles.length, 1, 'one path, one file');
});

test('AT2 — an unresolved input in the body and an unresolved file in the argv are ONE UnresolvedPlaceholderError', async () => {
  await assert.rejects(
    () =>
      renderSkillInstructions(
        node(),
        reader(
          manifest({
            instructions: 'Needs {{input.a}}.',
            command: { argv: ['tool', '{{input_file.b}}'] },
          }),
        ),
        {},
        { inputFilesDir: DIR },
      ),
    (error: unknown) => {
      assert.ok(error instanceof UnresolvedPlaceholderError);
      assert.deepEqual(error.paths, ['a', 'input_file.b']);
      return true;
    },
  );
});

test('AT2 — with no inputFilesDir a skill using a file token fails closed', async () => {
  await assert.rejects(
    () =>
      renderSkillInstructions(
        node(),
        reader(manifest({ command: { argv: ['tool', '{{input_file.y}}'] } })),
        { y: 'present' },
      ),
    (error: unknown) => {
      assert.ok(error instanceof UnresolvedPlaceholderError);
      assert.deepEqual(error.paths, ['input_file.y']);
      return true;
    },
  );

  await assert.rejects(
    () =>
      renderSkillInstructions(
        node(),
        reader(manifest({ instructions: 'See {{input_file.y}}.' })),
        { y: 'present' },
        {},
      ),
    UnresolvedPlaceholderError,
    'the instructions fail closed too',
  );
});

test('AT2 — a skill without file tokens renders as before whether or not a directory is given', async () => {
  const body = manifest({
    instructions: 'Date is {{input.date}}.',
    command: { argv: ['tool', '{{input.date}}'], env_allowlist: ['PATH'] },
  });

  const without = await renderSkillInstructions(node(), reader(body), { date: '2026-10-13' });
  const withDir = await renderSkillInstructions(node(), reader(body), { date: '2026-10-13' }, { inputFilesDir: DIR });

  assert.ok(without !== null && withDir !== null);
  assert.deepEqual(without.command, { argv: ['tool', '2026-10-13'], envAllowlist: ['PATH'] });
  assert.deepEqual(withDir.command, without.command);
  assert.equal(withDir.instructions, without.instructions);
  assert.deepEqual(without.inputFiles, []);
  assert.deepEqual(withDir.inputFiles, []);
});
