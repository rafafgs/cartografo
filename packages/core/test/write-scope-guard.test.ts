/**
 * Gate of the write side of D25's partition (t417, FR8/AT9).
 *
 * D25 says "every read of a table that carries `project_id` filters by it", and
 * three tickets (t410, t411, t412) gave that to the reads. Nothing said the
 * mirror sentence out loud, and the gap it left is the defect t417 closes: a
 * route that CREATES a row under a caller-declared `project_id` accepted any
 * integer, while the sibling route that READS the same table refused an
 * undeclared one with `404 unknown_project`. The combination writes a row
 * nothing can read back.
 *
 * A test is what keeps that closed, because the rule is not expressible as a
 * type: whether a `project_id` in a body names a NEW row's partition is a fact
 * about the route's meaning, not about its signature.
 *
 * ## Why the list is audited and not derived
 *
 * Same caveat the sweeps in `event-append-only.test.ts` carry, and one more of
 * its own. {@link WRITE_TARGETS} is written by hand, re-verified against the
 * real tree by whoever touches it, because the two mechanical readings both
 * fail:
 *
 * - **"the slice mentions `project_id`"** misses `POST /v1/webhooks`, whose
 *   scope is read inside `readSubscription`, one function out of the handler;
 * - **"the handler calls a repository that writes a partitioned table"** would
 *   have to follow `confirmDraft` into `createJob`, across two modules.
 *
 * So the list is the audit, and what the sweep below mechanically guarantees is
 * narrower and honest: every entry still EXISTS where it says it does, every
 * entry that claims to validate really carries the check, and no write route
 * that so much as mentions `project_id` is missing from either this list or
 * {@link AUDITED_NON_TARGETS}. A new route that declares a scope cannot land
 * unclassified.
 *
 * ## The two that are deliberately NOT fixed (FR6)
 *
 * `POST /v1/leases` and `PATCH /v1/settings` accept an unvalidated `project_id`
 * and stay that way, because neither has a paired READ that enforces project
 * existence: `GET /v1/leases`'s `?project_id=` is a non-validating filter and
 * `GET /v1/settings` defaults an absent scope to `1` and 404s nothing. There is
 * no asymmetry to close there, and closing only the write side would create a
 * new one in the opposite direction. They are listed here as excluded, with
 * that reason, so the exclusion is a record rather than an omission.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PACKAGE_ROOT, requireArtifacts } from './support.ts';

const ROUTES_DIR = path.join(PACKAGE_ROOT, 'src', 'routes');

/** The verbs that can create a row. `GET` and `DELETE` are nobody's write here. */
const WRITE_VERBS = ['post', 'put', 'patch'] as const;

/**
 * A route registration, as `registerX` writes it.
 *
 * The generic parameter is optional because half the file uses `app.post(` and
 * the other half `app.post<IdParam>(`; both open the same slice.
 */
const REGISTRATION =
  /^\s*app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']+)'/;

/**
 * What "this route validates its scope" looks like in source.
 *
 * Two spellings, because the codebase has two and both are correct:
 * `requireProject(` for a route that resolves the scope itself (`POST /graphs`
 * since t354), and the literal `'unknown_project'` for one that answers the
 * same refusal out of a `catch` or an explicit lookup (`POST /jobs` since
 * t417). What matters is the ANSWER being the same, not the route arriving at
 * it the same way.
 */
