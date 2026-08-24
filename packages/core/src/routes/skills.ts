/**
 * Skill-registry routes (t117, FR3/FR4; t215).
 *
 * `POST /skills` is the only door into the registry, and it is a GATE, not a
 * write: whatever the CLI derived and whoever approved it, the manifest is
 * verified here from scratch before a row exists. The refusal always carries
 * every reason, in the shape `routes/common.ts` already uses — an import that
 * came back "invalid" and nothing else would send a human to read source code.
 *
 * The reads exist because a registry nobody can consult is a write-only table:
 * the acceptance test confirms the registration through them, and they are the
 * surface a future capability reader (the synthesizer's "consultar capacidades"
 * step) already has.
 *
 * Four status codes on the way in since t215, and nothing else: 201 when a
 * version comes into being, 200 when the version submitted is already there with
 * the same content, 409 when it is there with DIFFERENT content, 422 when the
 * manifest does not check out. There is no 400 here because there is no envelope
 * to get wrong — the body IS the manifest, and a body that is not an object is
 * simply a manifest that fails its first rule.
 *
 * ## The reads, and which of them a node is allowed to use (D22)
 *
 * `GET /skills/:id` with no query answers the newest LIVE version, and it is for
 * whoever is choosing what to pin. `?version=` answers an exact row and `?hash=`
 * answers the row of that lineage carrying that pin — those two are the ones a
 * dispatch uses, because D22 is explicit that a node "never resolves 'the latest
 * one'". `GET /skills` lists every version of every lineage, flat, one entry
 * per `(id, version)`; `?id=` narrows it to one lineage.
 *
 * `PATCH /skills/:id/:version` retires a version. It takes no body, because
 * there is nothing to say: the only fact it records is that this version is no
 * longer what a new graph should pin, and every read except "latest" still serves
 * it. There is no DELETE, and there will not be one — a version graphs point at
 * is not something this API withdraws (D15).
 *
 * The response field names are the manifest format's own keys, English since
 * t178; the route paths, the query parameters and the error envelope are English
 * too (D18/D20).
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import {
  SkillRejected,
  deprecateSkill,
  getSkill,
  listSkills,
  registerSkill,
} from '../repositories/skill.ts';
import { notFound, type ErrorResponse } from './common.ts';

interface ListQuery {
  Querystring: { id?: string };
}

interface IdParam {
  Params: { id: string };
  Querystring: { version?: string; hash?: string };
}

interface VersionParam {
  Params: { id: string; version: string };
}

/** A blank query parameter is an ABSENT one: `?version=` asks nothing. */
function asked(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Registers the skill routes in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database.
 */
export function registerSkills(app: FastifyInstance, db: Database): void {
  app.post('/skills', async (request, reply) => {
    try {
      const { skill, created } = registerSkill(db, request.body);
      // 200 and not 201 for a reimport: `201` would claim a write that did not
      // happen, and the caller that cares about the difference — `cartografo
      // import`, counting created against known — is the one that reads it.
      reply.code(created ? 201 : 200);
      return skill;
    } catch (error) {
      if (error instanceof SkillRejected) {
        reply.code(error.status);
        return { error: error.code, details: error.problems } satisfies ErrorResponse;
      }
      throw error;
    }
  });

  app.get<ListQuery>('/skills', async (request) => ({
    skills: listSkills(db, { id: asked(request.query.id) }),
  }));

  app.get<IdParam>('/skills/:id', async (request, reply) => {
    const skill = getSkill(db, request.params.id, {
      version: asked(request.query.version),
      hash: asked(request.query.hash),
    });
    return skill ?? notFound(reply, 'skill');
  });

  app.patch<VersionParam>('/skills/:id/:version', async (request, reply) => {
    const skill = deprecateSkill(db, request.params.id, request.params.version);
    return skill ?? notFound(reply, 'skill version');
  });
}
