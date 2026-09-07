/**
 * Deriving a draft skill manifest from a `SKILL.md` (t439, FR1–FR4/FR6).
 *
 * This is the part of the D4 import gate that a machine can do with no
 * judgement, and nothing else. It used to live inline inside
 * `cli/skill-import.ts`, tangled with a `--role` flag somebody has to type, an
 * HTTP call that asks the registry about an id collision, and a file write —
 * three things a runner session has none of. It has a terminal to nobody, no
 * human standing by, and by D1/D11 no access to the control plane's modules at
 * all. So the derivation moves down here, where it is pure: no CLI, no network,
 * no filesystem, and — the one that is easiest to leave behind — no clock.
 *
 * **What "pure" buys.** `packages/runner/src/dispatch/skill-draft.ts` is a local
 * PORT of this file, the same way `synthesizer/similarity.ts` ports
 * `domain/similarity.ts`, and a port can only be trusted if the thing being
 * copied has no hidden input. `new Date()` was exactly such an input: the caller
 * passes `origin.importedAt` now, so the same text always derives the same
 * draft, on either side of the boundary, in a test as in production.
 *
 * **What the derivation refuses to do is as important as what it does.** It
 * fills in what can be read off the source — the id, the description, the body,
 * the commands quoted inside fenced blocks — and leaves an explicit placeholder
 * everywhere a human has to decide: `input`/`output` are never guessed from
 * prose, `permissions` come in at the safe default, and a `role` nobody supplied
 * becomes {@link ROLE_PLACEHOLDER} rather than `work` — a doing skill registered
 * as a gate is a gate that checks nothing (D4).
 *
 * **Errors are results, not exceptions**, following `domain/graph.ts` and
 * `domain/manifest.ts`: {@link deriveSkillDraft} never throws. The two thrown
 * cases {@link splitFrontmatter} keeps are the price of a function whose only
 * sensible answer to malformed input is "this is not a frontmatter"; the
 * composer maps them into its own result, and the CLI wraps them back into a
 * `UsageError` on its way to a terminal. Nothing here knows what a `UsageError`
 * is, which is what keeps `domain/` from depending on `cli/url.ts`.
 */

/** A check derived from a command quoted in the source body. */
export interface DerivedCheck {
  id: string;
  type: string;
  description: string;
  command: string;
}

/** What {@link deriveSkillDraft} answers: a draft, or the reason there is none. */
export type SkillDraftResult =
  | { ok: true; draft: Record<string, unknown> }
  | { ok: false; error: string };

/** Provenance the CALLER knows and this function cannot: repo, ref, who, when. */
export interface SkillDraftOrigin {
  repo?: string;
  ref?: string;
  importedBy?: string;
  /**
   * Import date, supplied by the caller.
   *
   * Deliberately not `new Date()`: a domain function that reads the wall clock
   * is a function whose output nobody can reproduce, and this one has two
   * implementations that have to agree character for character.
   */
  importedAt?: string;
}

/** Everything a caller may supply; every field of it is optional on purpose. */
export interface SkillDraftOptions {
  /** `work` or `gate`. Validating it is the caller's job — D4 is a human gate. */
  role?: string;
  origin?: SkillDraftOrigin;
}

/**
 * Command heads the derivation recognizes inside a fenced block.
 *
 * A closed list, and a short one: every entry here is a line that a machine can
 * turn into "exit 0 = passed" with no interpretation. `git commit`, `cd` or a
 * shell pipeline quoted in a tutorial are not checks, and inventing one out of
 * them would be exactly the silent inference the format forbids.
 */
const COMMAND_HEADS = ['make', 'npm', 'npx', 'pytest', 'go test', 'node'];

/** What only a human can write — never a guess (`skill-manifest.md:244-245`). */
export const SCHEMA_PLACEHOLDER = { $comment: 'revisor humano escreve o JSON Schema aqui' };

/** D4's safe default: read the workspace, write nothing, no network. */
export const SAFE_PERMISSIONS = {
  filesystem: { read: ['**'], write: [] },
  network: { allowed: false },
};

/** Version of a new import; the real source reference lives in `origin.ref` (D4). */
export const IMPORT_VERSION = '0.1.0';

/**
 * The `role` of a draft nobody named a role for.
 *
 * A placeholder and not a default, for the same reason `input`/`output` are
 * placeholders: `work` is the likely answer, and a likely answer written into
 * the field is indistinguishable from a decided one by the time a reviewer
 * reads it. This value is not a valid role, so it cannot pass the registry by
 * accident — it has to be replaced by somebody.
 */
export const ROLE_PLACEHOLDER = 'role not set — a human decision, D4: never inferred';

