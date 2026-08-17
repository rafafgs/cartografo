/**
 * D20 gate: no Portuguese flag or positional survives in this package's CLIs
 * (t230, AC).
 *
 * Port of `packages/core/test/no-portuguese-wire.test.ts`, the same way
 * `no-portuguese-identifiers.test.ts` is a port of the core's: one gate per
 * package, each reading the rows of `docs/spec/glossario-wire.md` that belong to
 * it. The rows that belong here are `superfície = routes-cli-report` — the flag
 * half of §5.2, since the routes are the screen's and the report is the core's.
 *
 * The sweep is raw text over everything outside a comment, because a flag is
 * never anything but a flag: `--classe` in this package only ever appears in the
 * argv it parses or in the help it prints, and both are code. Comments are
 * masked for the reason the core's original gives — prose about a name is
 * documentation, not the name, and explaining a rename means writing both
 * sides of it down.
 *
 * ## The two positionals, which the glossary does not carry
 *
 * §5.2 has exactly two rows (`--classe`, `--saida`). The surveyor's commands
 * PRINT two more Portuguese names — `<execucao_id>` and `<proposta_id>` in their
 * usage text — and t230 moves them by deriving the spelling from the API rows
 * for the same words (`execucao_id` → `execution_id`, §1.1; `proposta` →
 * `proposal`, §1.3), without adding rows to a document no child ticket has
 * edited since t213. They are listed inline below, and that is why.
 *
 * The scope of that derivation is DISPLAY, and the file list is what keeps it
 * there: `src/surveyor/proposal.ts` builds the body of
 * `POST /v1/proposals/:id/outcome`, whose `execucao_id` is the frozen
 * hypothesis vocabulary (`docs/spec/entidades-versionamento.md` §5), and it is
 * deliberately not swept. The CLI's display name and the wire field it feeds are
 * two different things, and renaming the second one is nobody's ticket.
 *
 * ## The other half: what a client READS off the answer (t254)
 *
 * Everything above gates what a person TYPES at these commands. Nothing gated
 * what they read back, and that is the gap t254 was opened on: `prune` read
 * `status.concluido` off a body that answers `completed`, so every candidate
 * looked unfinished and the command silently collected nothing; `intake` read
 * `draft.itens`/`draft.classe` off a `Rascunho` that carries `items`/`class`,
 * and crashed AFTER the draft was already posted; the surveyor printed
 * `proposta.grafo_id` and `proposta.versao_alvo`, which are two `undefined`s.
 * All three suites were green throughout — a client that reads a name the
 * server retired is invisible to a fake that answers the retired name.
 *
 * So the second gate reads the `superfície = api` rows — the fields the wire
 * really carries — over the six files that talk to `/v1` by hand, and it sweeps
 * two positions only: PROPERTY READS (`.itens`) and STRING or TEMPLATE LITERALS
 * (`` `versao_alvo:` ``). Those are exactly the two ways a client touches a
 * field name — it reads it off a body, or it prints it at a person. Everything
 * else is left alone on purpose, and one thing in particular: a plain
 * identifier. `cliente-controle.ts` still names its own parameters `pedido` and
 * `nome`, its own class `ErroDoControlPlane`; that is identifier debt of
 * another ficha (the file's own header says so, and t254's Out of Scope keeps
 * it out), and a sweep that fired on it would be demanding a rename this ticket
 * was told not to make.
 *
 * Three field names the `api` surface does not carry BY NAME are listed inline
 * in {@link DERIVED_FIELDS}, the same way {@link DISPLAYED_POSITIONALS} already
 * is and for the same reason — the glossary's §1.1 says an entity field on the
 * wire mirrors its column 1:1, so `concluido`, `bloqueado` and `versao_alvo`
 * take the spelling their already-converged `database` rows (§4.2) gave those
 * columns, without editing a document no child ticket has touched since t213.
 *
 * And two spans are exempted, in {@link EXEMPT_SPANS}, both for the same reason:
 * the name belongs to this package, not to the wire. `result.proposta` in the
 * surveyor's command is the runner-internal result of `proposeFlowImprovement`,
 * whose keys (`gargalo`, `evidencia`, `metrica_esperada`, `proposta`) are that
 * module's own — what came off the wire is what is INSIDE it, and reading
 * `.graph_id` off THAT is precisely what t254 fixed. `this.corpo` in
 * `cliente-controle.ts` is a field of `ErroDoControlPlane` being assigned, and
 * it is here because of t255 rather than t254: that ficha mapped `corpo` →
 * `body` on the `api` surface for the intake item that really carries it, and
 * this file has no intake item — it has the decoded body of a failed call, under
 * a name of its own.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const GLOSSARY = path.join(REPO_ROOT, 'docs', 'spec', 'glossario-wire.md');

/** The surface t230 migrates, as the glossary tags it. */
const SURFACE = 'routes-cli-report';

