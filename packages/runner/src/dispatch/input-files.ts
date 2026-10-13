/**
 * The files that carry a node's inputs, from name to removal (t689, FR5–FR7).
 *
 * `{{input_file.<path>}}` lets a shell skill hand a whole document to its command
 * by file instead of by argument. The render only PLANS those files
 * (`interpolate-input.ts`); this module is the impure half, in the shape the MCP
 * inputs already have: plan in the pure window, write in one step at the first
 * instant the dispatch is committed to a session, take away in a `finally`.
 *
 * **Where they live.** `<root>/job-<jobId>/<16 hex>/<placeholder path>.json`,
 * with the 16 hex characters minted per render from `crypto.randomBytes`. Two
 * attempts of one job therefore never share a directory, and a directory a
 * crashed runner left behind is never reused — nor swept: a crash costs at most
 * that one directory, and sweeping is a later ticket's. Every segment this
 * module generates matches `[A-Za-z0-9_.-]`; the node id is deliberately NOT in
 * the path, because node ids are free text and nothing here should need
 * quoting. The root is never inside the worktree: the worktree is a git
 * checkout, and a file written there would be uncommitted work.
 *
 * **Written once, exclusively.** Directory `0o700`, files `0o600`, flag `wx`: a
 * file that already exists is an error, never an overwrite. UTF-8, no BOM.
 *
 * **Removal never fails the dispatch.** It runs in a `finally` on every way the
 * dispatch can end, so an error it raised would mask the one that mattered. It
 * is idempotent, retries briefly for the Windows handle that is still closing,
 * and swallows what it cannot remove.
 *
 * English per D18.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { PlannedInputFile } from './interpolate-input.ts';

/** What the dispatch holds between planning and the end of the attempt. */
export interface InputFilesHandle {
  /** Creates the directory and writes every planned file. A no-op for an empty plan. */
  write(): Promise<void>;
  /** Removes what {@link write} created. Idempotent, and never throws. */
  dispose(): Promise<void>;
}

const ATTEMPT_DIR = /^[0-9a-f]{16}$/;
const JOB_DIR = /^job-\d+$/;

/**
 * Mints the directory one render's files will live in. Creates nothing.
 *
 * @param root Where every attempt's directory goes.
 * @param jobId The job being dispatched.
 * @returns `<root>/job-<jobId>/<16 hex>`, different on every call.
 */
export function newInputFilesDir(root: string, jobId: number): string {
  return path.join(root, `job-${String(jobId)}`, randomBytes(8).toString('hex'));
}

/**
 * Turns a plan into a handle that writes it and takes it away.
 *
 * The directory is read back off the plan — every entry sits directly in the
 * directory {@link newInputFilesDir} minted, because a path of the placeholder
 * grammar has no separator — so the handle needs no second argument that could
 * disagree with the plan.
 *
 * @param plan What the render planned. May be empty.
 * @returns The handle.
 */
export function createInputFiles(plan: readonly PlannedInputFile[]): InputFilesHandle {
  const first = plan[0];
  const dir = first === undefined ? null : path.dirname(first.filePath);

  return {
    async write(): Promise<void> {
      if (dir === null) return;

      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (const file of plan) {
        await writeFile(file.filePath, file.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      }
    },

    async dispose(): Promise<void> {
      // Refuses to remove anything that does not have the shape this module
      // mints: a recursive removal driven by a path somebody else built is the
      // one operation here that must never guess.
      if (dir === null) return;
      const jobDir = path.dirname(dir);
      if (!ATTEMPT_DIR.test(path.basename(dir)) || !JOB_DIR.test(path.basename(jobDir))) return;

      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Never masks the dispatch's own error.
      }
      try {
        // Not recursive: another attempt's directory in there makes this fail
        // with ENOTEMPTY, which is exactly the answer wanted.
        await rmdir(jobDir);
      } catch {
        // Not empty, already gone, or not removable: all of them leave it be.
      }
    },
  };
}