/**
 * Splits a `SKILL.md` into flat frontmatter and Markdown body.
 *
 * Hand-rolled and deliberately flat: the frontmatter of every skill this gate
 * targets (flowpilot, bootstrap-core) is `key: value` and nothing else, and a
 * YAML dependency in the control plane to read three lines would be a parser —
 * with its own history of surprises — added to the surface of the very feature
 * that exists to reduce it. A nested frontmatter simply does not parse here, and
 * that is a loud, reviewable failure rather than a silent misreading.
 *
 * @param text Whole file contents.
 * @returns Frontmatter keys and the body after the closing delimiter.
 * @throws {Error} A plain `Error` — the domain layer does not know what a
 *   `UsageError` is — when the block is absent or never closed.
 */
export function splitFrontmatter(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error('the SKILL.md does not start with a --- frontmatter block');
  }

  const closing = lines.findIndex((current, index) => index > 0 && current.trim() === '---');
  if (closing === -1) throw new Error('the SKILL.md frontmatter block is never closed');

  const frontmatter: Record<string, string> = {};
  for (const current of lines.slice(1, closing)) {
    if (current.trim() === '') continue;
    const separator = current.indexOf(':');
    if (separator === -1) continue;
    const key = current.slice(0, separator).trim();
    const value = current
      .slice(separator + 1)
      .trim()
      .replace(/^["'](.*)["']$/, '$1');
    if (key !== '') frontmatter[key] = value;
  }

  return { frontmatter, body: lines.slice(closing + 1).join('\n').replace(/^\n+/, '') };
}

/** kebab-case of an arbitrary label; it is the manifest's `id` and has to match its pattern. */
export function kebabCase(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Every shell command quoted inside a fenced code block of the body.
 *
 * Only fenced blocks count. A command in running prose is being NAMED, not
 * prescribed ("run them (`make test`) and confirm the failures"), and promoting
 * it to a check would be reading intent into a sentence.
 *
 * @param body Markdown body of the source.
 * @returns One deterministic check per distinct recognized command, in order.
 */
export function deriveChecks(body: string): DerivedCheck[] {
  const commands: string[] = [];
  let insideFence = false;

  for (const current of body.split('\n')) {
    if (current.trim().startsWith('```')) {
      insideFence = !insideFence;
      continue;
    }
    if (!insideFence) continue;

    const command = current.trim();
    if (command === '' || command.startsWith('#')) continue;
    const recognized = COMMAND_HEADS.some(
      (head) => command === head || command.startsWith(`${head} `),
    );
    if (recognized && !commands.includes(command)) commands.push(command);
  }

  const used = new Set<string>();
  return commands.map((command) => {
    let id = kebabCase(command).slice(0, 60);
    if (id === '') id = 'command';
    let candidate = id;
    for (let suffix = 2; used.has(candidate); suffix += 1) candidate = `${id}-${suffix}`;
    used.add(candidate);
    return {
      id: candidate,
      type: 'deterministic',
      description: `Command quoted in a code block of the source SKILL.md: \`${command}\`. Confirm it is still the right command before approving.`,
      command,
    };
  });
}

/**
 * Derives the whole draft manifest from a `SKILL.md`, or says why it cannot.
 *
 * The `hash` it leaves is always `''`. Filling it is the caller's concern
 * (`manifestHash`, `domain/manifest.ts`), which is what it already effectively
 * was inside the CLI and what keeps this function symmetric between its two
 * ports: the runner's copy would otherwise have to carry `manifestHash` and
 * `canonicalize` across the D1/D11 boundary, for a value every draft's own
 * printed instructions tell the human to recompute by hand after editing the
 * placeholders anyway.
 *
 * @param text Whole contents of the source `SKILL.md`.
 * @param options Role and provenance, all optional; nothing is guessed for the
 *   ones that are absent.
 * @returns The assembled draft, or the reason there is none. Never throws.
 */
export function deriveSkillDraft(text: string, options?: SkillDraftOptions): SkillDraftResult {
  let split: { frontmatter: Record<string, string>; body: string };
  try {
    split = splitFrontmatter(text);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const { frontmatter, body } = split;

  const name = frontmatter.name;
  if (name === undefined || name === '') {
    return { ok: false, error: 'has no "name" in its frontmatter — there is no id to derive' };
  }

  const id = kebabCase(name);
  if (id === '') {
    return { ok: false, error: `the frontmatter name "${name}" does not yield a kebab-case id` };
  }

  const draft: Record<string, unknown> = {
    id,
    version: IMPORT_VERSION,
    hash: '',
    role: options?.role ?? ROLE_PLACEHOLDER,
    description: frontmatter.description ?? '',
    input: SCHEMA_PLACEHOLDER,
    output: SCHEMA_PLACEHOLDER,
    preconditions: [],
    checks: deriveChecks(body),
    permissions: SAFE_PERMISSIONS,
    instructions: body,
    // `reviewed_by` is deliberately absent: nobody has reviewed this yet, and a
    // draft that claims a reviewer is a signature nobody gave.
    origin: {
      type: 'imported',
      repo: options?.origin?.repo ?? '',
      ref: options?.origin?.ref ?? '',
      imported_by: options?.origin?.importedBy ?? '',
      imported_at: options?.origin?.importedAt ?? '',
    },
  };

  return { ok: true, draft };
}
