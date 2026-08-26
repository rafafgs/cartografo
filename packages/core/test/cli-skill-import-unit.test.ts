/**
 * The derivation and the failure branches of the D4 import gate, in process (t212).
 *
 * `cli-skill-import.test.ts` walks the three commands against a real control
 * plane and proves the gate itself: the job blocks, nobody can auto-approve it,
 * and what the human answered is what reaches the registry. What it cannot walk
 * is what the gate does when things are wrong — a `SKILL.md` with no
 * frontmatter, an id already in the registry, an approval nobody answered, an
 * answer that is neither a manifest nor a refusal — and that is why
 * `skill-import.ts` read 93 % of lines and 45 % of branches.
 *
 * Those branches are not decoration. D4 exists because an imported skill is
 * content nobody in this repository wrote, and every one of them is a place
 * where the gate could fail OPEN: derive an id from a name it should have
 * refused, register a manifest the human never approved, treat a rejection as an
 * approval because the answer did not parse. Each test below is one of those
 * doors, checked shut.
 *
 * The three exported pure parts — `splitFrontmatter`, `kebabCase`,
 * `deriveChecks` — are tested directly, since they are where the "guesses
 * nothing" rule actually lives.
 *
 * English per D18. Since t226 what the gate READS back is English too
 * (`kind: 'approval'`, `status: 'answered'`) — D20's API child — while the body
 * it POSTS stays Portuguese, because that one is event-validated; `rejeitar:`
 * and the manifest field names are the formats' own either way.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  deriveChecks,
  kebabCase,
  runProposeSkill,
  runRegisterSkill,
  runScanSkill,
  splitFrontmatter,
} from '../src/cli/skill-import.ts';
import { UsageError } from '../src/cli/url.ts';
import { temporaryArea, type TestHook } from './cli-support.ts';
import { capture, startFakeControlPlane, type FakeAnswer } from './cli-unit-support.ts';

/** Writes a `SKILL.md` in an area of its own and answers with its path. */
function sourceFile(t: TestHook, contents: string, name = 'SKILL.md'): string {
  const area = temporaryArea(t, 'cartografo-t212-skill-');
  const file = path.join(area, name);
  writeFileSync(file, contents, 'utf8');
  return file;
}

/** A `SKILL.md` with the frontmatter the derivation reads. */
function skillSource(frontmatter: string, body = 'Do the work.\n'): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

/** The registry, empty, which is what `scan-skill` checks the id against. */
function emptyRegistry(): FakeAnswer {
  return { status: 200, body: { skills: [] } };
}

/** Options of `scan-skill` that are not what a given test is about. */
function scanOptions(source: string, url: string, output?: string) {
  return {
    source,
    repo: 'https://github.com/example/skills',
    ref: 'a1b2c3d',
    role: 'work',
    by: 'rafael',
    url,
    output,
  };
}

/* ------------------------------------------------------------ pure parts */

test('the frontmatter is read flat, and a malformed one is refused loudly', () => {
  const read = splitFrontmatter('---\nname: a-skill\ndescription: "with quotes"\n\nno_colon\n: no key\n---\n\n\nThe body.\n');

  assert.deepEqual(read.frontmatter, { name: 'a-skill', description: 'with quotes' });
  assert.equal(read.body, 'The body.\n', 'the blank lines after the block belong to the block');

  assert.throws(() => splitFrontmatter('# No frontmatter\n'), UsageError);
  assert.throws(() => splitFrontmatter('---\nname: a-skill\n'), UsageError);
});

test('kebabCase strips accents, punctuation and the dashes it would end on', () => {
  assert.equal(kebabCase('Résumé Review'), 'resume-review');
  assert.equal(kebabCase('  --npm run test!!  '), 'npm-run-test');
  assert.equal(kebabCase('naïve-already'), 'naive-already');
  assert.equal(kebabCase('!!!'), '', 'a name that yields nothing yields nothing, not a guess');
});

