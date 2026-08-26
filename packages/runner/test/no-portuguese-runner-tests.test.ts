/**
 * D24's last layer for this package: no Portuguese in `packages/runner/test/**`.
 *
 * t309 lifted the t180 exemption over `src/`, `scripts/` and `bin/` and
 * translated the 30 files it had been covering. It left the tests behind on
 * purpose, and said so: the assertions that quote a Portuguese literal the
 * source no longer emits were named, counted and handed forward. This file is
 * the other half of that handover — the same two sweeps, pointed at `test/`.
 *
 * `no-portuguese-user-facing-strings.test.ts` excludes `test/` by construction
 * and keeps excluding it: that guard quotes Portuguese prose to prove its own
 * detector bites, so a sweep that read it would fail on the evidence. The same
 * is true here, which is why {@link scannedFiles} skips the three language
 * gates and this very file.
 *
 * It started as two sweeps and is eight, because no one of them sees what the
 * next one does. Each arrived with the ticket that measured its class:
 *
 * - **AT1, the diacritics** (t312). A whole-file pass. It found 39 of the
 *   package's 81 non-gate test files when that ticket started, and 631
 *   diacritics in them.
 * - **AT2, the plain-ASCII Portuguese** (t312, grown by t318, t319 and t321).
 *   The same closed-stopword method the package guard uses, over the whole
 *   file rather than over its literals. It exists because a diacritic grep is
 *   a floor and not a checklist: t309's closing note measured two files that
 *   go red on Portuguese carrying no accent at all —
 *   `dispatch/pre-session-failure.test.ts` (`desbloqueie`, and a
 *   `/srv/bancos/…` path) and `intake/prompt.test.ts` (`para depois`,
 *   `opcional`) — and neither is visible to AT1.
 * - **AT3, what the masks hide** (t317). The tokens AT2 has to blank to be
 *   usable at all, spelled only where the wire needs them.
 * - **AT4, a wire word borrowed as prose** (t320): a word that IS a field
 *   somewhere in `src/`, used where no wire reads it back.
 * - **AT5, a name the wire never carried** (t323): AT4's mirror image, and
 *   worse — a spelling that LOOKS like the wire and never was.
 * - **AT6, Portuguese inside a machine name** (t321): the segments the masks
 *   blank whole, which a person and not the wire named. See
 *   {@link SCRATCH_WORDS}.
 * - **AT7, a name something renamed** (t322): the one class that is not a
 *   language problem at all. See {@link RETIRED_NAMES}.
 * - **AT8, a header that reports the wrong language** (t322): a docstring
 *   describing a file that stopped being that way. See {@link LANGUAGE_CLAIMS}.
 *
 * **This set is these tickets' own verification, not a permanent gate.** The
 * canonical `no-portuguese-*` guards still exclude `test/`, and folding this
 * scope into them belongs to the gate ticket that closes the series. Until
 * then these sweeps are a cheap regression check, and deleting them when that
 * ticket subsumes them costs nothing.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const TEST_ROOT = path.resolve(import.meta.dirname);

/** What counts as a test artifact here: the suites, their helpers, their data. */
const SCANNED_EXTENSION = /\.(?:ts|mjs|json|jsonl)$/;

/**
 * Portuguese by construction, and therefore never scanned.
 *
 * The three language gates are Portuguese ON PURPOSE — each one quotes the
 * prose it refuses so that a reader can see the detector bite, and each has its
 * own meta-test asserting exactly that. This file is the fourth for the same
 * reason: {@link STOPWORDS} below is a list of Portuguese words.
 */
const SELF_AND_GATES: ReadonlySet<string> = new Set([
  'no-portuguese-identifiers.test.ts',
  'no-portuguese-user-facing-strings.test.ts',
  'no-portuguese-wire.test.ts',
  'no-portuguese-runner-tests.test.ts',
]);

/**
 * Every test artifact of the package, in path order.
 *
 * A walk and not a list, for the reason t309 wrote down when it replaced the
 * package guard's `SCANNED_FILES`: a list records the files that existed the
 * day somebody wrote it, and a directory cannot forget to add itself.
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
 * Pinned by line and not by shape, for the reason the package guard's own two
 * pin lists are: what excuses a line is INTENT, and no regular expression
 * encodes intent. A line that moves breaks this list loudly, and somebody
 * re-reads the exception instead of inheriting it — which is the whole point.
 */
const OUT_OF_SCOPE: ReadonlyArray<{ file: string; line: number; reason: string }> = Object.freeze([
  {
    file: 'surveyor/spread.test.ts',
    line: 196,
    reason: 'a Portuguese DETECTOR, not Portuguese prose: the same shape the package guard is built from',
  },
  {
    file: 'engine/command.test.ts',
    line: 561,
    reason: 'names the two-byte character the fixture below is built from; the fixture is about bytes, not language',
  },
  {
    file: 'engine/command.test.ts',
    line: 564,
    reason: 'a run of one two-byte character, sized against the argv byte limit',
  },
  {
    file: 'engine/codex-command.test.ts',
    line: 411,
    reason: 'the same two-byte fixture, for the codex adapter',
  },
  {
    file: 'dispatch/render-input-values.test.ts',
    line: 216,
    reason: 'names the two-byte character that puts the truncation cap at an odd byte offset',
  },
  {
    file: 'dispatch/render-input-values.test.ts',
    line: 219,
    reason: 'the two-byte run itself',
  },
  {
    file: 'dispatch/render-input-values.test.ts',
    line: 221,
    reason: 'asserts the byte offset that run lands on',
  },
  {
    file: 'fixtures/codex-input-request.jsonl',
    line: 4,
    reason: 'a RECORDED frame of a real credentialed codex run; rewriting a recording falsifies the evidence (D24)',
  },
  {
    file: 'surveyor/close-outcome.e2e.test.ts',
    line: 38,
    reason: 'an English sentence that LISTS the frozen wire keys, `depois` among them, and names the decision freezing each',
  },
  {
    file: 'dispatch/dispatch.test.ts',
    line: 446,
    reason:
      '`packages/core/src/repositories/input-request.ts:265` WRITES this block reason; the assertion reads it back off a live control plane and has to spell it the way the wire does',
  },
]);

/** Any of these means the line around it is Portuguese. */
const DIACRITICS = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;

/**
 * Plain-ASCII Portuguese, closed and short.
 *
 * Five groups. The first is the package guard's own list: function words a
 * Portuguese sentence cannot avoid. The second is the content words this
 * package's tests actually used — every one measured in a file t312
 * translated, not imagined. The third is t318's: the prose a test INVENTS for
 * illustration, which is neither a function word nor a term of the domain, and
 * so belonged to no earlier list. The fourth is t319's: the text a fixture
 * writes about ITSELF — the reason it hands the block route, the message it
 * commits with, the ticket it says it came from. The fifth is t321's: the whole
 * of a scratch name that is a single bare word, which is the half of that
 * ticket's class {@link SCRATCH_WORDS} cannot reach. A closed list only catches
 * what somebody has seen before, which is exactly why AT1 runs beside it
 * rather than instead of it.
 */
const STOPWORDS: readonly string[] = Object.freeze([
  // function words
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
  // content words this package's tests carried
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
  'triagem',
  // t318: the prose a test invents for illustration
  //
  // An escalation's options, the two halves of a decoded assistant message, a
  // commit message a git fixture writes. None carries an accent and none is a
  // term of this domain, so both earlier groups walked past all eight lines.
  // Every word here was measured in a file this ticket translated.
  'renumerar',
  'manter',
  'primeira',
  'segunda',
  'parte',
  'partes',
  // t319: the text a fixture writes about itself
  //
  // Two block reasons a test hands the block route, the README and the commit
  // message every git fixture is built from, the `source` a graph fixture
  // signs its metadata with, and one job title. None is read back by anything
  // — the only line of this shape that IS read back is pinned above — and
  // none carries an accent, so all three earlier groups walked past them.
  //
  // `da` earns its place the way `nao` does, as a function word: it is the
  // whole of what is Portuguese in `Repo de fixture da t160`, and `de` cannot
  // join it because `de` is a frozen key of `metrica_esperada`. `entrega` and
  // its family stay OUT for the reason {@link ILLUSTRATIVE_IDS} records: they
  // are node ids of a repo-wide convention, not prose.
  'da',
  'fim',
  'caso',
  'teste',
  'aguardando',
  'resposta',
  'pergunta',
  'inicial',
  // t321: the bare word a scratch name is, when the name is one word long
  //
  // AT6 below reads the Portuguese hiding INSIDE a machine name, and cannot
  // read a name that is not one: a directory called `principal`, a branch
  // called `experimento`, a job title `colisao`, a filler argv `sobra`, a
  // branch template `tese-${jobId}` whose `-` is followed by an interpolation
  // and so forms no kebab span at all. AT2 was always the sweep that could see
  // these five — it simply had no word for any of them.
  'principal',
  'experimento',
  'colisao',
  'sobra',
  'tese',
]);

/**
 * Wire tokens the source tickets decided to keep, and this sweep must not fire on.
 *
 * `sempre` is the `condition` a single-exit edge carries, documented at
 * `docs/spec/graph.md:547` and taught by `src/synthesizer/prompt.ts`; `para` is
 * a required key of an edge and of `metrica_esperada`, and the package guard
 * freezes it in its own `WIRE_LITERALS` for the same reason. Both would fire on
 * the stopword pass and both are data, so they are removed from the text before
 * it is read rather than argued about at every call site (t309, FR6).
 *
 * `sessao` is the third: `src/dispatch/report.ts:589` signs an event actor with
 * it when the job stands on no node, and t309 translated that file around the
 * literal without touching it. A test that asserts the signature has to spell
 * it the way the wire does.
 *
 * The other kept tokens — `resultado` and its `aprovado`/`retrabalho` values,
 * `grafo-proposto`, `no_com_contrato`, `grafo_invalido` and
 * `intake-proposto.json` — need no entry here: none of them is a stopword, and
 * the machine-name masking below already blanks the snake and kebab shapes.
 *
 * Built from a list of strings rather than written as a regex literal: a
 * literal is CODE, and `no-portuguese-identifiers.test.ts` — which does scan
 * `test/` — reads these three as Portuguese identifiers there. Inside a string
 * they are masked, the same way `src/dispatch/report.ts` spells `sessao`.
 */
