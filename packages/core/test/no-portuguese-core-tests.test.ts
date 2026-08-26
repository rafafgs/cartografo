/**
 * D24's last layer for this package: no Portuguese in `packages/core/test/**`.
 *
 * The third and last of the split t312 was cut into on 2026-08-25, along the
 * package boundary. t309 lifted the t180 exemption over `packages/runner`'s
 * `src/`, `scripts/` and `bin/`; t312 followed it into that package's `test/`
 * and built `no-portuguese-runner-tests.test.ts`, whose design this file
 * copies. Both halves landed with the same lesson written on them, and it is
 * the reason AT2 exists: **a diacritic grep is a floor, not a checklist**.
 *
 * This package's floor was 35 files and 428 diacritics, measured live the day
 * the ticket was refined and again the day it was implemented. The stopword
 * pass below found Portuguese in 12 more files that carry no accent at all —
 * `ficha` used as a loanword for "ticket" (`domain-graph-contracts.test.ts:4`,
 * `no-leaked-row-keys.test.ts:16` and eleven others), a corrupt-database
 * fixture whose bytes spell a Portuguese sentence (`health.test.ts:101`), a
 * type-refusal fixture (`domain-graph.test.ts:511`) and a pair of invalid-URL
 * fixtures (`webhooks-routes.test.ts:106-107`). None of the twelve is visible
 * to AT1, and every one of them is Portuguese.
 *
 * ## The two sweeps
 *
 * - **AT1, the diacritics.** A whole-file pass. Cheap, exact, and blind to
 *   half the problem.
 * - **AT2, the plain-ASCII Portuguese.** The closed-stopword method the
 *   package's own `no-portuguese-user-facing-strings.test.ts` uses, over the
 *   whole file rather than over its literals. Seeded from the runner gate's
 *   list and grown by the content words this package actually carried.
 *
 * ## Why the five language gates are never scanned
 *
 * `no-portuguese-database.test.ts`, `no-portuguese-glossary-prose.test.ts`,
 * `no-portuguese-identifiers.test.ts`, `no-portuguese-user-facing-strings.test.ts`
 * and `no-portuguese-wire.test.ts` are Portuguese ON PURPOSE: each one is built
 * out of the forbidden vocabulary it refuses, and a sweep that read them would
 * fail on the evidence. This file is the sixth for the same reason —
 * {@link STOPWORDS} below is a list of Portuguese words.
 *
 * **This set is this ticket's own verification, not a permanent gate.** The
 * canonical guards still exclude `test/`, and folding this scope into them
 * belongs to t314, which owns the repo-wide gate. Until then these sweeps are
 * a cheap regression check, and deleting them when that ticket subsumes them
 * costs nothing.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const TEST_ROOT = path.resolve(import.meta.dirname);

/** What counts as a test artifact here: the suites, their helpers, their data. */
const SCANNED_EXTENSION = /\.(?:ts|md)$/;

/** Portuguese by construction, and therefore never scanned. */
const SELF_AND_GATES: ReadonlySet<string> = new Set([
  'no-portuguese-core-tests.test.ts',
  'no-portuguese-database.test.ts',
  'no-portuguese-glossary-prose.test.ts',
  'no-portuguese-identifiers.test.ts',
  'no-portuguese-user-facing-strings.test.ts',
  'no-portuguese-wire.test.ts',
]);

/**
 * Every test artifact of the package, in path order.
 *
 * A walk and not a list, for the reason t309 wrote down when it replaced the
 * package guard's `SCANNED_FILES`: a list records the files that existed the
 * day somebody wrote it, and a directory cannot forget to add itself. That is
 * what carries `fixtures/` (FR8) without naming it.
 *
 * @returns Paths relative to `test/`, sorted, directories walked depth-first.
 */
export function scannedFiles(): string[] {
  const found: string[] = [];

  function walk(relative: string): void {
    const here = relative === '' ? TEST_ROOT : path.join(TEST_ROOT, relative);
    for (const entry of readdirSync(here).sort()) {
      const next = relative === '' ? entry : `${relative}/${entry}`;
      if (statSync(path.join(TEST_ROOT, next)).isDirectory()) walk(next);
      else if (SCANNED_EXTENSION.test(entry) && !SELF_AND_GATES.has(next)) found.push(next);
    }
  }

  walk('');
  return found;
}