const VALIDATES = /requireProject\(|'unknown_project'/;

/** A write route that lets a caller declare a NEW row's `project_id`. */
interface WriteTarget {
  /** The partitioned table the row lands in. */
  table: string;
  /** File under `src/routes/`, by name. */
  file: string;
  /** HTTP verb, lower-case, as the registration spells it. */
  verb: (typeof WRITE_VERBS)[number];
  /** Path literal, exactly as the registration spells it. */
  route: string;
  /** Whether the route is required to refuse an undeclared project. */
  validates: boolean;
  /** Why — and for an excluded one, why NOT. Never empty. */
  reason: string;
}

/**
 * The audit (FR8). Re-verify against `src/routes/` before trusting it.
 *
 * Twelve entries validate and two do not. The twelve are not all t417's work:
 * `graph`, `graph_version`, `proposal`, `skill` and `hook_secret` have done
 * this since t354, and `POST /proposals` since t412 gave the same treatment to
 * the row it writes. They are here so the sweep proves its POSITIVE case on
 * routes this ticket never touched — a guard that only ever sees the rows one
 * ticket wrote proves that ticket, not the rule.
 */
const WRITE_TARGETS: readonly WriteTarget[] = Object.freeze([
  {
    table: 'job',
    file: 'jobs.ts',
    verb: 'post',
    route: '/jobs',
    validates: true,
    reason:
      'the ticket\'s own named case: GET /v1/jobs* has refused an undeclared project since t410, ' +
      'so a job created under one was a row nothing could read back',
  },
  {
    table: 'job',
    file: 'examples.ts',
    verb: 'post',
    route: '/examples/:class/run',
    validates: true,
    reason:
      'the second caller of createJob that takes a scope from the wire; it resolves the project ' +
      'with requireProject before the call, and has since t354 — audited, never fixed',
  },
  {
    table: 'intake_draft',
    file: 'intake.ts',
    verb: 'post',
    route: '/intake',
    validates: true,
    reason:
      'the draft carries the project_id that confirmDraft later hands to createJob, so a draft ' +
      'born under a phantom project is the same defect one HTTP call further in',
  },
  {
    table: 'job',
    file: 'intake.ts',
    verb: 'post',
    route: '/intake/:id/confirmations',
    validates: true,
    reason:
      'the other door into createJob: reachable only by a draft older than t417 now that POST ' +
      '/intake validates, and answered anyway — defense in depth, not dead weight',
  },
  {
    table: 'webhook_subscription',
    file: 'webhooks.ts',
    verb: 'post',
    route: '/webhooks',
    validates: true,
    reason:
      'readProject checked integer-ness and nothing else, so the row landed in a partition the ' +
      'scoped listing cannot hand back',
  },
  {
    table: 'graph',
    file: 'graphs.ts',
    verb: 'post',
    route: '/graphs',
    validates: true,
    reason: 'already correct since t354 — here to prove the sweep\'s positive case',
  },
  {
    table: 'graph_version',
    file: 'graphs.ts',
    verb: 'post',
    route: '/graphs/:id/fork',
    validates: true,
    reason: 'already correct since t354 — here to prove the sweep\'s positive case',
  },
  {
    table: 'proposal',
    file: 'graphs.ts',
    verb: 'post',
    route: '/graphs/:id/promote',
    validates: true,
    reason: 'already correct since t354 — here to prove the sweep\'s positive case',
  },
  {
    table: 'proposal',
    file: 'graphs.ts',
    verb: 'post',
    route: '/graphs/:id/offer',
    validates: true,
    reason: 'already correct since t354 — here to prove the sweep\'s positive case',
  },
  {
    table: 'proposal',
    file: 'proposals.ts',
    verb: 'post',
    route: '/proposals',
    validates: true,
    reason:
      'already correct since t412, which opened create() with requireProject so the graph and '
      + 'version lookups happen inside the scope the row is then written into — audited here on '
      + 'the merge that brought it, never fixed',
  },
  {
    table: 'skill',
    file: 'skills.ts',
    verb: 'post',
    route: '/skills',
    validates: true,
    reason: 'already correct since t354 — here to prove the sweep\'s positive case',
  },
  {
    table: 'hook_secret',
    file: 'hook-secrets.ts',
    verb: 'put',
    route: '/hook-secrets/:name',
    validates: true,
    reason: 'already correct since t354 — here to prove the sweep\'s positive case',
  },
  {
    table: 'lease',
    file: 'leases.ts',
    verb: 'post',
    route: '/leases',
    validates: false,
    reason:
      'FR6: GET /v1/leases never enforces project existence either — its ?project_id= is an ' +
      'optional, non-validating filter. Read and write are equally lenient, so there is no ' +
      'asymmetry to close, and scoping the table for the first time is a product decision',
  },
  {
    table: 'setting',
    file: 'settings.ts',
    verb: 'patch',
    route: '/settings',
    validates: false,
    reason:
      'FR6: GET /v1/settings defaults an absent project_id to 1 and 404s no unknown one. Same ' +
      'shape as lease, same exclusion',
  },
]);

/**
 * Write routes that MENTION `project_id` and declare no new row's scope.
 *
 * The exemption list of the completeness sweep, and the same device
 * `event-append-only.test.ts` uses for the module that owns the log: without it
 * the net would either miss real routes or shout at innocent ones forever.
 */
const AUDITED_NON_TARGETS: readonly { file: string; route: string; reason: string }[] =
  Object.freeze([
    {
      file: 'leases.ts',
      route: '/leases/:id/releases',
      reason:
        'reads the project off the lease it is releasing, to name it in the event; the caller ' +
        'declares nothing and no row is created',
    },
  ]);

/** One registration and the source between it and the next one. */
interface RouteSlice {
  file: string;
  verb: string;
  route: string;
  source: string;
}

/**
 * A call to a named function of the same file, in handler position.
 *
 * `routes/graphs.ts` registers every write as one line — `withValidation(reply,
 * () => create(db, request, reply))` — with the whole handler in a
 * module-level function above. Reading only the registration's own lines would
 * therefore report `POST /graphs` as unguarded when it has resolved its scope
 * with `requireProject` since t354, which is a false accusation and the fastest
 * way to get a guard deleted.
 */
const DELEGATION = /\b([A-Za-z_$][\w$]*)\(\s*db\s*,\s*request\s*,\s*reply\s*\)/g;

/**
 * The registration's source plus the bodies of the same-file functions it hands
 * the request to.
 *
 * ONE hop, deliberately. That is the shape the tree actually has, and a
 * transitive walk would eventually swallow a neighbouring helper and start
 * crediting a route with a check written for somebody else. A future route that
 * hides its validation two functions deep will trip this guard — and the right
 * answer then is to move the check where a reader can see it, not to loosen
 * the sweep.
 *
 * @param source Whole file, comments already stripped.
 * @param slice The registration's own lines.
 * @returns Both, concatenated.
 */
function withDelegatedHandlers(source: string, slice: string): string {
  let expanded = slice;

  for (const match of slice.matchAll(DELEGATION)) {
    const declaration = new RegExp(String.raw`\bfunction\s+${match[1]}\s*\(`).exec(source);
    if (declaration === null) continue;
    // Up to the next line that closes a top-level block — the file's own
    // formatting, which `eslint` keeps honest.
    const rest = source.slice(declaration.index);
    const end = rest.indexOf('\n}');
    expanded += `\n${end === -1 ? rest : rest.slice(0, end)}`;
  }

  return expanded;
}

/**
 * Strips comments before any pattern is applied.
 *
 * A comment EXPLAINING the check is not the check — and, the other way round,
 * a comment naming `project_id` must not enrol a route in the sweep. The same
 * reasoning `event-append-only.test.ts` writes down for its own sweep.
 */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Every route registration under `src/routes/`, with its own slice of source. */
function routeSlices(): RouteSlice[] {
  const slices: RouteSlice[] = [];

  for (const file of readdirSync(ROUTES_DIR).sort()) {
    if (!file.endsWith('.ts')) continue;
    const raw = readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    const clean = withoutComments(raw);
    const lines = raw.split('\n');

    const marks: { line: number; verb: string; route: string }[] = [];
    lines.forEach((text, index) => {
      const match = REGISTRATION.exec(text);
      if (match !== null) marks.push({ line: index, verb: match[1], route: match[2] });
    });

    marks.forEach((mark, index) => {
      const end = index + 1 < marks.length ? marks[index + 1].line : lines.length;
      slices.push({
        file,
        verb: mark.verb,
        route: mark.route,
        source: withDelegatedHandlers(clean, withoutComments(lines.slice(mark.line, end).join('\n'))),
      });
    });
  }

  return slices;
}

test('t417 AT9 — the guard really does tell a validated write from an unvalidated one', () => {
  // Without this pair the sweeps below could be passing by accident: a pattern
  // that never matches is indistinguishable from a tree with no violations.
  const unvalidated = `
    app.post('/things', async (request, reply) =>
      withValidation(reply, () => {
        const thing = createThing(db, { project_id: request.body.project_id });
        reply.code(201);
        return thing;
      }),
    );
  `;
  const byLookup = `
    app.post('/things', async (request, reply) => {
      const projectId = body.project_id ?? DEFAULT_PROJECT;
      if (getProject(db, projectId) === undefined) {
        return refusal(reply, 404, 'unknown_project', 'no project answers to this scope', {
          project_id: projectId,
        });
      }
      return createThing(db, { project_id: projectId });
    });
  `;
  const byScope = `
    app.post('/things', async (request, reply) => {
      const scope = requireProject(db, request, reply);
      if (scope.project === undefined) return scope.refusal;
      return createThing(db, { project_id: scope.project.id });
    });
  `;

  assert.equal(VALIDATES.test(unvalidated), false, 'a write that trusts the body has to trip');
  assert.equal(VALIDATES.test(byLookup), true, 'an explicit lookup counts');
  assert.equal(VALIDATES.test(byScope), true, 'and so does requireProject');

  // And a route that only TALKS about the rule is still an unvalidated route.
  assert.equal(
    VALIDATES.test(
      withoutComments("// TODO: answer 'unknown_project' here, calling requireProject(db, ...)"),
    ),
    false,
    'a comment is not a check',
  );
});

test('t417 AT9 — every audited write target still exists where the list says it does', () => {
  requireArtifacts('src/routes/jobs.ts', 'src/routes/intake.ts', 'src/routes/webhooks.ts');

  const slices = routeSlices();
  const missing = WRITE_TARGETS.filter(
    (target) =>
      !slices.some(
        (slice) =>
          slice.file === target.file &&
          slice.verb === target.verb &&
          slice.route === target.route,
      ),
  ).map((target) => `${target.verb.toUpperCase()} ${target.route} (${target.file})`);

  assert.deepEqual(
    missing,
    [],
    'a renamed or removed route would leave this guard passing over nothing at all',
  );
});

test('t417 AT9 — every write on a partitioned table validates its project, or is excluded with a reason', () => {
  requireArtifacts('src/routes/jobs.ts', 'src/routes/intake.ts', 'src/routes/webhooks.ts');

  const slices = routeSlices();
  const sliceOf = (target: WriteTarget): string =>
    slices.find(
      (slice) =>
        slice.file === target.file && slice.verb === target.verb && slice.route === target.route,
    )?.source ?? '';

  const unguarded = WRITE_TARGETS.filter(
    (target) => target.validates && !VALIDATES.test(sliceOf(target)),
  ).map((target) => `${target.verb.toUpperCase()} ${target.route} writes ${target.table}`);

  assert.deepEqual(
    unguarded,
    [],
    'a row created under a project nobody declared is a row the scoped read refuses: ' +
      'the write has to answer 404 unknown_project, exactly as the read does',
  );

  // The exclusions are a record, not an omission: each one names its reason
  // here, which is what tells a deliberate gap from a forgotten one.
  const excluded = WRITE_TARGETS.filter((target) => !target.validates);
  assert.deepEqual(
    excluded.map((target) => target.table).sort(),
    ['lease', 'setting'],
    'FR6 names exactly two, and a third would be a decision nobody recorded',
  );
  for (const target of excluded) {
    assert.match(target.reason, /FR6/, `${target.table}'s exclusion has to cite the requirement`);
  }
  for (const target of WRITE_TARGETS) {
    assert.ok(target.reason.trim().length > 0, `${target.route} has to carry its reason`);
  }
});

test('t417 AT9 — no write route mentions project_id without being classified', () => {
  const classified = new Set<string>([
    ...WRITE_TARGETS.map((target) => `${target.file} ${target.route}`),
    ...AUDITED_NON_TARGETS.map((target) => `${target.file} ${target.route}`),
  ]);

  const unclassified = routeSlices()
    .filter((slice) => (WRITE_VERBS as readonly string[]).includes(slice.verb))
    .filter((slice) => /project_id/.test(slice.source))
    .filter((slice) => !classified.has(`${slice.file} ${slice.route}`))
    .map((slice) => `${slice.verb.toUpperCase()} ${slice.route} (${slice.file})`);

  assert.deepEqual(
    unclassified,
    [],
    'a new write route that names a project has to be audited into WRITE_TARGETS (it declares a ' +
      "row's partition) or into AUDITED_NON_TARGETS (it does not), with the reason",
  );
});
