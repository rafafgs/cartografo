/**
 * The D4 import gate, in three commands (t117, FR5–FR7).
 *
 * `scan-skill` → `propose-skill` → `register-skill`. Three commands and not one,
 * because there is a HUMAN in the middle and the shape of the tool should say
 * so: the first derives a draft from a local checkout, the second puts it in
 * front of a person and stops, and the third only runs after somebody answered.
 * A single `import-skill` command would have to either block on a person or
 * decide on its behalf, and D4 exists precisely to keep that decision a person's.
 *
 * What the derivation refuses to do is as important as what it does. It fills in
 * what a machine can read off the source with no judgement — the id, the
 * description, the body, the commands quoted inside fenced blocks — and leaves an
 * explicit placeholder everywhere a human has to decide: `input` and `output`
 * are never guessed from prose ("where the prose does not say, the reviewer
 * decides... it is never inferred in silence"), `permissions` come in at the safe
 * default and are only ever widened by a recorded human decision, and `role` is
 * the `--role` flag
 * verbatim, because a "work" skill registered as a gate is a gate that checks
 * nothing.
 *
 * Since t439 the derivation itself is not here: it lives in
 * `domain/skill-draft.ts`, pure, so a runner session can derive the same draft
 * with no terminal to type `--role` at, no registry to ask and no file to write
 * — and, by D1/D11, no access to this package at all
 * (`packages/runner/src/dispatch/skill-draft.ts` is a port of it). What stayed
 * behind is everything that is genuinely the COMMAND's: the `--role` check, the
 * id-collision question the registry answers over HTTP, the hash, the file, and
 * the terminal's error type. The two paragraphs above still describe what the
 * draft says — they just describe it one module further down.
 *
 * Nothing here fetches anything. The source is an already-cloned local checkout,
 * and that is a decision, not a missing feature: automating the fetch of
 * untrusted third-party content is itself part of the injection surface D4 exists
 * to close, so the clone stays a deliberate, out-of-band human step.
 *
 * Like the other subcommands, these are pure HTTP clients of the public API
 * (D1, D11): they open no database and have no privilege the screen does not
 * have. The manifest they write is the format's own vocabulary, English since
 * t178 — which is what finally makes `--role` a straight copy: the flag was
 * already English (t127) and the value it carries now IS `role`, with no
 * translation step in the middle. What this file PRINTS, and the checklist it
 * puts in front of the reviewer, is English since t180.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { manifestHash } from '../domain/manifest.ts';
import {
  deriveChecks,
  deriveSkillDraft,
  kebabCase,
  splitFrontmatter as splitFrontmatterOrThrow,
} from '../domain/skill-draft.ts';
import { isObject } from '../util/is-object.ts';
import { UsageError, requestJson } from './url.ts';

// The derivation itself lives in `domain/skill-draft.ts` since t439, so a
// runner session can derive the same draft with no terminal, no `--role` flag
// to type and no file to write (FR1/FR7). These two keep being exported from
// HERE because they always were: `test/cli-skill-import-unit.test.ts` imports
// them from this module and passes unmodified, which is the concrete proof the
// command's behaviour did not change with the move.
export { deriveChecks, kebabCase };
export type { DerivedCheck } from '../domain/skill-draft.ts';

/** Options of `scan-skill`. */
export interface ScanSkillOptions {
  /** Path of the `SKILL.md` in an already-cloned local checkout. */
  source: string;
  /** Source repository, as it goes into `origin.repo`. */
  repo: string;
  /** Commit or tag — never a branch, which moves (D4). */
  ref: string;
  /** `work` or `gate`; always explicit, never inferred. */
  role: string;
  /** Who is importing, as it goes into `origin.imported_by`. */
  by: string;
  /** Base URL of the control plane (the id collision is checked against it). */
  url: string;
  /** Output file; defaults to `./<id>.manifest.json`. */
  output?: string;
}

/** Options of `propose-skill`. */
export interface ProposeSkillOptions {
  /** Manifest file, already completed by the human. */
  path: string;
  /** Base URL of the control plane. */
  url: string;
}

/** Options of `register-skill`. */
export interface RegisterSkillOptions {
  /** Job the import gate opened. */
  jobId: number;
  /** Base URL of the control plane. */
  url: string;
}

