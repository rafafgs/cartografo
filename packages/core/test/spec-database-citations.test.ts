/**
 * FR11 gate: four spec documents cite the schema the migrations build (t236, t237).
 *
 * The t229 pass moved these documents' DDL and their table/column citations to
 * the English of `glossario-wire.md` §4, and it walked past three spots. One
 * sentence of `entities-versioning.md` §5 still said the fork's column was
 * `grafo.origem_proposta_id`, of a type quoted as `INTEGER REFERENCES proposta(id)`,
 * when the schema called all three something else (t236). Then the t237 round
 * found two whole DDL blocks: the `runner`/`lease` bodies of
 * `runner-and-controller.md` §1, whose table names were already English and whose
 * every column and two of whose three index names were not, and the
 * `trabalho_dependencia` body of `intake.md` §4. A reader comparing the
 * specification to the database found two schemas.
 *
 * (A backticked span in a comment is how this package quotes a schema name past
 * the D18 gate, and that masking stops at the end of the line — so a quotation
 * long enough to wrap has to be re-wrapped, never split across two lines.)
 *
 * ## The oracle is the database, not a word list
 *
 * The sibling gate `no-portuguese-database.test.ts` reads the glossary and asks
 * of a name in a query: is this Portuguese? That is the wrong question to put to
 * documents which are bilingual ON PURPOSE. Almost everything they spell in
 * Portuguese, D20 leaves in Portuguese: the prose, the domain vocabulary, the
 * API error codes, the route paths, and the keys of the graph document itself.
 * The line right below the one t236 fixes
 * says `linhagem.origem_proposta_id`, and that one is CORRECT — it is a field of
 * `schema/grafo.schema.json`, not a column, and the whole point of the sentence
 * is that the two surfaces disagree by design.
 *
 * So this sweep asks a different question, and answers it against a database
 * really built by really running `packages/core/migrations/`: where a document
 * speaks about the SCHEMA, does it spell the schema as the schema is? Only
 * positions where a name cannot be anything but a table, a column or an index
 * are read:
 *
 * - **`CREATE TABLE <name>`** and the **`ON <name>`** of a `CREATE INDEX`.
 * - **The NAME of a `CREATE INDEX`.** An index name is not derived from anything
 *   — a cited one is either an index the migrations really build or one nothing
 *   builds.
 * - **`REFERENCES <name>(`** — the one that catches the prose, because §5 of
 *   `entities-versioning.md` quotes a column's SQL type inline rather than
 *   in a fenced block.
 * - **Inside the body of a `CREATE TABLE`** whose table resolves, a word that
 *   the migrations renamed away from on THAT table. It reads the column
 *   declaration and the `CHECK` that cites the same column a second time, and
 *   the "renamed away from" is what keeps it from being a word list: a name the
 *   glossary never retired is not a hit, because a specification is allowed to
 *   describe a column before a migration builds it. Quoted runs and the `--`
 *   tail of a line are blanked first — a stored value is not a citation of a
 *   name (`no-portuguese-database.test.ts` is the gate that reads those), and a
 *   trailing comment is prose.
 * - **A backticked `<table>.<column>`**, and only when BOTH halves resolve: the
 *   prefix has to be a table (today's spelling or one the migrations renamed
 *   away from) and the suffix a column of that table (likewise). That double
 *   condition is what tells `grafo.origem_proposta_id` — a stale citation — from
 *   `graph.md`, `taxonomia.md`, `dados.motivo` and `linhagem.tipo`, which are a
 *   file name, a file name, an event payload key and a key of the graph
 *   document, and none of which this gate touches.
 *
 * ## What is deliberately NOT swept
 *
 * **The bare, unqualified name.** `versao_alvo` in the error table of
 * `entities-versioning.md` names an API field and `origem_proposta_id` in
 * the fork's request body names a wire field, so deciding which of those is a
 * column takes reading the sentence. `human-escalation.md` §8 is the proof that
 * this is caution and not squeamishness: it cites `auto_aprovavel`, a wire field
 * that stays, four lines before it cited `no_id`, a column that had to move
 * (t237) — indistinguishable to any rule that only looks at the word. That one
 * was fixed by hand, and this gate does not hold it.
 *
 * **The event type.** `trabalho.bloqueado` in `intake.md` §4 carries a table's
 * old name on the left and a column's old name on the right and is neither: it
 * names an event, which the glossary maps on its own `events` surface and whose
 * citations belong to another child of D20. Those names are read out of the
 * glossary here and skipped, so this gate never asks a document to fix a
 * citation it does not own.
 *
 * ## Scope
 *
 * Every specification: `docs/spec/*.md`, `docs/formatos/*.md` and
 * `docs/o-que-e-o-cartografo.md`. It started as four documents — the one t236
 * owned plus the three the t237 round found — and t231 took the growth path
 * this paragraph used to describe, which was to widen `SWEPT` once
 * `screen-graph-editor.md`'s `grafo_versao.id` had a ticket of its own.
 *
 * `glossario-wire.md` is the one document of that set left out, and it is the
 * exception that proves the rule: a map FROM the retired names TO the ones that
 * replaced them is written, cell by cell, in retired names. Sweeping it would
 * ask the glossary to stop being a glossary. Its sibling gate
 * `glossario-wire-docs.test.ts` leaves it out for the same reason.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ConnectionModule from '../src/db/connection.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import { databaseNameRows } from './glossary-terms.ts';
import { MIGRATIONS_DIR, PACKAGE_ROOT, requireArtifacts } from './support.ts';

const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** Where the event names live, so a dotted span can be told from a citation. */
const GLOSSARY = 'docs/spec/glossario-wire.md';

