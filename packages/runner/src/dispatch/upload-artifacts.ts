/**
 * The declared output of a step that is a FILE, moved out of the worktree
 * (t423, FR2).
 *
 * Rafael's rule, 2026-09-05: an artifact is only what a step's CONTRACT
 * declares as output, never everything a session touched. That single sentence
 * is the whole design here. There is no sweep of the directory, no heuristic
 * about which files "look produced", and no manifest of its own: the node's
 * `output` schema names a property, the property carries `x-artifact: true`,
 * and the session writes a worktree-relative path into it. Everything else in
 * the tree is scratch, and stays scratch.
 *
 * **Why it has to run when it runs.** `dispatch.ts` releases a completed
 * session's worktree the moment the outcome is known, and `release(false)`
 * DISCARDS it — the file a session named exists on disk only until that line.
 * So this is called before the release, not after, which is why the decode and
 * the parse of the session's result block moved up above it: they had no
 * dependency on the tree, and now something between them and the release does.
 *
 * **And why the file is deleted.** An artifact is untracked scratch by
 * construction, so a tree that still holds one after the upload reads dirty to
 * `git status --porcelain` — which is exactly what the pre-existing
 * uncommitted-work guard blocks on. Without the delete, every session that
 * produced one declared artifact and nothing else would start failing that
 * guard the day this shipped. A delete that itself fails is swallowed: the
 * guard is then the safe fallback, and stopping a work over a file the store
 * already has would trade a recorded outcome for an unrecoverable one.
 *
 * **Two kinds of bad news, and they are not the same.** A declaration that does
 * not check out — a path that escapes the worktree, a file nobody wrote, a
 * property carrying a number — is a REFUSAL: it comes back as a list of
 * problems, the caller hands the control plane no report at all, and the work
 * stops on its node with the problems quoted. An upload the store itself
 * refused (a cap, a 5xx, a socket that died) is not classified here at all: it
 * throws, and travels up as an ordinary dispatch failure, exactly like every
 * other post-session write this package makes.
 *
 * **The containment check is literal, and says so.** A path is compared as a
 * string after `path.resolve`, and the filesystem is not touched for one that
 * fails: a session that names `../../etc/passwd` may not cause a `statSync` of
 * it. What that does NOT defend against is a symlink INSIDE the worktree that
 * resolves outside it, which is out of scope by decision — the session's write
 * scope is the directory it was given, and hardening beyond containment is its
 * own ficha.
 *
 * Raw `fetch` and not `ControlPlaneCall`: that client JSON-encodes every body
 * it is given, and this route takes bytes.
 *
 * Nothing here touches the database: the runner is an ordinary client of the
 * public API, same boundary the UI has (D1, D11).
 *
 * English per D18.
 */

import { readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_REQUEST_TIMEOUT_MS } from '../controller/http-client.ts';

/** The keyword a contract marks a file-valued output property with. */
const ARTIFACT_KEYWORD = 'x-artifact';

/** Where to go, with what credential, through which `fetch`, and for how long. */
export interface UploadArtifactsOptions {
  /** Base address of the control plane, with or without a trailing slash. */
  urlBase: string;
  /**
   * The credential, when there is one.
   *
   * Absent means no header at all, the discipline `control-plane-client.ts`
   * already keeps: an empty `Authorization` would look like a credential.
   */
  token?: string;
  /** What performs the request. Injected by every caller; the tests' only seam. */
  doFetch?: typeof fetch;
  /** Deadline of one upload. Default: {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
}

/**
 * What one pass over a report answers, and it is exactly one of the two.
 *
 * Never both, on purpose: a report with a single bad declaration is refused
 * WHOLE, so there is no half-rewritten object for a caller to be tempted by.
 * The successful uploads of that same pass are not rolled back — the store is
 * content-addressed, so a stray upload is harmless and a retry of the same node
 * re-dedupes on the hash.
 */
export interface UploadArtifactsResult {
  /**
   * The report, with every declared artifact rewritten to its id.
   *
   * Present when there was nothing to refuse, INCLUDING the vacuous cases: a
   * schema that declares no artifact, a report that declared none, a session
   * that reported nothing at all (then it is `undefined` itself, unchanged).
   */
  output?: Record<string, unknown>;
  /** Every reason the report was refused, one per property. */
  problems?: string[];
}

/** Whether a value is a plain object, which is what a schema and a report are. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The top-level property names an `output` document declares as artifacts.
 *
 * Tolerant by design and not by accident: `output` is an opaque `type: object`
 * in the manifest format (*Known limits*), so a document that is not a schema
 * at all is an ordinary thing to be handed. It declares no artifact, and that
 * is the whole reaction — refusing a report because somebody else's manifest is
 * malformed is the trade `t253` already declined to make.
 *
 * ONE level deep, and no further: a nested schema location and the `items` of
 * an array are not walked, which is the limit the format document records.
 */
function declaredArtifacts(outputSchema: unknown): string[] {
  if (!isPlainObject(outputSchema)) return [];
  const properties = outputSchema.properties;
  if (!isPlainObject(properties)) return [];

  return Object.keys(properties).filter((key) => {
    const property = properties[key];
    return isPlainObject(property) && property[ARTIFACT_KEYWORD] === true;
  });
}

/**
 * Resolves one declared path inside the worktree, or says why it will not.
 *
 * The containment test is `resolved === root || resolved.startsWith(root + sep)`
 * and not a `startsWith` on its own: without the separator, a sibling directory
 * whose name merely begins with the worktree's — `/tmp/tree-2` next to
 * `/tmp/tree` — reads as contained.
 *
 * @returns The absolute path when it is usable, or the problem it is instead.
 */
function resolveDeclaredFile(
  key: string,
  declared: unknown,
  worktreePath: string,
): { file: string } | { problem: string } {
  if (typeof declared !== 'string') {
    return {
      problem:
        '`' +
        key +
        '` is declared `' +
        ARTIFACT_KEYWORD +
        '` and has to carry a worktree-relative path as a string, but the report ' +
        `carries ${declared === null ? 'null' : typeof declared}`,
    };
  }

  const root = path.resolve(worktreePath);
  const resolved = path.resolve(root, declared);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    // Deliberately BEFORE any filesystem call: a session that names a path
    // outside its own write scope may not make this process read it.
    return {
      problem:
        '`' + key + '` names `' + declared + '`, which resolves outside the session worktree',
    };
  }