const PROTOCOL_TOKENS = new RegExp(`\\b(?:${['sempre', 'para', 'sessao'].join('|')})\\b`, 'g');

/**
 * Shapes that are a machine name rather than a word of prose.
 *
 * Narrow on purpose. The package guard can afford to blank every quoted span
 * because it reads one literal at a time and already knows the literal is a
 * message; a whole-file pass has no such context, and blanking quotes here
 * would hide exactly the Portuguese test data this ticket exists to remove. So
 * only the shapes that cannot be a Portuguese sentence are masked: `snake_case`
 * (`no_com_contrato`, `metrica_esperada`), `kebab-case` (`travessia-fazer`),
 * dotted paths (`input.producao.nota`) and the flags a person types.
 */
const MACHINE_NAMES: readonly RegExp[] = Object.freeze([
  // a dotted name written into a regex literal: `\.grafo\.rascunho\.json`,
  // which is the draft suffix `src/synthesizer/synthesize.ts` exports
  /(?:\\\.[A-Za-z0-9_]+)+/g,
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)+\b/g,
  /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g,
  /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g,
  /--?[A-Za-z][A-Za-z0-9-]*/g,
]);

/**
 * Node and skill ids this repository reuses as illustration, everywhere.
 *
 * `fazer` is a node of the two `spike-real-session*.mjs` proofs and of the skill
 * manifest they both name — files this ticket does not touch — so a test that
 * dispatches it has to spell it the way they do. It is a Portuguese verb, which
 * is the only reason it needs saying: the other illustrative ids of the same
 * family (`implementar`, `conferir`, `publicar`, `redigir`, `revisar`) are not
 * words the stopword list has.
 *
 * The full argument for leaving them alone is in this ticket's Out of Scope:
 * they are shared with `schema/examples/`, `docs/spec/` and three other
 * packages, and renaming half of a repo-wide convention is worse than the
 * convention.
 */
const ILLUSTRATIVE_IDS = new RegExp(`\\b(?:${['fazer'].join('|')})\\b`, 'g');

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
  let masked = text.replace(PROTOCOL_TOKENS, blank).replace(ILLUSTRATIVE_IDS, blank);
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

/**
 * The Portuguese the two sweeps above are blind to, by construction.
 *
 * Both masks exist for good reasons and both stay. {@link PROTOCOL_TOKENS}
 * blanks `sessao` before the stopword pass reads a line, because
 * `src/dispatch/report.ts:589` really does sign an actor with that literal;
 * {@link MACHINE_NAMES} blanks every kebab span, because that is what keeps
 * `nota-curta` and `grafo-proposto` out of the report. Together, though, they
 * hide a whole class of line neither was meant to excuse: an arbitrary local
 * scratch directory named in Portuguese. `worktree-da-sessao`,
 * `sessao-${jobId}-${serial}`, `sessao-boa` and `quadro-sucesso` were all in
 * this tree the day t312 declared it English, and both sweeps walked over
 * every one of them in silence (t317).
 *
 * AT3 is the difference between a token-wide excuse and a per-line one. The
 * wire token is kept where the wire needs it and nowhere else, and
 * {@link KEPT_TOKENS} is the whole list of places the wire needs it.
 *
 * Built from a list of strings and not written as a regex literal, for the
 * same reason {@link PROTOCOL_TOKENS} is: a literal is CODE, and
 * `no-portuguese-identifiers.test.ts` — which does scan this directory — reads
 * `sessao` in code position as a Portuguese identifier.
 */
const MASKED_TOKENS = new RegExp(
  `\\b(?:${['sessao', 'sessoes', 'sucesso', 'sucessos'].join('|')})\\b`,
  'i',
);

/**
 * Every line allowed to spell one of those tokens, and why it is allowed.
 *
 * One case, and it is the wire: a work standing on no node has its question
 * signed with the bare literal, and a test that asserts the signature has to
 * spell it the way the event does. Everything else the reproduction found was
 * a directory name a person invented on the spot, with nothing on the other
 * end of it reading the name back — so it reads in English now.
 */
const KEPT_TOKENS: ReadonlyArray<{ file: string; line: number; reason: string }> = Object.freeze([
  {
    file: 'dispatch/report.test.ts',
    line: 640,
    reason: 'the case name quotes the wire value the assertion below checks',
  },
  {
    file: 'dispatch/report.test.ts',
    line: 649,
    reason: '`src/dispatch/report.ts:589` signs the actor with this literal; the assertion spells it the way the wire does',
  },
]);

/**
 * Every line of one file that spells one of `pattern`'s tokens, pinned or not.
 *
 * @param relative A path under `test/`, as {@link scannedFiles} returns one.
 * @param pattern The token alternation to look for, one line at a time.
 */
function linesSpelling(
  relative: string,
  pattern: RegExp,
): Array<{ file: string; line: number; text: string }> {
  const source = readFileSync(path.join(TEST_ROOT, relative), 'utf8');
  return source.split('\n').flatMap((text, index) =>
    pattern.test(text)
      ? [{ file: relative, line: index + 1, text: text.trim().slice(0, 120) }]
      : [],
  );
}

/**
 * A word that IS a wire key somewhere in `src/`, and prose everywhere else.
 *
 * The class AT4 exists for, and it is not AT3's. `motivo` carries no accent, so
 * AT1 is blind to it; it is nobody's function word and nobody's term of this
 * domain, so no {@link STOPWORDS} group ever had it; and no mask hides it, so
 * AT3 would not have been the sweep to add it to either. What it has instead is
 * an alibi: `src/dispatch/parse-permission-denial.ts:35` declares
 * `PermissionDenial.motivo`, and a test that reads that field has to spell it
 * the way the interface does.
 *
 * The alibi is real in four lines and borrowed in the rest. A local `const` for
 * a value read off the English `reason` field, a loop variable over refusal
 * reasons, a key invented for an illustrative output schema — none of those has
 * a wire on the other end, and each one reads as though the product spoke
 * Portuguese there (t320).
 *
 * Built from a list of strings and not written as a regex literal, for the same
 * reason {@link PROTOCOL_TOKENS} and {@link MASKED_TOKENS} are: a literal is
 * CODE, and `no-portuguese-identifiers.test.ts` scans this directory.
 */
const WIRE_WORDS = new RegExp(`\\b(?:${['motivo', 'motivos'].join('|')})\\b`, 'i');

/**
 * Every line allowed to spell one of those words, and why it is allowed.
 *
 * Two files, and both mirror the same still-Portuguese interface: the tracker
 * builds a `PermissionDenial`, the reporter reads one, and neither test can
 * name that field in English while the type declares it in Portuguese.
 * Translating the interface is a `src/` change and belongs to whoever owns the
 * denial path, not to a sweep over `test/`.
 */
const WIRE_MIRRORS: ReadonlyArray<{ file: string; line: number; reason: string }> = Object.freeze([
  {
    file: 'dispatch/parse-permission-denial.test.ts',
    line: 83,
    reason: 'reads `PermissionDenial.motivo`, the field `src/dispatch/parse-permission-denial.ts:35` declares',
  },
  {
    file: 'dispatch/parse-permission-denial.test.ts',
    line: 84,
    reason: 'the same read, quoted in the failure message the assertion above prints',
  },
  {
    file: 'dispatch/report.test.ts',
    line: 323,
    reason: 'the denial fixture IS a `PermissionDenial`, so its field is spelled the way the interface spells it',
  },
  {
    file: 'dispatch/report.test.ts',
    line: 346,
    reason: 'asserts the English `reason` the report sends is that Portuguese field (`src/dispatch/report.ts:395`)',
  },
]);

/**
 * A name the wire RETIRED, or never carried at all.
 *
 * AT4's class is a live wire word borrowed as prose. This one is its mirror
 * image, and strictly worse: a name that LOOKS like the wire and is not, so a
 * reader who trusts it goes looking for a field no route has. All four sweeps
 * above are blind to every one of these — none carries an accent (AT1), none
 * is on a stopword list and three of them are `snake_case`, which
 * {@link MACHINE_NAMES} blanks before AT2 ever reads the line (AT2), no mask
 * hides them (AT3), and none is a word `src/` still spells (AT4).
 *
 * The damage is not cosmetic, and `bin.e2e.test.ts` is the proof. It posted
 * `teto_runner`/`teto_projeto` to `POST /v1/leases`, which has required
 * `runner_cap`/`project_cap` since t226 (`packages/core/src/routes/leases.ts`),
 * so the call meant to prove the runner had paired answered `400 invalid_body`
 * — and the assertion under it read `notEqual(status, 404)`, which a 400
 * satisfies. Three lines on, `doesNotMatch(body, /runner_desconhecido/)`
 * refused an error code the same ticket retired, and therefore refused
 * nothing. The case stayed green for exactly as long as the pairing it claimed
 * to prove was broken.
 *
 * The other two are the same shape with nothing masking them. `registrado_em`
 * on a skill fixture is a key `GET /v1/skills/:id` has spelled `registered_at`
 * since t290 (`packages/core/src/repositories/skill.ts:122`), and
 * `source: 'humano'` is not a translation of anything at all:
 * `input_request.source` is a closed enum of `user` and `auto`, and `humano`
 * was never one of the two.
 *
 * ## What was measured and deliberately left out
 *
 * `erro` is not on this list, and the next reader should know it was measured
 * rather than missed: ten lines across eight files build a fake control-plane
 * error body under that key, where every real refusal envelope says `error`
 * (`packages/core/src/routes/common.ts:191`). That is one class and one
 * ticket, and folding it in would have turned a sweep of five names into a
 * rename of eight files.
 *
 * `origem` is out for the opposite reason. It is still a LIVE key of the
 * engine-model projection (`packages/core/src/repositories/engine-models.ts:21`),
 * so no token sweep can tell the live use from the dead one — which is the
 * boundary of this whole instrument. The single line that used it for what the
 * input request calls `source` is corrected where it stands, with no entry
 * here.
 *
 * Built from a list of strings and not written as a regex literal, for the same
 * reason {@link PROTOCOL_TOKENS}, {@link MASKED_TOKENS} and {@link WIRE_WORDS}
 * are: a literal is CODE, and `no-portuguese-identifiers.test.ts` scans this
 * directory.
 */
