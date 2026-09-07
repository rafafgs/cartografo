/**
 * Artifact routes (t422, FR6/FR8–FR11) — the four addresses of a stored file.
 *
 * One upload and three reads: the bytes go up raw, and come back either as
 * metadata, as content, or as the list of what one session produced. What none
 * of them ever carries is `storage_ref` (`repositories/artifacts.ts`).
 *
 * ## Why this family is registered in a scope of its own
 *
 * The upload takes a RAW body — an artifact is a PNG, a tarball, a log — and
 * nothing else in this app has ever parsed a non-JSON content type. Teaching the
 * app a wildcard parser at the top level would change how every sibling route
 * reads its body, which is a silent, global behaviour change made for one
 * endpoint. Fastify's plugin encapsulation is exactly the tool for that: a
 * content-type parser added inside `registerArtifacts` lives and dies with this
 * scope, and `POST /v1/sessions` two lines away in `server.ts` still gets its
 * JSON. `test/artifact-store.test.ts`'s AT10 is that claim as a test.
 *
 * ## The size cap is the route's `bodyLimit`, and it is configuration
 *
 * Refusing an over-sized upload in the handler would mean reading the whole
 * thing into memory first, which is the resource problem the cap exists to
 * prevent. Fastify's own `bodyLimit` refuses it at the parser with a `413`
 * before a byte is buffered, and `server.ts`'s error handler passes that status
 * straight through. The NUMBER comes from the environment
 * (`CARTOGRAFO_ARTIFACT_SIZE_CAP_BYTES`, `src/index.ts`), the same shape the
 * lease ceilings already have: an operator whose sessions produce big evidence
 * changes one variable, not this file.
 *
 * ## Scope, and the one route that does not ask for it
 *
 * The three reads resolve the caller's project with `requireProject` and hand it
 * to the repository, which answers the SAME `404` for "no such artifact" and
 * "not yours" (t411). The upload deliberately does not: it is the runner-side
 * act of a session reporting what it produced, and the session id is already the
 * whole of what it may write to. When the caller that uploads is written (t367
 * child 2), whether it declares a project is that ticket's decision to take —
 * and so is putting this route on `RUNNER_SURFACE`, which is why `auth.ts` is
 * untouched here (FR11).
 */

import type { FastifyInstance } from 'fastify';

import type { ArtifactStore } from '../artifacts/store.ts';
import type { Database } from '../db/connection.ts';
import {
  createArtifact,
  getArtifact,
  getArtifactContent,
  listSessionArtifacts,
} from '../repositories/artifacts.ts';
import { notFound, refusal, requireProject, routeId, withValidation } from './common.ts';

/**
 * Ceiling of an upload when nobody configures one, in bytes (FR7).
 *
 * The same 32 MiB `FINISH_BODY_LIMIT_BYTES` already uses for the other body this
 * API is willing to read in bulk (`routes/sessions.ts`): generous enough that a
 * screenshot, a bundle or a heap dump goes through, bounded enough that a single
 * request cannot take the process down.
 */
export const DEFAULT_ARTIFACT_SIZE_CAP_BYTES = 32 * 1_048_576;

/** Header that carries the artifact's name; there is no other place for it. */
export const ARTIFACT_NAME_HEADER = 'x-artifact-name';

/** Error code of an upload that did not say what it is or what it is called. */
export const INCOMPLETE_UPLOAD_CODE = 'incomplete_upload';

/** What this route family needs beyond the database. */
export interface ArtifactRouteOptions {
  /** Where the bytes go and come from (FR3). */
  store: ArtifactStore;
  /** Ceiling of the upload route; defaults to {@link DEFAULT_ARTIFACT_SIZE_CAP_BYTES}. */
  sizeCapBytes?: number;
}

/**
 * Registers the artifact routes in the `/v1` scope.
 *
 * @param app Already prefixed scope — its OWN encapsulated one, see the header.
 * @param db Open database.
 * @param options Store and size cap.
 */