  let isFile: boolean;
  try {
    isFile = statSync(resolved).isFile();
  } catch {
    return {
      problem:
        '`' + key + '` names `' + declared + '`, which does not exist in the session worktree',
    };
  }
  if (!isFile) {
    return {
      problem: '`' + key + '` names `' + declared + '`, which is not a regular file',
    };
  }

  return { file: resolved };
}

/**
 * Sends one file to the artifact store and gives back the id it was given.
 *
 * The deadline is enforced here and not only through the signal handed to
 * `fetch`, for the reason `http-client.ts` records: `doFetch` is an injected
 * seam, and a request that gives up only if the injected implementation
 * cooperates has no deadline of its own.
 *
 * @throws An `Error` naming the route and the status, for any non-2xx; the
 *   `TimeoutError` of `AbortSignal.timeout`, unchanged, when time ran out.
 */
async function uploadOne(
  options: UploadArtifactsOptions,
  sessionId: number,
  key: string,
  file: string,
): Promise<string> {
  const doFetch = options.doFetch ?? fetch;
  const route = `/v1/sessions/${String(sessionId)}/artifacts`;
  const url = `${options.urlBase.replace(/\/+$/, '')}${route}`;

  const headers: Record<string, string> = {
    // Fixed, and never sniffed: what the store holds is bytes, and guessing a
    // MIME type from a name is a decision nobody asked this module to take.
    'content-type': 'application/octet-stream',
    // The CONTRACT's property key, not the file's basename: the key is the
    // stable label a later node reads the artifact back by.
    'x-artifact-name': key,
  };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

  const signal = AbortSignal.timeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const deadline = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

  const response = await Promise.race([
    doFetch(url, { method: 'POST', headers, body: readFileSync(file), signal }),
    deadline,
  ]);
  const text = await Promise.race([response.text(), deadline]);

  // The status before the body, which is t156's rule: a 502 from a proxy is an
  // HTML page, and a `JSON.parse` of it throws away both the status and the text.
  if (!response.ok) {
    throw new Error(`POST ${route} answered ${String(response.status)}: ${text}`);
  }

  const body: unknown = text === '' ? undefined : JSON.parse(text);
  if (!isPlainObject(body) || typeof body.id !== 'string') {
    throw new Error(`POST ${route} answered 2xx with no artifact id: ${text}`);
  }
  return body.id;
}

/**
 * Gets every declared artifact of one session out of its worktree.
 *
 * @param options Address, credential, `fetch` and deadline.
 * @param sessionId The session the artifacts belong to.
 * @param worktreePath The directory the session ran in — its entire write
 *   scope, and the root every declared path is resolved against.
 * @param outputSchema The `output` document of the node's contract, as the
 *   graph version carries it. Anything that is not a schema declares nothing.
 * @param report What the session reported, as `parse-node-result.ts` decoded it.
 * @returns The report rewritten, or the reasons it was refused — never both.
 * @throws Whatever the upload itself failed with; that is an ordinary dispatch
 *   failure and not one of the refusals this function classifies.
 */
export async function uploadArtifacts(
  options: UploadArtifactsOptions,
  sessionId: number,
  worktreePath: string,
  outputSchema: unknown,
  report: Record<string, unknown> | undefined,
): Promise<UploadArtifactsResult> {
  const keys = declaredArtifacts(outputSchema);
  if (keys.length === 0 || report === undefined) return { output: report };

  const problems: string[] = [];
  const rewritten: Record<string, unknown> = { ...report };

  for (const key of keys) {
    // An artifact the contract declares and this run did not produce is not a
    // problem: whether it was REQUIRED is the `output` schema's own question,
    // answered by the control plane on the closure.
    if (!(key in report)) continue;

    const resolved = resolveDeclaredFile(key, report[key], worktreePath);
    if ('problem' in resolved) {
      problems.push(resolved.problem);
      continue;
    }

    // Uploaded even when an earlier key already failed. The alternative —
    // stopping at the first problem — would report one reason per dispatch for
    // a session that got two things wrong, and the whole report is refused
    // either way, so the extra upload costs a hash the store already dedupes.
    rewritten[key] = await uploadOne(options, sessionId, key, resolved.file);

    try {
      rmSync(resolved.file);
    } catch {
      // Swallowed on purpose: the file is safely in the store, and the
      // uncommitted-work guard is the honest fallback for a tree that kept it.
    }
  }

  return problems.length === 0 ? { output: rewritten } : { problems };
}
