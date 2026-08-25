/**
 * D20 gate: no Portuguese flag or positional survives in this package's CLIs
 * (t230, AC).
 *
 * Port of `packages/core/test/no-portuguese-wire.test.ts`, the same way
 * `no-portuguese-identifiers.test.ts` is a port of the core's: one gate per
 * package, each reading the rows of `docs/spec/glossario-wire.md` that belong to
 * it. The rows that belong here are `surface = routes-cli-report` — the flag
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
 * there: the body of `POST /v1/proposals/:id/outcome` carries `execucao_id` as
 * the frozen hypothesis vocabulary (`docs/spec/entities-versioning.md` §5),
 * and it is deliberately not swept. The CLI's display name and the wire field it
 * feeds are two different things, and renaming the second one is nobody's ticket.
 *
 * That body lives in `src/controller/cliente-controle.ts`
 * (`fecharResultadoDeProposta`), and until t264 the assertion below pointed at
 * `src/surveyor/proposal.ts` instead — a file that never calls it. It only ever
 * passed because `FlowEvidence.execucao_id`, a key of the FLOW LENS and nobody's
 * frozen anything, happened to share the spelling. t264 migrated that lens to
 * English (§5.6), so the coincidence is gone and the assertion now reads the
 * file the frozen field is really in.
 *
 * ## The flow lens's own keys (t264)
 *
 * {@link FLOW_LENS_KEYS} is §5.6 as this package's gate reads it, and it is
 * swept over `src/surveyor/proposal.ts` in KEY positions only — `.perguntas` as
 * a read, `perguntas:` as a declaration. Not raw text, because that file also
 * builds the session's PROMPT, and the prompt's table header really does say
 * `perguntas` in Portuguese prose: it is content handed to an agent (D18), not a
 * name on the wire, and a sweep that could not tell them apart would have to be
 * turned off to be usable.
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
 * So the second gate reads the `surface = api` rows — the fields the wire
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
 * ## The third position, and the file nobody was sweeping (t266)
 *
 * t254 swept six files in two positions, and the first real crossing found the
 * hole in both halves at once. The half-file: `scripts/spike-surveyor-flow.mjs`
 * talks to `/v1` eleven times by hand and was on no list, so every rename since
 * t226 walked past it — it destructured `eventos` off a body that answers
 * `events`, read `.no_atual`, `.grafo`, `.evidencia` and compared `status`
 * against `'pendente'`, and the proof died on the first of them with a
 * `TypeError` about `undefined`. The half-position: a DESTRUCTURING is the third
 * way a client touches a field name, and it is the one a proof script uses most
 * — `const { eventos: events } = await api(…)` is neither a `.read` nor a
 * literal, so t254's two scanners could not see it even in the files they did
 * sweep. {@link destructuredSpans} is that position, and it is swept over every
 * client file rather than only the new one: the same line in `prune.ts` would be
 * the same defect.
 *
 * {@link PROPOSAL_FIELDS} is four more §4.2 derives, on the same §1.1 note
 * {@link DERIVED_FIELDS} rides — `evidence`, `expected_metric`,
 * `applied_version_id` and `current_version_id` are `proposal`'s and `graph`'s
 * columns (`packages/core/migrations/0002_grafo_versao_proposta.sql`), and
 * `toProposal`/`toGraph` project them onto the wire with the same spelling.
 *
 * And the spans of {@link EXEMPT_SPANS} are excused, all for the same reason:
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
 *
 * ## The three commands nobody was sweeping either (t285)
 *
 * t266 put the manual PROOF on a list and left the three manual COMMANDS off it,
 * and the same class of defect was already sitting in the first of them.
 * `scripts/close-surveyor-outcome.mjs` is the only caller of the one write of
 * the propose→gate→apply→measure→close cycle, and it read six names the wire
 * retired — `.grafo_id`, `.resultado`, `.metrica_esperada`,
 * `.versao_aplicada_id`, `.trabalhos`, and above all `status !== 'aplicada'`
 * against a wire that answers `applied`, which killed every real run on the
 * third statement with the message `only an applied proposal has an experiment
 * to close; this one is "applied"`. Its own header had said why nothing caught
 * it: the pure half is unit-tested and "what lives here is the network and the
 * exit code" — and the network half had no test at all.
 *
 * So {@link MANUAL_PROOF_FILES} grows by the three: `close-surveyor-outcome.mjs`,
 * `measure-executions.mjs` and `run-graph-traversal.mjs`. The re-audit the same
 * ficha ran over the last two found one more, in the report of the traversal
 * driver (`version.grafo_id`, printed as `undefined` on every crossing) — which
 * is the whole argument for sweeping a file instead of re-reading it.
 *
 * {@link PROPOSAL_FIELDS} gains a fifth derive in the same pass: `resultado` →
 * `result` is a `proposal` column of `0002_grafo_versao_proposta.sql` that §4.2
 * already maps and that `toProposal` projects onto the wire unchanged, exactly
 * like the four beside it. Nobody had derived it, which is why the two reads of
 * `.resultado` above would have survived a naive extension of this sweep.
 *
 * The exemptions those three files need are the same kind as the ones above, and
 * two vocabularies account for all of them. `.nome` in the close command is the
 * metric object's OWN key, frozen hypothesis vocabulary D20 does not unfreeze
 * (`glossario-wire.md:796`), and the whole point of that command is to read it.
 * `.titulo` and `.execucao_id` in the traversal driver — and the two messages and
 * the usage line that spell them — are the keys of the PLAN FILE that driver
 * takes as input: an operator-authored document of its own, not a body of the
 * wire, and renaming it is nobody's ticket.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { type GlossaryTerm, glossaryTerms } from '@cartografo/test-support';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

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
 * The manual proofs and commands of this package, clients like any other (t266,
 * t285).
 *
 * `scripts/spike-surveyor-flow.mjs` is the half of the surveyor the suite cannot
 * run — it needs a real `claude`, an account and three minutes — and that is
 * exactly why it needs this gate more than the commands do, not less: nothing
 * else in CI ever executes a line of it, so a field the server renamed goes on
 * reading fine to every reviewer until someone spends the three minutes. Swept
 * with the same terms and the same positions as {@link CLIENT_FILES}; the only
 * difference is that the list is separate, because {@link PROPOSAL_FIELDS} is
 * vocabulary no command reads.
 *
 * The other three arrive with t285 and are the same argument one step further:
 * `close-surveyor-outcome.mjs` and `measure-executions.mjs` talk to a control
 * plane the suite does not boot, and `run-graph-traversal.mjs` dispatches real
 * `claude`/`codex` sessions and must never become a CI test — so a static sweep
 * is the only thing that reads them at all between one manual run and the next.
 * See this file's header for the two vocabularies that made them need
 * exemptions, and `test/surveyor/close-outcome.e2e.test.ts` for the half of
 * `close-surveyor-outcome.mjs` a sweep cannot judge.
 */