/**
 * Lines excused from both sweeps, by line, each with the reason it is excused.
 *
 * Pinned by line and not by shape, for the reason the package guard's own pin
 * lists are: what excuses a line is INTENT, and no regular expression encodes
 * intent. A line that moves breaks this list loudly, and somebody re-reads the
 * exception instead of inheriting it — which is the whole point.
 */
const OUT_OF_SCOPE: ReadonlyArray<{ file: string; line: number; reason: string }> = Object.freeze([
  {
    file: 'sessions.test.ts',
    line: 365,
    reason: 'a route D18 RETIRED, asserted to answer 404; translating it would prove a route that never existed is gone',
  },
  {
    file: 'sessions.test.ts',
    line: 366,
    reason: 'the same retired route, on the read verb',
  },
  {
    file: 'sessions.test.ts',
    line: 367,
    reason: 'the retired finish route, spelled the way D18 retired it',
  },
  {
    file: 'sessions.test.ts',
    line: 1822,
    reason: "the input property of the bets red-team gate at 1.0.0; the fixture's own docstring pins that version's names on purpose",
  },
  {
    file: 'input-requests.test.ts',
    line: 119,
    reason: '`src/repositories/input-request.ts:265` WRITES this block reason; the assertion has to spell it the way the control plane does',
  },
  {
    file: 'input-requests.test.ts',
    line: 152,
    reason: 'the same block reason, handed to the block route',
  },
  {
    file: 'input-requests.test.ts',
    line: 482,
    reason: 'a route D18 RETIRED, asserted to answer 404',
  },
  {
    file: 'input-requests.test.ts',
    line: 897,
    reason: 'the same block reason `src/repositories/input-request.ts:265` writes, read back off the projection',
  },
  {
    file: 'input-requests.test.ts',
    line: 916,
    reason: 'the same block reason, in the event payload',
  },
  {
    file: 'proposal-routes.test.ts',
    line: 14,
    reason: 'an English sentence that QUOTES the frozen hypothesis keys `src/routes/proposals.ts:744-745` names',
  },
  {
    file: 'proposal-routes.test.ts',
    line: 16,
    reason: 'the same sentence, listing the rest of the frozen shape',
  },
  {
    file: 'proposal-routes.test.ts',
    line: 939,
    reason: 'an English sentence that quotes the wire key it asserts on, the way `src/repositories/proposals.ts:548` spells it',
  },
]);

/** Any of these means the line around it is Portuguese. */
const DIACRITICS = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;

/**
 * Plain-ASCII Portuguese, closed and short.
 *
 * Two groups. The first is the runner gate's list, carried over whole: function
 * words a Portuguese sentence cannot avoid, plus the content words t312, t318,
 * t319 and t321 measured in their own package. The second is this package's,
 * and every word in it was measured in a file this ticket translated rather
 * than imagined — `com`, `duas`, `qual` and `isto` are the function words the
 * runner's list happened not to need; the rest are the vocabulary of this
 * package's fixtures (a report, a check, a source, a project, a class).
 *
 * The accent-less spellings of accented words (`migracao`, `revisao`,
 * `afirmacao`) are here for the same reason the runner's `execucao` is: they
 * never fired during this ticket, because every live instance carried its
 * accent and AT1 saw it. They are a guard against the next person typing the
 * word without one.
 *
 * A closed list only catches what somebody has seen before, which is exactly
 * why AT1 runs beside it rather than instead of it.
 */