const WIRE_FICTIONS = new RegExp(
  `\\b(?:${['teto_runner', 'teto_projeto', 'registrado_em', 'runner_desconhecido', 'humano'].join('|')})\\b`,
  'i',
);

/**
 * Every line allowed to spell a fiction, and why it is allowed.
 *
 * One case, and it is the only shape that can survive this sweep honestly: a
 * test that REFUSES the retired spelling has to name what it refuses. Every
 * other occurrence the reproduction found was a fixture claiming to depict a
 * wire, and a fixture that depicts a wire nobody speaks is not evidence.
 */
const FICTION_PINS: ReadonlyArray<{ file: string; line: number; reason: string }> = Object.freeze([
  {
    file: 'cli/index.test.ts',
    line: 604,
    reason: 'asserts the retired spelling is ABSENT from the usage text; a refusal has to name what it refuses',
  },
]);

/**
 * What each fiction was replaced by, and the file whose word is final on it.
 *
 * This is the other half of the sweep, and t319 wrote down why it has to
 * exist: a claim a reader cannot check is how an exception outlives its
 * reason. AT5 bans five names on the grounds that no source emits them, and
 * that ground is itself checkable — so it is checked, per name, against the
 * file that owns the field. The day core brings one of these spellings back,
 * this fails and names the ban to lift instead of leaving five tests refusing
 * a live wire.
 *
 * Paths are from the repository root, because two of the three authorities
 * are core's and one of them is a migration.
 */
const REPLACEMENTS: ReadonlyArray<{
  fiction: string;
  live: RegExp;
  file: string;
  authority: string;
}> = Object.freeze([
  {
    fiction: 'teto_runner',
    live: /'runner_cap'/,
    file: 'packages/core/src/routes/leases.ts',
    authority: 'the required body fields of POST /v1/leases',
  },
  {
    fiction: 'teto_projeto',
    live: /'project_cap'/,
    file: 'packages/core/src/routes/leases.ts',
    authority: 'the required body fields of POST /v1/leases',
  },
  {
    fiction: 'runner_desconhecido',
    live: /'unknown_runner'/,
    file: 'packages/core/src/routes/leases.ts',
    authority: 'the 404 an unpaired runner gets from the same route',
  },
  {
    fiction: 'registrado_em',
    live: /^ {2}registered_at: string;$/m,
    file: 'packages/core/src/repositories/skill.ts',
    authority: 'the column GET /v1/skills/:id projects',
  },
  {
    fiction: 'humano',
    live: /CHECK \(source IN \('user','auto'\)\)/,
    file: 'packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql',
    authority: "the CHECK that closes input_request.source to two values, neither of them this one",
  },
]);

/**
 * The spans {@link MACHINE_NAMES} blanks that a PERSON, not the wire, names.
 *
 * AT6's class, and it is a hole the two masks cut between them rather than a
 * word any list was missing. {@link MACHINE_NAMES} blanks a kebab span whole,
 * which is what keeps `nota-curta` and `grafo-proposto` out of AT2's report;
 * the price is that everything inside such a span is invisible too, and a
 * scratch directory, a branch, a temp prefix, a problem class or a case label
 * is exactly that shape. `despacho-com-negacao.json`, `banco-de-testes`,
 * `cartografo-t259-fabrica-`, `selecao-de-modelo-declarado`, `sem-arquivo` and
 * `um-no-que-ninguem-declarou` were all in this tree the day t312 declared it
 * English, and no sweep could see one of them: they carry no accent, so AT1 is
 * blind; they are masked, so AT2 is; they spell none of the four masked tokens,
 * so AT3 is; no `src/` interface declares any of these words, so AT4 has no
 * alibi to check them against; and every one of them is a name a PERSON
 * invented rather than one the wire retired, so AT5 has nothing to match
 * (t321).
 *
 * The snake_case shape is the one deliberately left out. `banco_de_testes`,
 * `metrica_esperada`, `no_com_contrato`, `contexto_falha`, `ponta_do_principal`
 * and `custo_por_travessia` are wire keys frozen by earlier decisions, and
 * snake_case is how this repository spells the wire. So AT6 reads the shapes a
 * test invents — kebab, dotted, and the flags a person types — and leaves the
 * wire's own shape to {@link PROTOCOL_TOKENS} and the guards that own it.
 */
const SCRATCH_SPANS: readonly RegExp[] = Object.freeze([
  // the same dotted name written into a regex literal MACHINE_NAMES reads
  /(?:\\\.[A-Za-z0-9_]+)+/g,
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)+\b/g,
  /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g,
  /--?[A-Za-z][A-Za-z0-9-]*/g,
]);

/**
 * The Portuguese a scratch name is built from, segment by segment.
 *
 * Closed and measured, like every other list here: each word was counted in a
 * name this ticket renamed. Two groups, and the second is the reason AT6 is a
 * segment pass and not another whole-line one — `sem`, `nao`, `que`, `ninguem`,
 * `um` and `ja` are unreadable as a line-wide pattern and unambiguous as a
 * kebab segment, because no English identifier of this tree has a segment
 * spelled that way.
 *
 * Three words a reader will look for and not find, each left out on purpose:
 *
 * - `no`, which is `nó` in `roteamento-por-no-at3` and plain English in
 *   `no-graph.json`, `no-op` and `no-portuguese-identifiers.test.ts`. A segment
 *   that means both cannot be a detector.
 * - `classe` and `registro`, which survive only where a comment quotes a name
 *   the product RETIRED — the `--classe` flag D20 §5.2 replaced, the
 *   `registro-monitoramento` node the bets bundle renamed. Those are verbatim
 *   quotations of pre-existing Portuguese, and every scratch name they would
 *   have caught is already caught by a word beside them.
 *
 * The illustrative node and skill ids stay out for the reason
 * {@link ILLUSTRATIVE_IDS} records — `travessia`, `grafo`, `nota`, `revisar`,
 * `implementar`, `conferir`, `publicar` and the rest are a repo-wide
 * convention shared with `schema/examples/`, `docs/spec/` and three other
 * packages, and renaming half of a convention is worse than the convention.
 */
const SCRATCH_WORDS: ReadonlySet<string> = new Set([
  // the content words a scratch name was built from
  'antigo',
  'arquivo',
  'ausente',
  'avanca',
  'banco',
  'bloco',
  'contexto',
  'credencial',
  'declarado',
  'declarou',
  'desconhecida',
  'despacho',
  'escala',
  'fabrica',
  'fecha',
  'fechamento',
  'injetado',
  'negacao',
  'pendurada',
  'portao',
  'primeiro',
  'projecao',
  'quadro',
  'recusa',
  'registrada',
  'registrou',
  'resolvido',
  'rota',
  'roteamento',
  'segundo',
  'selecao',
  'teto',
  'torto',
  'transitorio',
  'unica',
  'vazio',
  'vazios',
  'vazou',
  // the function words, readable only because a segment is not a line
  'ja',
  'nao',
  'ninguem',
  'que',
  'sem',
  'um',
]);

/**
 * The Portuguese segments of one line's machine names, if any.
 *
 * @param text One raw line of a scanned file.
 * @returns Every offending segment found, sorted, or an empty list.
 */
export function scratchNamesIn(text: string): string[] {
  const found = new Set<string>();
  for (const span of SCRATCH_SPANS) {
    for (const match of text.matchAll(span)) {
      for (const segment of match[0].split(/[-.\\]+/)) {
        const word = segment.toLowerCase();
        if (SCRATCH_WORDS.has(word)) found.add(word);
      }
    }
  }
  return [...found].sort();
}

/** The lines of one file whose machine names carry Portuguese, as AT6 reports them. */
function scratchHitsInFile(relative: string): string[] {
  const source = readFileSync(path.join(TEST_ROOT, relative), 'utf8');
  return source.split('\n').flatMap((text, index) => {
    const found = scratchNamesIn(text);
    if (found.length === 0) return [];
    return [`${relative}:${index + 1} — ${found.join(', ')} — ${text.trim().slice(0, 120)}`];
  });
}