/** The surface a client of `/v1` reads and prints, as the glossary tags it (t254). */
const API_SURFACE = 'api';

/** The commands whose flags §5.2 renames. */
const FLAG_FILES = [
  path.join('src', 'intake', 'command-line.ts'),
  path.join('src', 'intake', 'cli.mjs'),
  path.join('src', 'intake', 'generate.ts'),
  path.join('src', 'synthesizer', 'synthesize.ts'),
  path.join('src', 'synthesizer', 'cli.mjs'),
];

/** The commands whose usage text names a positional. */
const POSITIONAL_FILES = [
  path.join('src', 'surveyor', 'command-line.ts'),
  path.join('src', 'surveyor', 'outcome.ts'),
  path.join('src', 'surveyor', 'cli.mjs'),
];

/**
 * The displayed positionals, derived from the API rows for the same words.
 *
 * Not in the glossary; see this file's header for why they are here instead.
 */
const DISPLAYED_POSITIONALS: ReadonlyArray<{ term: string; english: string }> = Object.freeze([
  { term: 'execucao_id', english: 'execution_id' },
  { term: 'proposta_id', english: 'proposal_id' },
]);

/** The commands that read a `/v1` answer by hand, or print a field of one (t254). */
const CLIENT_FILES = [
  path.join('src', 'cli', 'prune.ts'),
  path.join('src', 'cli', 'index.ts'),
  path.join('src', 'intake', 'cli.mjs'),
  path.join('src', 'intake', 'command-line.ts'),
  path.join('src', 'surveyor', 'cli.mjs'),
  path.join('src', 'controller', 'cliente-controle.ts'),
];

/**
 * Entity fields the `api` surface does not carry by name, derived from §4.2.
 *
 * Not in the `api` rows; see this file's header for why they are here instead.
 * All three are columns first and JSON keys second — `completed` and `blocked`
 * are `job`'s (`packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql`,
 * projected by `packages/core/src/repositories/job.ts`), `target_version` is
 * `proposal`'s (`packages/core/migrations/0002_grafo_versionado.sql`) — and the
 * glossary's §1.1 note is what says the wire spells them the same way.
 */
const DERIVED_FIELDS: ReadonlyArray<{ term: string; english: string }> = Object.freeze([
  { term: 'concluido', english: 'completed' },
  { term: 'bloqueado', english: 'blocked' },
  { term: 'versao_alvo', english: 'target_version' },
]);

/**
 * Spans of a client file that are not a wire name, each with the reason.
 *
 * Pinned by the span's exact text rather than by line, unlike the sibling gate's
 * `OUT_OF_SCOPE`: what excuses this one is WHOSE name it is, which does not
 * change when the line moves — and the test below fails if the span stops
 * existing, so an exemption still cannot outlive what it excuses.
 */