const STOPWORDS: readonly string[] = Object.freeze([
  // the runner gate's list (t312, t318, t319, t321), carried over whole
  'nao',
  'uma',
  'uns',
  'umas',
  'que',
  'dos',
  'das',
  'pelo',
  'pela',
  'pelos',
  'quando',
  'porque',
  'entao',
  'ainda',
  'apenas',
  'sem',
  'ser',
  'foi',
  'era',
  'esta',
  'este',
  'essa',
  'esse',
  'isso',
  'aqui',
  'cada',
  'outro',
  'outra',
  'mesmo',
  'mesma',
  'seja',
  'sejam',
  'deve',
  'devia',
  'pode',
  'podia',
  'precisa',
  'existe',
  'nenhum',
  'nenhuma',
  'nada',
  'tudo',
  'quem',
  'quais',
  'onde',
  'como',
  'sobre',
  'depois',
  'antes',
  'entre',
  'durante',
  'desde',
  'muito',
  'todo',
  'toda',
  'todos',
  'todas',
  'qualquer',
  'alguns',
  'algumas',
  'ninguem',
  'nunca',
  'talvez',
  'dele',
  'dela',
  'seus',
  'suas',
  'minha',
  'nosso',
  'nossa',
  'vai',
  'vao',
  'veio',
  'foram',
  'sera',
  'serao',
  'estao',
  'estava',
  'sendo',
  'tem',
  'ter',
  'tinha',
  'havia',
  'faz',
  'fazer',
  'feito',
  'feita',
  'fez',
  'ler',
  'leu',
  'lido',
  'diz',
  'disse',
  'escreve',
  'escrever',
  'escreveu',
  'escrito',
  'desbloqueie',
  'bancos',
  'opcional',
  'obrigatorio',
  'arquivo',
  'arquivos',
  'linha',
  'linhas',
  'sessoes',
  'travessia',
  'trabalho',
  'grafo',
  'aresta',
  'arestas',
  'ficha',
  'etapa',
  'etapas',
  'portao',
  'declaracao',
  'permissao',
  'permissoes',
  'execucao',
  'renumerar',
  'manter',
  'primeira',
  'segunda',
  'parte',
  'partes',
  'da',
  'fim',
  'caso',
  'teste',
  'aguardando',
  'resposta',
  'pergunta',
  'inicial',
  'principal',
  'experimento',
  'colisao',
  'sobra',
  'tese',
  // t315: the vocabulary this package's own fixtures carried
  //
  // Function words first — the four the runner's list never needed — then the
  // content words. A report, a check, a source, a class, a project: the nouns a
  // fixture of this package reaches for when it invents a job, a node
  // description or a block reason.
  'com',
  'duas',
  'qual',
  'assim',
  'isto',
  'hoje',
  'algo',
  'banco',
  'bom',
  'checagem',
  'citada',
  'classe',
  'comando',
  'confere',
  'confirme',
  'contra',
  'cria',
  'declara',
  'esperando',
  'evidencia',
  'fonte',
  'lixo',
  'nova',
  'novo',
  'parou',
  'passa',
  'projeto',
  'prosa',
  'queda',
  'roda',
  'rodada',
  'tema',
  'vazia',
  'vazio',
  'velho',
  // the accent-less spellings of the accented words this ticket removed
  'afirmacao',
  'codigo',
  'conexao',
  'confirmacao',
  'faca',
  'indisponivel',
  'migracao',
  'nucleo',
  'observacao',
  'pagina',
  'premissa',
  'principio',
  'projecao',
  'propria',
  'redacao',
  'reindexando',
  'relatorio',
  'renomear',
  'revisao',
  'saida',
  'superficie',
  'taxonomia',
  'telemetria',
  'trimestral',
]);

/**
 * Wire tokens this ticket keeps, and this sweep must not fire on.
 *
 * `sempre` is the `condition` a single-exit edge carries, documented at
 * `docs/spec/graph.md:547` and frozen as an example in
 * `schema/graph.schema.json:378`; `resultado` is the routing key t269 named,
 * with `aprovado` and `retrabalho` as its values, in the same schema line; and
 * `para` is a required key of an edge and of `metrica_esperada`, which the
 * package guard freezes in its own `WIRE_LITERALS` for the same reason. None of
 * the four is a stopword today, and all four are masked anyway: the point of a
 * kept token is that it stays kept when somebody widens the list above.
 *
 * Built from a list of strings rather than written as a regex literal: a
 * literal is CODE, and `no-portuguese-identifiers.test.ts` — which does scan
 * `test/` — reads these as Portuguese identifiers there. Inside a string they
 * are masked.
 */
const PROTOCOL_TOKENS = new RegExp(
  `\\b(?:${['sempre', 'para', 'resultado', 'aprovado', 'retrabalho'].join('|')})\\b`,
  'g',
);

/**
 * Wire keys still spelled in Portuguese, masked ONLY where they are a key.
 *
 * A whole-file sweep cannot tell `depois: 0.1` — the frozen hypothesis field
 * `src/routes/proposals.ts:744` reads off the body — from `depois da queda`,
 * which is a Portuguese sentence in a fixture title. The difference is
 * POSITION, and position is something a regex can see: a key is followed by a
 * colon and a value is not. So the mask below blanks these six words when they
 * head a property and leaves them alone everywhere else, which is why
 * `merge_commit: 'depois'` still goes red — the value there is prose that
 * happens to be one word long.
 *
 * Each of the six is a name the source really writes:
 *
 * - `antes`, `depois` — `src/repositories/proposals.ts:548-549` declares both
 *   on the hypothesis outcome, and `src/routes/proposals.ts:750-751` reads
 *   `execucao_id`/`depois` off the request body. The header of that route file
 *   calls the vocabulary frozen (FR5) in so many words.
 * - `fonte`, `observacao` — the two halves of an `evidencia` payload:
 *   `packages/runner/src/surveyor/proposal.ts:131` declares
 *   `FlowEvidence.fonte`, and `docs/spec/screen-graph-editor.md:74` documents
 *   `{"fonte": …, "observacao": …}` as what the graph screen sends.
 * - `pergunta`, `resposta` — the two keys of every entry of
 *   `input.perguntas_respondidas`, built by `src/domain/context.ts:266-267`
 *   and by `src/routes/jobs.ts:127-128`.
 *
 * Built from a list of strings rather than written as a regex literal, for the
 * reason {@link PROTOCOL_TOKENS} is.
 */