/** The node a skill import travels through, in the job that carries the gate. */
const IMPORT_NODE = 'importar-skill';

/** What the reviewer signs (`skill-manifest.md`, "O que o revisor humano assina"). */
const REVIEW_CHECKLIST = `What you sign off on by approving (skill-manifest.md, "O que o revisor humano assina"):

  1. that \`role\` is right — a doing skill registered as a gate becomes a gate that checks nothing;
  2. that \`input\`/\`output\` describe what the skill really consumes and produces;
  3. that there is at least one check, and that every agentic check demands evidence of its own;
  4. that \`permissions\` are the minimum needed;
  5. that the reviewed \`instructions\` carry no hostile instruction — a reference to a file resident in the target repo, an external document the source controls, a request for a credential, exfiltration or execution of downloaded content.

To APPROVE: answer with the final manifest in JSON, with \`origin.reviewed_by\` filled in.
To REFUSE: answer with \`rejeitar: <reason>\`.`;

/** One `label  value` line of the success output — same shape as import/export. */
function line(label: string, value: string): string {
  return `  ${label.padEnd(18)}${value}\n`;
}

/** Reads a file, turning an unreadable path into a message instead of a stack trace. */
function readText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    throw new UsageError(`could not read "${filePath}"`);
  }
}

/**
 * `domain/skill-draft.ts`'s split, with the terminal's error type back on it.
 *
 * The domain module throws a plain `Error`, because `domain/` may not depend on
 * `cli/url.ts` — but this symbol is imported directly by
 * `test/cli-skill-import-unit.test.ts`, which asserts `instanceof UsageError`,
 * and more to the point every caller of it here is on its way to a terminal,
 * where a `UsageError` is what turns a stack trace into a message. So the wrap
 * is one line, and the message crosses it untouched.
 *
 * @param text Whole file contents.
 * @returns Frontmatter keys and the body after the closing delimiter.
 * @throws {UsageError} When the block is absent or never closed.
 */
