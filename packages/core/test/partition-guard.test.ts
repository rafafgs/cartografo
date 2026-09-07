/**
 * Structural gate of D25's project partition (t414, FR5–FR7).
 *
 * The technique is `test/event-append-only.test.ts`'s and, one step further
 * back, `scripts/check-single-writer.mjs`'s: walk `packages/core/src` as TEXT,
 * with no parser, flag by pattern, and PROVE the pattern fires — a regex that
 * matches nothing is indistinguishable from clean code, which is why the
 * self-proof below is a test of its own.
 *
 * The rule: a statement that reads or writes a table carrying its own
 * `project_id` column has to carry a `project_id` PREDICATE, unless the function
 * it lives in is on {@link ALLOWLIST} with an argued reason. Scoping a query is
 * mechanical work, and mechanical work is what a gate is for; what is NOT
 * mechanical is the handful of statements that are correct without a project,
 * and those are the ones that owe a sentence.
 *
 * ## Three things this gate deliberately does not see
 *
 * 1. **A scoped query called with the WRONG project.** This is a SQL-level
 *    sweep: `getVersion(db, id)` reads `WHERE project_id = ?` and is green here
 *    even when the caller let the parameter default to project 1. The two known
 *    instances are `repositories/session.ts`'s `resolveOutputSchema` (which
 *    resolves a version and a skill with no project at all, so project 1's
 *    schema can judge project 2's report when a content hash collides) and
 *    `repositories/intake.ts`'s `listDrafts`, whose `DraftFilter.project_id`
 *    `routes/intake.ts` does now thread off the wire (t417) but never defaults,
 *    so `GET /v1/intake` with no `?project_id=` still lists every project's
 *    drafts together. Both were named in t414's Context as real, currently
 *    unowned gaps, and neither is this ticket's to fix.
 * 2. **A route that never passes the scope its repository accepts.** Same
 *    reason, one level up. `test/partition-isolation.test.ts` is the gate for
 *    that half: it is behavioural, it goes through the API, and it is where a
 *    leak of this shape shows up.
 * 3. **A conditional branch inside a dynamically built statement.** When the
 *    prepared SQL is a template with a `${...}` hole in it, the predicate can
 *    only be looked for in the enclosing function's text (that is where
 *    `conditions.push('project_id = ?')` lives), so a function with a scoped
 *    branch AND an unscoped one reads as scoped. Behaviour, again, is
 *    `partition-isolation.test.ts`'s to prove.
 *
 * ## The four classes an exception may belong to
 *
 * They are t414's FR6, and a finding that fits none of them is a bug this gate
 * correctly caught — never a fifth class to invent.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PACKAGE_ROOT, requireArtifacts } from './support.ts';

const SOURCE_DIR = path.join(PACKAGE_ROOT, 'src');

/**
 * The tables that carry a `project_id` column of their own.
 *
 * The list is `docs/spec/entities-versioning.md`'s ("Which other tables are
 * partitioned, and which are deliberately not"), copied rather than derived: a
 * table gaining the column is a decision somebody takes, and this line is where
 * they say so. `session`, `input_request`, `webhook_delivery` and
 * `job_dependency` are absent on purpose — they inherit the partition through a
 * foreign key and resolve it by reading their owner, which is D25's own rule —
 * and so are `credential` and `engine_model`, which are facts about a person or
 * a machine and not about a project.
 *
 * `project` itself is on the list because it is on the spec's, and every read of
 * it is on the allowlist for the one reason that cannot be fixed: the table IS
 * the partition catalogue.
 */
const PARTITIONED_TABLES = Object.freeze([
  'project',
  'graph',
  'graph_version',
  'proposal',
  'skill',
  'hook_secret',
  'job',
  'lease',
  'intake_draft',
  'webhook_subscription',
  'hook_delivery',
  'event',
  'setting',
]);

