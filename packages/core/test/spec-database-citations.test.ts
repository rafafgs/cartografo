/**
 * FR11 gate: `entidades-versionamento.md` cites the schema the migrations build (t236).
 *
 * The t229 pass moved this document's DDL and its table/column citations to the
 * English of `glossario-wire.md` §4, and one sentence of §5 stayed behind: it
 * still said the fork's column was `grafo.origem_proposta_id`, of type `INTEGER
 * REFERENCES proposta(id)`, when migration `0019` had renamed all three names.
 * A reader comparing the specification to the database found two schemas.
 *
 * ## The oracle is the database, not a word list
 *
 * The sibling gate `no-portuguese-database.test.ts` reads the glossary and asks
 * of a name in a query: is this Portuguese? That is the wrong question to put to
 * a document which is bilingual ON PURPOSE. Almost everything this file spells
 * in Portuguese, D20 leaves in Portuguese: the prose, the domain vocabulary, the
 * API error codes of the last section, the CHECK-constrained stored values, and
 * the keys of the graph document itself. The line right below the one t236 fixes
 * says `linhagem.origem_proposta_id`, and that one is CORRECT — it is a field of
 * `schema/grafo.schema.json`, not a column, and the whole point of the sentence
 * is that the two surfaces disagree by design.
 *
 * So this sweep asks a different question, and answers it against a database
 * really built by really running `packages/core/migrations/`: where the document
 * speaks about the SCHEMA, does it spell the schema as the schema is? Only
 * positions where a name cannot be anything but a table or a column are read:
 *
 * - **`CREATE TABLE <name>`** and the **`ON <name>`** of a `CREATE INDEX`.
 * - **`REFERENCES <name>(`** — the one that catches the prose, because §5 quotes
 *   a column's SQL type inline rather than in a fenced block.
 * - **A backticked `<table>.<column>`**, and only when BOTH halves resolve: the
 *   prefix has to be a table (today's spelling or one the migrations renamed
 *   away from) and the suffix a column of that table (likewise). That double
 *   condition is what tells `grafo.origem_proposta_id` — a stale citation — from
 *   `grafo.md`, `taxonomia.md`, `dados.motivo` and `grafo_versao.revertida`,
 *   which are a file name, a file name, an event payload key and an event type,
 *   and none of which this ticket touches.
 *
 * What is deliberately NOT swept is the bare, unqualified name: `versao_alvo` in
 * the error table names an API field, `origem_proposta_id` in the fork's request
 * body names a wire field, and deciding which of those is a column takes reading
 * the sentence. The ticket says as much — the citation it fixes is unambiguous
 * precisely because it is qualified and typed.
 *
 * ## Scope
 *
 * One document. `docs/spec/intake.md` §4 has the same kind of leftover in its
 * `trabalho_dependencia` DDL, and `docs/spec/tela-editor-grafo.md` cites
 * `grafo_versao.id`; both are other tickets' files, and widening `SWEPT` is how
 * this gate should grow once they land.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ConnectionModule from '../src/db/connection.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import { MIGRATIONS_DIR, PACKAGE_ROOT, requireArtifacts } from './support.ts';

const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** The document this ticket owns, relative to the repository root. */
const SWEPT = 'docs/spec/entidades-versionamento.md';

/** Every table the migrations build, mapped to the columns it really has. */
type LiveSchema = Map<string, Set<string>>;

/**
 * What the migrations renamed, so a stale citation can be named as such.
 *
 * `table` maps every spelling a table ever had to the one it has today, and
 * `column` does the same per table, keyed by TODAY's table name. Both are read
 * out of the `ALTER TABLE … RENAME` statements themselves rather than declared
 * here: a rename registered in a migration is a rename this sweep knows about on
 * the next run, and the two cannot drift.
 */
interface RenameHistory {
  table: Map<string, string>;
  column: Map<string, Map<string, string>>;
}

async function loadConnection(): Promise<typeof ConnectionModule> {
  requireArtifacts('src/db/connection.ts');
  return (await import(
    new URL('../src/db/connection.ts', import.meta.url).href
  )) as typeof ConnectionModule;
}

