/**
 * Unit tests for the disclosure gate (t329, FR6).
 *
 * The gate has one job and it is positional: a first-time reader must meet both
 * disclosures BEFORE the first command they would paste. A check that only
 * asked "is the text present anywhere" would pass a README that puts the whole
 * block at the bottom, which is exactly the failure the gate exists against —
 * so every fixture below differs from the positive one by position, by a
 * missing citation, or by a missing pointer, and by nothing else.
 *
 * Fixtures are strings, not files: the gate reads the real `README.md` and
 * `docs/getting-started.md` through its CLI, and pinning its RULES to the real
 * documents would mean editing this file every time a paragraph moves.
 *
 * Same pattern as `scripts/no-portuguese-prose.test.mjs`: fixed sample text,
 * one assertion per verdict, no filesystem.
 *
 * Run with: `npm test` at the root, or `node --test scripts/`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CITATION_AFTER_FIRST_COMMAND,
  CITATION_MISSING,
  ENVIRONMENT_CITATION,
  GETTING_STARTED_POINTER,
  POINTER_AFTER_FIRST_COMMAND,
  POINTER_MISSING,
  TRANSCRIPT_CITATION,
  checkGettingStartedPointer,
  checkReadmeDisclosure,
} from './check-readme-disclosure.mjs';

/** The disclosure block, reduced to the two citations the gate looks for. */
const DISCLOSURE = [
  'Two properties of this design, before the first command:',
  '',
  `- The agent inherits the whole shell environment (\`${ENVIRONMENT_CITATION}\`).`,
  `- Transcripts are stored unredacted (\`${TRANSCRIPT_CITATION}\`).`,
].join('\n');

/** A README whose disclosure sits where a reader passes through it. */
const README_VALID = [
  '# cartografo',
  '',
  '## How to run it',
  '',
  DISCLOSURE,
  '',
  'Below is the fast path.',
  '',
  '```bash',
  'npm install',
  '```',
  '',
  'Step 1 is `npm install` because a working checkout is where the lockfile moves.',
].join('\n');

/** The same README with the disclosure moved past the command it warns about. */
const README_BLOCK_AFTER_FENCE = [
  '# cartografo',
  '',
  '## How to run it',
  '',
  'Below is the fast path.',
  '',
  '```bash',
  'npm install',
  '```',
  '',
  DISCLOSURE,
].join('\n');

/** The same README with one of the two citations dropped. */
const README_WITHOUT_ENVIRONMENT_CITATION = README_VALID.replace(
  `- The agent inherits the whole shell environment (\`${ENVIRONMENT_CITATION}\`).\n`,
  '',
);

/** A getting-started page whose pointer sits above its own first command. */
const GETTING_STARTED_VALID = [
  '# Getting started',
  '',
  'This page is the long way round.',
  '',
  `Before you run anything, read [what you hand to the agent](${GETTING_STARTED_POINTER}).`,
  '',
  '---',
  '',
  '## 1. Install',
  '',
  '```bash',
  'npm install',
  '```',
].join('\n');

/** The same page with the pointer removed. */
const GETTING_STARTED_WITHOUT_POINTER = GETTING_STARTED_VALID.replace(
  `Before you run anything, read [what you hand to the agent](${GETTING_STARTED_POINTER}).\n\n`,
  '',
);

/** The same page with the pointer pushed below the first command. */
const GETTING_STARTED_POINTER_AFTER_FENCE = [
  '# Getting started',
  '',
  'This page is the long way round.',
  '',
  '---',
  '',
  '## 1. Install',
  '',
  '```bash',
  'npm install',
  '```',
  '',
  `Before you run anything, read [what you hand to the agent](${GETTING_STARTED_POINTER}).`,
].join('\n');

const codesOf = (report) => report.violations.map((violation) => violation.code);
const targetsOf = (report) => report.violations.map((violation) => violation.target);

test('a README carrying both citations before the first command passes', () => {
  const report = checkReadmeDisclosure(README_VALID);

  assert.deepEqual(report, { valid: true, violations: [] });
});

test('a missing citation fails, and the report names which one', () => {
  const report = checkReadmeDisclosure(README_WITHOUT_ENVIRONMENT_CITATION);

  assert.equal(report.valid, false);
  assert.deepEqual(codesOf(report), [CITATION_MISSING]);
  assert.deepEqual(targetsOf(report), [ENVIRONMENT_CITATION]);
  assert.match(report.violations[0].message, new RegExp(ENVIRONMENT_CITATION));
});

test('a disclosure moved past the first command fails on both citations', () => {
  const report = checkReadmeDisclosure(README_BLOCK_AFTER_FENCE);

  assert.equal(report.valid, false);
  assert.deepEqual(codesOf(report), [
    CITATION_AFTER_FIRST_COMMAND,
    CITATION_AFTER_FIRST_COMMAND,
  ]);
  assert.deepEqual(targetsOf(report), [ENVIRONMENT_CITATION, TRANSCRIPT_CITATION]);
});

test('the getting-started pointer is required, and required before the first command', () => {
  const missing = checkGettingStartedPointer(GETTING_STARTED_WITHOUT_POINTER);
  assert.equal(missing.valid, false);
  assert.deepEqual(codesOf(missing), [POINTER_MISSING]);

  const present = checkGettingStartedPointer(GETTING_STARTED_VALID);
  assert.deepEqual(present, { valid: true, violations: [] });

  const late = checkGettingStartedPointer(GETTING_STARTED_POINTER_AFTER_FENCE);
  assert.equal(late.valid, false);
  assert.deepEqual(codesOf(late), [POINTER_AFTER_FIRST_COMMAND]);
});

test('the fence that decides position is the one under "How to run it", not an earlier one', () => {
  const readme = [
    '# cartografo',
    '',
    '## The idea in one paragraph',
    '',
    '```bash',
    'npx cartografo --help',
    '```',
    '',
    '## How to run it',
    '',
    DISCLOSURE,
    '',
    '```bash',
    'npm install',
    '```',
  ].join('\n');

  assert.deepEqual(checkReadmeDisclosure(readme), { valid: true, violations: [] });
});