export function splitFrontmatter(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  try {
    return splitFrontmatterOrThrow(text);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/**
 * The refusal `deriveSkillDraft` reported, as the terminal has to read it.
 *
 * Only ONE of the derivation's refusals names the source file, and only this
 * layer knows what the file is called — the domain function is handed a string
 * and nothing else. So the prefix is added here, to that one message, which
 * keeps `"<source>" has no "name" in its frontmatter — there is no id to
 * derive` byte-identical to what the command printed before the extraction.
 *
 * @param source Resolved path of the `SKILL.md`.
 * @param error Message as the domain reported it.
 * @returns The error to throw.
 */
function refusalOf(source: string, error: string): UsageError {
  return new UsageError(error.startsWith('has no "name"') ? `"${source}" ${error}` : error);
}

/**
 * Runs `cartografo scan-skill` (FR5).
 *
 * @param options Source, provenance, role and destination.
 * @returns Process exit code.
 */
export async function runScanSkill(options: ScanSkillOptions): Promise<number> {
  if (options.role !== 'work' && options.role !== 'gate') {
    throw new UsageError('--role has to be work or gate (D4: never inferred, always confirmed)');
  }

  const source = path.resolve(options.source);

  // The whole derivation, in one call and before anything is asked of the
  // network: the role is already validated above, and a source the derivation
  // refuses is refused here too — the registry is never asked about an id that
  // does not exist. `imported_at` is computed HERE because the domain function
  // reads no clock (t439, FR4); the value is the same one this command has
  // always written.
  const derived = deriveSkillDraft(readText(source), {
    role: options.role,
    origin: {
      repo: options.repo,
      ref: options.ref,
      importedBy: options.by,
      importedAt: new Date().toISOString().slice(0, 10),
    },
  });
  if (!derived.ok) throw refusalOf(source, derived.error);

  const draft = derived.draft;
  const id = String(draft.id);

  const registry = await requestJson(`${options.url}/v1/skills`);
  if (registry.status !== 200) {
    process.stderr.write(
      `cartografo: the control plane answered HTTP ${registry.status} while listing the registry\n`,
    );
    return 1;
  }
  const known = isObject(registry.body) && Array.isArray(registry.body.skills)
    ? registry.body.skills
    : [];
  if (known.some((skill) => isObject(skill) && skill.id === id)) {
    // The refusal STAYS, and t215 did not soften it. The registry carries
    // versions now, but that answers a different question: whether this
    // `SKILL.md` is a newer version of that lineage or a different skill that
    // happens to share a name is exactly D4's human decision, and a derivation
    // from a fresh source has no way to tell. What changed is that the message
    // used to read as a dead end. There are two ways through now, both of them
    // a person's, and neither needs a flag that does not exist: rename, or say
    // "yes, same lineage" by hand — `propose-skill` and `register-skill` do not
    // re-run this check, because they take a manifest a human wrote and signed.
    process.stderr.write(
      `cartografo: id "${id}" is already registered at ${options.url} — a collision is a human decision (D4)\n` +
        '  a different skill that shares a name: re-run with a source-prefixed name\n' +
        `  a newer version of the same skill: edit this draft with a bumped "version" (and its recomputed "hash"), then send it through \`cartografo propose-skill\` → \`register-skill\`\n`,
    );
    return 1;
  }

  // The pin is the caller's to compute, on purpose (t439, FR6): the derivation
  // leaves `hash: ''` so the runner's port of it does not have to carry
  // `manifestHash`/`canonicalize` across the D1/D11 boundary. Here, where the
  // hasher already exists, the value written to disk is what it always was.
  draft.hash = manifestHash(draft);
  const checks = Array.isArray(draft.checks) ? draft.checks : [];

  const destination = path.resolve(options.output ?? `${id}.manifest.json`);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');

  process.stdout.write('skill draft written\n');
  process.stdout.write(line('id', id));
  process.stdout.write(line('role', options.role));
  process.stdout.write(line('checks derived', String(checks.length)));
  process.stdout.write(line('file', destination));
  if (checks.length === 0) {
    process.stdout.write(
      '\nno check could be derived from the source: the registry refuses an imported skill\nwith no check at all (D4), so one has to be written by hand before proposing.\n',
    );
  }
  process.stdout.write('\nwhat only a human can write is still a placeholder:\n');
  process.stdout.write(line('input/output', 'write the JSON Schema of what the skill consumes and produces'));
  process.stdout.write(line('instructions', 'review the body as an injection vector before approving'));
  process.stdout.write(line('hash', 'recompute it after editing — the pin covers the content fields'));
  process.stdout.write(`\nnext: cartografo propose-skill ${destination}\n`);
  return 0;
}

/**
 * Runs `cartografo propose-skill` (FR6).
 *
 * Creates the job and, on it, the approval that blocks it. Both through the
 * public API, and both with the machinery that already exists: human escalation
 * is a first-class entity, so the import gate becomes an item in the same inbox
 * as every other decision instead of a parallel approval mechanism nobody else
 * can see.
 *
 * @param options Manifest file and base URL.
 * @returns Process exit code.
 */
export async function runProposeSkill(options: ProposeSkillOptions): Promise<number> {
  const target = path.resolve(options.path);
  const text = readText(target);

  let manifest: unknown;
  try {
    manifest = JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`"${target}" is not valid JSON — ${(error as Error).message}`);
  }
  if (!isObject(manifest)) throw new UsageError(`"${target}" is not a manifest object`);

  const id = typeof manifest.id === 'string' ? manifest.id : '(no id)';
  const origin = isObject(manifest.origin) ? manifest.origin : {};
  const repo = typeof origin.repo === 'string' ? origin.repo : '(origin not declared)';
  const ref = typeof origin.ref === 'string' ? origin.ref : '(ref not declared)';

  const job = await requestJson(`${options.url}/v1/jobs`, {
    method: 'POST',
    body: { title: `importar skill: ${id} de ${repo}@${ref}`, entry_node_id: IMPORT_NODE },
  });
  if (job.status !== 201 || !isObject(job.body) || typeof job.body.id !== 'number') {
    process.stderr.write(
      `cartografo: the control plane refused the import job (HTTP ${job.status})\n`,
    );
    return 1;
  }
  const jobId = job.body.id;

  const gate = await requestJson(`${options.url}/v1/input-requests`, {
    method: 'POST',
    body: {
      job_id: jobId,
      kind: 'approval',
      question: `Approve importing skill ${id}?`,
      context: `${JSON.stringify(manifest, null, 2)}\n\n${REVIEW_CHECKLIST}`,
      // Never auto-approvable, in any circumstance: D4's gate is a person.
      auto_approvable: false,
    },
  });
  if (gate.status !== 201 || !isObject(gate.body) || typeof gate.body.id !== 'number') {
    process.stderr.write(
      `cartografo: the control plane refused the approval request (HTTP ${gate.status}); job ${jobId} was created and is not blocked\n`,
    );
    return 1;
  }

  process.stdout.write('skill import proposed\n');
  process.stdout.write(line('skill', id));
  process.stdout.write(line('job', String(jobId)));
  process.stdout.write(line('input request', String(gate.body.id)));
  process.stdout.write('\nthe job is blocked until somebody answers it in the inbox.\n');
  process.stdout.write(`next, once approved: cartografo register-skill --job ${jobId}\n`);
  return 0;
}

/**
 * Runs `cartografo register-skill` (FR7).
 *
 * Sends what the human answered, and nothing else — it does not re-derive, does
 * not repair and does not re-pin. If the registry refuses what was approved, the
 * refusal is printed verbatim: the registry is the gate of truth, and a CLI that
 * softened its answer would be re-approving on the human's behalf.
 *
 * @param options Job of the gate and base URL.
 * @returns Process exit code.
 */
export async function runRegisterSkill(options: RegisterSkillOptions): Promise<number> {
  const queue = await requestJson(
    `${options.url}/v1/input-requests?job_id=${options.jobId}`,
  );
  if (queue.status !== 200 || !isObject(queue.body) || !Array.isArray(queue.body.input_requests)) {
    process.stderr.write(
      `cartografo: the control plane answered HTTP ${queue.status} for the gate of job ${options.jobId}\n`,
    );
    return 1;
  }

  // The last answered approval, and not the first: a gate reopened after a
  // rejection is the same job with a newer decision on it.
  const answered = queue.body.input_requests
    .filter(
      (item): item is Record<string, unknown> =>
        isObject(item) && item.kind === 'approval' && item.status === 'answered',
    )
    .at(-1);

  if (answered === undefined) {
    process.stderr.write(
      `cartografo: no answered approval on job ${options.jobId} — the import gate is still waiting for a human\n`,
    );
    return 1;
  }

  const decision = typeof answered.answer === 'string' ? answered.answer.trim() : '';
  if (decision.toLowerCase().startsWith('rejeitar:')) {
    const why = decision.slice('rejeitar:'.length).trim();
    process.stderr.write(
      `cartografo: import refused by ${String(answered.answered_by)} — ${why === '' ? '(no reason given)' : why}\n`,
    );
    process.stderr.write('cartografo: nothing was registered\n');
    return 1;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(decision) as unknown;
  } catch (error) {
    process.stderr.write(
      `cartografo: the answer on input request ${String(answered.id)} is neither a "rejeitar:" nor a manifest in JSON — ${(error as Error).message}\n`,
    );
    return 1;
  }

  const registration = await requestJson(`${options.url}/v1/skills`, {
    method: 'POST',
    body: manifest,
  });
  const body = isObject(registration.body) ? registration.body : {};

  if (registration.status === 201) {
    process.stdout.write('skill registered\n');
    process.stdout.write(line('id', String(body.id)));
    process.stdout.write(line('version', String(body.version)));
    process.stdout.write(line('hash', String(body.hash)));
    process.stdout.write(line('registered_at', String(body.registered_at)));
    return 0;
  }

  if (registration.status >= 400 && registration.status < 500) {
    process.stderr.write(
      `cartografo: the registry refused the approved manifest (HTTP ${registration.status})\n`,
    );
    process.stderr.write(`  ${String(body.error ?? 'manifest_rejected')}\n`);
    for (const problem of Array.isArray(body.details) ? body.details : []) {
      process.stderr.write(`  ${String(problem)}\n`);
    }
    process.stderr.write('cartografo: nothing was registered\n');
    return 1;
  }

  process.stderr.write(
    `cartografo: the control plane answered HTTP ${registration.status} while registering the skill\n`,
  );
  return 1;
}