async function loadMigrate(): Promise<typeof MigrateModule> {
  requireArtifacts('src/db/migrate.ts');
  return (await import(new URL('../src/db/migrate.ts', import.meta.url).href)) as typeof MigrateModule;
}

/**
 * Runs every migration into a throwaway database and reads the schema back.
 *
 * The database is opened, migrated, read and closed inside this function: what
 * the sweep needs is the answer, not the connection, and holding one open across
 * three tests would only add a teardown to get wrong.
 */
async function buildLiveSchema(): Promise<LiveSchema> {
  const { openDatabase, applyPragmas } = await loadConnection();
  const { migrate } = await loadMigrate();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t236-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  try {
    applyPragmas(db);
    migrate(db, MIGRATIONS_DIR);

    const schema: LiveSchema = new Map();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const columnsOf = db.prepare('SELECT name FROM pragma_table_info(?)');
    for (const { name } of tables) {
      const columns = columnsOf.all(name) as Array<{ name: string }>;
      schema.set(name, new Set(columns.map((column) => column.name)));
    }
    return schema;
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
}

let schemaCache: Promise<LiveSchema> | null = null;

function liveSchema(): Promise<LiveSchema> {
  schemaCache ??= buildLiveSchema();
  return schemaCache;
}

/** `ALTER TABLE t RENAME TO u` and `ALTER TABLE t RENAME COLUMN a TO b`, in one pass. */
const RENAME =
  /^[ \t]*ALTER[ \t]+TABLE[ \t]+(\w+)[ \t]+RENAME[ \t]+(?:COLUMN[ \t]+(\w+)[ \t]+)?TO[ \t]+(\w+)[ \t]*;/gim;

/**
 * Replays the renames of every migration, in the order they really ran.
 *
 * Order is what makes a chain resolve: `0010` renamed `proposta_novo` to
 * `proposta` and `0019` renamed `proposta` to `proposal`, so the first spelling
 * has to end up pointing at the last one and not at the middle.
 */
async function renameHistory(): Promise<RenameHistory> {
  const { listMigrations } = await loadMigrate();
  const table = new Map<string, string>();
  const column = new Map<string, Map<string, string>>();

  for (const migration of listMigrations(MIGRATIONS_DIR)) {
    const body = readFileSync(migration.path, 'utf8');
    for (const [, subject, renamedColumn, target] of body.matchAll(RENAME)) {
      if (renamedColumn === undefined) {
        for (const [was, today] of table) if (today === subject) table.set(was, target);
        table.set(subject, target);
        const columns = column.get(subject);
        if (columns !== undefined) {
          column.delete(subject);
          column.set(target, columns);
        }
        continue;
      }
      const columns = column.get(subject) ?? new Map<string, string>();
      for (const [was, today] of columns) if (today === renamedColumn) columns.set(was, target);
      columns.set(renamedColumn, target);
      column.set(subject, columns);
    }
  }

  return { table, column };
}

const CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
const CREATE_INDEX = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+(\w+)/gi;
const REFERENCE = /\bREFERENCES\s+(\w+)\s*\(/gi;
const QUALIFIED = /`(\w+)\.(\w+)`/g;

/**
 * Every database citation of one document that the migrations contradict.
 *
 * @param document The file's contents.
 * @param live The schema the migrations really build.
 * @param history What the migrations renamed along the way.
 * @returns One `line: what` entry per citation, sorted by line.
 */
export function citationHits(
  document: string,
  live: LiveSchema,
  history: RenameHistory,
): string[] {
  const hits: string[] = [];

  const checkTable = (name: string, at: number, position: string): void => {
    if (live.has(name)) return;
    const today = history.table.get(name);
    hits.push(
      today === undefined
        ? `${at}: ${position} "${name}", which is not a table the migrations build`
        : `${at}: ${position} "${name}"; the migrations call that table "${today}"`,
    );
  };

  document.split('\n').forEach((line, index) => {
    const at = index + 1;

    for (const [, name] of line.matchAll(CREATE_TABLE)) checkTable(name, at, 'CREATE TABLE');
    for (const [, name] of line.matchAll(CREATE_INDEX)) checkTable(name, at, 'CREATE INDEX … ON');
    for (const [, name] of line.matchAll(REFERENCE)) checkTable(name, at, 'REFERENCES');

    for (const [, prefix, suffix] of line.matchAll(QUALIFIED)) {
      const owner = live.has(prefix) ? prefix : history.table.get(prefix);
      if (owner === undefined) continue;
      const columns = live.get(owner);
      if (columns === undefined) continue;

      const field = columns.has(suffix) ? suffix : history.column.get(owner)?.get(suffix);
      if (field === undefined || !columns.has(field)) continue;
      if (prefix === owner && suffix === field) continue;

      hits.push(`${at}: "${prefix}.${suffix}" is "${owner}.${field}" in the database`);
    }
  });

  return hits.sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
}

test('FR11 — every database citation of the spec spells the schema the migrations build', async () => {
  const live = await liveSchema();
  const history = await renameHistory();
  const target = path.join(REPO_ROOT, SWEPT);

  assert.ok(existsSync(target), `${SWEPT} does not exist`);
  assert.ok(live.size > 10, `the migrations built only ${live.size} tables; the sweep has no oracle`);
  assert.ok(
    history.table.size > 5,
    `only ${history.table.size} table renames were parsed; the sweep cannot name a stale citation`,
  );

  const hits = citationHits(readFileSync(target, 'utf8'), live, history);
  assert.deepEqual(hits, [], `${SWEPT} cites a schema the migrations do not build:\n${hits.join('\n')}`);
});

test('FR11 — the sweep bites on a citation the rename left behind', async () => {
  const live = await liveSchema();
  const history = await renameHistory();
  const caught = [
    // The exact sentence of §5 that t236 fixes: stale table AND stale column,
    // plus the stale table of the SQL type quoted right after it.
    '`grafo.origem_proposta_id` é `INTEGER REFERENCES proposta(id)`, e',
    // Half-renamed citations, each of which reads plausible on its own.
    '`graph.origem_proposta_id` chega ao documento como `String(id)`.',
    '`grafo.current_version_id` é o ponteiro da linhagem.',
    // A DDL block that did not follow migration 0019.
    'CREATE TABLE grafo_versao (',
    "CREATE UNIQUE INDEX graph_class_base_unique ON grafo (class) WHERE lineage_type = 'base';",
    '  grafo_id    TEXT NOT NULL REFERENCES grafo(id),',
  ];
  for (const line of caught) {
    assert.ok(
      citationHits(line, live, history).length > 0,
      `the sweep missed a stale database citation: ${line}`,
    );
  }
});

test('FR11 — the sweep does NOT bite on what the document keeps in Portuguese', async () => {
  const live = await liveSchema();
  const history = await renameHistory();
  const allowed = [
    // The very next line of §5: a field of `schema/grafo.schema.json`, not a
    // column, and the reason the sentence above it exists at all.
    '`linhagem.origem_proposta_id` é `string` no `grafo.schema.json` — pensado',
    // A document key and a wire field, both unqualified: out of this sweep.
    '| `origem_proposta_id` não é inteiro positivo | `400` | `origem_proposta_id_invalido` |',
    '| Base sem `versao_corrente_id` (invariante defensivo) | `409` | `grafo_sem_versao_corrente` |',
    // A file name whose stem happens to be a renamed table.
    'o formato está em [`grafo.md` §7](grafo.md) e a taxonomia em `taxonomia.md`.',
    // An event type and an event payload key, neither of them a column.
    '`motivo` espelha `dados.motivo` do evento `grafo_versao.revertida`.',
    // The renamed schema, cited correctly.
    '`graph.origin_proposal_id` é `INTEGER REFERENCES proposal(id)`, e',
    '  origin_proposal_id  INTEGER REFERENCES proposal(id),',
    'CREATE TABLE graph_version (',
    '`graph_version.graph_id`, `proposal.operations` e `proposal.result`.',
  ];
  for (const line of allowed) {
    assert.deepEqual(
      citationHits(line, live, history),
      [],
      `the sweep flagged a name the document keeps on purpose: ${line}`,
    );
  }
});