const EXEMPT_SPANS: ReadonlyArray<{ file: string; span: string; reason: string }> = Object.freeze([
  {
    file: path.join('src', 'surveyor', 'cli.mjs'),
    span: '.proposta',
    reason:
      'the runner-internal result of `proposeFlowImprovement`, not a body of the wire: ' +
      'its keys are `src/surveyor/proposal.ts`’s own, and renaming them is that ' +
      'module’s identifier debt (t254, Out of Scope)',
  },
  {
    file: path.join('src', 'controller', 'cliente-controle.ts'),
    span: '.corpo',
    reason:
      'the field of `ErroDoControlPlane`, this package’s own error class, being ' +
      'ASSIGNED — not a field read off an answer. t255 mapped `corpo` → `body` ' +
      'because the intake item carries it on the wire (`domain/intake.ts`), and ' +
      'this file never reads that item: what it stores here is the whole decoded ' +
      'body of a failed call, under a name its own consumers spell (`erro.corpo` ' +
      'in `test/controller/cliente-controle.test.ts` and `test/dispatch/dispatch.test.ts`). ' +
      'Renaming it is the same identifier debt the file’s own header flags, and ' +
      't254’s Out of Scope keeps it out',
  },
]);

/** A term of the glossary, with the English it has to be written in. */
interface Term {
  term: string;
  english: string;
}

/**
 * Every Portuguese term the glossary maps on one surface.
 *
 * @param surface The `superfície` label of the rows that belong to the caller.
 * @param minimum How many rows that surface has to still parse to, so a
 *   glossary this stops being able to read fails loudly instead of quietly
 *   sweeping for nothing.
 */
function surfaceTerms(surface: string, minimum: number): Term[] {
  assert.ok(existsSync(GLOSSARY), `${GLOSSARY} does not exist`);
  const terms: Term[] = [];

  for (const line of readFileSync(GLOSSARY, 'utf8').split('\n')) {
    const cells = line.trim();
    if (!cells.startsWith('|')) continue;
    const parts = cells.slice(1).split('|').map((cell) => cell.replace(/`/g, '').trim());
    if (parts[0] !== surface) continue;

    const english = parts[2] ?? '';
    const term = (parts[1] ?? '').trim();
    if (term === '' || term === english) continue;
    terms.push({ term, english });
  }

  assert.ok(
    terms.length >= minimum,
    `the glossary's "${surface}" surface parsed to only ${terms.length} terms`,
  );
  return terms;
}

/**
 * The §5.2 rows: the flags a person types at a command of this repository.
 *
 * Not only this package's. §5.2 also carries the cost lens's flags — since t255,
 * which moved them out of a local array in that package's own gate and into the
 * glossary — and sweeping them here costs nothing and claims nothing: a runner
 * command that ever spelled one would be caught by the row that already exists.
 * The floor is a floor and not an equality for that reason: another package's
 * row landing in §5.2 must not turn this gate red.
 */
function flagTerms(): Term[] {
  const flags = surfaceTerms(SURFACE, 25).filter((entry) => entry.term.startsWith('--'));
  assert.ok(flags.length >= 2, `the glossary's §5.2 parsed to only ${flags.length} CLI flags`);
  return flags;
}

/** The §1 rows a client reads or prints, plus the three §4.2 derives (t254). */
function apiTerms(): Term[] {
  return [...surfaceTerms(API_SURFACE, 100), ...DERIVED_FIELDS];
}

/** Blanks every comment, so prose about a name is not read as the name. */
function maskComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (span) => span.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (span) => span.replace(/[^\n]/g, ' '));
}

/**
 * Every hit of an old spelling in one source text, as `line: what`.
 *
 * The boundary on the right is what keeps `--class` from reading as a hit on
 * `--classe`, and `execution_id` from reading as one on `execucao_id`: only the
 * old spelling, whole, counts. The one on the LEFT does the same job on the
 * other side and t254 needed it: this package's own name ENDS in `grafo`, so
 * without it every `cartografo` in a usage line reads as the field `grafo`.
 */