/** Why a statement is allowed to touch a partitioned table with no project. */
type ExceptionClass =
  /**
   * The only predicate is equality against a single-table, globally-unique
   * `AUTOINCREMENT` id (`job.id`, `lease.id`, `event.id`, ...), so the row it
   * reaches cannot belong to a project other than the one that id was minted in.
   */
  | 'GLOBAL_ID_LOOKUP'
  /**
   * The SAME function already resolved the id against the caller's project
   * before this statement runs.
   */
  | 'SAFE_BY_CORRELATION'
  /**
   * Not project-scoped as a product decision rather than as an omission — a
   * position in the global id sequence, a periodic sweep over self-contained
   * rows, a fact about a runner.
   */
  | 'GLOBAL_BY_DESIGN'
  /**
   * A mutation — its guarded read and the `UPDATE` that read protects — whose
   * authorization-by-project is a write-side risk already deferred to a future
   * ticket, in `routes/jobs.ts`'s own words: "The four WRITES below are
   * deliberately left alone... it is the write-side slice of the same split".
   */
  | 'WRITE_PATH_DEFERRED';

/** One argued exception. */
interface Exception {
  /** `<path under src>::<enclosing function>`. */
  where: string;
  /**
   * Substring of the normalized SQL, when one function's statements do not all
   * belong to the same class. Absent, the entry covers every statement of the
   * function.
   */
  sql?: string;
  class: ExceptionClass;
  /** Why, in one line. */
  reason: string;
}

/**
 * The argued exceptions, re-verified against the tree at construction time.
 *
 * Two rules keep this list from rotting: an entry that matches nothing is a
 * FAILURE (below), so a query that gets scoped forces its cover to be deleted;
 * and a temporary entry naming a sibling ticket's not-yet-merged gap is never
 * permanent cover. Both rules have now been paid: `ticket-411` merged before
 * this ticket was built and left nothing behind here, and `ticket-412` merged
 * into it, at which point the dead-entry rule went red on all six of the `t412`
 * entries at once and they were deleted — the mechanism working exactly as the
 * ticket designed it, and the reason there is no temporary entry left below.
 */