const MANUAL_PROOF_FILES = [
  path.join('scripts', 'spike-surveyor-flow.mjs'),
  path.join('scripts', 'close-surveyor-outcome.mjs'),
  path.join('scripts', 'measure-executions.mjs'),
  path.join('scripts', 'run-graph-traversal.mjs'),
];

/**
 * Five more entity fields the `api` surface does not carry by name (t266, t285).
 *
 * The same derivation {@link DERIVED_FIELDS} documents, over the columns of
 * `0002_grafo_versao_proposta.sql` a proposal and a graph are read by:
 * `evidencia`, `metrica_esperada`, `versao_aplicada_id` and `resultado` are
 * `proposta`'s, `versao_corrente_id` is `grafo`'s, §4.2 already maps all five,
 * and §1.1 is what says the wire spells them the way the column does — which it
 * does, in `toProposal` and `toGraph` (`packages/core/src/repositories/`).
 *
 * `resultado` is t285's, and it was a derive nobody had made rather than a new
 * one: the close command read `proposal.resultado` off a body that answers
 * `result`, so its already-closed guard never fired.
 *
 * Kept out of {@link DERIVED_FIELDS} on purpose: `evidencia` and
 * `metrica_esperada` are ALSO two keys of the runner-internal `SurveyorResult`,
 * which `src/surveyor/cli.mjs` prints under their own names and which
 * `glossario-wire.md` §5.6 records as staying — so a sweep that carried them
 * over every client file would be demanding a rename the glossary refuses.
 */
const PROPOSAL_FIELDS: ReadonlyArray<GlossaryTerm> = Object.freeze([
  { term: 'evidencia', english: 'evidence' },
  { term: 'metrica_esperada', english: 'expected_metric' },
  { term: 'versao_aplicada_id', english: 'applied_version_id' },
  { term: 'versao_corrente_id', english: 'current_version_id' },
  { term: 'resultado', english: 'result' },
]);

