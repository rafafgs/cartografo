/**
 * Acceptance tests of the map's export half (t432, RF-25).
 *
 * A browser download is bytes, not a directory, so `export-bundle.ts` has to
 * assemble a real `.zip` instead of pointing at a bundle on disk. The claim
 * worth proving is therefore not "it produced a file" but **the produced bytes
 * are a bundle the repository's own validator accepts** — so AT1 unpacks them
 * with a reader written here, by hand, and hands the result to
 * `scripts/validate-factory-bundle.mjs` unchanged. A writer checked only
 * against its own reader proves nothing about either.
 *
 * The reader is small because the writer stores (compression method 0): there
 * is no inflate step where the two could silently disagree, which is exactly
 * why Stored was picked for a ticket that asks for a valid bundle and never for
 * a small one.
 *
 * The other claim is purity. `buildBundleZip` reads no clock and no random
 * source — the entries carry the ZIP format's own epoch floor as their
 * timestamp — so the same draft always produces the same bytes (AT3). A
 * wall-clock stamp would have broken that one hour past midnight, and nowhere
 * else.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type * as ExportBundleModule from '../src/export-bundle.ts';
import type * as RegisterMapModule from '../src/register-map.ts';
import { requireArtifacts } from './support.ts';

/**
 * The repository's reference validator, reached through a computed specifier
 * — the same posture `graph-soundness.test.ts` already takes toward
 * `scripts/validate-graph.mjs`: the script is not part of this package's
 * dependency graph, it is the third party this test measures against.
 */
const BUNDLE_VALIDATOR = new URL('../../../scripts/validate-factory-bundle.mjs', import.meta.url)
  .href;

/** The slice of the validator's report this file reads. */
interface BundleReport {
  valid: boolean;
  errors: { code: string; message: string }[];
  manifests: { file: string; errors: { pointer: string; message: string }[] }[];
  pins: { node: string | null; problems: string[] }[];
}

async function load(): Promise<typeof ExportBundleModule> {
  requireArtifacts('src/register-map.ts', 'src/export-bundle.ts');
  return (await import(
    new URL('../src/export-bundle.ts', import.meta.url).href
  )) as typeof ExportBundleModule;
}

async function validateBundle(directory: string): Promise<BundleReport> {
  const module = (await import(BUNDLE_VALIDATOR)) as {
    validateBundle: (directory: string) => BundleReport;
  };
  return module.validateBundle(directory);
}

/* ------------------------------------------------------------------ fixtures */

/**
 * A draft as the interview leaves it: manifests with no `hash`, nodes pinned by
 * id and version only. Freshly built on every call, which is what makes AT3 a
 * statement about the input's CONTENT and not about its identity.
 */
function bundleDraft(): RegisterMapModule.MapDraft {
  return {
    graph: {
      problem_class: 'widget-triage',
      lineage: { type: 'base' },
      metadata: {
        name: 'Widget triage — the interviewed map',
        description: 'Two nodes: one writes the triage note, one checks it and closes the run.',
        schema_version: '1.0.0',
        created_at: '2026-09-06',
        source: 'an interview at the screen',
      },
      nodes: [
        {
          id: 'triage',
          role: 'analyst',
          node_type: 'work',
          description: 'Writes the triage note from the reported widget.',
          skill_ref: { id: 'triage-widget', version: '1.0.0' },
          contract: {
            input_schema: {
              type: 'object',
              required: ['widget'],
              properties: { widget: { type: 'string', minLength: 1 } },
            },
            output_schema: {
              type: 'object',
              required: ['note'],
              properties: { note: { type: 'string', minLength: 1 } },
            },
            checks: [
              {
                type: 'deterministic',
                command: 'test -s triage.md',
                description: 'The triage note exists and is not empty.',
              },
            ],
          },
        },
        {
          id: 'review',
          role: 'reviewer',
          node_type: 'gate',
          description: 'Checks the triage note against the reported widget and closes the run.',
          skill_ref: { id: 'review-widget', version: '2.1.0' },
          contract: {
            input_schema: {
              type: 'object',
              required: ['widget', 'note'],
              properties: { widget: { type: 'string' }, note: { type: 'string' } },
            },
            output_schema: {
              type: 'object',
              required: ['outcome', 'evidence'],
              properties: {
                outcome: { enum: ['pass', 'fail', 'escalate_human'] },
                evidence: { type: 'string', minLength: 1 },
              },
            },
            checks: [
              {
                type: 'agentic',
                instruction:
                  'Does the note name the reported widget and the decision taken about it? Cite the passage that supports the verdict.',
                required_evidence: true,
                description: 'A judgement of adherence, with evidence of its own.',
              },
            ],
          },
        },
      ],
      edges: [
        {
          from: 'triage',
          to: 'review',
          condition: 'always',
          description: 'A single exit: the note always goes on to review.',
        },
      ],
      initial_node: 'triage',
      final_nodes: ['review'],
      custom_fields: [],
    },
    skills: [
      {
        id: 'triage-widget',
        version: '1.0.0',
        role: 'work',
        description: 'Writes the triage note for one reported widget.',
        input: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['widget'],
          properties: { widget: { type: 'string', minLength: 1 } },
        },
        output: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['note'],
          properties: { note: { type: 'string', minLength: 1 } },
        },
        preconditions: ['the reported widget is available in the input'],
        checks: [
          {
            id: 'note-exists',
            type: 'deterministic',
            description: 'The triage note exists and is not empty.',
            command: 'test -s triage.md',
          },
        ],
        permissions: {
          filesystem: { read: ['**'], write: ['triage.md'] },
          network: { allowed: false },
        },
        instructions: '# Triage the widget\n\nWrite `triage.md` naming the widget and the decision.',
        origin: { type: 'native' },
      },
      {
        id: 'review-widget',
        version: '2.1.0',
        role: 'gate',
        description: 'Checks the triage note and closes the run.',
        input: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['widget', 'note'],
          properties: { widget: { type: 'string' }, note: { type: 'string' } },
        },
        output: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['outcome', 'evidence'],
          properties: {
            outcome: { type: 'string', enum: ['pass', 'fail', 'escalate_human'] },
            evidence: { type: 'string', minLength: 1 },
          },
        },
        preconditions: ['the triage note was written'],
        checks: [
          {
            id: 'adherence',
            type: 'agentic',
            description: 'A judgement of adherence, with evidence of its own.',
            instruction:
              'Does the note name the reported widget and the decision taken about it? Cite the passage that supports the verdict.',
            required_evidence: ['the passage of the note the verdict cites'],
          },
        ],
        permissions: { filesystem: { read: ['**'], write: [] }, network: { allowed: false } },
        instructions: '# Review the triage note\n\nRead `triage.md` and issue one verdict.',
        origin: { type: 'native' },
      },
    ],
  };
}