const ALLOWLIST: readonly Exception[] = Object.freeze([
  /* ---------------------------------------------------------------------- */
  /* GLOBAL_ID_LOOKUP — the id is the scope.                                 */
  /* ---------------------------------------------------------------------- */
  {
    where: 'db/events.ts::getEventsByEntity',
    class: 'GLOBAL_ID_LOOKUP',
    reason: 'one entity by its own id; the caller that needs a project resolves it from the entity.',
  },
  {
    where: 'repositories/external-calls.ts::jobExists',
    class: 'GLOBAL_ID_LOOKUP',
    reason:
      "the owning job by id — this read is what TELLS the external-call row its project (t370, and the same shape `openSession` above already argues).",
  },
  {
    where: 'repositories/hooks.ts::recordHookDeliverySuccess',
    class: 'GLOBAL_ID_LOOKUP',
    reason: 'closes the one delivery row the sweep just attempted, by its own id.',
  },
  {
    where: 'repositories/hooks.ts::recordHookDeliveryFailure',
    class: 'GLOBAL_ID_LOOKUP',
    reason: 'reads and re-writes the one delivery row the sweep just attempted, by its own id.',
  },
  {
    where: 'repositories/input-request.ts::createInputRequest',
    class: 'GLOBAL_ID_LOOKUP',
    reason: "the owning job by id — this read is what TELLS the row its project.",
  },
  {
    where: 'repositories/input-request.ts::answer',
    class: 'GLOBAL_ID_LOOKUP',
    reason: "the owning job by id, to stamp the answer's event with that job's project.",
  },
  {
    where: 'repositories/input-request.ts::getPrecedents',
    class: 'GLOBAL_ID_LOOKUP',
    reason: 'the asking job by id; the precedent search itself is scoped by that project (t411).',
  },
  {
    where: 'repositories/leases.ts::renewLease',
    class: 'GLOBAL_ID_LOOKUP',
    reason: 'the runner renews the one lease it holds, by the id the grant handed it.',
  },
  {
    where: 'repositories/leases.ts::releaseLease',
    class: 'GLOBAL_ID_LOOKUP',
    reason: 'the runner releases the one lease it holds, by the id the grant handed it.',
  },
  {
    where: 'repositories/leases.ts::grantLease',
    sql: 'job_id = ?',
    class: 'GLOBAL_ID_LOOKUP',
    reason: '"is this job already leased?" — `job.id` is global, so a project would narrow it wrongly.',
  },
  {
    where: 'repositories/session.ts::openSession',
    class: 'GLOBAL_ID_LOOKUP',
    reason: "the owning job by id — this read is what TELLS the session its project.",
  },
  {
    where: 'repositories/session.ts::resolveOutputSchema',
    class: 'GLOBAL_ID_LOOKUP',
    reason:
      "the session's own job by id; what this function then does with the version it finds is the unowned gap the header names.",
  },

  /* ---------------------------------------------------------------------- */
  /* SAFE_BY_CORRELATION — the project was already checked upstream.         */
  /* ---------------------------------------------------------------------- */
  {
    where: 'repositories/job.ts::jobTraversal',
    class: 'SAFE_BY_CORRELATION',
    reason: 'downstream of `readScopedRow`, which already refused a job of another project.',
  },
  {
    where: 'repositories/job.ts::transitionJob',
    class: 'SAFE_BY_CORRELATION',
    reason: "the `alreadyWalked` check runs after this function's own scoped read of the job.",
  },
  {
    where: 'repositories/job.ts::blockOnRepeatedFailure',
    class: 'SAFE_BY_CORRELATION',
    reason: "the job id comes from the session row `finishSession` just resolved, never from a caller.",
  },

  /* ---------------------------------------------------------------------- */
  /* GLOBAL_BY_DESIGN — a project here would be the bug.                     */
  /* ---------------------------------------------------------------------- */
  {
    where: 'repositories/projects.ts::getProject',
    class: 'GLOBAL_BY_DESIGN',
    reason: 'the `project` table IS the partition catalogue; scoping it by itself is not a concept.',
  },
  {
    where: 'repositories/projects.ts::getProjectByName',
    class: 'GLOBAL_BY_DESIGN',
    reason: 'same: the name is the address a person uses to FIND the partition.',
  },
  {
    where: 'repositories/projects.ts::listProjects',
    class: 'GLOBAL_BY_DESIGN',
    reason: 'same: the switcher has to see every partition there is.',
  },
  {
    where: 'repositories/leases.ts::expireOverdue',
    class: 'GLOBAL_BY_DESIGN',
    reason: 'a deadline that has passed has passed; lease expiry is not a per-project concept.',
  },
  {
    where: 'repositories/leases.ts::grantLease',
    sql: 'runner_id = ?',
    class: 'GLOBAL_BY_DESIGN',
    reason: "one runner's own concurrency cap counts every lease it holds, across projects.",
  },
  {
    where: 'repositories/runners.ts::listRunnersWithHealth',
    class: 'GLOBAL_BY_DESIGN',
    reason:
      'a runner is a machine and not a project (the spec excludes `credential`/`engine_model` for the same reason); its health counts all of its leases.',
  },
  {
    where: 'repositories/webhooks.ts::createSubscription',
    class: 'GLOBAL_BY_DESIGN',
    reason: '`MAX(id)` is a position in the global monotonic id sequence, never a data read.',
  },
  {
    where: 'repositories/webhooks.ts::dueDeliveries',
    class: 'GLOBAL_BY_DESIGN',
    reason:
      'the partition was decided at fan-out time — every row FKs to the one subscription this joins back to — so the "what is due?" sweep needs no project.',
  },
  {
    where: 'repositories/hooks.ts::dueHookDeliveries',
    class: 'GLOBAL_BY_DESIGN',
    reason:
      'the same sweep for hooks, and self-contained on top of it: `hook_delivery` copies its own url/secret at queue time (`0016_gancho.sql`).',
  },
  {
    where: 'routes/events.ts::readCursor',
    class: 'GLOBAL_BY_DESIGN',
    reason: '`MAX(id)` is where this connection starts reading, not something it reads.',
  },
  {
    where: 'repositories/job.ts::jobProjectId',
    class: 'GLOBAL_BY_DESIGN',
    reason:
      'the one read of that file that crosses the partition on purpose — it answers WHICH project an id lives in, so `POST /v1/leases` can tell a foreign job from one that never existed (t412); a project predicate would be the bug.',
  },

  /* ---------------------------------------------------------------------- */
  /* WRITE_PATH_DEFERRED — a named, deferred write-side risk.                */
  /* ---------------------------------------------------------------------- */
  {
    where: 'repositories/job.ts::readRow',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'the unscoped read the four job writes use; `routes/jobs.ts` names the deferral.',
  },
  {
    where: 'repositories/job.ts::mutate',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'the `UPDATE` those same four writes go through.',
  },
  {
    where: 'repositories/intake.ts::readRow',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'the intake mirror of `job.ts`’s `readRow`, by the identical reasoning (t414, FR6).',
  },
  {
    where: 'repositories/intake.ts::amendDraft',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'intake write half; same deferral.',
  },
  {
    where: 'repositories/intake.ts::discardDraft',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'intake write half; same deferral.',
  },
  {
    where: 'repositories/intake.ts::confirmDraft',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'intake write half; same deferral.',
  },
  {
    where: 'repositories/proposals.ts::appendProposalEvidence',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'reinforcement of a pending proposal the route already found; write-side scope deferred.',
  },
  {
    where: 'repositories/proposals.ts::approveProposal',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'status transition by id, guarded by the previous status; write-side scope deferred.',
  },
  {
    where: 'repositories/proposals.ts::rejectProposal',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'status transition by id, guarded by the previous status; write-side scope deferred.',
  },
  {
    where: 'repositories/proposals.ts::rejectProposalByHuman',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'status transition by id, guarded by the previous status; write-side scope deferred.',
  },
  {
    where: 'repositories/proposals.ts::applyProposal',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'status transition by id, guarded by the previous status; write-side scope deferred.',
  },
  {
    where: 'repositories/proposals.ts::revertProposal',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'status transition by id, guarded by the previous status; write-side scope deferred.',
  },
  {
    where: 'repositories/proposals.ts::recordVerdict',
    class: 'WRITE_PATH_DEFERRED',
    reason: 'status transition by id, guarded by the previous status; write-side scope deferred.',
  },

]);

