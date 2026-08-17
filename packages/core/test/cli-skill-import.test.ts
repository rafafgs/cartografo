/**
 * Acceptance tests of the D4 import pipeline (t117, AT8–AT11).
 *
 * Three commands, one gate: `scan-skill` derives what can be derived
 * mechanically and refuses to guess the rest, `propose-skill` puts the draft in
 * front of a human through the input-request machinery that already exists, and
 * `register-skill` only ever sends to the registry what a human answered — with
 * the registry still free to refuse it.
 *
 * The fixtures under `test/fixtures/external-skills/` make this hermetic. The
 * `feature-dev` one is a verbatim copy of
 * `~/flowpilot/.claude/skills/feature-dev/SKILL.md`, which is the worked example
 * `especificacoes/formatos/manifesto-skill.md` itself uses for D4: eleven of the
 * twelve required manifest fields simply do not exist at the source. Copying it
 * into the repository is what lets the test prove the pipeline against a real,
 * unmodified external skill without depending on that checkout existing on the
 * machine running `npm test`.
 *
 * The manifest field names are English since t178: the 2026-08-15 D18 amendment
 * pulled the skill-manifest format's keys into the rename the original decision
 * had left them out of. The `--role` flag is unchanged — it was already English
 * (t127) — but the VALUE it takes now maps straight onto `role`, with no
 * translation step in between.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PACKAGE_ROOT,
  type RunningControlPlane,
  looksLikeStackTrace,
  runCli,
  startControlPlane,
  temporaryArea,
} from './cli-support.ts';

const FIXTURES = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'external-skills');
const FEATURE_DEV = path.join(FIXTURES, 'feature-dev', 'SKILL.md');
const NO_DERIVABLE_CHECK = path.join(FIXTURES, 'no-derivable-check', 'SKILL.md');

const SOURCE_REPO = 'https://github.com/rafaelgomes/flowpilot';
const SOURCE_REF = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** The draft `scan-skill` writes — the contract this test demands of it. */
interface Draft {
  id: string;
  version: string;
  hash: string;
  role: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  preconditions: string[];
  checks: { id: string; type: string; description: string; command?: string }[];
  permissions: {
    filesystem: { read: string[]; write: string[] };
    network: { allowed: boolean; domains?: string[] };
  };
  instructions: string;
  origin: Record<string, unknown>;
}

/** Sorts keys recursively — same canonicalization the format's hash is defined over. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonical(source[key]);
    return sorted;
  }
  return value;
}

/** The pin, recomputed here on purpose (see `skill-routes.test.ts`). */
function contentHash(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(subset)), 'utf8').digest('hex')}`;
}

/** Runs `scan-skill` against a fixture and returns the draft it wrote. */
async function scan(
  source: string,
  destination: string,
  controlPlane: RunningControlPlane,
  role = 'work',
): Promise<Draft> {
  const result = await runCli([
    'scan-skill',
    source,
    '--repo',
    SOURCE_REPO,
    '--ref',
    SOURCE_REF,
    '--role',
    role,
    '--by',
    'rafael',
    '--out',
    destination,
    '--url',
    controlPlane.url,
  ], { token: controlPlane.token });
  assert.equal(result.code, 0, `scan-skill failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(looksLikeStackTrace(result.stderr), false, `a stack trace leaked:\n${result.stderr}`);
  return JSON.parse(readFileSync(destination, 'utf8')) as Draft;
}

/**
 * What the human does between the draft and the approval: writes the two schemas
 * the tool refused to guess, signs the review, and recomputes the pin over what
 * they actually approved.
 */
function complete(draft: Draft, extra: Partial<Draft> = {}): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    ...draft,
    input: {
      type: 'object',
      required: ['ticket'],
      properties: { ticket: { type: 'string' } },
    },
    output: {
      type: 'object',
      required: ['nota'],
      properties: { nota: { type: 'string' } },
    },
    origin: { ...(draft.origin as Record<string, unknown>), reviewed_by: 'rafael' },
    ...extra,
  };
  manifest.hash = contentHash(manifest);
  return manifest;
}

/** Writes a manifest to disk and returns the path — what `propose-skill` reads. */
function writeManifest(destination: string, manifest: Record<string, unknown>): string {
  writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return destination;
}

/** Reads the two ids `propose-skill` prints. */
function proposedIds(stdout: string): { job: number; inputRequest: number } {
  const job = /\bjob\s+(\d+)/.exec(stdout);
  const inputRequest = /\binput request\s+(\d+)/.exec(stdout);
  assert.ok(job !== null, `propose-skill did not print the job id:\n${stdout}`);
  assert.ok(inputRequest !== null, `propose-skill did not print the input-request id:\n${stdout}`);
  return { job: Number(job[1]), inputRequest: Number(inputRequest[1]) };
}

