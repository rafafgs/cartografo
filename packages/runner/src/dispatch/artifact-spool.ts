/**
 * Where a completed session's declared file waits when the artifact store
 * refused it (t1340, FR2).
 *
 * The file a session names under an `x-artifact` property lives in its
 * worktree, and `dispatch.ts` releases a completed session's worktree with
 * `release(false)` right after the upload — which discards it. When the store
 * refused the upload, the bytes have to leave the tree BEFORE that line, to a
 * place this runner owns and a restart does not wipe. That place is this spool.
 *
 * **The server is the authority, the spool only holds bytes.** What is still
 * pending on a session is the control plane's to say
 * (`GET /v1/sessions/:id/artifact-settlements`, t1339); this module never
 * decides it. It keeps the files, the decoded session text the advance needs,
 * and the runner's own retry count — the one fact the core cannot count,
 * because its t1312 cap only sees `open` sessions and this one is `completed`.
 *
 * Layout, one directory per held session:
 *
 *     <root>/job-<jobId>/session-<sessionId>/
 *       state.json          the marker, written last, through a rename
 *       output.txt          the decoded session text, exactly as `advance()` reads it
 *       files/<hex(name)>   one file per pending property
 *
 * The file name is the hex of the property name, so no name — `../x`, `a/b`,
 * anything non-ASCII — can ever address a path outside the root. The name
 * itself lives only inside `state.json`.
 *
 * **The spool belongs to the machine that wrote it.** A different runner that
 * picks the job up finds nothing here and redispatches the node as before;
 * shipping spool bytes between machines is out of scope.
 *
 * Nothing here touches the database or the API: it is plain disk.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_ARTIFACT_UPLOAD_BACKOFF_MS,
  DEFAULT_MAX_ARTIFACT_UPLOAD_ATTEMPTS,
} from './options.ts';

/** The only marker format this module reads; anything else is left alone. */
export const SPOOL_STATE_VERSION = 1;

/** No wait between two held-upload attempts is ever longer than this. */
export const MAX_ARTIFACT_UPLOAD_BACKOFF_MS = 3_600_000;

const STATE_FILE = 'state.json';
const OUTPUT_FILE = 'output.txt';
const FILES_DIR = 'files';

/** The marker of one held session, as `state.json` stores it. */
export interface SpoolState {
  version: 1;
  job_id: number;
  /** The project the dispatch was scoped to, or `null` when it named none. */
  project_id: number | null;
  session_id: number;
  /** The node the session ran on; an entry for any other node is stale. */
  node_id: string;
  /** The properties held, in declaration order. */
  names: string[];
  /** Attempts so far, the in-session one included. `0` after a cap was reached. */
  attempts: number;
  /** Epoch milliseconds before which no retry is made. */
  next_attempt_at: number;
}

/** One held session, as {@link ArtifactSpool.find} hands it back. */
export interface SpoolEntry {
  /** `<root>/job-<J>/session-<S>`. */
  readonly dir: string;
  readonly state: SpoolState;
  /** The decoded session text, `output.txt`. */
  readonly output: string;
}

/** What {@link ArtifactSpool.hold} is given. */
export interface HoldInput {
  jobId: number;
  projectId?: number;
  sessionId: number;
  nodeId: string;
  /** The decoded session text, exactly the string `advance()` is given. */
  output: string;
  /** Each pending property and the worktree file that holds it. */
  files: ReadonlyArray<{ name: string; file: string }>;
}

/** How a {@link ArtifactSpool} is configured. */
export interface ArtifactSpoolOptions {
  root: string;
  /** The ladder. Unusable values fall back (see {@link resolveArtifactUploadBackoff}). */
  backoffMs?: readonly number[];
  /** Default `Date.now`. */
  now?: () => number;
}

/**
 * The backoff ladder to use: the override when it is a usable one, the default
 * otherwise. Empty, zero, negative or `NaN` means "no override", never "no wait".
 */
export function resolveArtifactUploadBackoff(declared: readonly number[] | undefined): readonly number[] {
  if (declared === undefined || declared.length === 0) return DEFAULT_ARTIFACT_UPLOAD_BACKOFF_MS;
  const usable = declared.every((rung) => Number.isFinite(rung) && rung > 0);
  return usable ? declared : DEFAULT_ARTIFACT_UPLOAD_BACKOFF_MS;
}

/**
 * The attempt cap to use: the override when it is a positive integer, the
 * default otherwise. Zero, negative or `NaN` means "no override", never "no cap".
 */
export function resolveMaxArtifactUploadAttempts(declared: number | undefined): number {
  return declared !== undefined && Number.isSafeInteger(declared) && declared > 0
    ? declared
    : DEFAULT_MAX_ARTIFACT_UPLOAD_ATTEMPTS;
}

/**
 * The wait after `attempts` attempts: `ladder[attempts - 1]`, the last rung
 * repeating, never more than {@link MAX_ARTIFACT_UPLOAD_BACKOFF_MS}.
 */
export function backoffAfter(ladder: readonly number[], attempts: number): number {
  const rung = Math.min(Math.max(attempts, 1), ladder.length) - 1;
  return Math.min(ladder[rung], MAX_ARTIFACT_UPLOAD_BACKOFF_MS);
}

