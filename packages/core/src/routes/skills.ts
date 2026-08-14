/**
 * Skill-registry routes (t117, FR3/FR4).
 *
 * `POST /skills` is the only door into the registry, and it is a GATE, not a
 * write: whatever the CLI derived and whoever approved it, the manifest is
 * verified here from scratch before a row exists. The refusal always carries
 * every reason, in the shape `routes/common.ts` already uses — an import that
 * came back "invalid" and nothing else would send a human to read source code.
 *
 * The two reads exist because a registry nobody can consult is a write-only
 * table: the acceptance test confirms the registration through them, and they
 * are the surface a future capability reader (the synthesizer's "consultar
 * capacidades" step) already has.
 *
 * Three status codes and nothing else: 201 when the manifest checks out, 422
 * when it does not, 409 when the id is taken. There is no 400 here because there
 * is no envelope to get wrong — the body IS the manifest, and a body that is not
 * an object is simply a manifest that fails its first rule.
 *
 * The response field names are the manifest format's own keys, which D18 leaves
 * in Portuguese (`DECISOES.md:153-155`); the route paths and the error envelope
 * are English.
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { SkillRejected, getSkill, listSkills, registerSkill } from '../repositories/skill.ts';
import { notFound, type ErrorResponse } from './common.ts';

interface IdParam {
  Params: { id: string };
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
      const skill = registerSkill(db, request.body);
      reply.code(201);
      return skill;
    } catch (error) {
      if (error instanceof SkillRejected) {
        reply.code(error.status);
        return { error: error.code, details: error.problems } satisfies ErrorResponse;
      }
      throw error;
    }
  });

  app.get('/skills', async () => ({ skills: listSkills(db) }));

  app.get<IdParam>('/skills/:id', async (request, reply) => {
    const skill = getSkill(db, request.params.id);
    return skill ?? notFound(reply, 'skill');
  });
}