test('AT8 — scan-skill derives what it can from a real external SKILL.md and guesses nothing', { timeout: 300_000 }, async (t) => {
  const base = temporaryArea(t, 'cartografo-t117-');
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'scan', 'cartografo.db'),
  });

  const draft = await scan(FEATURE_DEV, path.join(base, 'feature-dev.manifest.json'), controlPlane);

  assert.equal(draft.id, 'feature-dev', 'the id is the kebab-case of the frontmatter name');
  assert.equal(draft.version, '0.1.0', 'a new import is always 0.1.0 (D4)');
  assert.equal(draft.role, 'work', 'role is the --role flag, verbatim');
  assert.equal(
    draft.description,
    'Orchestrates new feature development following the full 4-phase protocol',
    'description comes from the frontmatter description',
  );

  // What only a human can write is a placeholder, never a guess.
  assert.deepEqual(draft.input, { $comment: 'revisor humano escreve o JSON Schema aqui' });
  assert.deepEqual(draft.output, { $comment: 'revisor humano escreve o JSON Schema aqui' });

  assert.deepEqual(draft.permissions, {
    filesystem: { read: ['**'], write: [] },
    network: { allowed: false },
  });

  assert.deepEqual(draft.origin, {
    type: 'imported',
    repo: SOURCE_REPO,
    ref: SOURCE_REF,
    imported_by: 'rafael',
    imported_at: new Date().toISOString().slice(0, 10),
  });
  assert.equal(
    (draft.origin as { reviewed_by?: string }).reviewed_by,
    undefined,
    'nobody has reviewed the draft yet, so it cannot claim a reviewer',
  );

  // The fenced `bash` block of Phase 4 has four commands; the `git` block has none
  // that the derivation recognizes, and no check is ever invented.
  assert.deepEqual(
    draft.checks.map((check) => check.command),
    ['make test', 'make test-front', 'make typecheck', 'make lint'],
  );
  for (const check of draft.checks) {
    assert.equal(check.type, 'deterministic');
    assert.ok(check.description.length > 0, 'a check with no description is not a contract');
  }

  assert.ok(
    draft.instructions.includes('# Feature Development Orchestrator'),
    'instructions is the Markdown body of the source',
  );
  assert.equal(
    draft.instructions.includes('name: feature-dev'),
    false,
    'the frontmatter is metadata, not part of the instructions',
  );
  assert.equal(draft.hash, contentHash(draft as unknown as Record<string, unknown>));
});

test('AT9 — propose-skill opens a blocking human gate, never auto-approvable', { timeout: 300_000 }, async (t) => {
  const base = temporaryArea(t, 'cartografo-t117-');
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'propose', 'cartografo.db'),
  });

  const draft = await scan(FEATURE_DEV, path.join(base, 'draft.json'), controlPlane);
  const manifestPath = writeManifest(path.join(base, 'final.json'), complete(draft));

  const result = await runCli(['propose-skill', manifestPath, '--url', controlPlane.url], { token: controlPlane.token });
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const ids = proposedIds(result.stdout);

  const job = (await (await fetch(`${controlPlane.url}/v1/jobs/${ids.job}`)).json()) as {
    title: string;
    entry_node_id: string;
    blocked: boolean;
  };
  assert.equal(job.blocked, true, 'the job waits on the human');
  assert.equal(job.entry_node_id, 'importar-skill');
  assert.match(job.title, /feature-dev/);
  assert.match(job.title, new RegExp(SOURCE_REF));

  const queue = (await (
    await fetch(`${controlPlane.url}/v1/input-requests?job_id=${ids.job}`)
  ).json()) as {
    input_requests: {
      id: number;
      kind: string;
      question: string;
      context: string | null;
      auto_approvable: boolean;
      status: string;
    }[];
  };
  assert.equal(queue.input_requests.length, 1);
  const pending = queue.input_requests[0];
  assert.equal(pending.id, ids.inputRequest);
  assert.equal(pending.kind, 'approval');
  assert.equal(pending.auto_approvable, false, 'D4 never allows auto-approval of an import');
  assert.equal(pending.status, 'pending');
  assert.match(pending.question, /feature-dev/);
  assert.ok(pending.context !== null, 'whoever answers has to see the manifest');
  assert.match(pending.context, /"id": "feature-dev"/, 'the manifest goes in pretty-printed');
  assert.match(pending.context, /permissions/, 'the checklist covers what the reviewer signs');

  // t180 — the question and the checklist are what a person READS, so they are
  // English; the manifest keys quoted inside them are the format's own (FR2).
  assert.equal(pending.question, 'Approve importing skill feature-dev?');
  assert.ok(
    pending.context.includes('What you sign off on by approving'),
    `the checklist header is English; came:\n${pending.context}`,
  );
  assert.ok(
    pending.context.includes('To APPROVE: answer with the final manifest in JSON'),
    'so is the instruction that closes it',
  );
});