/** Whether a parsed `state.json` is a marker this version can trust. */
function isState(value: unknown): value is SpoolState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === SPOOL_STATE_VERSION &&
    Number.isSafeInteger(state.job_id) &&
    (state.project_id === null || Number.isSafeInteger(state.project_id)) &&
    Number.isSafeInteger(state.session_id) &&
    typeof state.node_id === 'string' &&
    Array.isArray(state.names) &&
    state.names.every((name) => typeof name === 'string') &&
    typeof state.attempts === 'number' &&
    typeof state.next_attempt_at === 'number'
  );
}

/** The runner's spool of held artifact uploads. */
export class ArtifactSpool {
  readonly root: string;
  readonly backoffMs: readonly number[];
  readonly #now: () => number;

  constructor(options: ArtifactSpoolOptions) {
    this.root = options.root;
    this.backoffMs = resolveArtifactUploadBackoff(options.backoffMs);
    this.#now = options.now ?? Date.now;
  }

  /** Where the bytes of one held property are. */
  fileOf(entry: SpoolEntry, name: string): string {
    return path.join(entry.dir, FILES_DIR, Buffer.from(name, 'utf8').toString('hex'));
  }

  /**
   * Copies each pending file into the spool, writes the marker last, and then
   * removes the originals from the worktree.
   *
   * A failure to write the spool propagates (and leaves the originals where
   * they were, so the caller's kept-tree path still has them); a partially
   * written session directory is removed on the way out. A failed remove of an
   * original is swallowed: the bytes are already safe here, and the
   * uncommitted-work guard is the honest fallback for a tree that kept one.
   *
   * @returns The entry, attempt 1, due one rung from now.
   */
  hold(input: HoldInput): SpoolEntry {
    const dir = path.join(this.root, `job-${String(input.jobId)}`, `session-${String(input.sessionId)}`);
    const state: SpoolState = {
      version: SPOOL_STATE_VERSION,
      job_id: input.jobId,
      project_id: input.projectId ?? null,
      session_id: input.sessionId,
      node_id: input.nodeId,
      names: input.files.map((held) => held.name),
      attempts: 1,
      next_attempt_at: this.#now() + backoffAfter(this.backoffMs, 1),
    };
    const entry: SpoolEntry = { dir, state, output: input.output };

    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(path.join(dir, FILES_DIR), { recursive: true });
      for (const held of input.files) copyFileSync(held.file, this.fileOf(entry, held.name));
      writeFileSync(path.join(dir, OUTPUT_FILE), input.output);
      this.#writeState(dir, state);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }

    for (const held of input.files) {
      try {
        rmSync(held.file);
      } catch {
        // Swallowed on purpose: the copy above is what the retry reads.
      }
    }
    return entry;
  }

  /**
   * The held session of one job, or `null`.
   *
   * Tolerant: a missing root, a marker that does not parse, or one of another
   * version is "nothing here", and is neither deleted nor thrown about — it may
   * be a newer runner's, and it is a person's to look at. An entry recorded for
   * another project is not this dispatch's either.
   */
  find(jobId: number, projectId?: number): SpoolEntry | null {
    const jobDir = path.join(this.root, `job-${String(jobId)}`);
    let sessions: string[];
    try {
      sessions = readdirSync(jobDir).filter((name) => /^session-\d+$/.test(name));
    } catch {
      return null;
    }
    // Newest session first: if two were ever held, the later one is current.
    sessions.sort((left, right) => Number(right.slice(8)) - Number(left.slice(8)));

    for (const name of sessions) {
      const dir = path.join(jobDir, name);
      let state: unknown;
      let output: string;
      try {
        state = JSON.parse(readFileSync(path.join(dir, STATE_FILE), 'utf8'));
        output = readFileSync(path.join(dir, OUTPUT_FILE), 'utf8');
      } catch {
        continue;
      }
      if (!isState(state) || state.job_id !== jobId) continue;
      if (state.project_id !== (projectId ?? null)) continue;
      return { dir, state, output };
    }
    return null;
  }

  /** Stores a new attempt count and due instant; nothing else changes. */
  recordAttempt(entry: SpoolEntry, update: { attempts: number; next_attempt_at: number }): SpoolEntry {
    const state: SpoolState = {
      ...entry.state,
      attempts: update.attempts,
      next_attempt_at: update.next_attempt_at,
    };
    this.#writeState(entry.dir, state);
    return { ...entry, state };
  }

  /** Removes the session directory, then the job directory if it is empty. */
  discard(entry: SpoolEntry | null): void {
    if (entry === null) return;
    rmSync(entry.dir, { recursive: true, force: true });
    const jobDir = path.dirname(entry.dir);
    try {
      if (existsSync(jobDir) && readdirSync(jobDir).length === 0) rmdirSync(jobDir);
    } catch {
      // Another session's entry appeared in between, or it is already gone.
    }
  }

  /** Writes the marker through a temp file and a rename, so it is never half-written. */
  #writeState(dir: string, state: SpoolState): void {
    const temporary = path.join(dir, `${STATE_FILE}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(state)}\n`);
    renameSync(temporary, path.join(dir, STATE_FILE));
  }
}