test('only a command quoted inside a fenced block becomes a check', () => {
  const checks = deriveChecks(
    [
      'Run the suite (`npm test`) and confirm the failures.',
      '',
      '```bash',
      '# a comment is not a command',
      '',
      'npm test',
      'npm test!',
      'npm test',
      'git commit -m "none of that"',
      'cd /tmp',
      'pytest -q',
      '```',
      '',
      'npm run build',
    ].join('\n'),
  );

  assert.deepEqual(
    checks.map((check) => check.command),
    ['npm test', 'npm test!', 'pytest -q'],
    'prose names a command, a fence prescribes one — and a repeat is not a second check',
  );
  assert.deepEqual(
    checks.map((check) => check.id),
    ['npm-test', 'npm-test-2', 'pytest-q'],
    'two commands with the same kebab id do not become one check',
  );
  assert.deepEqual(
    [...new Set(checks.map((check) => check.type))],
    ['deterministic'],
    'a derived check is always the deterministic kind',
  );
  assert.deepEqual(deriveChecks('no fence at all\n'), []);
});

/* -------------------------------------------------------------- scan-skill */

test('a role that is neither work nor gate never becomes a draft', async (t) => {
  const plane = await startFakeControlPlane(t, emptyRegistry);
  const source = sourceFile(t, skillSource('name: a-skill'));

  await assert.rejects(
    capture(() => runScanSkill({ ...scanOptions(source, plane.url), role: 'judge' })),
    (error: unknown) => error instanceof UsageError && /work or gate/.test(error.message),
  );
  assert.deepEqual(plane.requests, [], 'D4: the role is never inferred, so it is never guessed away');
});

test('a source with no usable name is refused before the registry is asked', async (t) => {
  const plane = await startFakeControlPlane(t, emptyRegistry);

  await assert.rejects(
    capture(() => runScanSkill(scanOptions(sourceFile(t, skillSource('description: no name')), plane.url))),
    (error: unknown) => error instanceof UsageError && /has no "name"/.test(error.message),
  );
  await assert.rejects(
    capture(() => runScanSkill(scanOptions(sourceFile(t, skillSource('name: ""')), plane.url))),
    UsageError,
  );
  await assert.rejects(
    capture(() => runScanSkill(scanOptions(sourceFile(t, skillSource('name: "!!!"')), plane.url))),
    (error: unknown) => error instanceof UsageError && /does not yield a kebab-case id/.test(error.message),
  );
});

test('a source that cannot be read is a message, not a stack trace', async (t) => {
  const plane = await startFakeControlPlane(t, emptyRegistry);

  await assert.rejects(
    capture(() => runScanSkill(scanOptions('/does/not/exist/SKILL.md', plane.url))),
    (error: unknown) => error instanceof UsageError && /could not read/.test(error.message),
  );
});

test('a registry that does not answer 200 stops the scan', async (t) => {
  const plane = await startFakeControlPlane(t, () => ({ status: 503 }));
  const source = sourceFile(t, skillSource('name: a-skill'));

  const run = await capture(() => runScanSkill(scanOptions(source, plane.url)));

  assert.equal(run.code, 1);
  assert.match(run.stderr, /HTTP 503 while listing the registry/);
});

test('an id already registered is a human decision, not an overwrite', async (t) => {
  const plane = await startFakeControlPlane(t, () => ({
    status: 200,
    body: { skills: ['not an object', { id: 'a-skill' }] },
  }));
  const source = sourceFile(t, skillSource('name: A Skill'));

  const run = await capture(() => runScanSkill(scanOptions(source, plane.url)));

  assert.equal(run.code, 1);
  assert.match(run.stderr, /id "a-skill" is already registered/);
  assert.match(run.stderr, /a collision is a human decision \(D4\)/);

  // t215, FR8: the refusal STAYS — `scan-skill` derives from a fresh `SKILL.md`,
  // and whether that is the same lineage or a name collision is still a
  // person's call. What it may no longer read as is a dead end: since the
  // registry carries versions, the escape hatch for "yes, same skill, newer
  // content" already exists and needs no new code, so the message says it.
  assert.match(run.stderr, /propose-skill/, 'the message has to name the way through');
  assert.match(run.stderr, /version/, 'and say that the way through is a bumped version');
});