/**
 * The documents this gate owns, relative to the repository root.
 *
 * Read off the disk instead of listed, so a specification added tomorrow is
 * swept without anyone remembering to come here.
 */
function swept(): string[] {
  const documents = [
    ...['docs/spec', 'docs/formatos'].flatMap((directory) =>
      readdirSync(path.join(REPO_ROOT, directory))
        .filter((entry) => entry.endsWith('.md'))
        .sort()
        .map((entry) => `${directory}/${entry}`),
    ),
    'docs/o-que-e-o-cartografo.md',
  ];
  return documents.filter((relative) => relative !== GLOSSARY);
}

/** The glossary surface that owns those names (§2.1). */
const EVENT_SURFACE = 'events';

/**
 * What the schema renamed away from, so a stale citation can be named as such.
 *
 * `table` maps every spelling a table ever had to the one it has today, and
 * `column` does the same per table, keyed by TODAY's table name. Neither is
 * declared here — they come from two sources that cannot drift from the tree:
 *
 * - **The glossary's `database` rows.** This is where the D20 vocabulary lives,
 *   and since t235 it is the ONLY place it lives: that ticket rewrote
 *   `0001`–`0018` so the schema is born English and deleted the `0019` whose
 *   `ALTER … RENAME` statements this sweep used to read. A retired name is now a
 *   `today` cell whose `becomes` cell really is a table, or really is a column
 *   of the table being read — which is the same question the `ALTER` answered,
 *   asked of the document that decided the rename in the first place.
 * - **The `ALTER TABLE … RENAME` still in the sequence.** `0010` rebuilds
 *   `proposal` through a `proposal_new`, and a spelling a migration really does
 *   move stays known here without anyone listing it.
 */
interface RenameHistory {
  table: Map<string, string>;
  column: Map<string, Map<string, string>>;
}

/**
 * Everything a citation is read against, all of it derived from the repository.
 *
 * Nothing here is a declared list: the tables, their columns and the index names
 * come from a database the migrations really built, the retired spellings from
 * the glossary's `database` rows read against that schema, and the event names
 * from the glossary's `events` rows.
 */
