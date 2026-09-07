/**
 * The one {@link ArtifactStore} implementation v0 ships: files on the same disk
 * as the database (t422, FR2).
 *
 * Layout, and it is this module's alone:
 *
 * ```
 * <root>/<sha256[0:2]>/<sha256>
 * ```
 *
 * Two levels, the way git stores objects, for the same reason git does: a single
 * flat directory with tens of thousands of entries is slow to list and unpleasant
 * to look at on every filesystem that still has a linear directory scan. The
 * first byte of the digest is a good enough fan-out for anything this control
 * plane will hold.
 *
 * ## Content addressing, and what falls out of it for free
 *
 * The file name IS the sha256 of its content, so identical bytes written by two
 * sessions are one file (RF-38's dedupe) and a `put` of content already there
 * writes nothing at all. `storage_ref` is that digest and nothing else: no path,
 * no root, no scheme. Move the root and every reference in the database still
 * resolves.
 *
 * ## Why the write is a temp file and a rename
 *
 * `rename(2)` within one filesystem is atomic, and `open`/`exists` are reading
 * the very path a concurrent `put` would be writing. Writing straight to the
 * content address would mean a crash — or a full disk — mid-write leaves a
 * TRUNCATED file at the address of the whole content, which is the worst
 * possible failure for a content-addressed store: every later reader gets bytes
 * that do not hash to their own name, and `put` itself would then find the file
 * and dedupe onto the corruption. The temp file is created in the same two-level
 * directory precisely so the rename stays inside one filesystem.
 *
 * This is the ticket's declared TDD exception: killing the process between
 * `writeFile` and `rename` is not something a test can drive, so the guarantee
 * is the code and this paragraph.
 *
 * ## The ref is validated before the filesystem is touched
 *
 * A ref only ever originates from `createHash('sha256')` right here — no caller
 * builds one, and the database only ever hands back what `put` returned. The
 * `^[0-9a-f]{64}$` check is therefore defense in depth and not input validation:
 * the day something upstream starts passing a value through (a query parameter,
 * an imported bundle, a second store's ref), a `..` in it is a read of an
 * arbitrary file rather than a miss. Cheap, absolute, and it fails loudly.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

import type { ArtifactStore, StoredArtifact } from './store.ts';

/** The directory the artifacts of a database live in, beside the file itself. */
export const ARTIFACTS_DIRNAME = 'artifacts';

/** The only shape a ref of this store can have: a lowercase hex sha256. */
export const REF_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Where the artifacts of a given database file belong.
 *
 * Here and not at the call sites, so this module stays the only one that knows
 * the layout: `src/index.ts` builds the store out of the database path it
 * already resolved, and `src/server.ts` builds the same default for a caller
 * that did not pass one.
 *
 * @param databaseFile Path of the SQLite file.
 * @returns Root directory of the artifact store beside it.
 */
export function artifactRootFor(databaseFile: string): string {
  return path.join(path.dirname(databaseFile), ARTIFACTS_DIRNAME);
}

/** Files on disk, addressed by the sha256 of their content. */
export class LocalArtifactStore implements ArtifactStore {
  /** Directory the two-level tree hangs off. */
  readonly #root: string;

  /**
   * @param root Directory the two-level tree hangs off. Not created here: a
   *   store that is never written to must not leave a directory behind, and
   *   every write path below creates what it needs anyway.
   *
   *   Assigned in the body and not declared as a parameter property: the
   *   packages run TypeScript through node's strip-only mode
   *   (`tsconfig.base.json`), which has no way to emit the assignment a
   *   `private readonly root` parameter implies.
   */
  constructor(root: string) {
    this.#root = root;
  }

  /**
   * Stores the bytes at their own digest, writing nothing if they are there.
   *
   * The interface's second parameter is NOT declared here, and its absence is
   * the statement: the name and the media type are facts about this REFERENCE
   * to the content, not about the content, and two sessions storing identical
   * bytes under different names get one file and two rows. That is why both
   * fields live in the `artifact` table and nothing on disk carries them — a
   * store that wrote them somewhere would be inventing a second, divergent copy
   * of a column. A caller still passes them: `ArtifactMeta` is part of the
   * contract, and the store that needs them (an object store setting
   * `Content-Type`) is the one that will declare it.
   *
   * @param source The whole content.
   * @returns The content address, the digest and the size.
   */
  async put(source: Buffer): Promise<StoredArtifact> {
    const sha256 = createHash('sha256').update(source).digest('hex');
    const stored: StoredArtifact = { ref: sha256, sha256, size: source.byteLength };

    const target = this.pathOf(sha256);
    if (existsSync(target)) return stored;

    const bucket = path.dirname(target);
    mkdirSync(bucket, { recursive: true });

    // In the SAME directory as the target, so the rename below cannot cross a
    // filesystem, and under a name no second writer can guess.
    const temporary = path.join(bucket, `.tmp-${randomBytes(8).toString('hex')}`);
    try {
      writeFileSync(temporary, source);
      renameSync(temporary, target);
    } catch (error) {
      // A rename that failed leaves the temp file behind; a crash is what the
      // rename protects against, and a leftover `.tmp-*` is never readable as an
      // artifact because it is not at a content address.
      try {
        unlinkSync(temporary);
      } catch {
        // Nothing to clean up, or nothing we can do about it.
      }
      throw error;
    }

    return stored;
  }

  /**
   * @param ref A ref this store produced.
   * @returns The content, as a stream.
   */
  open(ref: string): Readable {
    return createReadStream(this.pathOf(ref));
  }

  /**
   * @param ref A ref this store produced.
   * @returns Whether the content is on disk.
   */
  exists(ref: string): boolean {
    return existsSync(this.pathOf(ref));
  }

  /**
   * The absolute path of a ref — the ONE place the layout is written down.
   *
   * @param ref The content address.
   * @returns Where its bytes are.
   * @throws {Error} When the ref is not a lowercase hex sha256.
   */
  private pathOf(ref: string): string {
    if (!REF_PATTERN.test(ref)) {
      throw new Error(
        `"${ref}" is not an artifact ref; a ref is the 64-character lowercase hex sha256 this store produced`,
      );
    }
    return path.join(this.#root, ref.slice(0, 2), ref);
  }
}