test('the draft leaves a placeholder wherever a human has to decide', async (t) => {
  const plane = await startFakeControlPlane(t, emptyRegistry);
  const area = temporaryArea(t, 'cartografo-t212-draft-');
  const output = path.join(area, 'folder', 'new', 'a-skill.manifest.json');
  const source = sourceFile(
    t,
    skillSource('name: A Skill\ndescription: does a thing', 'Run:\n\n```bash\nnpm test\n```\n'),
  );

  const run = await capture(() => runScanSkill({ ...scanOptions(source, plane.url, output), role: 'gate' }));

  assert.equal(run.code, 0);
  const draft = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
  assert.equal(draft.id, 'a-skill');
  assert.equal(draft.role, 'gate', 'the role is the flag, verbatim');
  assert.equal(draft.description, 'does a thing');
  assert.deepEqual(draft.input, { $comment: 'revisor humano escreve o JSON Schema aqui' });
  assert.deepEqual(draft.permissions, {
    filesystem: { read: ['**'], write: [] },
    network: { allowed: false },
  });
  assert.equal(
    Object.hasOwn(draft, 'reviewed_by'),
    false,
    'a draft nobody reviewed may not claim a reviewer',
  );
  assert.match(run.stdout, /checks derived\s+1/);
  assert.match(run.stdout, /next: cartografo propose-skill/);
});

test('a source with no derivable check says so, because the registry refuses one', async (t) => {
  const plane = await startFakeControlPlane(t, emptyRegistry);
  const area = temporaryArea(t, 'cartografo-t212-draft-');
  const source = sourceFile(t, skillSource('name: no-check', 'Just prose, no command.\n'));

  const previous = process.cwd();
  process.chdir(area);
  t.after(() => process.chdir(previous));

  const run = await capture(() => runScanSkill(scanOptions(source, plane.url)));

  assert.equal(run.code, 0);
  assert.match(run.stdout, /checks derived\s+0/);
  assert.match(run.stdout, /no check could be derived/);
  assert.equal(
    JSON.parse(readFileSync(path.join(area, 'no-check.manifest.json'), 'utf8')).id,
    'no-check',
    'without --out the draft is named after the id, where the command was run',
  );
});

/* ----------------------------------------------------------- propose-skill */

test('a manifest file that is not a manifest never opens a gate', async (t) => {
  const plane = await startFakeControlPlane(t, () => ({ status: 201, body: { id: 1 } }));
  const area = temporaryArea(t, 'cartografo-t212-propose-');

  const broken = path.join(area, 'quebrado.json');
  writeFileSync(broken, '{ "id": ', 'utf8');
  const list = path.join(area, 'lista.json');
  writeFileSync(list, '["not a manifest"]', 'utf8');

  await assert.rejects(
    capture(() => runProposeSkill({ path: path.join(area, 'does-not-exist.json'), url: plane.url })),
    (error: unknown) => error instanceof UsageError && /could not read/.test(error.message),
  );
  await assert.rejects(
    capture(() => runProposeSkill({ path: broken, url: plane.url })),
    (error: unknown) => error instanceof UsageError && /is not valid JSON/.test(error.message),
  );
  await assert.rejects(
    capture(() => runProposeSkill({ path: list, url: plane.url })),
    (error: unknown) => error instanceof UsageError && /is not a manifest object/.test(error.message),
  );
  assert.deepEqual(plane.requests, []);
});

test('the approval is opened on the job, never auto-approvable', async (t) => {
  const plane = await startFakeControlPlane(t, (request) =>
    request.path === '/v1/jobs' ? { status: 201, body: { id: 77 } } : { status: 201, body: { id: 91 } },
  );
  const area = temporaryArea(t, 'cartografo-t212-propose-');
  const manifest = path.join(area, 'a-skill.manifest.json');
  writeFileSync(
    manifest,
    JSON.stringify({ id: 'a-skill', origin: { repo: 'example/skills', ref: 'a1b2c3d' } }),
    'utf8',
  );

  const run = await capture(() => runProposeSkill({ path: manifest, url: plane.url }));

  assert.equal(run.code, 0);
  const gate = plane.requests[1].body as Record<string, unknown>;
  assert.equal(gate.kind, 'approval');
  assert.equal(gate.job_id, 77);
  assert.equal(gate.auto_approvable, false, 'D4 gate is a person, in every circumstance');
  assert.match(String(gate.context), /What you sign off on by approving/);
  assert.match(run.stdout, /input request\s+91/);
});