interface Oracle {
  /** Every table the migrations build, mapped to the columns it really has. */
  tables: Map<string, Set<string>>;
  /** Every index the migrations build, by name. */
  indexes: Set<string>;
  /** What the migrations renamed along the way. */
  renamed: RenameHistory;
  /** Every dotted name the glossary's `events` surface registers, old and new. */
  events: Set<string>;
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
 *
 * @returns The tables with their columns, and the names of the indexes.
 */
async function buildLiveSchema(): Promise<Pick<Oracle, 'tables' | 'indexes'>> {
  const { openDatabase, applyPragmas } = await loadConnection();
  const { migrate } = await loadMigrate();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t236-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  try {
    applyPragmas(db);
    migrate(db, MIGRATIONS_DIR);

    const tables = new Map<string, Set<string>>();
    const named = db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name");
    const columnsOf = db.prepare('SELECT name FROM pragma_table_info(?)');
    for (const { name } of named.all('table') as Array<{ name: string }>) {
      const columns = columnsOf.all(name) as Array<{ name: string }>;
      tables.set(name, new Set(columns.map((column) => column.name)));
    }

    const indexes = new Set(
      (named.all('index') as Array<{ name: string }>).map((entry) => entry.name),
    );
    return { tables, indexes };
  } finally {
    db.close();
    rmSync(base, { recursive: true, force: true });
  }
}

/** `ALTER TABLE t RENAME TO u` and `ALTER TABLE t RENAME COLUMN a TO b`, in one pass. */
const RENAME =
  /^[ \t]*ALTER[ \t]+TABLE[ \t]+(\w+)[ \t]+RENAME[ \t]+(?:COLUMN[ \t]+(\w+)[ \t]+)?TO[ \t]+(\w+)[ \t]*;/gim;

/**
 * Every spelling the schema retired, read off the glossary and off the sequence.
 *
 * The glossary half asks the live schema which side of a row is real: a
 * `becomes` cell that names a table registers the `today` cell as that table's
 * old name, and a `becomes` cell that names a column of table T registers it as
 * T's old name for that column. Reading it per table is what keeps the three
 * meanings of `tipo` apart without this file re-deciding which is which —
 * `evento.tipo` lands on `event.type`, `pergunta.tipo` on `input_request.kind`
 * and `credencial.tipo` on `credential.owner_type`, because those are the tables
 * that really have those columns.
 *
 * The `ALTER` half is replayed in migration order, which is what makes a chain
 * resolve when one exists.
 *
 * @param tables The live schema: what a name has to be to count as one.
 */
async function renameHistory(tables: Map<string, Set<string>>): Promise<RenameHistory> {
  const { listMigrations } = await loadMigrate();
  const table = new Map<string, string>();
  const column = new Map<string, Map<string, string>>();

  for (const row of databaseNameRows()) {
    if (tables.has(row.english)) table.set(row.term, row.english);
    for (const [name, columns] of tables) {
      if (!columns.has(row.english) || columns.has(row.term)) continue;
      const known = column.get(name) ?? new Map<string, string>();
      known.set(row.term, row.english);
      column.set(name, known);
    }
  }

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

/**
 * Every dotted name the glossary registers on the `events` surface.
 *
 * Both cells of the row are taken — the retired spelling and the one that
 * replaced it — because a document may still be standing on either, and neither
 * is a database citation.
 */
function eventNames(): Set<string> {
  const glossary = path.join(REPO_ROOT, GLOSSARY);
  assert.ok(existsSync(glossary), `${GLOSSARY} does not exist`);
  const names = new Set<string>();

  for (const line of readFileSync(glossary, 'utf8').split('\n')) {
    const row = line.trim();
    if (!row.startsWith('|')) continue;
    const cells = row.slice(1).split('|').map((cell) => cell.replace(/`/g, '').trim());
    if (cells[0] !== EVENT_SURFACE) continue;

    for (const cell of [cells[1] ?? '', cells[2] ?? '']) {
      for (const spelling of cell.split(' / ')) {
        const name = spelling.trim();
        if (name.includes('.')) names.add(name);
      }
    }
  }

  return names;
}

let oracleCache: Promise<Oracle> | null = null;

async function buildOracle(): Promise<Oracle> {
  const { tables, indexes } = await buildLiveSchema();
  return { tables, indexes, renamed: await renameHistory(tables), events: eventNames() };
}

function oracle(): Promise<Oracle> {
  oracleCache ??= buildOracle();
  return oracleCache;
}

const CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
const CREATE_INDEX = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)/gi;
const REFERENCE = /\bREFERENCES\s+(\w+)\s*\(/gi;
const QUALIFIED = /`(\w+)\.(\w+)`/g;

/** A `CREATE TABLE` that opens a body, its closing line, and a fence that ends one. */
const OPENS_BODY = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/i;
const CLOSES_BODY = /^\s*\)\s*;/;
const FENCE = /^\s*```/;

/** A word in a DDL body: a column name, a type keyword or a bare SQL keyword. */
const WORD = /[A-Za-z_]\w*/g;

/** Drops what a DDL body says that is not a declaration: stored values, comments. */
function declarationOnly(line: string): string {
  return line.replace(/'[^']*'/g, '').replace(/--.*$/, '');
}

/**
 * Every database citation of one document that the migrations contradict.
 *
 * @param document The file's contents.
 * @param seen The schema, the renames and the event names to read it against.
 * @returns One `line: what` entry per citation, sorted by line.
 */
export function citationHits(document: string, seen: Oracle): string[] {
  const hits: string[] = [];

  const checkTable = (name: string, at: number, position: string): void => {
    if (seen.tables.has(name)) return;
    const today = seen.renamed.table.get(name);
    hits.push(
      today === undefined
        ? `${at}: ${position} "${name}", which is not a table the migrations build`
        : `${at}: ${position} "${name}"; the migrations call that table "${today}"`,
    );
  };

  /** Today's name of the table whose `CREATE TABLE` body this line is inside. */
  let body: string | null = null;

  /** The table a `CREATE TABLE` line opens a body for, when the sweep knows it. */
  const openedBy = (line: string): string | null => {
    const opened = OPENS_BODY.exec(line);
    if (opened === null) return null;
    const cited = opened[1];
    const owner = seen.tables.has(cited) ? cited : seen.renamed.table.get(cited);
    return owner !== undefined && seen.tables.has(owner) ? owner : null;
  };

  document.split('\n').forEach((line, index) => {
    const at = index + 1;

    for (const [, name] of line.matchAll(CREATE_TABLE)) checkTable(name, at, 'CREATE TABLE');
    for (const [, name, table] of line.matchAll(CREATE_INDEX)) {
      checkTable(table, at, 'CREATE INDEX … ON');
      if (!seen.indexes.has(name)) {
        hits.push(`${at}: CREATE INDEX "${name}", which is not an index the migrations build`);
      }
    }
    for (const [, name] of line.matchAll(REFERENCE)) checkTable(name, at, 'REFERENCES');

    for (const [, prefix, suffix] of line.matchAll(QUALIFIED)) {
      if (seen.events.has(`${prefix}.${suffix}`)) continue;
      const owner = seen.tables.has(prefix) ? prefix : seen.renamed.table.get(prefix);
      if (owner === undefined) continue;
      const columns = seen.tables.get(owner);
      if (columns === undefined) continue;

      const field = columns.has(suffix) ? suffix : seen.renamed.column.get(owner)?.get(suffix);
      if (field === undefined || !columns.has(field)) continue;
      if (prefix === owner && suffix === field) continue;

      hits.push(`${at}: "${prefix}.${suffix}" is "${owner}.${field}" in the database`);
    }

    if (body !== null) {
      const columns = seen.tables.get(body) ?? new Set<string>();
      const renamed = seen.renamed.column.get(body);
      for (const [word] of declarationOnly(line).matchAll(WORD)) {
        const today = renamed?.get(word);
        if (today === undefined || today === word || !columns.has(today)) continue;
        hits.push(
          `${at}: "${word}" in the body of "${body}"; the migrations call that column "${today}"`,
        );
      }
    }

    if (FENCE.test(line)) body = null;
    else if (OPENS_BODY.test(line)) body = openedBy(line);
    else if (body !== null && CLOSES_BODY.test(line)) body = null;
  });

  return hits.sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
}

test('FR11 — every database citation of the specs spells the schema the migrations build', async () => {
  const seen = await oracle();

  assert.ok(
    seen.tables.size > 10,
    `the migrations built only ${seen.tables.size} tables; the sweep has no oracle`,
  );
  assert.ok(
    seen.indexes.size > 10,
    `the migrations built only ${seen.indexes.size} indexes; the sweep cannot read an index name`,
  );
  assert.ok(
    seen.renamed.table.size > 5,
    `only ${seen.renamed.table.size} table renames were parsed; the sweep cannot name a stale citation`,
  );
  assert.ok(
    seen.events.size > 10,
    `only ${seen.events.size} event names were parsed; the sweep would read one as a citation`,
  );

  const documents = swept();
  assert.ok(
    documents.length > 15,
    `the sweep found only ${documents.length} documents; it is not walking the specs`,
  );

  const hits = documents.flatMap((relative) => {
    const target = path.join(REPO_ROOT, relative);
    assert.ok(existsSync(target), `${relative} does not exist`);
    return citationHits(readFileSync(target, 'utf8'), seen).map((hit) => `${relative}:${hit}`);
  });

  assert.deepEqual(
    hits,
    [],
    `a specification cites a schema the migrations do not build:\n${hits.join('\n')}`,
  );
});

test('FR11 — the sweep bites on a citation the rename left behind', async () => {
  const seen = await oracle();
  const caught = [
    // The exact sentence of §5 that t236 fixes: stale table AND stale column,
    // plus the stale table of the SQL type quoted right after it.
    '`grafo.origem_proposta_id` é `INTEGER REFERENCES proposta(id)`, e',
    // Half-renamed citations, each of which reads plausible on its own.
    '`graph.origem_proposta_id` chega ao documento como `String(id)`.',
    '`grafo.current_version_id` é o ponteiro da linhagem.',
    // A DDL block written against the schema before D20's database children.
    'CREATE TABLE grafo_versao (',
    "CREATE UNIQUE INDEX graph_class_base_unique ON grafo (class) WHERE lineage_type = 'base';",
    '  grafo_id    TEXT NOT NULL REFERENCES grafo(id),',
    // A body whose table name was already English and whose columns were not:
    // the block of `runner-and-controller.md` §1 that t237 fixes.
    'CREATE TABLE lease (\n  trabalho_id  INTEGER NOT NULL,\n  expira_em    TEXT NOT NULL\n);',
    // The same block's index, which the sequence builds under another name.
    'CREATE INDEX idx_lease_projeto_status ON lease (projeto_id, status);',
    // A table constraint, which cites the columns of the body a second time.
    'CREATE TABLE job_dependency (\n  CHECK (trabalho_id != depende_de_trabalho_id)\n);',
  ];
  for (const line of caught) {
    assert.ok(
      citationHits(line, seen).length > 0,
      `the sweep missed a stale database citation: ${line}`,
    );
  }
});

test('FR11 — the sweep does NOT bite on what the documents keep in Portuguese', async () => {
  const seen = await oracle();
  const allowed = [
    // The very next line of §5: a field of `schema/grafo.schema.json`, not a
    // column, and the reason the sentence above it exists at all.
    '`linhagem.origem_proposta_id` é `string` no `grafo.schema.json` — pensado',
    // A document key and a wire field, both unqualified: out of this sweep.
    '| `origem_proposta_id` não é inteiro positivo | `400` | `origem_proposta_id_invalido` |',
    '| Base sem `versao_corrente_id` (invariante defensivo) | `409` | `grafo_sem_versao_corrente` |',
    // A file name whose stem happens to be a renamed table.
    'o formato está em [`graph.md` §7](graph.md) e a taxonomia em `taxonomia.md`.',
    // An event type and an event payload key, neither of them a column.
    '`motivo` espelha `dados.motivo` do evento `grafo_versao.revertida`.',
    // An event whose two halves both resolve as schema and are still an event.
    '**Declarar não bloqueia.** Nenhum `trabalho.bloqueado` nasce daqui.',
    // The renamed schema, cited correctly.
    '`graph.origin_proposal_id` é `INTEGER REFERENCES proposal(id)`, e',
    '  origin_proposal_id  INTEGER REFERENCES proposal(id),',
    'CREATE TABLE graph_version (',
    '`graph_version.graph_id`, `proposal.operations` e `proposal.result`.',
    // The body of §1 as the migrations really build it, and the index it kept.
    'CREATE TABLE lease (\n  job_id  INTEGER NOT NULL,\n  expires_at  TEXT NOT NULL\n);',
    'CREATE INDEX idx_lease_runner_status ON lease (runner_id, status);',
    // A trailing comment inside a body, naming the word a column is named after.
    'CREATE TABLE graph (\n  id  TEXT PRIMARY KEY,  -- classe, para a linhagem base (D8)\n);',
    // A stored value inside a body: this sweep reads NAMES, and the value is
    // `no-portuguese-database.test.ts`'s to judge.
    "CREATE TABLE proposal (\n  status  TEXT NOT NULL DEFAULT 'pending'\n);",
  ];
  for (const line of allowed) {
    assert.deepEqual(
      citationHits(line, seen),
      [],
      `the sweep flagged a name the documents keep on purpose: ${line}`,
    );
  }
});