export function registerArtifacts(
  app: FastifyInstance,
  db: Database,
  options: ArtifactRouteOptions,
): void {
  const cap = options.sizeCapBytes ?? DEFAULT_ARTIFACT_SIZE_CAP_BYTES;

  // Everything Fastify parses by default is dropped FIRST, inside this scope
  // and only inside it. Adding the wildcard without this line looks like it
  // works and does not: Fastify matches an exact content type before a
  // catch-all, so its built-in `text/plain` parser would keep winning and a
  // `Content-Type: text/plain` artifact would arrive as a STRING — which is how
  // a log file gets stored as zero bytes with the digest of the empty string,
  // with no error anywhere. `removeAllContentTypeParsers` is encapsulated like
  // the parser below, so the JSON routes outside keep theirs.
  app.removeAllContentTypeParsers();

  // The wildcard, and it is encapsulated: it exists for the one POST below and
  // is invisible to every route registered outside this function. `parseAs:
  // 'buffer'` is what makes `request.body` the bytes as they arrived — no
  // decoding, no charset guessing, no interpretation of a media type this
  // server has no business understanding.
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: cap }, (_request, body, done) => {
    done(null, body);
  });

  app.post('/sessions/:id/artifacts', { bodyLimit: cap }, async (request, reply) =>
    withValidation(reply, async () => {
      // Two headers and no body fields, because the body IS the file. A missing
      // one is a 400 and not a default: an artifact with an invented name is
      // evidence nobody can identify later, and a media type this server chose
      // is a lie about what the producer sent.
      const name = request.headers[ARTIFACT_NAME_HEADER];
      const mediaType = request.headers['content-type'];
      if (typeof name !== 'string' || name.trim() === '') {
        return refusal(
          reply,
          400,
          INCOMPLETE_UPLOAD_CODE,
          `an upload declares its name in the "${ARTIFACT_NAME_HEADER}" header`,
        );
      }
      if (typeof mediaType !== 'string' || mediaType.trim() === '') {
        return refusal(
          reply,
          400,
          INCOMPLETE_UPLOAD_CODE,
          'an upload declares what it is in the "content-type" header',
        );
      }

      // A Buffer, or the parser above stopped being the one that ran. The
      // string branch is not politeness: a body silently coerced to `alloc(0)`
      // stores an EMPTY artifact under the digest of nothing, and an operator
      // reading the row has no way to tell that from a session that really did
      // produce an empty file.
      const body = request.body;
      const buffer = Buffer.isBuffer(body)
        ? body
        : typeof body === 'string'
          ? Buffer.from(body, 'utf8')
          : Buffer.alloc(0);
      const artifact = await createArtifact(
        db,
        routeId(request.params),
        { name: name.trim(), mediaType, buffer },
        options.store,
      );
      if (artifact === null) return notFound(reply, 'session');

      reply.code(201);
      return artifact;
    }),
  );

  app.get('/artifacts/:id', async (request, reply) =>
    withValidation(reply, () => {
      const scope = requireProject(db, request, reply);
      if (scope.project === undefined) return scope.refusal;

      const artifact = getArtifact(db, routeId(request.params), scope.project.id);
      return artifact === null ? notFound(reply, 'artifact') : artifact;
    }),
  );

  // The bytes. `content-length` from the stored size rather than from the file,
  // so what a client is told to expect is what the row promised — and a store
  // whose content no longer matches its metadata shows up as a truncated
  // response instead of as a silent difference.
  app.get('/artifacts/:id/content', async (request, reply) =>
    withValidation(reply, () => {
      const scope = requireProject(db, request, reply);
      if (scope.project === undefined) return scope.refusal;

      const content = getArtifactContent(
        db,
        routeId(request.params),
        options.store,
        scope.project.id,
      );
      if (content === null) return notFound(reply, 'artifact');

      void reply.header('content-type', content.media_type);
      void reply.header('content-length', content.size);
      return content.stream;
    }),
  );

  app.get('/sessions/:id/artifacts', async (request, reply) =>
    withValidation(reply, () => {
      const scope = requireProject(db, request, reply);
      if (scope.project === undefined) return scope.refusal;

      const artifacts = listSessionArtifacts(db, routeId(request.params), scope.project.id);
      // `null` is the session, not the list: a session that exists and produced
      // nothing answers `{artifacts: []}`, and only one that is not there — or
      // is somebody else's — is a 404 (FR10).
      return artifacts === null ? notFound(reply, 'session') : { artifacts };
    }),
  );
}
