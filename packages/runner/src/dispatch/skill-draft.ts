/**
 * Deriving a draft skill manifest from a `SKILL.md` — local port of
 * `packages/core/src/domain/skill-draft.ts` (t439, FR7).
 *
 * A PORT, deliberately, and not an import across the package boundary. The
 * runner is an ordinary client of the public API (D1/D11): it speaks HTTP and
 * nothing else, and a compile-time reach into the control plane's `domain/`
 * would be the first crack in the wall `test/no-privileged-access.test.ts`
 * exists to keep. It is the same trade `src/synthesizer/similarity.ts` already
 * made against `domain/similarity.ts`, and the same one the core itself made
 * when `domain/graph.ts` ported `scripts/validate-graph.mjs`.
 *
 * A copy that can drift is worse than no copy, so the parity is a test, not a
 * promise: `test/dispatch/skill-draft.test.ts` runs the fixtures of
 * `packages/core/test/skill-draft-domain.test.ts` against this file, down to
 * the two refusal messages character for character. Change the derivation on
 * one side and the other side's suite says so.
 *
 * What the port does NOT carry is the hash. `manifestHash`/`canonicalize`
 * (`domain/hash.ts`) stay on the core's side of the boundary and the draft
 * derived here always leaves `hash: ''` — the value every draft's own printed
 * instructions already tell the human to recompute after editing the
 * placeholders anyway (FR6). Whoever needs a pinned manifest asks the control
 * plane for one; nobody needs a second hasher.
 *
 * Everything below is pure: no CLI, no network, no filesystem, no clock. The
 * import date is the caller's to supply, which is what lets a session derive a
 * draft and a test assert on it byte for byte.
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
 * @throws {Error} A plain `Error`, exactly as the core's copy throws it: this
 *   side has no CLI error type of its own, and the two messages are compared
 *   character for character by the parity test.
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