export function cliHits(source: string, terms: ReadonlyArray<Term>): string[] {
  const hits: string[] = [];

  maskComments(source).split('\n').forEach((line, index) => {
    for (const entry of terms) {
      if (new RegExp(`(?<![A-Za-z0-9_-])${entry.term}(?![A-Za-z0-9_-])`).test(line)) {
        hits.push(`${index + 1}: "${entry.term}" (English: "${entry.english}")`);
      }
    }
  });

  return hits.sort();
}

/** One property read or one literal chunk, and the line it is on. */
export interface ClientSpan {
  line: number;
  text: string;
}

/** A property read: the dot and the name, never a `#private` or a number. */
const PROPERTY_READ = /^\.[A-Za-z_$][A-Za-z0-9_$]*/;

/**
 * The two positions of a client file this gate sweeps: reads and prints.
 *
 * A hand-written scanner rather than a regex, for the reason
 * `no-portuguese-user-facing-strings.test.ts`'s own says: alternation lets one
 * backtick swallow everything after it, and a sweep that silently stops
 * applying is worse than no sweep. Comments are skipped here rather than masked
 * — prose about a rename has to be able to write both sides of it down.
 *
 * A template literal comes back one span per LINE, so a hit inside a 60-line
 * usage text is reported where it really is; the expressions inside its `${…}`
 * are code, and the reads in there are collected in their own right.
 *
 * @param source File contents.
 * @returns Every property read and every literal chunk, in source order.
 */
export function clientSpans(source: string): ClientSpan[] {
  const spans: ClientSpan[] = [];
  let index = 0;
  let line = 1;

  /** Consumes `count` characters, keeping the line counter honest. */
  function advance(count: number): void {
    for (let step = 0; step < count && index < source.length; step += 1) {
      if (source[index] === '\n') line += 1;
      index += 1;
    }
  }

  function push(at: number, text: string): void {
    if (text !== '') spans.push({ line: at, text });
  }

  function readQuoted(quote: string): void {
    const startLine = line;
    advance(1);
    const chunk: string[] = [];
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        // The escaped character itself, never the backslash.
        chunk.push(source[index + 1] ?? '');
        advance(2);
        continue;
      }
      if (char === quote || char === '\n') break;
      chunk.push(char);
      advance(1);
    }
    advance(1);
    push(startLine, chunk.join(''));
  }

  function readTemplate(): void {
    advance(1);
    let chunkLine = line;
    let chunk: string[] = [];
    const flush = (): void => {
      push(chunkLine, chunk.join(''));
      chunk = [];
    };

    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        chunk.push(source[index + 1] ?? '');
        advance(2);
        continue;
      }
      if (char === '`') {
        advance(1);
        break;
      }
      if (char === '$' && source[index + 1] === '{') {
        flush();
        advance(2);
        walk(true);
        chunkLine = line;
        continue;
      }
      if (char === '\n') {
        flush();
        advance(1);
        chunkLine = line;
        continue;
      }
      chunk.push(char);
      advance(1);
    }
    flush();
  }

  /**
   * Walks source, collecting as it goes.
   *
   * @param inExpression `true` inside a `${…}`, where the matching `}` ends the
   *   walk instead of being one more character.
   */
  function walk(inExpression: boolean): void {
    let depth = 1;

    while (index < source.length) {
      const char = source[index];
      const next = source[index + 1];

      if (inExpression && char === '{') {
        depth += 1;
        advance(1);
        continue;
      }
      if (inExpression && char === '}') {
        depth -= 1;
        advance(1);
        if (depth === 0) return;
        continue;
      }
      if (char === '/' && next === '/') {
        const stop = source.indexOf('\n', index);
        advance((stop === -1 ? source.length : stop) - index);
        continue;
      }
      if (char === '/' && next === '*') {
        const stop = source.indexOf('*/', index + 2);
        advance((stop === -1 ? source.length : stop + 2) - index);
        continue;
      }
      if (char === "'" || char === '"') {
        readQuoted(char);
        continue;
      }
      if (char === '`') {
        readTemplate();
        continue;
      }
      if (char === '.') {
        const read = PROPERTY_READ.exec(source.slice(index, index + 64));
        if (read !== null) {
          push(line, read[0]);
          advance(read[0].length);
          continue;
        }
      }
      advance(1);
    }
  }

  walk(false);
  return spans;
}