/* -------------------------------------------------------------- the zip reader */

/** One entry, as the central directory declares it. */
interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Reads a Stored zip the way the format says to: from the end.
 *
 * Written by hand, deliberately — an extractor from npm would test somebody
 * else's reader against ours, and this package carries no runtime dependency at
 * all.
 *
 * @param bytes The archive.
 * @returns One entry per file, in central-directory order.
 */
function readZip(bytes: Uint8Array): ZipEntry[] {
  const buffer = Buffer.from(bytes);

  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'the archive carries no end-of-central-directory record');

  const total = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < total; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, `central directory record #${index}`);
    const method = buffer.readUInt16LE(cursor + 10);
    assert.equal(method, 0, 'every entry is Stored, so no inflate step exists');
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `local header of "${name}"`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ name, data: buffer.subarray(start, start + compressedSize) });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Unpacks the archive into a fresh directory, as a person's download manager would. */
function extract(t: TestContext, bytes: Uint8Array): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cartografo-t432-bundle-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  for (const entry of readZip(bytes)) {
    const target = path.join(directory, entry.name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
  return directory;
}

/* ---------------------------------------------------------------------- tests */

test('AT1 — the produced bytes unpack into a bundle the reference validator accepts', async (t) => {
  const { buildBundleZip } = await load();

  const result = buildBundleZip(bundleDraft());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const directory = extract(t, result.bytes);
  assert.deepEqual(
    readZip(result.bytes).map((entry) => entry.name),
    ['graph.json', 'skills/triage-widget.json', 'skills/review-widget.json'],
    'the graph first, then one manifest per node, in the draft order',
  );

  const report = await validateBundle(directory);
  assert.equal(
    report.valid,
    true,
    JSON.stringify(
      {
        errors: report.errors,
        manifests: report.manifests.filter((entry) => entry.errors.length > 0),
        pins: report.pins.filter((pin) => pin.problems.length > 0),
      },
      null,
      2,
    ),
  );

  const graph = JSON.parse(readFileSync(path.join(directory, 'graph.json'), 'utf8')) as {
    nodes: { skill_ref: { hash: string } }[];
  };
  for (const node of graph.nodes) {
    assert.match(node.skill_ref.hash, /^sha256:[a-f0-9]{64}$/, 'every pin closed on the way out');
  }
});

test('AT2 — the file is named after the problem class', async () => {
  const { buildBundleZip } = await load();

  const result = buildBundleZip(bundleDraft());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.filename, 'widget-triage.bundle.zip');
});

test('AT3 — the same draft always produces the same bytes', async () => {
  const { buildBundleZip } = await load();

  const first = buildBundleZip(bundleDraft());
  const second = buildBundleZip(bundleDraft());
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.equal(
    Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes)),
    0,
    'no clock and no randomness: two structurally identical drafts pack identically',
  );
});

test('AT4 — a broken pin refuses the export, and no byte is built', async () => {
  const { buildBundleZip } = await load();
  const draft = bundleDraft();
  (draft.graph.nodes ?? [])[1].skill_ref = { id: 'nobody-wrote-this', version: '2.1.0' };

  const result = buildBundleZip(draft);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.problems.map((problem) => problem.code), ['unmatched_skill_ref']);
  assert.match(result.problems[0].message, /nobody-wrote-this/);
});

test('AT5 — a draft with no problem class has nothing to name the file after', async () => {
  const { buildBundleZip } = await load();

  const absent = bundleDraft();
  delete absent.graph.problem_class;
  const blank = bundleDraft();
  blank.graph.problem_class = '';

  for (const draft of [absent, blank]) {
    const result = buildBundleZip(draft);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.problems.map((problem) => problem.code), ['missing_problem_class']);
  }
});