/**
 * The flow lens's Portuguese keys and the English each one became (t264, FR3).
 *
 * Read from the header of this file rather than from the glossary, the same way
 * {@link DISPLAYED_POSITIONALS} and {@link DERIVED_FIELDS} are: the shared
 * reader filters on a surface tag, and `flow-lens`'s rows are readable only by
 * this package — pointing it at them would hand three other sweeps a
 * vocabulary none of them can see. `fonte` is deliberately absent: it is the
 * module's own provenance label, and `docs/spec/surveyor-flow.md` §4 already
 * records the decision to leave it where it is.
 */
const FLOW_LENS_KEYS: ReadonlyArray<GlossaryTerm> = Object.freeze([
  { term: 'no_id', english: 'node_id' },
  { term: 'execucao_id', english: 'execution_id' },
  { term: 'grafo_versao_id', english: 'graph_version_id' },
  { term: 'tempo_agente_ms', english: 'agent_ms' },
  { term: 'tempo_espera_ms', english: 'blocked_ms' },
  { term: 'tempo_fila_ms', english: 'queue_ms' },
  { term: 'perguntas', english: 'input_requests' },
  { term: 'eventos', english: 'event_ids' },
  { term: 'por_no', english: 'by_node' },
]);

/**
 * Every hit of an old key in a KEY position: `.name` read or `name:` declared.
 *
 * The two positions a wire key of this lens can occupy in TypeScript, and
 * neither of them is prose. Comments are masked first, for the reason the sweeps
 * above give: explaining a rename means writing both sides of it down.
 *
 * @param source File contents.
 * @param terms The vocabulary to look for.
 * @returns One `line: what` per hit, sorted.
 */
export function keyHits(source: string, terms: ReadonlyArray<GlossaryTerm>): string[] {
  const hits: string[] = [];

  maskComments(source).split('\n').forEach((line, index) => {
    for (const entry of terms) {
      // `.name` on the left, `name:` on the right; the boundaries on both sides
      // keep `node_id` from reading as a hit on `no_id`.
      const tail = `${entry.term}(?![A-Za-z0-9_$])`;
      const read = `\\.${tail}`;
      const declared = `(?<![A-Za-z0-9_$.])${tail}\\s*:`;
      if (new RegExp(`${read}|${declared}`).test(line)) {
        hits.push(`${index + 1}: "${entry.term}" (English: "${entry.english}")`);
      }
    }
  });

  return hits.sort();
}

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
    file: path.join('scripts', 'spike-surveyor-flow.mjs'),
    span: '.proposta',
    reason:
      'the same runner-internal result, in the manual proof of the same module: ' +
      '`proposeFlowImprovement` answers `{gargalo, evidencia, metrica_esperada, ' +
      'proposta}`, and `glossario-wire.md` §5.6 records those four as staying — ' +
      'what came off the wire is the proposal INSIDE it, and every read of THAT ' +
      'is swept (t266)',
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
  {
    file: path.join('scripts', 'close-surveyor-outcome.mjs'),
    span: '.nome',
    reason:
      'the metric object’s OWN key, which is the frozen hypothesis vocabulary of ' +
      '`domain/hypothesis.ts` — `{nome, direcao, de, para}`, `glossario-wire.md:796`, ' +
      'a format D20 does not unfreeze. The WRAPPER is `expected_metric` and t285 ' +
      'fixed that read; what is inside it does not move (t285, Out of Scope)',
  },
  {
    file: path.join('scripts', 'close-surveyor-outcome.mjs'),
    span: '.corpo',
    reason:
      'the same field of `ErroDoControlPlane` the exemption above excuses, being ' +
      'READ this time: `error.corpo` is the decoded body of a failed call, under ' +
      'this package’s own name for it (t285)',
  },
  {
    file: path.join('scripts', 'measure-executions.mjs'),
    span: '.corpo',
    reason: 'the same read of `ErroDoControlPlane.corpo`, in the sibling command (t285)',
  },
  {
    file: path.join('scripts', 'run-graph-traversal.mjs'),
    span: '.titulo',
    reason:
      'a key of the PLAN FILE this driver takes as input — an operator-authored ' +
      'document of its own (`{titulo, execucao_id, grafo_versao_id, nos}`), never a ' +
      'body of the wire. What the driver SENDS is `title`, one line down, and that ' +
      'read is swept (t285)',
  },
  {
    file: path.join('scripts', 'run-graph-traversal.mjs'),
    span: '.execucao_id',
    reason:
      'the same plan file’s key. It feeds `execution_id` on the wire and the route ' +
      'segments that carry it, and both of those spellings are swept (t285)',
  },
  {
    file: path.join('scripts', 'run-graph-traversal.mjs'),
    span: 'plano.json    {titulo, execucao_id, grafo_versao_id, nos: [{id, task, engine?}]}',
    reason:
      'the usage line that DOCUMENTS the plan file’s keys. Spelling them in English ' +
      'there would describe a format the driver does not accept (t285)',
  },
  {
    file: path.join('scripts', 'run-graph-traversal.mjs'),
    span: 'plan.titulo is required',
    reason: 'a refusal that names the plan file’s key, for whoever wrote the plan (t285)',
  },
  {
    file: path.join('scripts', 'run-graph-traversal.mjs'),
    span: 'plan.execucao_id has to be an integer',
    reason: 'the same refusal, about the same document (t285)',
  },
]);

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
function flagTerms(): GlossaryTerm[] {
  const flags = glossaryTerms({ surface: SURFACE }, 25).filter((entry) =>
    entry.term.startsWith('--'),
  );
  assert.ok(flags.length >= 2, `the glossary's §5.2 parsed to only ${flags.length} CLI flags`);
  return flags;
}