test('a manifest with no id and no origin is described as what it is', async (t) => {
  const plane = await startFakeControlPlane(t, () => ({ status: 201, body: { id: 5 } }));
  const area = temporaryArea(t, 'cartografo-t212-propose-');
  const manifest = path.join(area, 'anonimo.json');
  writeFileSync(manifest, JSON.stringify({ origin: 'not an object' }), 'utf8');

  const run = await capture(() => runProposeSkill({ path: manifest, url: plane.url }));

  assert.equal(run.code, 0);
  const job = plane.requests[0].body as Record<string, unknown>;
  assert.equal(job.title, 'importar skill: (no id) de (origin not declared)@(ref not declared)');
});

test('a control plane that refuses the job or the approval stops the proposal', async (t) => {
  const area = temporaryArea(t, 'cartografo-t212-propose-');
  const manifest = path.join(area, 'a-skill.json');
  writeFileSync(manifest, JSON.stringify({ id: 'a-skill' }), 'utf8');

  const noJob = await startFakeControlPlane(t, () => ({ status: 500 }));
  const first = await capture(() => runProposeSkill({ path: manifest, url: noJob.url }));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /refused the import job \(HTTP 500\)/);

  const jobWithoutId = await startFakeControlPlane(t, () => ({ status: 201, body: { without: 'id' } }));
  const second = await capture(() => runProposeSkill({ path: manifest, url: jobWithoutId.url }));
  assert.equal(second.code, 1);

  const noGate = await startFakeControlPlane(t, (request) =>
    request.path === '/v1/jobs' ? { status: 201, body: { id: 77 } } : { status: 422 },
  );
  const third = await capture(() => runProposeSkill({ path: manifest, url: noGate.url }));
  assert.equal(third.code, 1);
  assert.match(third.stderr, /refused the approval request \(HTTP 422\)/);
  assert.match(third.stderr, /job 77 was created and is not blocked/);
});

/* ---------------------------------------------------------- register-skill */

/** The queue of input requests of a job, as `register-skill` reads it. */
function queue(questions: unknown[]): FakeAnswer {
  return { status: 200, body: { input_requests: questions } };
}

/** An answered approval carrying `answer` as the human's decision. */
function answered(answer: string, id = 91): Record<string, unknown> {
  return {
    id,
    kind: 'approval',
    status: 'answered',
    answer,
    answered_by: 'rafael',
  };
}

const APPROVED_MANIFEST = { id: 'a-skill', version: '0.1.0', hash: 'sha256:abc' };

test('a gate nobody answered registers nothing', async (t) => {
  const pending = await startFakeControlPlane(t, () =>
    queue([
      { id: 1, kind: 'approval', status: 'pending', answer: null },
      { id: 2, kind: 'question', status: 'answered', answer: 'anything at all' },
    ]),
  );

  const run = await capture(() => runRegisterSkill({ jobId: 77, url: pending.url }));

  assert.equal(run.code, 1);
  assert.match(run.stderr, /no answered approval on job 77/);
  assert.equal(
    pending.requests[0].path,
    '/v1/input-requests?job_id=77',
    'the queue is asked for that job alone',
  );
});

test('a queue that does not come back as a queue stops the registration', async (t) => {
  const broken = await startFakeControlPlane(t, () => ({ status: 500 }));
  const first = await capture(() => runRegisterSkill({ jobId: 77, url: broken.url }));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /HTTP 500 for the gate of job 77/);

  const shapeless = await startFakeControlPlane(t, () => ({ status: 200, body: { without: 'input_requests' } }));
  const second = await capture(() => runRegisterSkill({ jobId: 77, url: shapeless.url }));
  assert.equal(second.code, 1);
});