/** Every old spelling a client source reads or prints, as `line: what`. */
function clientHitsIn(source: string, terms: ReadonlyArray<Term>): string[] {
  return clientSpans(source).flatMap((span) =>
    // `cliHits` numbers the lines of what it is given, and what it is given here
    // is one span — so the line it reports is replaced by the span's own.
    cliHits(span.text, terms).map((hit) => `${span.line}: ${hit.replace(/^\d+: /, '')}`),
  );
}

/** ...and the same over one scanned file, minus the spans {@link EXEMPT_SPANS} excuses. */
function clientHitsOf(relative: string, terms: ReadonlyArray<Term>): string[] {
  const excused = new Set(
    EXEMPT_SPANS.filter((entry) => entry.file === relative).map((entry) => entry.span),
  );
  return clientSpans(sourceOf(relative))
    .filter((span) => !excused.has(span.text.trim()))
    .flatMap((span) =>
      cliHits(span.text, terms).map((hit) => `${relative}:${span.line}: ${hit.replace(/^\d+: /, '')}`),
    );
}

/** Reads one scanned file, failing loudly if the list went stale. */
function sourceOf(relative: string): string {
  const full = path.join(PACKAGE_ROOT, relative);
  assert.ok(existsSync(full), `artifact does not exist: ${relative}`);
  return readFileSync(full, 'utf8');
}

test('t230 — the intake and synthesizer commands take the English flags of §5.2', () => {
  const terms = flagTerms();

  const hits = FLAG_FILES.flatMap((relative) =>
    cliHits(sourceOf(relative), terms).map((hit) => `${relative}:${hit}`),
  );

  assert.deepEqual(
    hits,
    [],
    `Portuguese CLI flags still typed (D20, glossario-wire.md §5.2):\n${hits.join('\n')}`,
  );
});

test('t230 — the surveyor commands print English positionals, without touching the frozen body', () => {
  const hits = POSITIONAL_FILES.flatMap((relative) =>
    cliHits(sourceOf(relative), DISPLAYED_POSITIONALS).map((hit) => `${relative}:${hit}`),
  );

  assert.deepEqual(
    hits,
    [],
    `Portuguese positionals still printed (D20, derived from §1.1/§1.3):\n${hits.join('\n')}`,
  );

  // And the frozen half is still spelled the old way, on purpose: a sweep that
  // had quietly renamed it too would have moved a wire field no D20 child owns.
  const proposal = sourceOf(path.join('src', 'surveyor', 'proposal.ts'));
  assert.ok(
    proposal.includes('execucao_id'),
    'the hypothesis body lost `execucao_id`; that field is frozen (entidades-versionamento.md §5)',
  );
});