/**
 * A name something RENAMED, still quoted as though it were the current one.
 *
 * The class this sweep exists for is not a language problem, and that is the
 * whole gotcha: renaming a column, a flag or an enum value moves every line of
 * `src/` that reads it and no line of prose that describes it. The comment goes
 * on saying `heartbeat_em` long after the route answers `heartbeat_at`, and it
 * says it in a sentence that mentions no language at all, so a reader who trusts
 * it goes looking for a field no route has — the same damage AT5 measures, from
 * the other direction.
 *
 * The six sweeps before it are blind to every one of these, and each for its
 * own reason. None carries an accent (AT1). Six of the eight tree-wide names are
 * `snake_case`, which {@link MACHINE_NAMES} blanks before the stopword pass ever
 * reads the line, and the rest are on no stopword group (AT2). No mask hides
 * them (AT3). None is a word `src/` still spells in the position the line claims
 * (AT4). None is an invention: every one of them was a REAL name once, which is
 * exactly what AT5's list is not (AT5). And none is a segment of a scratch name
 * a person invented — `snake_case` is the shape AT6 leaves alone on purpose, and
 * the one dotted span here (`<classe>.grafo.rascunho.json`) is built from the
 * two words {@link SCRATCH_WORDS} deliberately excludes (AT6).
 *
 * ## The authority, and why it is not a source file
 *
 * AT5 grounds each ban by reading the file that owns the field. That works for
 * an invention, because an invention has no history. A rename does, and this
 * repository already keeps the register of it: `docs/spec/glossario-wire.md` is
 * the table of what every wire name was and what it became, row by row, with the
 * file that defines it. So a ban here cites a ROW, and the day the glossary
 * stops carrying it the ground test fails and names the ban to lift.
 *
 * Two renames are nobody's wire row and are grounded where they really live.
 * The graph document's keys are `schema/graph.schema.json`'s property names,
 * because the schema is what a proposal is validated against. The synthesizer's
 * draft placeholder is `src/synthesizer/synthesize.ts`'s, which documents the
 * default path in the same words its `--help` prints.
 *
 * ## Scope, which is the whole instrument
 *
 * {@link RetiredName.scope} is not decoration and it is not a shortcut around a
 * pin list: it is what keeps a ban off the files where the same spelling is
 * still alive. `nome`, `descricao` and `classe` are LIVE fields of
 * `SimilarClass` (`src/synthesizer/prompt.ts:57-66`), so the graph-document
 * group is scoped to the two files that BUILD a graph document and
 * `synthesizer/prompt.test.ts` goes on spelling them the way the interface does.
 * `uso` is the sharper case: `src/engine/types.ts:248` and
 * `docs/formats/engine-adapter.md:1137` still call the token totals that, and
 * `engine/conformance.claude-code.test.ts` mirrors both almost verbatim — that
 * is AT4's boundary, and a sweep built to fire on a word `src/` still spells is
 * a gate somebody turns off. `agente` is the same shape from the other end: its
 * second occurrence is Portuguese fixture prose in
 * `dispatch/parse-fenced-json.test.ts`, a file no part of this reproduction
 * touches. Both are banned in the one suite that quoted them as current.
 *
 * There is no line pin here, and none was needed: a scope is a reason somebody
 * has to write down, where a pinned line number is one somebody can inherit.
 *
 * ## What was measured and deliberately left out
 *
 * `classe` and `--classe` are not on this list. The tests that spell them REFUSE
 * them: `synthesizer/cli.test.ts` and `intake/command-line.test.ts` both prove
 * the retired flag is gone from the help text, and a refusal has to name what it
 * refuses. What IS banned is the usage placeholder `<classe>`, which no refusal
 * needs and which one test title still promised where the CLI prints `<class>`.
 *
 * `FiltroDeEventos` is out because it is not a wire name and the glossary
 * therefore has no row for it: it is the old identifier of `EventFilter`
 * (`packages/core/src/db/events.ts:159`), quoted by the same comment as
 * `trabalho_id`, and corrected beside it with nothing to cite.
 *
 * Built from a list of strings and not written as regex literals, for the same
 * reason {@link PROTOCOL_TOKENS}, {@link MASKED_TOKENS}, {@link WIRE_WORDS} and
 * {@link WIRE_FICTIONS} are: a literal is CODE, and
 * `no-portuguese-identifiers.test.ts` scans this directory.
 */
interface RetiredName {
  /** The spelling the line still uses. */
  stale: string;
  /** What the artifact that owns the name calls it today. */
  live: string;
  /** Which document is final on the rename. */
  authority: 'glossary' | 'graph-schema' | 'draft-path';
  /** The files the ban covers. Absent means the whole tree. */
  scope?: readonly string[];
}

/**
 * The two files that build a graph document, and therefore name its keys.
 *
 * Both declare it in the same words — "in the shape of
 * `schema/graph.schema.json`" — over a literal that spelled seven of those keys
 * in a language the schema does not have.
 */
const GRAPH_DOCUMENT_FILES: readonly string[] = Object.freeze([
  'synthesizer/parse-graph-proposal.test.ts',
  'synthesizer/synthesize.e2e.test.ts',
]);

/** The suite that quoted two event-payload keys the taxonomy had already moved. */
const DISPATCH_SUITE: readonly string[] = Object.freeze(['dispatch/dispatch.test.ts']);

/** The suite whose titles quote the synthesizer's usage text. */
const SYNTHESIZER_CLI: readonly string[] = Object.freeze(['synthesizer/cli.test.ts']);

/** Every retired name this sweep bans, with the rename each one is behind. */
const RETIRED_NAMES: ReadonlyArray<RetiredName> = Object.freeze([
  // The wire, by glossary row, everywhere in the tree.
  { stale: 'trabalho_id', live: 'job_id', authority: 'glossary' },
  { stale: 'grafo_versao_id', live: 'graph_version_id', authority: 'glossary' },
  { stale: 'tempo_esgotado', live: 'timed_out', authority: 'glossary' },
  { stale: 'heartbeat_em', live: 'heartbeat_at', authority: 'glossary' },
  { stale: 'trabalho_ja_leased', live: 'job_already_leased', authority: 'glossary' },
  { stale: 'heartbeat_perdido', live: 'heartbeat_lost', authority: 'glossary' },
  { stale: 'expirou', live: 'ttl_elapsed', authority: 'glossary' },
  { stale: 'ativa', live: 'active', authority: 'glossary' },
  // The wire again, in the one suite that quoted it: `src/` still spells both.
  { stale: 'uso', live: 'usage', authority: 'glossary', scope: DISPATCH_SUITE },
  { stale: 'agente', live: 'agent', authority: 'glossary', scope: DISPATCH_SUITE },
  // The graph document, by schema property, in the two files that build one.
  { stale: 'tipo', live: 'type', authority: 'graph-schema', scope: GRAPH_DOCUMENT_FILES },
  { stale: 'nome', live: 'name', authority: 'graph-schema', scope: GRAPH_DOCUMENT_FILES },
  { stale: 'versao', live: 'version', authority: 'graph-schema', scope: GRAPH_DOCUMENT_FILES },
  { stale: 'descricao', live: 'description', authority: 'graph-schema', scope: GRAPH_DOCUMENT_FILES },
  { stale: 'papel', live: 'role', authority: 'graph-schema', scope: GRAPH_DOCUMENT_FILES },
  { stale: 'contrato', live: 'contract', authority: 'graph-schema', scope: GRAPH_DOCUMENT_FILES },
  { stale: 'comando', live: 'command', authority: 'graph-schema', scope: GRAPH_DOCUMENT_FILES },
  // The usage placeholder, by the doc comment that prints it.
  { stale: '<classe>', live: '<class>', authority: 'draft-path', scope: SYNTHESIZER_CLI },
]);

/**
 * Whether `text` spells `name` as a name, and not as a slice of a longer one.
 *
 * The boundaries are `no-portuguese-wire.test.ts`'s, and they are wider than
 * `\b` on purpose: `\b` would read `trabalho_id` inside `depende_de_trabalho_id`
 * and `ativa` inside `lease_nao_ativa`, and both of those are other names.
 *
 * @param text One raw line of a scanned file.
 * @param name The retired spelling to look for.
 */
function spellsName(text: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_$-])${name}(?![A-Za-z0-9_$-])`).test(text);
}

/** Every line of the tree that spells a retired name, as `file:line — what`. */
function retiredHits(): string[] {
  const hits: string[] = [];

  for (const file of scannedFiles()) {
    const covered = RETIRED_NAMES.filter(
      (entry) => entry.scope === undefined || entry.scope.includes(file),
    );
    if (covered.length === 0) continue;

    readFileSync(path.join(TEST_ROOT, file), 'utf8')
      .split('\n')
      .forEach((text, index) => {
        for (const entry of covered) {
          if (!spellsName(text, entry.stale)) continue;
          hits.push(
            `${file}:${index + 1} — \`${entry.stale}\` (today \`${entry.live}\`) — ${text.trim().slice(0, 100)}`,
          );
        }
      });
  }

  return hits;
}

/**
 * A header that reports the LANGUAGE of an artifact it does not read.
 *
 * The other half of the same defect, and no token sweep can reach it: there is
 * no retired name on these lines at all. What there is instead is a claim —
 * "the prompt's own prose is Portuguese", "the graph document's keys are the
 * published, Portuguese surface" — sitting in a docstring, describing a file
 * that stopped being that way several tickets ago. Every one of the three was
 * true when it was written and none of them was ever revisited, because nothing
 * reads a rationale.
 *
 * The check is the same shape AT7's ground test is: the claim is pinned, and so
 * is the artifact that settles it. The day `src/intake/prompt.ts` really does go
 * back to Portuguese prose, the ground test fails and names the claim to
 * restore, instead of leaving a header that says the opposite of the file.
 *
 * ## What was measured and deliberately left out
 *
 * Twenty-two other headers in this tree carry a sentence of the same shape —
 * "English per D18; X stays in Portuguese" — and they are NOT pinned here. They
 * are not all wrong: route segments, payload keys and recorded transcripts
 * really do stay Portuguese, and each one needs its own artifact read to tell
 * which kind it is. That is a sweep of its own and it is the gate ticket's, not
 * this one's. The three below are the three this reproduction measured, and each
 * is contradicted by the very file it names.
 */
const LANGUAGE_CLAIMS: ReadonlyArray<{
  file: string;
  about: string;
  english: RegExp;
  claim: RegExp;
  reason: string;
}> = Object.freeze([
  {
    file: 'dispatch/prompt.test.ts',
    about: 'packages/runner/src/dispatch/prompt.ts',
    english: /English, content included \(D24, t309\)/,
    claim: /the prompt's own CONTENT is Portuguese/,
    reason: 'the module it tests records the OPPOSITE, at length, and the header cites it as agreeing',
  },
  {
    file: 'intake/prompt.test.ts',
    about: 'packages/runner/src/intake/prompt.ts',
    english: /English, the prompt's own PROSE included \(D24, t309\)/,
    claim: /the prompt's own prose is Portuguese/,
    reason: "`INTAKE_INSTRUCTIONS` is English, and the module's own header says so",
  },
  {
    file: 'synthesizer/synthesize.e2e.test.ts',
    about: 'schema/graph.schema.json',
    english: /"initial_node":/,
    claim: /the graph document's keys are the\s+\*\s+published, Portuguese surface/,
    reason: "the schema's property names are English, and have been since t178",
  },
]);

test('t312 — AT1: no Portuguese diacritic survives in packages/runner/test', () => {
  const hits = scannedFiles().flatMap((file) =>
    hitsInFile(file, (text) => DIACRITICS.exec(text)?.[0] ?? null),
  );

  assert.deepEqual(hits, [], `Portuguese diacritics still in the tests (t312, AT1):\n${hits.join('\n')}`);
});

test('t312 — AT2: no plain-ASCII Portuguese survives in packages/runner/test', () => {
  const hits = scannedFiles().flatMap((file) =>
    hitsInFile(file, (text) => {
      const offenders = offendersIn(text);
      return offenders.length === 0 ? null : offenders.join(', ');
    }),
  );

  assert.deepEqual(hits, [], `Portuguese words still in the tests (t312, AT2):\n${hits.join('\n')}`);
});

