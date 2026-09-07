/**
 * The storage interface a stored file leaves a session's worktree through
 * (t422, RF-38/FR1).
 *
 * The whole point of this file is that nothing else in the control plane knows
 * where an artifact's bytes are. A repository asks for a `ref`, a route pipes
 * what `open` hands back, and neither has ever seen a directory: the database
 * keeps a reference and the layout belongs to whichever implementation is
 * configured (`local-store.ts` is the only one today, D25's wave-3 item 4).
 *
 * ## `ref` is opaque, and that is the contract
 *
 * `put` answers a `ref` that means something to the store that produced it and
 * to nothing else. For {@link ArtifactStore} it happens to be the sha256 hex
 * digest of the content — which is what makes dedupe free — but a caller may
 * not read it as a hash, split it, join it onto a root or otherwise build a path
 * out of it. `test/artifact-paths-guard.test.ts` is that rule as a gate rather
 * than as a sentence.
 *
 * ## Nothing here deletes
 *
 * There is no `delete`, no `expire` and no `prune`, and their absence is the
 * decision (RF-42): an artifact is evidence of what a session did, and evidence
 * that can be removed is evidence nobody can rely on. `docs/spec/artifacts.md`
 * writes that down for whoever comes looking for the missing verb.
 *
 * The second implementation this interface is shaped for — object storage — is
 * deliberately not written yet: the "rule of two consumers" keeps an extension
 * point open until a second one exists, so this stays a small interface with one
 * honest implementation instead of a speculative abstraction.
 */

import type { Readable } from 'node:stream';

/** What a store answers when it has taken the bytes. */
export interface StoredArtifact {
  /**
   * The content address, opaque to every caller.
   *
   * It is what goes in `artifact.storage_ref`, and the ONE column that never
   * reaches `/v1`: publishing it would tie the wire contract to whichever
   * implementation is configured (t422, FR5).
   */
  ref: string;
  /** Hex sha256 of the content, which IS a fact about the file and does travel. */
  sha256: string;
  /** Size in bytes, as stored. */
  size: number;
}

/** What the caller knows about the file it is handing over. */
export interface ArtifactMeta {
  /** The name the producer gave it — `report.md`, `screenshot.png`. */
  name: string;
  /** Media type as declared; the store records nothing and interprets nothing. */
  mediaType: string;
}

/** Storage of an artifact's bytes, addressed by content. */
export interface ArtifactStore {
  /**
   * Stores the bytes and answers where they can be found again.
   *
   * Idempotent by construction: the same content is the same address, so a
   * second `put` of bytes already stored answers the same triple without
   * writing anything (RF-38's free dedupe).
   *
   * @param source The whole content.
   * @param meta What the caller knows about it; a store may ignore all of it.
   * @returns The content address, the digest and the size.
   */
  put(source: Buffer, meta: ArtifactMeta): Promise<StoredArtifact>;

  /**
   * Opens the content for reading.
   *
   * A stream and not a buffer: the one route that reads bytes pipes them
   * straight to the socket, and an artifact is the payload of this system that
   * is measured in megabytes.
   *
   * @param ref A `ref` this same store produced.
   * @returns The content, as a stream.
   * @throws When the ref is not one this store could have produced.
   */
  open(ref: string): Readable;

  /**
   * @param ref A `ref` this same store produced.
   * @returns Whether the content is there.
   * @throws When the ref is not one this store could have produced.
   */
  exists(ref: string): boolean;
}