test('AT10 — scan, complete, propose, approve, register: the whole D4 gate', { timeout: 300_000 }, async (t) => {
  const base = temporaryArea(t, 'cartografo-t117-');
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'gate', 'cartografo.db'),
  });

  const draft = await scan(FEATURE_DEV, path.join(base, 'draft.json'), controlPlane);
  const finalized = complete(draft);
  const manifestPath = writeManifest(path.join(base, 'final.json'), finalized);

  const proposal = await runCli(['propose-skill', manifestPath, '--url', controlPlane.url], { token: controlPlane.token });
  assert.equal(proposal.code, 0, `stdout:\n${proposal.stdout}\nstderr:\n${proposal.stderr}`);
  const ids = proposedIds(proposal.stdout);

  // The human answers in the inbox: the answer IS the finalized manifest.
  const answered = await fetch(`${controlPlane.url}/v1/input-requests/${ids.inputRequest}/answer`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer: JSON.stringify(finalized), answered_by: 'rafael' }),
  });
  assert.equal(answered.status, 200);

  const registration = await runCli([
    'register-skill',
    '--job',
    String(ids.job),
    '--url',
    controlPlane.url,
  ], { token: controlPlane.token });
  assert.equal(
    registration.code,
    0,
    `register-skill failed\nstdout:\n${registration.stdout}\nstderr:\n${registration.stderr}`,
  );
  assert.match(registration.stdout, /feature-dev/);
  assert.match(registration.stdout, new RegExp(finalized.hash as string));

  const response = await fetch(`${controlPlane.url}/v1/skills/feature-dev`);
  assert.equal(response.status, 200);
  const registered = (await response.json()) as {
    id: string;
    hash: string;
    origin: { type: string; reviewed_by: string; ref: string };
    checks: unknown[];
  };
  assert.equal(registered.id, 'feature-dev');
  assert.equal(registered.hash, finalized.hash);
  assert.equal(registered.origin.type, 'imported');
  assert.equal(registered.origin.reviewed_by, 'rafael', 'the signature of the D4 gate is stored');
  assert.equal(registered.origin.ref, SOURCE_REF);
  assert.equal(registered.checks.length, 4);

  const job = (await (await fetch(`${controlPlane.url}/v1/jobs/${ids.job}`)).json()) as {
    blocked: boolean;
  };
  assert.equal(job.blocked, false, 'answering the input request unblocks the job');
});

test('AT11 — a skill with no derivable check is refused by the registry, even once approved', { timeout: 300_000 }, async (t) => {
  const base = temporaryArea(t, 'cartografo-t117-');
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'refused', 'cartografo.db'),
  });

  const draft = await scan(NO_DERIVABLE_CHECK, path.join(base, 'draft.json'), controlPlane);
  assert.equal(draft.id, 'architecture-review');
  assert.deepEqual(draft.checks, [], 'pure prose yields no check, and none is invented');

  // The human completes everything a human can complete — and there is still no
  // check to write, which is exactly the case D4 says does not enter.
  const finalized = complete(draft);
  const manifestPath = writeManifest(path.join(base, 'final.json'), finalized);

  const proposal = await runCli(['propose-skill', manifestPath, '--url', controlPlane.url], { token: controlPlane.token });
  assert.equal(proposal.code, 0, `stdout:\n${proposal.stdout}\nstderr:\n${proposal.stderr}`);
  const ids = proposedIds(proposal.stdout);

  const answered = await fetch(`${controlPlane.url}/v1/input-requests/${ids.inputRequest}/answer`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer: JSON.stringify(finalized), answered_by: 'rafael' }),
  });
  assert.equal(answered.status, 200);

  const registration = await runCli([
    'register-skill',
    '--job',
    String(ids.job),
    '--url',
    controlPlane.url,
  ], { token: controlPlane.token });
  assert.equal(registration.code, 1, `expected exit 1\nstdout:\n${registration.stdout}\nstderr:\n${registration.stderr}`);
  assert.match(registration.stderr, /no derivable check/i);
  assert.equal(looksLikeStackTrace(registration.stderr), false, `a stack trace leaked:\n${registration.stderr}`);

  const response = await fetch(`${controlPlane.url}/v1/skills/architecture-review`);
  assert.equal(response.status, 404, 'an approved manifest the registry refuses is still not registered');
});