test('t312 — the walk reads the whole test tree, gates and this file excepted', () => {
  const files = scannedFiles();

  // One per directory, plus the two fixture shapes: if the walk ever narrows,
  // it fails here instead of passing quietly on a corner of the tree.
  for (const expected of [
    'bin.e2e.test.ts',
    'authorized-fetch.ts',
    'cli/run.e2e.test.ts',
    'controller/graph-traversal.e2e.test.ts',
    'dispatch/dispatch.test.ts',
    'engine/command.test.ts',
    'fixtures/fake-engine.mjs',
    'fixtures/graph-traversal.json',
    'fixtures/codex-input-request.jsonl',
    'intake/prompt.test.ts',
    'surveyor/spread.test.ts',
    'synthesizer/prompt.test.ts',
  ]) {
    assert.ok(files.includes(expected), `the sweep no longer reads ${expected}`);
  }
  assert.ok(files.length > 75, `the sweep reads only ${files.length} files; the tree has more`);
  assert.deepEqual(
    files.filter((file) => SELF_AND_GATES.has(file)),
    [],
    'the language gates and this file are Portuguese on purpose and stay out',
  );
});

test('t312 — every Out of Scope pin still lands on a line that needs excusing', () => {
  for (const entry of OUT_OF_SCOPE) {
    const lines = readFileSync(path.join(TEST_ROOT, entry.file), 'utf8').split('\n');
    const pinned = lines[entry.line - 1] ?? '';
    assert.ok(
      DIACRITICS.test(pinned) || offendersIn(pinned).length > 0,
      `${entry.file}:${entry.line} is no longer Portuguese; drop the exception (${entry.reason})`,
    );
  }
});

test('t312 — AT2 bites on the Portuguese that carries no accent', () => {
  // The two lines t309's closing note named as invisible to a diacritic grep,
  // and the shapes around them. If AT2 ever stops seeing these, it has stopped
  // being the reason it exists.
  const caught = [
    '    /desbloqueie/,',
    "  'confirma, e a tela fica para depois.',",
    "  'Preciso fechar a camada de intake: uma rota que propoe a quebra, outra que',",
    '    /opcional/i,',
    '  title: "ficha sem grafo",',
  ];
  for (const text of caught) {
    assert.ok(offendersIn(text).length > 0, `AT2 missed plain-ASCII Portuguese: ${text}`);
  }
});

test('t312 — AT2 does NOT bite on the wire tokens the source tickets kept', () => {
  const allowed = [
    "      { from: 'implementar', to: 'conferir', condition: 'sempre' },",
    "  expected_metric: { nome: 'tempo_espera_ms:revisar', direcao: 'cai', de: 100, para: 80 },",
    "    assert.equal(parsed?.resultado, 'aprovado');",
    "  const output = ['```resultado', '{\"resultado\":\"retrabalho\"}', '```'].join('\\n');",
    '  assert.ok(refused.includes(`no_com_contrato`), `an empty checks list is refused`);',
    "  assert.match(prompt, /grafo-proposto/, 'the fenced block the session has to hand back');",
    "  assert.equal(basename(written), 'intake-proposto.json');",
  ];
  for (const text of allowed) {
    assert.deepEqual(offendersIn(text), [], `AT2 flagged a kept wire token: ${text}`);
  }
});

test('t317 — AT3: the tokens the masks hide are spelled only where the wire needs them', () => {
  const pinned = new Set(KEPT_TOKENS.map((entry) => `${entry.file}:${entry.line}`));
  const hits = scannedFiles()
    .flatMap((file) => linesSpelling(file, MASKED_TOKENS))
    .filter((hit) => !pinned.has(`${hit.file}:${hit.line}`))
    .map((hit) => `${hit.file}:${hit.line} — ${hit.text}`);

  assert.deepEqual(hits, [], `Portuguese hiding under a sweep mask (t317, AT3):\n${hits.join('\n')}`);
});

test('t317 — every kept-token pin still lands on a line that spells it', () => {
  for (const entry of KEPT_TOKENS) {
    const lines = readFileSync(path.join(TEST_ROOT, entry.file), 'utf8').split('\n');
    assert.ok(
      MASKED_TOKENS.test(lines[entry.line - 1] ?? ''),
      `${entry.file}:${entry.line} no longer spells the kept token; drop the pin (${entry.reason})`,
    );
  }
});

