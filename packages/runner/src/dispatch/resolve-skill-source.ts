/**
 * The skills a person already has, turned into drafts to adapt (t440, FR4).
 *
 * Almost nobody arrives at the interview with nothing. They have a folder of
 * prompts, or a repository of `SKILL.md` files they have been carrying between
 * projects, and RF-14's extension is that the interview may point at it: the
 * turn that asks for the class name also asks whether they have existing skills
 * and where, and what they answer arrives here as `{kind, location}`.
 *
 * What this module does with it is small and deliberately dull: it READS. A
 * folder is walked; a git URL is cloned `--depth 1`, read and thrown away. Every
 * `SKILL.md` it finds goes through `deriveSkillDraft` (`./skill-draft.ts`, the
 * port t439 made of the control plane's own derivation) and comes back as a
 * draft manifest with the format's placeholders where a human decision belongs.
 *
 * ## Three rules, and each one is a decision
 *
 * - **Nothing from the source is ever executed.** Not a `SKILL.md`'s commands,
 *   not a repository's hooks, not a script that happened to be beside them. The
 *   clone exists to be read, and the drafts it yields are PROPOSALS a session
 *   adapts — they enter the registry only when a person runs Register
 *   (t432/t433), which is D4's gate and the only one anything from outside
 *   crosses.
 * - **It never throws.** A misspelled folder, a repository nobody can reach, a
 *   `git` that is not installed: each resolves `{drafts: [], error: <message>}`,
 *   and the interview relays that message to the person in its next question.
 *   This is context, the same as `environment.similar_classes`, and an interview
 *   that could not open because a folder name had a typo in it would have broken
 *   the very thing the folder was meant to help with.
 * - **One bad file does not sink the others.** A `SKILL.md` with no `name` in
 *   its frontmatter has no id to derive, so it is skipped in silence while its
 *   siblings still produce drafts. Refusing the whole source over one file would
 *   hand a person an error about a file they may not even have written.
 *
 * ## Where the clone lands, and why it is not the session's worktree
 *
 * Beside `worktreesRoot`, in `<worktreesRoot>/.skill-sources/`, and not inside
 * the worktree the session will get. The dispatch resolves the whole input —
 * this module included — in `resolveSessionPlan` (`dispatch.ts:271`), and only
 * acquires the worktree afterwards (`dispatch.ts:303`), so at the moment this
 * runs there is no worktree to write into. Reordering that sequence for a
 * throwaway, read-only clone was judged not worth it: nothing depends on the
 * clone outliving the derivation, and it does not — the subdirectory is removed
 * as soon as the drafts are in hand.
 *
 * English per D24.
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { deriveSkillDraft } from './skill-draft.ts';

/** Where the person's existing skills are, as the interview reported it. */
export interface SkillSource {
  /** A directory on this machine, or a repository to clone read-only. */
  kind: 'path' | 'git';
  /** The path or the URL, in the person's own words. */
  location: string;
}

/** What one source yielded: drafts to adapt, or the reason there are none. */
export interface SkillSourceResult {
  /** One derived draft manifest per readable `SKILL.md`, in the order found. */
  drafts: Record<string, unknown>[];
  /** `null` when the source was read; a message for the person when it was not. */
  error: string | null;
}

/** What one runner needs in order to read a source at all. */
export interface SkillSourceConfig {
  /**
   * Whether this workspace may clone a repository — the `allow_git_clone`
   * setting (t439), seeded `'true'`.
   *
   * A workspace switch and not a per-source decision: cloning somebody's
   * repository runs `git` with this process's credentials, and an operator who
   * turned it off did so for the whole runner. A `git` source with it off is a
   * refusal that NAMES the setting, so the person reading it knows what to ask
   * for rather than being told a URL is invalid.
   */
  allowGitClone: boolean;
  /**
   * Directory the throwaway clones are made under — `<worktreesRoot>/.skill-sources`.
   *
   * Created on first use and never before: a runner that clones nothing leaves
   * nothing behind, which is also what makes "a refused clone writes nothing"
   * observable.
   */
  scratchRoot: string;
  /** Ceiling on how many drafts one source yields. Default: {@link DEFAULT_MAX_DRAFTS}. */
  maxDrafts?: number;
}

/**
 * How many drafts a session is shown, at most.
 *
 * Twenty, for `PRECEDENT_LIMIT`'s reason one size up (`resolve-input.ts`): this
 * is a suggestion and not an index. A person being interviewed can weigh a
 * handful of "start from this one?" and cannot weigh a repository of two
 * hundred, and a prompt that carried them all would spend its budget on skills
 * nobody is going to adapt.
 */
export const DEFAULT_MAX_DRAFTS = 20;

/** The one file name a skill is published under. */
const SKILL_FILE = 'SKILL.md';

/** Directories the walk never enters: object stores and dependency trees. */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

/** How deep the walk goes before it stops looking. */
const MAX_DEPTH = 6;

/** What `git clone` answered. */
interface CloneResult {
  code: number;
  stderr: string;
}

/**
 * Clones a repository shallow, and never throws.
 *
 * `--depth 1` because the only thing this reads is the tip: a draft's `origin`
 * records `HEAD`, and history nobody looks at is bandwidth and disk spent on a
 * folder that is deleted seconds later. Whatever credential helper the machine
 * already has is what authenticates it — nothing here adds, asks for or stores
 * one, so a private repository with nothing configured simply fails to clone,
 * like any other unreachable URL.
 *
 * @param location Repository to clone, as the person named it.
 * @param into Directory to clone into; it must not exist yet.
 * @returns Exit code and stderr, for the caller to turn into a message.
 */
