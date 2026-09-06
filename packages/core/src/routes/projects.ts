/**
 * Project routes (t354, FR1).
 *
 * Two verbs and no third: declare a project, list the projects. Renaming and
 * removing one are out of scope by name, and neither is an accident — the name
 * is the address the screen's switcher and `cartografo --project <name>` use,
 * so moving it is a decision with consequences outside this file, and a project
 * that disappeared would leave every partitioned row it owned pointing at
 * nothing.
 *
 * **Only an operator may reach these**, and by OMISSION rather than by a check
 * here: the gate in `src/auth.ts` refuses any route outside `RUNNER_SURFACE`
 * with `out_of_scope_credential`, and this family is deliberately not on that
 * list — the same posture `POST /v1/skills` already has. A runner dispatches
 * sessions against a project somebody else declared; it does not declare one.
 *
 * The name is trimmed before anything else looks at it, and a blank one is a
 * `400`. Uniqueness is the schema's (`migrations/0026_project_partition.sql`),
 * so two calls racing cannot both win; `ProjectNameTaken` is how the loser is
 * told, as a `409` with the code the ficha names.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Database } from '../db/connection.ts';
import { ValidationError } from '../db/event-validation.ts';
import {
  ProjectNameTaken,
  createProject,
  listProjects,
} from '../repositories/projects.ts';
import {
  ERROR_RESPONSE_SCHEMA,
  OPEN_OBJECT_SCHEMA,
  refusal,
  withValidation,
} from './common.ts';

/** Contract of `POST /projects` in the public document. */
const CREATE_PROJECT_SCHEMA = {
  description:
    'Declares a project. A project is the partition every owned table is keyed by (D25): a class of graph, a registered skill and a hook secret are unique inside one project, never across the database.',
  body: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
  response: {
    201: OPEN_OBJECT_SCHEMA,
    400: ERROR_RESPONSE_SCHEMA,
    409: ERROR_RESPONSE_SCHEMA,
  },
} as const;

/** Contract of `GET /projects`: the listing, which takes nothing and cannot refuse. */
const LIST_PROJECTS_SCHEMA = {
  response: { 200: OPEN_OBJECT_SCHEMA },
} as const;

/**
 * Registers the project routes in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database; the routes never open their own (D1).
 */
export function registerProjects(app: FastifyInstance, db: Database): void {
  app.post('/projects', { schema: CREATE_PROJECT_SCHEMA }, async (request, reply) =>
    withValidation(reply, () => create(db, request, reply)),
  );

  app.get('/projects', { schema: LIST_PROJECTS_SCHEMA }, async () => ({
    projects: listProjects(db),
  }));
}

/** `POST /projects` — a name becomes a partition. */
function create(db: Database, request: FastifyRequest, reply: FastifyReply): unknown {
  const raw = (request.body as { name?: unknown } | null)?.name;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError(['name has to be a non-empty string']);
  }
  const name = raw.trim();

  try {
    const project = createProject(db, name);
    reply.code(201);
    return project;
  } catch (error) {
    if (error instanceof ProjectNameTaken) {
      return refusal(
        reply,
        409,
        'project_name_already_registered',
        `a project named "${error.projectName}" already exists; a name is how a person addresses one, so it holds only once`,
        { name: error.projectName },
      );
    }
    throw error;
  }
}