test('t230 — the sweep bites on the old spellings and lets the new ones through', () => {
  const flags = flagTerms();

  const caught = [
    "  '    \"<request>\" --classe <name> [options]',",
    "if (name === '--classe') return 1;",
    "  '  --saida <path>      where to write the draft (default',",
  ];
  for (const source of caught) {
    assert.ok(cliHits(source, flags).length > 0, `the sweep missed an old flag: ${source}`);
  }

  const allowed = [
    "  '    \"<request>\" --class <name> [options]',",
    "  '  --out <path>        where to write the draft (default',",
    // A flag that merely starts the same way is not the old one.
    "  '  --classes-url <url> where the registry lives',",
    // Prose about the rename, which is how a header explains one.
    '/** flags (`--classe`, `--saida`), renamed by t230 to `--class` and `--out`. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(cliHits(source, flags), [], `the sweep flagged the new spelling: ${source}`);
  }

  const caughtPositionals = [
    '  <proposta_id> <execucao_id> [url] [--token <token>]',
    'return refuse(`execucao_id has to be an integer (got: ${JSON.stringify(rawId)})`);',
  ];
  for (const source of caughtPositionals) {
    assert.ok(
      cliHits(source, DISPLAYED_POSITIONALS).length > 0,
      `the sweep missed an old positional: ${source}`,
    );
  }
  assert.deepEqual(
    cliHits('  <proposal_id> <execution_id> [url] [--token <token>]', DISPLAYED_POSITIONALS),
    [],
    'the English positionals have to pass',
  );
});

test('t254 — the client commands read and print the English fields the wire really answers', () => {
  const terms = apiTerms();

  const hits = CLIENT_FILES.flatMap((relative) => clientHitsOf(relative, terms));

  assert.deepEqual(
    hits,
    [],
    `a client still reads or prints a Portuguese wire field (D20, glossario-wire.md §1):\n${hits.join('\n')}`,
  );
});

test('t254 — every exempted span is still there, and still a span', () => {
  for (const entry of EXEMPT_SPANS) {
    const spans = clientSpans(sourceOf(entry.file));
    assert.ok(
      spans.some((span) => span.text.trim() === entry.span),
      `${entry.file} no longer has \`${entry.span}\`; drop the exception (${entry.reason})`,
    );
  }
});

test('t254 — the client sweep bites on a read of the old wire and lets the new one through', () => {
  const terms = apiTerms();

  // Every one of these is a line that really shipped, and every one of them was
  // green until this gate existed.
  const caught = [
    'if (status?.concluido !== true) return;',
    "write(status.bloqueado ? 'blocked' : 'not concluded');",
    '`intake: draft ${draft.id} with ${draft.itens.length} item(s) over ${draft.classe}`',
    'console.log(`grafo: ${proposal.grafo_id}`);',
    'console.log(`versao_alvo: ${proposal.versao_alvo}`);',
    "  '  - confirm the draft. It lands as `pendente`, no ticket exists yet,',",
    'const USAGE = `  for its own runner id (teto_runner); the server`;',
  ];
  for (const source of caught) {
    assert.ok(clientHitsIn(source, terms).length > 0, `the sweep missed an old wire name: ${source}`);
  }

  const allowed = [
    'if (status?.completed !== true) return;',
    "write(status.blocked ? 'blocked' : 'not concluded');",
    '`intake: draft ${draft.id} with ${draft.items.length} item(s) over ${draft.class}`',
    'console.log(`graph: ${proposal.graph_id}`);',
    'console.log(`target_version: ${proposal.target_version}`);',
    "  '  - confirm the draft. It lands as `pending`, no ticket exists yet,',",
    'const USAGE = `  for its own runner id (runner_cap); the server`;',
    // The package's own name ends in `grafo`, and it is in every usage line.
    "  '  npm run intake --workspace @cartografo/runner -- \\\\',",
    "export const READY_EVENT = 'cartografo.runner.ready';",
    // An identifier is neither a read of a body nor a name printed at a person:
    // `cliente-controle.ts` still has these, and renaming them is another ficha.
    'async pedirLease(pedido: PedidoDeLease): Promise<RespostaDeConcessao> {',
    'constructor(mensagem: string, status: number, corpo: unknown) {',
    // ...and so is a key of the frozen hypothesis body it writes.
    'entrada: { execucao_id: number; depois: number },',
    // Prose about the rename, which is how a header explains one.
    '/** `concluido` is what this read was called before t226 renamed it. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(clientHitsIn(source, terms), [], `the sweep flagged what is not a wire read: ${source}`);
  }
});