function clone(location: string, into: string): Promise<CloneResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['clone', '--depth', '1', location, into],
      { encoding: 'utf8' },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stderr });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : -1;
        resolve({ code, stderr: stderr === '' ? error.message : stderr });
      },
    );
  });
}

/**
 * Every `SKILL.md` under a directory, in a stable order.
 *
 * Sorted by name at each level, and not in whatever order the filesystem
 * answered: "the order found" is a promise this module makes to its own
 * acceptance tests and to a person comparing two runs, and readdir order is a
 * property of the disk. Depth is bounded ({@link MAX_DEPTH}) because a source
 * somebody names may be a whole home directory, and an unbounded walk over one
 * is a dispatch that does not open.
 *
 * @param root Directory to walk.
 * @param depth How many levels are left.
 * @returns Absolute paths of the files found.
 */
async function findSkillFiles(root: string, depth = MAX_DEPTH): Promise<string[]> {
  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  const found: string[] = [];
  const directories: string[] = [];

  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) directories.push(full);
      continue;
    }
    if (entry.isFile() && entry.name === SKILL_FILE) found.push(full);
  }

  // Files of a level before the directories under it: a folder of skills is
  // usually one directory per skill, and the order that reads naturally is the
  // one somebody would list by hand.
  if (depth > 0) {
    for (const directory of directories) {
      // A directory that will not read — a permission, a broken symlink — is
      // skipped like an unusable file: the rest of the source still counts.
      try {
        found.push(...(await findSkillFiles(directory, depth - 1)));
      } catch {
        continue;
      }
    }
  }

  return found;
}

/**
 * Builds the runner's `resolveSkillSource` hook out of one runner's configuration.
 *
 * @param config The workspace switch, the scratch directory and the ceiling.
 * @returns A function of one reported source that answers the drafts derived
 *   from it, or the reason there are none. It never throws and never leaves
 *   anything of a clone behind.
 */
export function createSkillSourceResolver(
  config: SkillSourceConfig,
): (source: SkillSource) => Promise<SkillSourceResult> {
  const maxDrafts = config.maxDrafts ?? DEFAULT_MAX_DRAFTS;

  /** Derives one draft per readable file, up to the ceiling, in the order found. */
  const draftsOf = async (
    directory: string,
    source: SkillSource,
  ): Promise<Record<string, unknown>[]> => {
    const importedAt = new Date().toISOString();
    const drafts: Record<string, unknown>[] = [];

    for (const file of await findSkillFiles(directory)) {
      if (drafts.length >= maxDrafts) break;

      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }

      const derived = deriveSkillDraft(text, {
        origin: {
          repo: source.location,
          ref: source.kind === 'git' ? 'HEAD' : 'local',
          importedAt,
        },
      });
      // `{ok: false}` is a file with no `name` in its frontmatter, or no
      // frontmatter at all. Not an error: one unusable file among ten is not a
      // source that could not be read.
      if (derived.ok) drafts.push(derived.draft);
    }

    return drafts;
  };

  /** The folder case: read it where it is, and touch nothing. */
  const fromPath = async (source: SkillSource): Promise<SkillSourceResult> => {
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(source.location)).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      return {
        drafts: [],
        error:
          `the skill source \`${source.location}\` is not a directory this runner can read — ` +
          'check the path, or give a git URL instead',
      };
    }

    return { drafts: await draftsOf(source.location, source), error: null };
  };

  /** The repository case: clone shallow, derive, delete. */
  const fromGit = async (source: SkillSource): Promise<SkillSourceResult> => {
    if (!config.allowGitClone) {
      return {
        drafts: [],
        error:
          `this workspace does not clone repositories: \`allow_git_clone\` is off, so ` +
          `\`${source.location}\` was not fetched — set it to \`true\` with ` +
          '`PATCH /v1/settings`, or give a folder on this machine instead',
      };
    }

    // Fresh per call, and under the scratch root rather than in the session's
    // worktree (see the header): two dispatches of the same job never share a
    // directory, so neither can delete what the other is reading.
    const into = path.join(
      config.scratchRoot,
      `clone-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`,
    );

    try {
      await mkdir(config.scratchRoot, { recursive: true });
    } catch (error) {
      return { drafts: [], error: `the clone directory could not be created: ${message(error)}` };
    }

    try {
      const cloned = await clone(source.location, into);
      if (cloned.code !== 0) {
        return {
          drafts: [],
          error:
            `\`git clone --depth 1 ${source.location}\` failed — ` +
            `${cloned.stderr.trim() === '' ? '(no output)' : cloned.stderr.trim()}`,
        };
      }
      return { drafts: await draftsOf(into, source), error: null };
    } finally {
      // Always, and best effort: the clone existed to be read once. A directory
      // that will not delete is not worth failing an interview over, and the
      // next `prune` sweeps the scratch root anyway.
      await rm(into, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  return async (source: SkillSource): Promise<SkillSourceResult> => {
    try {
      return source.kind === 'git' ? await fromGit(source) : await fromPath(source);
    } catch (error) {
      // The backstop, and it should never fire: every branch above already
      // answers with a message. It is here because this hook's whole contract
      // is "never throws" — a rejection would travel up through
      // `resolveSessionPlan` and block a job over a folder somebody mistyped.
      return { drafts: [], error: `the skill source could not be read: ${message(error)}` };
    }
  };
}

/** Whatever was thrown, as a line a person can read. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