test('t317 — AT3 reads what AT1 and AT2 mask, which is the only reason it exists', () => {
  // The four shapes the reproduction measured, verbatim. Each one asserts the
  // premise first — both older sweeps stay quiet — and then that AT3 does not.
  for (const text of [
    '  const worktreePath = path.join(workDir, "worktree-da-sessao");',
    '      const dir = path.join(root, `sessao-${String(jobId)}-${String(serial)}`);',
    "    workingDir: scratch(t, 'sessao-boa'),",
    "  const dir = scratch(t, 'quadro-sucesso');",
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.deepEqual(offendersIn(text), [], `AT2 would have caught this one: ${text}`);
    assert.ok(MASKED_TOKENS.test(text), `AT3 missed a masked-token line: ${text}`);
  }

  // And the English they became: no token left for AT3 to find.
  for (const text of [
    '  const worktreePath = path.join(workDir, "worktree-of-the-session");',
    '      const dir = path.join(root, `session-${String(jobId)}-${String(serial)}`);',
    "    workingDir: scratch(t, 'good-session'),",
    "  const dir = scratch(t, 'frame-success');",
  ]) {
    assert.ok(!MASKED_TOKENS.test(text), `AT3 fires on English: ${text}`);
  }
});

test('t318 — AT2 bites on the fixture prose no earlier group had a word for', () => {
  // The eight lines the reproduction measured, verbatim. Two are the halves of
  // one escalation object whose other three fields were already English — the
  // shape this ticket exists for — and the rest are the same kind of invented
  // illustration: a decoded message split in two, a commit a git fixture makes.
  //
  // Each asserts the premise first: neither AT1 nor AT3 sees any of them, so
  // AT2 is the only sweep that can, and it can only because of the third group.
  for (const text of [
    '  options: ["Renumerar para 0003", "Manter 0002"],',
    '  default: "Manter 0002",',
    "    JSON.stringify({ question: 'Renumerar para 0003?', default: 'Manter 0002' }),",
    "  assert.equal(request.question, 'Renumerar para 0003?');",
    "        { type: 'text', text: 'Primeira parte.' },",
    "        { type: 'text', text: 'Segunda parte.' },",
    "  assert.equal(decodeClaudeCodeSessionText([frame]), 'Primeira parte.\\nSegunda parte.');",
    "  const moved = commit(repoRoot, 'segunda entrega');",
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.ok(!MASKED_TOKENS.test(text), `AT3 would have caught this one: ${text}`);
    assert.ok(offendersIn(text).length > 0, `AT2 missed invented fixture prose: ${text}`);
  }
});

test('t318 — AT2 stays quiet on the English those eight lines became', () => {
  for (const text of [
    '  options: ["Renumber to 0003", "Keep 0002"],',
    '  default: "Keep 0002",',
    "    JSON.stringify({ question: 'Renumber to 0003?', default: 'Keep 0002' }),",
    "  assert.equal(request.question, 'Renumber to 0003?');",
    "        { type: 'text', text: 'First part.' },",
    "        { type: 'text', text: 'Second part.' },",
    "  assert.equal(decodeClaudeCodeSessionText([frame]), 'First part.\\nSecond part.');",
    "  const moved = commit(repoRoot, 'second delivery');",
  ]) {
    assert.deepEqual(offendersIn(text), [], `AT2 fires on English: ${text}`);
  }
});

test('t318 — an escalation fixture reads in ONE language, field by field', () => {
  // The defect itself, stated as the invariant it broke: three English fields
  // and two Portuguese ones in the same object. A per-field check, because the
  // object is what a reader takes as the example of an escalation, and a sweep
  // that reports a file cannot say the five fields disagree with each other.
  const escalation: Record<string, string | string[]> = {
    question: 'Renumber the migration to 0003?',
    context: 't101 runs in parallel and owns the same numbering space.',
    options: ['Renumber to 0003', 'Keep 0002'],
    recommendation: 'Keep 0002 and renumber only if it collides at the merge.',
    default: 'Keep 0002',
  };

  const source = readFileSync(path.join(TEST_ROOT, 'dispatch/dispatch.test.ts'), 'utf8');
  const fixture = /const ESCALATION = \{(.*?)\n\};/s.exec(source)?.[1];
  assert.ok(fixture !== undefined, 'the escalation fixture is no longer where this test reads it');

  for (const [field, value] of Object.entries(escalation)) {
    for (const literal of Array.isArray(value) ? value : [value]) {
      assert.ok(
        fixture.includes(literal),
        `ESCALATION.${field} does not read in the same language as its siblings: ${literal}`,
      );
    }
  }
  assert.deepEqual(offendersIn(fixture), [], 'the escalation fixture still carries Portuguese');
});

test('t319 — AT2 bites on the text a fixture writes about itself', () => {
  // The sixteen lines the reproduction measured, verbatim. Two block reasons a
  // test hands the block route, five commit messages, three fixture READMEs,
  // two `source` attributions, one job title and two case names that still say
  // `pergunta` for a row this file otherwise calls a question.
  //
  // Each asserts the premise first: neither AT1 nor AT3 sees any of them, so
  // AT2 is the only sweep that can, and it can only because of the fourth
  // group.
  for (const text of [
    "  git('commit', '--quiet', '-m', 'inicial');",
    "          reason: 'fim do caso de teste',",
    "  writeFileSync(path.join(repoRoot, TRACKED_FILE), '# Repo de fixture da t207-C\\n');",
    "  git(repoRoot, 'commit', '--quiet', '-m', 'inicial');",
    "  writeFileSync(path.join(space.repoRoot, 'README.md'), '# Repo de fixture da t179\\n');",
    "  git(space.repoRoot, 'commit', '--quiet', '-m', 'inicial');",
    "    await api(plane, 'POST', `/v1/jobs/${job.id}/blocks`, { reason: 'fim do caso de teste' });",
    '      source: "fixture da t141",',
    '    "AT1 — a session that asks at a never node is blocked, and no pergunta exists",',
    '        "no pergunta row is ever created for an escalation at a never node",',
    '      source: "fixture da t166",',
    '        title: `ticket cujo relato o schema da skill recusa (${nodeId})`,',
    "  commit(repoRoot, 'inicial');",
    "const TRACKED_CONTENT = '# Repo de fixture da t160\\n';",
    "  git(repoRoot, 'commit', '--quiet', '-m', 'inicial');",
    "    event(7, 'job.blocked', work(1), 40, { reason: 'aguardando resposta da pergunta 20' }),",
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.ok(!MASKED_TOKENS.test(text), `AT3 would have caught this one: ${text}`);
    assert.ok(offendersIn(text).length > 0, `AT2 missed a fixture's own text: ${text}`);
  }
});

test('t319 — AT2 stays quiet on the English those sixteen lines became', () => {
  for (const text of [
    "  git('commit', '--quiet', '-m', 'initial');",
    "          reason: 'end of the test case',",
    "  writeFileSync(path.join(repoRoot, TRACKED_FILE), '# Fixture repo of t207-C\\n');",
    "  git(repoRoot, 'commit', '--quiet', '-m', 'initial');",
    "  writeFileSync(path.join(space.repoRoot, 'README.md'), '# Fixture repo of t179\\n');",
    "  git(space.repoRoot, 'commit', '--quiet', '-m', 'initial');",
    "    await api(plane, 'POST', `/v1/jobs/${job.id}/blocks`, { reason: 'end of the test case' });",
    '      source: "fixture of t141",',
    '    "AT1 — a session that asks at a never node is blocked, and no question exists",',
    '        "no question row is ever created for an escalation at a never node",',
    '      source: "fixture of t166",',
    '        title: `ticket whose report the skill schema refuses (${nodeId})`,',
    "  commit(repoRoot, 'initial');",
    "const TRACKED_CONTENT = '# Fixture repo of t160\\n';",
    "  git(repoRoot, 'commit', '--quiet', '-m', 'initial');",
    "    event(7, 'job.blocked', work(1), 40, { reason: 'awaiting the answer to question 20' }),",
  ]) {
    assert.deepEqual(offendersIn(text), [], `AT2 fires on English: ${text}`);
  }
});

test('t319 — the one block reason that stays is the one the control plane writes', () => {
  // The pin above claims a wire dependency, and a claim a reader cannot check
  // is how an exception outlives its reason. So it is checked: the literal the
  // assertion reads back has to be the literal core blocks the job with.
  //
  // The day core is translated this fails, and whoever translates it finds the
  // runner assertion from here instead of from a red e2e run.
  const source = readFileSync(
    path.join(TEST_ROOT, '..', '..', 'core', 'src', 'repositories', 'input-request.ts'),
    'utf8',
  );
  assert.match(
    source,
    /reason: `aguardando resposta da pergunta \$\{id\}`/,
    'core no longer writes this block reason; translate dispatch.test.ts:446 and drop the pin',
  );
});

test('t320 — AT4: a wire word is spelled only where the wire spells it', () => {
  const pinned = new Set(WIRE_MIRRORS.map((entry) => `${entry.file}:${entry.line}`));
  const hits = scannedFiles()
    .flatMap((file) => linesSpelling(file, WIRE_WORDS))
    .filter((hit) => !pinned.has(`${hit.file}:${hit.line}`))
    .map((hit) => `${hit.file}:${hit.line} — ${hit.text}`);

  assert.deepEqual(hits, [], `a wire word used as prose (t320, AT4):\n${hits.join('\n')}`);
});

test('t320 — every wire-mirror pin still lands on a line that spells the word', () => {
  for (const entry of WIRE_MIRRORS) {
    const lines = readFileSync(path.join(TEST_ROOT, entry.file), 'utf8').split('\n');
    assert.ok(
      WIRE_WORDS.test(lines[entry.line - 1] ?? ''),
      `${entry.file}:${entry.line} no longer spells the wire word; drop the pin (${entry.reason})`,
    );
  }
});

test('t320 — AT4 reads what the other three sweeps have no way of seeing', () => {
  // The lines the reproduction measured, verbatim: two local `const`s bound to
  // the English `reason` a block carries, the loop variable of a refusal-reason
  // case, and the field of an illustrative output schema nothing reads back.
  //
  // Each asserts the premise first. AT1 needs an accent and there is none; AT2
  // needs the word on a closed list and no group of it is about wire keys; AT3
  // needs a mask to be hiding the word and no mask touches this one. AT4 is the
  // only sweep that can flag them, which is the only reason it exists.
  for (const text of [
    '      const motivo = String(blocks[0].reason);',
    '      assert.ok(motivo.includes("implementar"), motivo);',
    '      assert.equal(after.block_reason, motivo);',
    "for (const motivo of ['runner_cap', 'project_cap'] as const) {",
    '    const { client, asked } = refusingClient([1, 2, 3], [{ lease: null, reason: motivo }]);',
    "    required: ['outcome', 'motivo'],",
    "    properties: { outcome: { enum: ['aprovado', 'retrabalho'] }, motivo: { type: 'string' } },",
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.deepEqual(offendersIn(text), [], `AT2 would have caught this one: ${text}`);
    assert.ok(!MASKED_TOKENS.test(text), `AT3 would have caught this one: ${text}`);
    assert.ok(WIRE_WORDS.test(text), `AT4 missed a wire word used as prose: ${text}`);
  }

  // And the English they became: the name the value already has on the wire.
  for (const text of [
    '      const reason = String(blocks[0].reason);',
    '      assert.ok(reason.includes("implementar"), reason);',
    '      assert.equal(after.block_reason, reason);',
    "for (const reason of ['runner_cap', 'project_cap'] as const) {",
    '    const { client, asked } = refusingClient([1, 2, 3], [{ lease: null, reason }]);',
    "    required: ['outcome', 'reason'],",
    "    properties: { outcome: { enum: ['aprovado', 'retrabalho'] }, reason: { type: 'string' } },",
  ]) {
    assert.ok(!WIRE_WORDS.test(text), `AT4 fires on English: ${text}`);
    assert.deepEqual(offendersIn(text), [], `AT2 fires on English: ${text}`);
  }
});

test('t323 — AT5: a name the wire retired is spelled only where a test refuses it', () => {
  const pinned = new Set(FICTION_PINS.map((entry) => `${entry.file}:${entry.line}`));
  const hits = scannedFiles()
    .flatMap((file) => linesSpelling(file, WIRE_FICTIONS))
    .filter((hit) => !pinned.has(`${hit.file}:${hit.line}`))
    .map((hit) => `${hit.file}:${hit.line} — ${hit.text}`);

  assert.deepEqual(hits, [], `a fixture spelling a wire nobody speaks (t323, AT5):\n${hits.join('\n')}`);
});

test('t323 — every fiction pin still lands on a line that spells one', () => {
  for (const entry of FICTION_PINS) {
    const lines = readFileSync(path.join(TEST_ROOT, entry.file), 'utf8').split('\n');
    assert.ok(
      WIRE_FICTIONS.test(lines[entry.line - 1] ?? ''),
      `${entry.file}:${entry.line} no longer spells a retired name; drop the pin (${entry.reason})`,
    );
  }
});

test('t323 — every fiction is dead in the source, and the name that took its place is alive', () => {
  const repoRoot = path.resolve(TEST_ROOT, '..', '..', '..');
  for (const entry of REPLACEMENTS) {
    const source = readFileSync(path.join(repoRoot, entry.file), 'utf8');
    assert.match(
      source,
      entry.live,
      `${entry.file} no longer carries ${entry.authority}; AT5 is banning \`${entry.fiction}\` on a claim that stopped being true`,
    );
    assert.ok(
      !new RegExp(`\\b${entry.fiction}\\b`).test(source),
      `${entry.file} spells \`${entry.fiction}\` again; the wire came back and AT5 has to let it through`,
    );
  }
});

test('t323 — AT5 reads what the other four sweeps have no way of seeing', () => {
  // The seven lines the reproduction measured, verbatim. Two body fields of a
  // lease request, the error code the assertion under them refuses, one key of
  // a skill fixture, two `source` values that were never in the enum, and one
  // fake 404 body that fabricates both a key and a code.
  //
  // Each asserts the premise first. AT1 needs an accent and there is none; AT2
  // needs the word on a closed list, and the three `snake_case` names are
  // blanked as machine names before it ever looks; AT3 needs a mask to be
  // hiding the word and no mask touches these; AT4 needs the word to be a name
  // `src/` still spells, which is the exact opposite of what these are.
  for (const text of [
    '        teto_runner: 1,',
    '        teto_projeto: 1,',
    '    assert.doesNotMatch(body, /runner_desconhecido/);',
    "    registrado_em: '2026-08-15T12:00:00.000Z',",
    "    source: 'humano',",
    "    [question({ id: 1, source: 'humano', answered_by: 'rafael' })],",
    "  const { fetchImpl } = fakeFetch(() => ({ status: 404, body: { erro: 'runner_desconhecido' } }));",
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.deepEqual(offendersIn(text), [], `AT2 would have caught this one: ${text}`);
    assert.ok(!MASKED_TOKENS.test(text), `AT3 would have caught this one: ${text}`);
    assert.ok(!WIRE_WORDS.test(text), `AT4 would have caught this one: ${text}`);
    assert.ok(WIRE_FICTIONS.test(text), `AT5 missed a name the wire never carried: ${text}`);
  }

  // And what they became: the name the wire really has, in every one of them.
  for (const text of [
    '        runner_cap: 1,',
    '        project_cap: 1,',
    '    assert.doesNotMatch(body, /unknown_runner/);',
    "    registered_at: '2026-08-15T12:00:00.000Z',",
    "    source: 'user',",
    "    [question({ id: 1, source: 'user', answered_by: 'rafael' })],",
    "  const { fetchImpl } = fakeFetch(() => ({ status: 404, body: { error: 'unknown_runner' } }));",
  ]) {
    assert.ok(!WIRE_FICTIONS.test(text), `AT5 fires on a live name: ${text}`);
    assert.deepEqual(offendersIn(text), [], `AT2 fires on English: ${text}`);
  }
});

test('t323 — the pairing probe asserts a grant, and not merely a non-404', () => {
  // The half of this defect no token sweep can reach. The body fields could be
  // spelled right and the case would still prove nothing, because
  // `notEqual(status, 404)` is satisfied by the `400 invalid_body` that the
  // wrong spelling produced — which is precisely how the break stayed green.
  // A lease request that names the right fields for a paired runner is a 201,
  // and only that number distinguishes a pairing from a malformed request.
  const source = readFileSync(path.join(TEST_ROOT, 'bin.e2e.test.ts'), 'utf8');

  assert.match(
    source,
    /assert\.equal\(\s*response\.status,\s*201,/,
    'AT14 no longer asserts the grant; a probe that accepts any non-404 measures nothing',
  );
  assert.doesNotMatch(
    source,
    /assert\.notEqual\(\s*response\.status,\s*404/,
    'the masking assertion is back: a 400 passes it, and so does every other refusal',
  );
});

test('t323 — the answered-question fixture carries values the projection really has', () => {
  // AT5 cannot reach this, and the reason is worth writing down: `respondida`
  // and `pendente` are ALIVE in `src/` — six comments across three packages
  // still describe an input request that way — so a token sweep would be
  // demanding a rename this ticket was not opened to make. What CAN be checked
  // is narrower and stronger: the two closed sets this one fixture draws from,
  // read out of the files that close them, against every value it declares.
  //
  // The fixture had `status: 'respondida'` two lines above the `source` the
  // reproduction named, and `status: 'pendente'` in the case that proves an
  // open question is not rendered. Both are what the column held before t235,
  // and neither is what `GET /v1/input-requests` has answered since.
  const repoRoot = path.resolve(TEST_ROOT, '..', '..', '..');
  const core = readFileSync(
    path.join(repoRoot, 'packages', 'core', 'src', 'repositories', 'input-request.ts'),
    'utf8',
  );
  const migration = readFileSync(
    path.join(repoRoot, 'packages', 'core', 'migrations', '0003_trabalho_sessao_evento_pergunta.sql'),
    'utf8',
  );

  const declared = (source: string, pattern: RegExp): string[] => {
    const listed = pattern.exec(source)?.[1];
    assert.ok(listed !== undefined, `the closed set is no longer where this test reads it: ${String(pattern)}`);
    return [...listed.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  };

  const statuses = declared(core, /INPUT_REQUEST_STATUSES: readonly string\[\] = Object\.freeze\(\[([^\]]*)\]\)/);
  const sources = declared(migration, /CHECK \(source IN \(([^)]*)\)\)/);
  assert.deepEqual(statuses, ['pending', 'answered'], 'the status set moved; re-read the fixture against it');
  assert.deepEqual(sources, ['user', 'auto'], 'the source set moved; re-read the fixture against it');

  const fixture = readFileSync(path.join(TEST_ROOT, 'dispatch', 'prompt.test.ts'), 'utf8');
  const values = (field: string): string[] =>
    [...fixture.matchAll(new RegExp(`\\b${field}: '([^']*)'`, 'g'))].map((match) => match[1]);

  assert.ok(values('status').length > 0, 'the fixture no longer declares a status; this test reads nothing');
  for (const value of values('status')) {
    assert.ok(statuses.includes(value), `prompt.test.ts declares a status no input request ever had: ${value}`);
  }
  for (const value of values('source')) {
    assert.ok(sources.includes(value), `prompt.test.ts declares a source the column's CHECK refuses: ${value}`);
  }
});

test('t321 — AT6: a scratch name reads in English, segment by segment', () => {
  const hits = scannedFiles().flatMap((file) => scratchHitsInFile(file));

  assert.deepEqual(hits, [], `Portuguese inside a machine name (t321, AT6):\n${hits.join('\n')}`);
});

test('t321 — AT6 reads inside the masks, which is the only reason it exists', () => {
  // One line per shape the reproduction measured: a fixture file name, a
  // problem class, a temp prefix, a scratch directory, a case label, a node id.
  //
  // Each asserts the premise first, against all five older sweeps. AT1 needs an
  // accent and there is none. AT2 would have the word — `sem`, `que`, `arquivo`
  // and `portao` are on its own list — but {@link MACHINE_NAMES} blanks the
  // span before it reads the line. AT3 needs one of four masked tokens, AT4 a
  // `src/` interface to check against, and AT5 a name the wire once carried and
  // retired — and none of the three is here. AT6 is the only sweep that can
  // flag them.
  for (const text of [
    '  const record = path.join(workDir, "despacho-com-negacao.json");',
    '        twoEngineGraph("roteamento-por-no-at3", "codex"),',
    "  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t259-fabrica-'));",
    "  const benchPath = path.join(root, 'banco-de-testes');",
    '        modelGraph("selecao-de-modelo-declarado", { model: "claude-haiku-4-5" }),',
    '      const record = path.join(workDir, "portao.json");',
    "    { label: 'sem-arquivo', env: {}, code: 'missing_output' },",
    "  const dir = scratch(t, 'quadro-sem-bloco');",
    "    { current_node_id: 'um-no-que-ninguem-declarou', graph_version_id: VERSION_ID },",
    "  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t270-nao-repo-'));",
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.deepEqual(offendersIn(text), [], `AT2 would have caught this one: ${text}`);
    assert.ok(!MASKED_TOKENS.test(text), `AT3 would have caught this one: ${text}`);
    assert.ok(!WIRE_WORDS.test(text), `AT4 would have caught this one: ${text}`);
    assert.ok(!WIRE_FICTIONS.test(text), `AT5 would have caught this one: ${text}`);
    assert.ok(scratchNamesIn(text).length > 0, `AT6 missed a Portuguese scratch name: ${text}`);
  }

  // And the English they became: no segment left for AT6 to find.
  for (const text of [
    '  const record = path.join(workDir, "dispatch-with-denial.json");',
    '        twoEngineGraph("routing-by-node-at3", "codex"),',
    "  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t259-factory-'));",
    "  const benchPath = path.join(root, 'test-bench');",
    '        modelGraph("model-choice-declared", { model: "claude-haiku-4-5" }),',
    '      const record = path.join(workDir, "gate.json");',
    "    { label: 'no-file', env: {}, code: 'missing_output' },",
    "  const dir = scratch(t, 'frame-without-block');",
    "    { current_node_id: 'node-nobody-declared', graph_version_id: VERSION_ID },",
    "  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t270-not-a-repo-'));",
  ]) {
    assert.deepEqual(scratchNamesIn(text), [], `AT6 fires on English: ${text}`);
    assert.deepEqual(offendersIn(text), [], `AT2 fires on English: ${text}`);
  }
});

test('t321 — AT6 leaves the wire shape alone, and the ids the repo shares', () => {
  // The snake_case keys earlier tickets froze, and the illustrative ids the
  // bundles, the schema examples and three other packages all spell the same
  // way. Renaming half of either is worse than leaving both alone, so AT6 has
  // to stay quiet on every one of these.
  for (const text of [
    "    (first.banco_de_testes as Record<string, unknown>).caminho,",
    "  expected_metric: { nome: 'tempo_espera_ms:revisar', direcao: 'cai', de: 100, para: 80 },",
    '  assert.ok(refused.includes(`no_com_contrato`), `an empty checks list is refused`);',
    "    referenceMode: 'ponta_do_principal',",
    "  assert.match(prompt, /grafo-proposto/, 'the fenced block the session has to hand back');",
    "      const dir = path.join(root, 'nota-curta');",
    '      traversalGraph("travessia-t272-cap"),',
    '  // bundles end exactly this way (`registro-monitoramento`, `implantar`).',
    "    refusal(parseArguments([REQUEST, '--classe', 'nota-curta'], EMPTY_ENV)),",
    '  const bareRecord = path.join(workDir, "no-graph.json");',
    "test('AT5 — an absent install command is a no-op, and the merge alone succeeds', async (t) => {",
  ]) {
    assert.deepEqual(scratchNamesIn(text), [], `AT6 fires on a name the repo keeps: ${text}`);
  }
});

test('t321 — AT2 bites on a scratch name that is one bare word', () => {
  // The five shapes AT6 cannot reach: a name with no separator in it, and one
  // whose separator is followed by an interpolation rather than by a segment.
  // AT2 is the sweep that can see them, and only because of the fifth group.
  for (const text of [
    "  const repoRoot = path.join(root, 'principal');",
    "  git(benchPath, 'checkout', '--quiet', '-b', 'experimento');",
    "    'the test bench is checked out on `experimento`, not on the main line `main`',",
    '    const argv = await toldTo(t, "colisao", 2704, {',
    "    refusal(parseArguments([REQUEST, 'sobra', '--class', 'x'], EMPTY_ENV)),",
    '      return Promise.resolve({ path: dir, branch: `tese-${String(jobId)}` });',
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.ok(!MASKED_TOKENS.test(text), `AT3 would have caught this one: ${text}`);
    assert.ok(!WIRE_WORDS.test(text), `AT4 would have caught this one: ${text}`);
    assert.ok(!WIRE_FICTIONS.test(text), `AT5 would have caught this one: ${text}`);
    assert.deepEqual(scratchNamesIn(text), [], `AT6 would have caught this one: ${text}`);
    assert.ok(offendersIn(text).length > 0, `AT2 missed a one-word scratch name: ${text}`);
  }
});

test('t321 — AT2 stays quiet on the English those six lines became', () => {
  for (const text of [
    "  const repoRoot = path.join(root, 'main-repo');",
    "  git(benchPath, 'checkout', '--quiet', '-b', 'experiment');",
    "    'the test bench is checked out on `experiment`, not on the main line `main`',",
    '    const argv = await toldTo(t, "collision", 2704, {',
    "    refusal(parseArguments([REQUEST, 'leftover', '--class', 'x'], EMPTY_ENV)),",
    '      return Promise.resolve({ path: dir, branch: `thesis-${String(jobId)}` });',
  ]) {
    assert.deepEqual(offendersIn(text), [], `AT2 fires on English: ${text}`);
    assert.deepEqual(scratchNamesIn(text), [], `AT6 fires on English: ${text}`);
  }
});

test('t322 — AT7: a name something renamed is not quoted as though it were current', () => {
  const hits = retiredHits();

  assert.deepEqual(hits, [], `a retired name quoted as current (t322, AT7):\n${hits.join('\n')}`);
});

test('t322 — every name AT7 bans is a rename some document really recorded', () => {
  // The half of the sweep that keeps it honest, and t319 wrote down why it has
  // to exist: a claim a reader cannot check is how an exception outlives its
  // reason. Every ban above rests on somebody having renamed something, and
  // that is itself checkable — so it is checked, per name, against the document
  // that owns the rename. The day one of these spellings comes back, this fails
  // and names the ban to lift instead of leaving a sweep refusing a live name.
  const repoRoot = path.resolve(TEST_ROOT, '..', '..', '..');
  const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8');
  const glossary = read('docs/spec/glossario-wire.md');
  const schema = read('schema/graph.schema.json');
  const synthesize = read('packages/runner/src/synthesizer/synthesize.ts');

  for (const entry of RETIRED_NAMES) {
    switch (entry.authority) {
      case 'glossary':
        assert.match(
          glossary,
          new RegExp(`^\\|[^|]*\\|\\s*\`${entry.stale}\`\\s*\\|\\s*\`${entry.live}\`\\s*\\|`, 'm'),
          `glossario-wire.md has no row retiring \`${entry.stale}\` for \`${entry.live}\`; AT7 is banning a name on a rename nobody recorded`,
        );
        break;

      case 'graph-schema':
        assert.match(
          schema,
          new RegExp(`"${entry.live}":`),
          `graph.schema.json no longer declares \`${entry.live}\`; AT7 is banning \`${entry.stale}\` on a claim that stopped being true`,
        );
        assert.doesNotMatch(
          schema,
          new RegExp(`"${entry.stale}":`),
          `graph.schema.json declares \`${entry.stale}\` again; the key came back and AT7 has to let it through`,
        );
        break;

      case 'draft-path':
        assert.match(
          synthesize,
          new RegExp(`\`${entry.live}\\.grafo\\.rascunho\\.json\``),
          `synthesize.ts no longer documents the default draft as \`${entry.live}.grafo.rascunho.json\`; re-read the title AT7 is refusing`,
        );
        assert.ok(
          !synthesize.includes(entry.stale),
          `synthesize.ts prints \`${entry.stale}\` again; the placeholder came back and AT7 has to let it through`,
        );
        break;
    }
  }
});

test('t322 — AT7 reads what the six sweeps before it have no way of seeing', () => {
  // The fifteen lines the reproduction measured, verbatim. Five comments about
  // an event payload, a lease and a graph version, two test titles, two
  // assertion messages, and six keys of a literal that calls itself a graph
  // document.
  //
  // Each asserts the premise first. AT1 needs an accent and there is none; AT2
  // needs the word on a closed list, and `trabalho` and `grafo` ARE on one —
  // which is the point, because {@link MACHINE_NAMES} blanks every `snake_case`
  // span before the stopword pass reads the line; AT3 needs a mask to be hiding
  // the word and no mask touches these; AT4 needs the word to be one `src/` still
  // spells in this position; AT5 needs the name to be an invention, and every one
  // of these was a real name once; AT6 needs a kebab or dotted segment somebody
  // invented, and the only dotted span here spells two words it excludes.
  for (const text of [
    '    // by omission: their payloads carry no `trabalho_id`, so the work timeline',
    '      // --- 1. no `grafo_versao_id` at all: today\'s behaviour, byte for byte ------',
    '      // and the server\'s own `heartbeat_em` is the observation.',
    '      // no grant has swept yet still reads `ativa`, and the poll below would',
    '      // quiet (`heartbeat_perdido`), not one that never started (`expirou`,',
    "test('t208 — tick() still tries the next candidate after `trabalho_ja_leased`', async () => {",
    '      `a "${reason}" stop closes the session as tempo_esgotado with its cause`,',
    '    "the transcript rides along with `uso`; it does not replace it",',
    '        "the wiring raised this one, not the session — a session-authored one is `agente`",',
    "test('AT5 — the default draft path is <classe>.grafo.rascunho.json in the current directory', async () => {",
    '    lineage: { tipo: \'base\' },',
    "    metadata: { nome: CLASS_NAME, descricao: 'Redige e revisa.', schema_version: '1.0.0' },",
    "      { id: 'redigir', papel: 'redator', node_type: 'work', skill_ref: pin, contrato: contract },",
    "    checks: [{ type: 'deterministic', comando: 'npm test', descricao: 'Prova.' }],",
    "    skill_ref: { id: 'cartografo/redigir-nota', versao: '1.0.0', hash: `sha256:${'0'.repeat(64)}` },",
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.deepEqual(offendersIn(text), [], `AT2 would have caught this one: ${text}`);
    assert.ok(!MASKED_TOKENS.test(text), `AT3 would have caught this one: ${text}`);
    assert.ok(!WIRE_WORDS.test(text), `AT4 would have caught this one: ${text}`);
    assert.ok(!WIRE_FICTIONS.test(text), `AT5 would have caught this one: ${text}`);
    assert.deepEqual(scratchNamesIn(text), [], `AT6 would have caught this one: ${text}`);
    assert.ok(
      RETIRED_NAMES.some((entry) => spellsName(text, entry.stale)),
      `AT7 missed a name the rename retired: ${text}`,
    );
  }

  // And the names they became: nothing left for AT7 to find, and English to AT2.
  for (const text of [
    '    // by omission: their payloads carry no `job_id`, so the work timeline',
    '      // --- 1. no `graph_version_id` at all: today\'s behaviour, byte for byte ------',
    '      // and the server\'s own `heartbeat_at` is the observation.',
    '      // no grant has swept yet still reads `active`, and the poll below would',
    '      // quiet (`heartbeat_lost`), not one that never started (`ttl_elapsed`,',
    "test('t208 — tick() still tries the next candidate after `job_already_leased`', async () => {",
    '      `a "${reason}" stop closes the session as timed_out with its cause`,',
    '    "the transcript rides along with `usage`; it does not replace it",',
    '        "the wiring raised this one, not the session — a session-authored one is `agent`",',
    "test('AT5 — the default draft path is <class>.grafo.rascunho.json in the current directory', async () => {",
    '    lineage: { type: \'base\' },',
    "    metadata: { name: CLASS_NAME, description: 'Drafts and reviews.', schema_version: '1.0.0' },",
    "      { id: 'redigir', role: 'redator', node_type: 'work', skill_ref: pin, contract },",
    "    checks: [{ type: 'deterministic', command: 'npm test', description: 'Proof.' }],",
    "    skill_ref: { id: 'cartografo/redigir-nota', version: '1.0.0', hash: `sha256:${'0'.repeat(64)}` },",
  ]) {
    assert.ok(
      !RETIRED_NAMES.some((entry) => spellsName(text, entry.stale)),
      `AT7 fires on a live name: ${text}`,
    );
    assert.deepEqual(offendersIn(text), [], `AT2 fires on English: ${text}`);
  }
});

test('t322 — AT7 reads a name and not a slice of a longer one', () => {
  // The two boundaries `\b` gets wrong, and both are real names of this wire:
  // `depende_de_trabalho_id` is the intake item's dependency key
  // (glossario-wire.md §4) and `lease_nao_ativa` is a refusal code of
  // `POST /v1/leases`. A sweep that read either as a hit would be unusable in
  // the files that legitimately carry them.
  for (const text of [
    "  const body = { depende_de_trabalho_id: 7 };",
    "  assert.equal(refused.body.error, 'lease_nao_ativa');",
  ]) {
    assert.ok(
      !RETIRED_NAMES.some((entry) => spellsName(text, entry.stale)),
      `AT7 read a slice of a longer name as a hit: ${text}`,
    );
  }
});

test('t322 — AT8: no header reports a language the artifact it names does not have', () => {
  const offenders = LANGUAGE_CLAIMS.filter((entry) =>
    entry.claim.test(readFileSync(path.join(TEST_ROOT, entry.file), 'utf8')),
  ).map((entry) => `${entry.file} — still claims ${String(entry.claim)} — ${entry.reason}`);

  assert.deepEqual(
    offenders,
    [],
    `a header describing a language its own subject does not have (t322, AT8):\n${offenders.join('\n')}`,
  );
});

test('t322 — every language claim AT8 pins is checkable against the artifact', () => {
  const repoRoot = path.resolve(TEST_ROOT, '..', '..', '..');

  for (const entry of LANGUAGE_CLAIMS) {
    assert.match(
      readFileSync(path.join(repoRoot, entry.about), 'utf8'),
      entry.english,
      `${entry.about} no longer reads in English; AT8 is refusing a claim that has become true again (${entry.file})`,
    );
  }
});

test('t322 — AT8 reads what every token sweep is blind to, because there is no token', () => {
  // The reason this pair exists beside AT7 rather than inside it: there is no
  // retired name on any of these lines. What there is is a SENTENCE about a
  // file, and the file says the opposite.
  for (const text of [
    " * English per D18; the prompt's own prose is Portuguese, like every other agent",
    " * English per D18; the draft file name and the graph document's keys are the",
    " * English per D18; the prompt's own CONTENT is Portuguese, because it is what",
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.deepEqual(offendersIn(text), [], `AT2 would have caught this one: ${text}`);
    assert.ok(!MASKED_TOKENS.test(text), `AT3 would have caught this one: ${text}`);
    assert.ok(!WIRE_WORDS.test(text), `AT4 would have caught this one: ${text}`);
    assert.ok(!WIRE_FICTIONS.test(text), `AT5 would have caught this one: ${text}`);
    assert.deepEqual(scratchNamesIn(text), [], `AT6 would have caught this one: ${text}`);
    assert.ok(
      !RETIRED_NAMES.some((entry) => spellsName(text, entry.stale)),
      `AT7 would have caught this one: ${text}`,
    );
  }
});