test('a refusal is a refusal, with or without a reason written on it', async (t) => {
  const withReason = await startFakeControlPlane(t, () =>
    queue([answered('rejeitar: the instructions ask for a credential')]),
  );
  const first = await capture(() => runRegisterSkill({ jobId: 77, url: withReason.url }));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /import refused by rafael — the instructions ask for a credential/);
  assert.match(first.stderr, /nothing was registered/);
  assert.deepEqual(
    withReason.requests.map((request) => request.method),
    ['GET'],
    'a refused import never reaches the registry',
  );

  const bare = await startFakeControlPlane(t, () => queue([answered('Rejeitar:   ')]));
  const second = await capture(() => runRegisterSkill({ jobId: 77, url: bare.url }));
  assert.equal(second.code, 1);
  assert.match(second.stderr, /\(no reason given\)/);
});

test('an answer that is neither a refusal nor a manifest registers nothing', async (t) => {
  const plane = await startFakeControlPlane(t, () => queue([answered('go ahead, looks great')]));

  const run = await capture(() => runRegisterSkill({ jobId: 77, url: plane.url }));

  assert.equal(run.code, 1);
  assert.match(run.stderr, /the answer on input request 91 is neither a "rejeitar:" nor a manifest in JSON/);
});

test('the last answer on the gate is the one that counts', async (t) => {
  const plane = await startFakeControlPlane(t, (request) =>
    request.method === 'GET'
      ? queue([
          answered('rejeitar: the input schema is missing', 90),
          answered(JSON.stringify(APPROVED_MANIFEST), 91),
        ])
      : {
          status: 201,
          body: { ...APPROVED_MANIFEST, registered_at: '2026-08-16T00:00:00.000Z' },
        },
  );

  const run = await capture(() => runRegisterSkill({ jobId: 77, url: plane.url }));

  assert.equal(run.code, 0, 'a gate reopened after a rejection is the same job with a newer decision');
  assert.deepEqual(plane.requests[1].body, APPROVED_MANIFEST, 'what the human approved, verbatim');
  assert.match(run.stdout, /skill registered/);
  assert.match(run.stdout, /registered_at\s+2026-08-16/);
});

test('a registry that refuses the approved manifest is quoted, never softened', async (t) => {
  const detailed = await startFakeControlPlane(t, (request) =>
    request.method === 'GET'
      ? queue([answered(JSON.stringify(APPROVED_MANIFEST))])
      : {
          status: 422,
          body: { error: 'manifesto_invalido', details: ['checks: at least one', 'hash: does not match'] },
        },
  );
  const first = await capture(() => runRegisterSkill({ jobId: 77, url: detailed.url }));
  assert.equal(first.code, 1);
  assert.match(first.stderr, /refused the approved manifest \(HTTP 422\)/);
  assert.match(first.stderr, /manifesto_invalido/);
  assert.match(first.stderr, /hash: does not match/);
  assert.match(first.stderr, /nothing was registered/);

  const silent = await startFakeControlPlane(t, (request) =>
    request.method === 'GET' ? queue([answered(JSON.stringify(APPROVED_MANIFEST))]) : { status: 409 },
  );
  const second = await capture(() => runRegisterSkill({ jobId: 77, url: silent.url }));
  assert.equal(second.code, 1);
  assert.match(second.stderr, /manifest_rejected/);

  const broken = await startFakeControlPlane(t, (request) =>
    request.method === 'GET' ? queue([answered(JSON.stringify(APPROVED_MANIFEST))]) : { status: 503 },
  );
  const third = await capture(() => runRegisterSkill({ jobId: 77, url: broken.url }));
  assert.equal(third.code, 1);
  assert.match(third.stderr, /HTTP 503 while registering the skill/);
});

test('the three commands are HTTP clients and nothing else', async (t) => {
  const plane = await startFakeControlPlane(t, emptyRegistry);
  const area = temporaryArea(t, 'cartografo-t212-client-');
  mkdirSync(path.join(area, 'output'), { recursive: true });
  const source = sourceFile(t, skillSource('name: a-skill'));

  await capture(() =>
    runScanSkill(scanOptions(source, plane.url, path.join(area, 'output', 'draft.json'))),
  );

  assert.deepEqual(
    plane.requests.map((request) => `${request.method} ${request.path}`),
    ['GET /v1/skills'],
    'D1: the gate reads the registry over the API, never a database',
  );
});