/** The §1 rows a client reads or prints, plus the three §4.2 derives (t254). */
function apiTerms(): GlossaryTerm[] {
  return [...glossaryTerms({ surface: API_SURFACE }, 100), ...DERIVED_FIELDS];
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
 *
 * Both boundaries are `\p{L}` and not `A-Za-z` since t266, because the text on
 * either side of them is not always ASCII: the manual proof titles its job
 * `nota curta sobre o topógrafo de fluxo` — Portuguese CONTENT, which D18 keeps
 * — and an accented letter that does not count as a letter turns the `grafo`
 * inside `topógrafo` into a wire field. A letter is a letter; the `u` flag is
 * what makes the class mean that.
 */
export function cliHits(source: string, terms: ReadonlyArray<GlossaryTerm>): string[] {
  const hits: string[] = [];

  maskComments(source).split('\n').forEach((line, index) => {
    for (const entry of terms) {
      if (new RegExp(`(?<![\\p{L}\\p{N}_-])${entry.term}(?![\\p{L}\\p{N}_-])`, 'u').test(line)) {
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

/**
 * The keys a `const {…} = …` binds: the third position of a client (t266).
 *
 * A regex and not a pass of the scanner above, because there is nothing to
 * disambiguate here — a destructuring pattern is `const`, `let` or `var`
 * followed immediately by a brace, which no object literal and no block ever is,
 * and what it binds is a comma-separated list of names. Comments are masked
 * first, for the reason every sweep in this file gives.
 *
 * Each key comes back shaped like a property read (`.eventos`), because that is
 * what it IS — `const { eventos: events } = body` and `body.eventos` are the
 * same read of the same field written two ways — and shaping it so lets one
 * {@link EXEMPT_SPANS} entry excuse both.
 *
 * @param source File contents.
 * @returns One span per bound key, at the line the declaration opens on.
 */
export function destructuredSpans(source: string): ClientSpan[] {
  const masked = maskComments(source);
  const spans: ClientSpan[] = [];

  for (const match of masked.matchAll(/(?:const|let|var)\s*\{([^{}]*)\}\s*=/g)) {
    const line = masked.slice(0, match.index).split('\n').length;
    for (const bound of (match[1] ?? '').split(',')) {
      // `key: alias` reads the key; `key` on its own reads itself; `...rest`
      // reads nothing at all.
      const key = (bound.split(':')[0] ?? '').trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) spans.push({ line, text: `.${key}` });
    }
  }

  return spans;
}

/** Every position of a client source this gate judges, in one list. */
function readSpans(source: string): ClientSpan[] {
  return [...clientSpans(source), ...destructuredSpans(source)];
}

/** Every old spelling a client source reads or prints, as `line: what`. */
function clientHitsIn(source: string, terms: ReadonlyArray<GlossaryTerm>): string[] {
  return readSpans(source).flatMap((span) =>
    // `cliHits` numbers the lines of what it is given, and what it is given here
    // is one span — so the line it reports is replaced by the span's own.
    cliHits(span.text, terms).map((hit) => `${span.line}: ${hit.replace(/^\d+: /, '')}`),
  );
}

/** ...and the same over one scanned file, minus the spans {@link EXEMPT_SPANS} excuses. */
function clientHitsOf(relative: string, terms: ReadonlyArray<GlossaryTerm>): string[] {
  const excused = new Set(
    EXEMPT_SPANS.filter((entry) => entry.file === relative).map((entry) => entry.span),
  );
  return readSpans(sourceOf(relative))
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
  // The file is the one that BUILDS that body (t264, FR6); see this file's
  // header for why it used to be `proposal.ts`, and why that never proved this.
  const client = sourceOf(path.join('src', 'controller', 'cliente-controle.ts'));
  assert.ok(
    client.includes('execucao_id'),
    'the hypothesis body lost `execucao_id`; that field is frozen (entities-versioning.md §5)',
  );

  // ...and the flow lens, which shared that spelling by coincidence and nothing
  // else, no longer carries a single Portuguese key of §5.6.
  const proposal = sourceOf(path.join('src', 'surveyor', 'proposal.ts'));
  assert.deepEqual(
    keyHits(proposal, FLOW_LENS_KEYS),
    [],
    'a Portuguese flow-lens key survives in src/surveyor/proposal.ts (D20, §5.6)',
  );
  for (const relative of [
    path.join('src', 'surveyor', 'metrics.ts'),
    path.join('src', 'surveyor', 'outcome.ts'),
  ]) {
    assert.deepEqual(
      keyHits(sourceOf(relative), FLOW_LENS_KEYS),
      [],
      `a Portuguese flow-lens key survives in ${relative} (D20, §5.6)`,
    );
  }
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

  // ...and the §5.6 sweep, which judges KEY positions and nothing else (t264).
  const caughtKeys = [
    '  tempo_agente_ms: number;',
    'return { por_no: ranking, gargalo: worst };',
    '`| \\`${row.no_id}\\`| ${row.tempo_espera_ms} |`',
    '  perguntas: bottleneck.perguntas,',
  ];
  for (const source of caughtKeys) {
    assert.ok(keyHits(source, FLOW_LENS_KEYS).length > 0, `the sweep missed an old key: ${source}`);
  }

  const allowedKeys = [
    '  agent_ms: number;',
    'return { by_node: ranking, gargalo: worst };',
    '  input_requests: bottleneck.input_requests,',
    // The prompt's own table header: Portuguese content handed to an agent
    // (D18), in neither of the two positions a key can occupy.
    "    '| nó | agente (ms) | espera (ms) | fila (ms) | total (ms) | perguntas |',",
    // A name that merely starts the same way is not the old one.
    '  node_id: string;',
    // ...and the event vocabulary this fold READS, which is the taxonomy's.
    "      const target = asText(event.data.to_node_id);",
  ];
  for (const source of allowedKeys) {
    assert.deepEqual(
      keyHits(source, FLOW_LENS_KEYS),
      [],
      `the sweep flagged what is not a flow-lens key: ${source}`,
    );
  }
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

test('t266 — the surveyor manual proof reads the English fields the wire really answers', () => {
  const terms = [...apiTerms(), ...PROPOSAL_FIELDS];

  const hits = MANUAL_PROOF_FILES.flatMap((relative) => clientHitsOf(relative, terms));

  assert.deepEqual(
    hits,
    [],
    'the manual proof still reads or prints a Portuguese wire field, so it dies against a real ' +
      `control plane (D20, glossario-wire.md §1/§4.2):\n${hits.join('\n')}`,
  );
});

test('t266 — the sweep bites on a destructured read of the old wire and lets the new one through', () => {
  const terms = [...apiTerms(), ...PROPOSAL_FIELDS];

  // Every one of these is a line that really shipped in the manual proof, and
  // every one of them was green until this gate existed. The first is the one
  // the crossing died on: `events` bound to nothing, `.map` on `undefined`.
  const caught = [
    "    const { eventos: events } = await api(url, 'GET', `/v1/executions/${EXECUTION_ID}/events`);",
    "    const { propostas: proposals } = await api(url, 'GET', '/v1/proposals');",
    "    const { grafo: graph, grafo_versao: version } = await api(url, 'POST', '/v1/graphs', doc, 201);",
    '    log(`job ${job.id} created on node "${job.no_atual}"`);',
    "    if (proposal.status !== 'pendente') die(`the proposal is \"${proposal.status}\"`);",
    "    if (proposal.versao_aplicada_id !== null) die('something applied the proposal');",
    '    for (const id of proposal.evidencia.event_ids) {',
    '    if (graphAfter.grafo.versao_corrente_id !== version.id) {',
    '    console.log(`operacoes:        ${JSON.stringify(proposal.operacoes, null, 2)}`);',
    '    console.log(`metrica_esperada: ${JSON.stringify(proposal.metrica_esperada)}`);',
    // ...and the six of `close-surveyor-outcome.mjs`, which t285 found. The
    // second one is the one that killed every real run, on the third statement:
    // the wire answers `applied`, so the comparison was true for every proposal
    // that HAD an experiment to close.
    '  log(`proposal ${proposal.id} of graph "${proposal.grafo_id}" is "${proposal.status}"`);',
    "  if (proposal.status !== 'aplicada') {",
    '  if (proposal.resultado !== null && proposal.resultado !== undefined) {',
    '  const metric = proposal.metrica_esperada;',
    '  const appliedVersionId = proposal.versao_aplicada_id;',
    '  if (underApplied === undefined || underApplied.trabalhos < 1) {',
    '  console.log(`version:     ${written.versao_aplicada_id}`);',
    '  console.log(`outcome:     ${JSON.stringify(written.resultado)}`);',
  ];
  for (const source of caught) {
    assert.ok(clientHitsIn(source, terms).length > 0, `the sweep missed an old wire name: ${source}`);
  }

  const allowed = [
    "    const { events } = await api(url, 'GET', `/v1/executions/${EXECUTION_ID}/events`);",
    "    const { proposals } = await api(url, 'GET', '/v1/proposals');",
    "    const { graph, graph_version: version } = await api(url, 'POST', '/v1/graphs', doc, 201);",
    '    log(`job ${job.id} created on node "${job.current_node_id}"`);',
    "    if (proposal.status !== 'pending') die(`the proposal is \"${proposal.status}\"`);",
    "    if (proposal.applied_version_id !== null) die('something applied the proposal');",
    '    for (const id of proposal.evidence.event_ids) {',
    '    if (graphAfter.graph.current_version_id !== version.id) {',
    '    console.log(`operations:       ${JSON.stringify(proposal.operations, null, 2)}`);',
    '    console.log(`expected_metric:  ${JSON.stringify(proposal.expected_metric)}`);',
    // The same eight lines as t285 spells them now.
    '  log(`proposal ${proposal.id} of graph "${proposal.graph_id}" is "${proposal.status}"`);',
    "  if (proposal.status !== 'applied') {",
    '  if (proposal.result !== null && proposal.result !== undefined) {',
    '  const metric = proposal.expected_metric;',
    '  const appliedVersionId = proposal.applied_version_id;',
    '  if (underApplied === undefined || underApplied.jobs < 1) {',
    '  console.log(`version:     ${written.applied_version_id}`);',
    '  console.log(`outcome:     ${JSON.stringify(written.result)}`);',
    // A binding of this script's own is not a read of a body.
    '    const { root, repo } = createDisposableRepo();',
    // Portuguese CONTENT, which D18 keeps: the `grafo` inside `topógrafo` is a
    // word, not a field, and the accent is the only thing that says so.
    "        title: 'nota curta sobre o topógrafo de fluxo',",
    // ...and neither is the runner-internal result the proof destructures
    // nothing out of: `gargalo` is `SurveyorResult`'s, §5.6 keeps it.
    '    if (result.gargalo === null) die(`the real execution produced no time signal at all`);',
  ];
  for (const source of allowed) {
    assert.deepEqual(
      clientHitsIn(source, terms),
      [],
      `the sweep flagged what is not a Portuguese wire read: ${source}`,
    );
  }

  // The position itself: what a destructuring binds, and where it says it is.
  assert.deepEqual(
    destructuredSpans('const a = 1;\nconst { eventos: events, propostas } = body;\n'),
    [
      { line: 2, text: '.eventos' },
      { line: 2, text: '.propostas' },
    ],
    'the third position has to report each bound key at the line its declaration opens on',
  );
  assert.deepEqual(
    destructuredSpans('// const { eventos: events } = body;\nconst document = { eventos: [] };\n'),
    [],
    'a comment is not a binding, and neither is an object literal',
  );
});

test('t254 — every exempted span is still there, and still a span', () => {
  for (const entry of EXEMPT_SPANS) {
    const spans = readSpans(sourceOf(entry.file));
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