const WIRE_KEYS = new RegExp(
  `\\b(?:${['antes', 'depois', 'fonte', 'observacao', 'pergunta', 'resposta'].join('|')})\\s*:`,
  'g',
);

/**
 * Node and skill ids this repository reuses as illustration, everywhere.
 *
 * `triagem` is the one that needs saying: it is the entry node of the
 * asymmetric-bets graph, spelled that way in `schema/graph.schema.json:95`,
 * `docs/spec/graph.md:97-99` and `factory-graphs/asymmetric-bets/`, and it is
 * also a word the runner's stopword list has. The other ids of the same family
 * — `redigir`, `revisar`, `implementar`, `conferir`, `publicar`, `entrada`,
 * `coleta-fundamentos` — are not words either list has, and the kebab ones are
 * blanked by {@link MACHINE_NAMES} before AT2 reads the line.
 *
 * The argument for leaving the family alone is t312's, and this ticket's FR6
 * repeats it: the convention is shared with `schema/examples/`, `docs/spec/`,
 * `packages/screen/test/` and `packages/test-support/`, and translating only
 * this package's copy splits one convention into two spellings instead of
 * finishing it.
 */
const ILLUSTRATIVE_IDS = new RegExp(`\\b(?:${['triagem'].join('|')})\\b`, 'g');

/**
 * Shapes that are a machine name rather than a word of prose.
 *
 * Narrow on purpose. The package guard can afford to blank every quoted span
 * because it reads one literal at a time and already knows the literal is a
 * message; a whole-file pass has no such context, and blanking quotes here
 * would hide exactly the Portuguese test data this ticket exists to remove. So
 * only the shapes that cannot be a Portuguese sentence are masked:
 * `snake_case` (`criterios_de_aceite`, `metrica_esperada`), `kebab-case`
 * (`nota-curta`, `grafo-proposto`), dotted paths (`nota.md`,
 * `trabalho.criado`) and the flags a person types.
 */
const MACHINE_NAMES: readonly RegExp[] = Object.freeze([
  // a dotted name written into a regex literal: `\.grafo\.rascunho\.json`
  /(?:\\\.[A-Za-z0-9_]+)+/g,
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)+\b/g,
  /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g,
  /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g,
  /--?[A-Za-z][A-Za-z0-9-]*/g,
]);

/** Replaces a span with same-length blanks, so no offset shifts under it. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * The Portuguese words of one line, if any, once the machine names are gone.
 *
 * @param text One raw line of a scanned file.
 * @returns Every offending token found, or an empty list.
 */
export function offendersIn(text: string): string[] {
  let masked = text
    .replace(WIRE_KEYS, blank)
    .replace(PROTOCOL_TOKENS, blank)
    .replace(ILLUSTRATIVE_IDS, blank);
  for (const span of MACHINE_NAMES) masked = masked.replace(span, blank);

  const offenders: string[] = [];
  for (const word of STOPWORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(masked)) offenders.push(word);
  }
  return offenders;
}

/** The lines of one file that a sweep flags, as `file:line — token — text`. */
function hitsInFile(relative: string, flag: (text: string) => string | null): string[] {
  const source = readFileSync(path.join(TEST_ROOT, relative), 'utf8');
  const excused = new Set(
    OUT_OF_SCOPE.filter((entry) => entry.file === relative).map((entry) => entry.line),
  );
  return source.split('\n').flatMap((text, index) => {
    const line = index + 1;
    if (excused.has(line)) return [];
    const found = flag(text);
    if (found === null) return [];
    return [`${relative}:${line} — ${found} — ${text.trim().slice(0, 120)}`];
  });
}