/* -------------------------------------------------------------------------- */
/* The sweep                                                                  */
/* -------------------------------------------------------------------------- */

/** Lists the `.ts` files under a directory, recursively. */
function listSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listSources(filePath));
    } else if (entry.isFile() && filePath.endsWith('.ts')) {
      found.push(filePath);
    }
  }
  return found.sort();
}

/**
 * The same text with every COMMENT blanked out, character for character.
 *
 * Length-preserving, because every offset below indexes back into the original,
 * and newline-preserving, because the function-region scan is line-anchored.
 * The string literals are left whole — they are what carries the SQL — which is
 * why this scanner tracks template literals and their `${...}` holes properly:
 * a `//` inside a URL is not a comment, and `` ` `` nested inside `${}` (which
 * `repositories/job.ts` really does) must not end the outer literal early.
 *
 * A comment that MENTIONS a query is not a query, and without this the gate
 * would punish precisely whoever documents the reason for not writing one.
 */
export function blankComments(code: string): string {
  const out = code.split('');
  const stack: Array<{ kind: 'template' } | { kind: 'hole'; depth: number }> = [];
  let index = 0;

  while (index < code.length) {
    const top = stack[stack.length - 1];
    const character = code[index];

    if (top?.kind === 'template') {
      if (character === '\\') {
        index += 2;
      } else if (character === '`') {
        stack.pop();
        index += 1;
      } else if (character === '$' && code[index + 1] === '{') {
        stack.push({ kind: 'hole', depth: 0 });
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (character === '/' && code[index + 1] === '/') {
      while (index < code.length && code[index] !== '\n') {
        out[index] = ' ';
        index += 1;
      }
      continue;
    }

    if (character === '/' && code[index + 1] === '*') {
      const closed = code.indexOf('*/', index + 2);
      const stop = closed === -1 ? code.length : closed + 2;
      for (let cursor = index; cursor < stop; cursor += 1) {
        if (code[cursor] !== '\n') out[cursor] = ' ';
      }
      index = stop;
      continue;
    }

    if (character === '`') {
      stack.push({ kind: 'template' });
      index += 1;
      continue;
    }

    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;
      while (index < code.length) {
        if (code[index] === '\\') {
          index += 2;
          continue;
        }
        if (code[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (top?.kind === 'hole') {
      if (character === '{') top.depth += 1;
      else if (character === '}') {
        if (top.depth === 0) stack.pop();
        else top.depth -= 1;
      }
    }

    index += 1;
  }

  return out.join('');
}

/** A named region of a file: a top-level declaration and everything until the next. */
interface Region {
  name: string;
  start: number;
  end: number;
}

/** `export function f`, `function f`, `const f =` — anything anchored at column zero. */
const DECLARATION =
  /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*[:=]/gm;

/**
 * The top-level declarations of a file, each owning the text up to the next one.
 *
 * A region and not a brace-matched body, on purpose: `function f(db: Database,
 * filters: F = {}): T {` opens its first brace in a DEFAULT PARAMETER, so brace
 * matching from the name is wrong exactly where it matters most. Column zero is
 * the reliable boundary in this package, and a `.prepare(` inside a closure
 * nested in a function is attributed to that function — which is the name an
 * exception wants to be argued under anyway.
 */
function regions(code: string): Region[] {
  const found: Array<{ name: string; start: number }> = [];
  DECLARATION.lastIndex = 0;
  let match = DECLARATION.exec(code);
  while (match !== null) {
    found.push({ name: match[1] ?? match[2], start: match.index });
    match = DECLARATION.exec(code);
  }
  return found.map((region, position) => ({
    ...region,
    end: found[position + 1]?.start ?? code.length,
  }));
}

/** One prepared statement, with where in the file it was written. */
interface Statement {
  sql: string;
  at: number;
}

/**
 * Every `.prepare(`-wrapped SQL literal of a file.
 *
 * The `${...}` holes of a template are kept AS THEY ARE, never expanded: a
 * `${COLUMNS}` that happens to select `project_id` is a column coming back, not
 * a row being narrowed, and expanding it would turn the gate green on exactly
 * the reads it exists to find.
 */
function statements(code: string): Statement[] {
  const found: Statement[] = [];
  const marker = '.prepare(';
  let at = code.indexOf(marker);

  while (at !== -1) {
    let cursor = at + marker.length;
    while (cursor < code.length && /\s/.test(code[cursor])) cursor += 1;

    const quote = code[cursor];
    if (quote === '`' || quote === "'" || quote === '"') {
      let sql = '';
      cursor += 1;
      while (cursor < code.length) {
        if (code[cursor] === '\\') {
          sql += code[cursor + 1] ?? '';
          cursor += 2;
          continue;
        }
        if (code[cursor] === quote) break;
        sql += code[cursor];
        cursor += 1;
      }
      found.push({ sql, at });
    }

    at = code.indexOf(marker, at + marker.length);
  }

  return found;
}

/**
 * `FROM x` / `JOIN x` / `UPDATE x` / `DELETE FROM x` naming a partitioned table.
 *
 * `INSERT INTO` is absent on purpose: a row being written declares its own
 * `project_id` in the column list, and there is no other project's row for it to
 * reach.
 */
const READS_PARTITIONED = new RegExp(
  String.raw`\b(?:from|join|update|delete\s+from)\s+(${PARTITIONED_TABLES.join('|')})\b`,
  'gi',
);

/**
 * A `project_id` PREDICATE, and not merely the two words appearing somewhere.
 *
 * Stricter than "the literal substring `project_id`" on purpose: `SELECT
 * project_id, execution_id FROM job WHERE id = ?` contains the substring and
 * narrows nothing — it is a column coming back. Every predicate contains the
 * substring, so nothing that would have passed the looser rule for a real
 * reason fails this one.
 */
const SCOPED = /\bproject_id\s*(?:=|<>|!=|\bin\b)/i;

/** A statement the sweep flagged, in the words the failure prints. */
interface Finding {
  where: string;
  sql: string;
}

/** Collapses a SQL literal onto one line, for a readable failure. */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** Every statement of `src/` that touches a partitioned table with no project predicate. */
function sweep(): Finding[] {
  const findings: Finding[] = [];

  for (const file of listSources(SOURCE_DIR)) {
    const code = blankComments(readFileSync(file, 'utf8'));
    const named = regions(code);
    const relative = path.relative(SOURCE_DIR, file).split(path.sep).join('/');

    for (const statement of statements(code)) {
      READS_PARTITIONED.lastIndex = 0;
      if (!READS_PARTITIONED.test(statement.sql)) continue;
      if (SCOPED.test(statement.sql)) continue;

      const region = named.filter((one) => one.start <= statement.at && statement.at < one.end).pop();
      // A statement assembled out of a `${...}` hole cannot be judged on its own
      // text: the predicate lives in the `conditions.push('project_id = ?')` a
      // few lines above it. The enclosing region is the smallest honest place to
      // look, and the header says what that costs.
      if (statement.sql.includes('${') && region !== undefined) {
        if (SCOPED.test(code.slice(region.start, region.end))) continue;
      }

      findings.push({
        where: `${relative}::${region?.name ?? '<module>'}`,
        sql: normalize(statement.sql),
      });
    }
  }

  return findings;
}

/** Does this exception cover that finding? */
function covers(exception: Exception, finding: Finding): boolean {
  if (exception.where !== finding.where) return false;
  return exception.sql === undefined || finding.sql.includes(exception.sql);
}

/* -------------------------------------------------------------------------- */
/* The tests                                                                  */
/* -------------------------------------------------------------------------- */

test('t414 — the gate really does catch an unscoped read of a partitioned table', () => {
  // Without this proof the sweep below could be passing by accident: a regex
  // that never matches anything looks exactly like a clean tree
  // (`test/event-append-only.test.ts:91-100`, the same argument).
  const flagged = (code: string): Finding[] => {
    const cleaned = blankComments(code);
    return statements(cleaned)
      .filter((statement) => {
        READS_PARTITIONED.lastIndex = 0;
        return READS_PARTITIONED.test(statement.sql) && !SCOPED.test(statement.sql);
      })
      .map((statement) => ({ where: 'fixture', sql: normalize(statement.sql) }));
  };

  assert.equal(
    flagged("db.prepare('SELECT id FROM job WHERE execution_id = ?')").length,
    1,
    'a read of a partitioned table with no project predicate has to trip the pattern',
  );
  assert.equal(
    flagged("db.prepare('SELECT id FROM job WHERE project_id = ? AND execution_id = ?')").length,
    0,
    'the same read, scoped, must not trip it',
  );
  assert.equal(
    flagged("db.prepare('SELECT project_id, id FROM job WHERE execution_id = ?')").length,
    1,
    'a project_id in the SELECT list is a column coming back, not a filter',
  );
  assert.equal(
    flagged("db.prepare('SELECT id FROM session WHERE job_id = ?')").length,
    0,
    'a table that carries no project_id column of its own is not this gate’s business',
  );
  assert.equal(
    flagged("db.prepare('INSERT INTO job (project_id, title) VALUES (?, ?)')").length,
    0,
    'an insert declares its own partition and can reach no other row',
  );
  assert.equal(
    flagged('// db.prepare("SELECT id FROM job WHERE execution_id = ?")').length,
    0,
    'a comment describing a query is not a query',
  );
});

test('t414 — every read of a partitioned table is scoped or argued on the allowlist', () => {
  requireArtifacts('src/db/events.ts', 'src/routes/events.ts');

  const uncovered = sweep().filter(
    (finding) => !ALLOWLIST.some((exception) => covers(exception, finding)),
  );

  assert.deepEqual(
    uncovered.map((finding) => `${finding.where} — ${finding.sql}`),
    [],
    'a partitioned table read with no project predicate has to be scoped, or argued on ALLOWLIST under one of the four classes',
  );
});

test('t414 — the allowlist carries no entry that covers nothing', () => {
  requireArtifacts('src/db/events.ts');

  const findings = sweep();
  const dead = ALLOWLIST.filter(
    (exception) => !findings.some((finding) => covers(exception, finding)),
  );

  assert.deepEqual(
    dead.map((exception) => `${exception.where}${exception.sql === undefined ? '' : ` [${exception.sql}]`}`),
    [],
    'an exception that matches nothing is cover for a query that no longer needs it — delete it (this is how a ticket-412 entry dies on that merge)',
  );
});

test('t414 — every exception states a class and a reason', () => {
  const classes: readonly ExceptionClass[] = [
    'GLOBAL_ID_LOOKUP',
    'SAFE_BY_CORRELATION',
    'GLOBAL_BY_DESIGN',
    'WRITE_PATH_DEFERRED',
  ];

  for (const exception of ALLOWLIST) {
    assert.ok(
      classes.includes(exception.class),
      `${exception.where}: a finding that fits none of the four classes is a bug the gate caught, not a fifth class`,
    );
    assert.ok(
      exception.reason.trim().length > 20,
      `${exception.where}: an exception owes a sentence, not a shrug`,
    );
  }
});