test('t315 — AT1: no Portuguese diacritic survives in packages/core/test', () => {
  const hits = scannedFiles().flatMap((file) =>
    hitsInFile(file, (text) => DIACRITICS.exec(text)?.[0] ?? null),
  );

  assert.deepEqual(
    hits,
    [],
    `Portuguese diacritics still in the tests (t315, AT1):\n${hits.join('\n')}`,
  );
});

test('t315 — AT2: no plain-ASCII Portuguese survives in packages/core/test', () => {
  const hits = scannedFiles().flatMap((file) =>
    hitsInFile(file, (text) => {
      const offenders = offendersIn(text);
      return offenders.length === 0 ? null : offenders.join(', ');
    }),
  );

  assert.deepEqual(hits, [], `Portuguese words still in the tests (t315, AT2):\n${hits.join('\n')}`);
});

test('t315 — the walk reads the whole test tree, the gates and this file excepted', () => {
  const files = scannedFiles();

  // One per shape the tree has: a suite, a shared helper, and the two fixture
  // documents FR8 names. If the walk ever narrows, it fails here instead of
  // passing quietly on a corner of the tree.
  for (const expected of [
    'auth.test.ts',
    'cli-support.ts',
    'fixtures/external-skills/feature-dev/SKILL.md',
    'fixtures/external-skills/no-derivable-check/SKILL.md',
    'glossary-terms.ts',
    'jobs.test.ts',
    'no-leaked-row-keys.test.ts',
    'sessions.test.ts',
    'support.ts',
  ]) {
    assert.ok(files.includes(expected), `the sweep no longer reads ${expected}`);
  }
  assert.ok(files.length > 65, `the sweep reads only ${files.length} files; the tree has more`);
  assert.deepEqual(
    files.filter((file) => SELF_AND_GATES.has(file)),
    [],
    'the language gates and this file are Portuguese on purpose and stay out',
  );
});

test('t315 — every Out of Scope pin still lands on a line that needs excusing', () => {
  for (const entry of OUT_OF_SCOPE) {
    const lines = readFileSync(path.join(TEST_ROOT, entry.file), 'utf8').split('\n');
    const pinned = lines[entry.line - 1] ?? '';
    assert.ok(
      DIACRITICS.test(pinned) || offendersIn(pinned).length > 0,
      `${entry.file}:${entry.line} is no longer Portuguese; drop the exception (${entry.reason})`,
    );
  }
});

test('t315 — AT2 bites on the Portuguese that carries no accent', () => {
  // The five shapes this ticket's refinement measured as invisible to a
  // diacritic grep. If AT2 ever stops seeing these, it has stopped being the
  // reason it exists.
  const caught = [
    ' * Principle 3 promises contracts are checked at the gate, and until this ficha',
    "  notAList.custom_fields = 'nem lista nem nada';",
    "  writeFileSync(filePath, 'isto nao e um banco sqlite, so lixo textual\\n'.repeat(64), 'utf8');",
    "  await refused({ url: '/apenas/um/caminho', secret: SECRET });",
    "  const EVIDENCE = { fonte: 'telemetria', observacao: 'duas travessias com retrabalho' };",
  ];
  for (const text of caught) {
    assert.ok(offendersIn(text).length > 0, `AT2 missed plain-ASCII Portuguese: ${text}`);
  }
});

test('t315 — AT2 does NOT bite on the wire tokens and shared ids this ticket kept', () => {
  const allowed = [
    "      { from: 'implementar', to: 'conferir', condition: 'sempre' },",
    "  assert.equal(parsed?.resultado, 'aprovado');",
    "  const output = ['```resultado', '{\"resultado\":\"retrabalho\"}', '```'].join('\\n');",
    "  expected_metric: { nome: 'tempo_espera_ms:revisar', direcao: 'cai', de: 100, para: 80 },",
    "  { name: 'premise_source', type: 'string', required_at: 'triagem' },",
    "  nodes_visited: ['triagem', 'coleta-fundamentos', 'analise-assimetria'],",
    "  corpo: 'the body the column still spells in Portuguese',",
    "  criterios_de_aceite: ['the frozen D20 column name, untouched'],",
    "  transcricao_truncada: 1,",
    "  transcricao_tamanho_original: 4096,",
    "  const written = ['nota.md', 'parecer.md', 'nota-curta', 'artigo-revisado'];",
  ];
  for (const text of allowed) {
    assert.deepEqual(offendersIn(text), [], `AT2 flagged a kept wire token: ${text}`);
  }
});
