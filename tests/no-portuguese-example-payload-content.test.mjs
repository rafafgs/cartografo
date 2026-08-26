/**
 * D24's blind spot: the example payloads inside fenced blocks (t328).
 *
 * Every sweep the D24 series shipped blanks fenced code blocks before reading a
 * `.md` file — `proseOf` in `scripts/no-portuguese-prose.mjs`, and through it
 * `tests/no-portuguese-repo-sweep.test.mjs`, `no-portuguese-document-tree` and
 * `no-portuguese-reader-documents`. That cut is right for what a fence usually
 * holds: the DDL of a migration, the frames of a session, the JSON of a graph
 * document, whose vocabulary is the product's and not the writer's.
 *
 * It is wrong for a SPEC's example payload, which is two things at once. Half of
 * it is wire — keys and enum values the product really emits — and half of it is
 * CONTENT a reader reads: a title somebody typed, a hostname they will replace,
 * a secret they chose. The content half was invisible to every gate in the tree,
 * and this file is what makes it visible.
 *
 * ## Three buckets, and the one that is not translated
 *
 * Every Portuguese-shaped token in the six specs this ticket walked was sorted
 * into one of three, and `reason` on every entry below says which and why:
 *
 * 1. **Frozen wire** — verified live in a schema, a route, a migration or an
 *    exported constant TODAY. Untouched, and not pinned here. That is
 *    `"problem_class": "nota-curta"` and `.grafo.rascunho.json`, the node ids
 *    `redigir`/`revisar` and the hook ids `avisar-revisao`/`gancho-revisao`
 *    (all four live in `schema/examples/graph-valid-with-hooks.json` and in
 *    `packages/core/test/`), `intake-proposto.json`
 *    (`packages/runner/src/intake/prompt.ts:63`), and — the one that surprises
 *    everybody — the `tipo "…"` prefix of the webhook route's refusal, which
 *    `packages/core/src/routes/webhooks.ts:106` still emits in Portuguese while
 *    its sibling `routes/events.ts:118` emits `type "…"`. Quoting server output
 *    means quoting what the server says, not what it ought to say.
 * 2. **Retired wire** — a key or enum value that WAS wire before one of the five
 *    English-rename tickets (t226, t258, t259, t289, t290), is not any more, and
 *    was still sitting in a fence as if it were. Not translated: **corrected**,
 *    because the example was factually wrong about the product independently of
 *    what language it was in. `docs/spec/glossary-wire.md` is the oracle — every
 *    one of them was already a row there.
 * 3. **Illustrative content** — free text the caller supplies. Translated.
 *
 * ## Why an inventory and not a parser
 *
 * The obvious fix is to teach `linesToScan`/`proseOf` to unblank a fenced JSON
 * block and mask its keys. The ticket's FR9 refuses it, and the refusal is the
 * interesting part: the fences in this tree hold JSON, shell, SQL, HTTP frames
 * and ASCII-art diagrams in no declared order, and `.md` files OUTSIDE these six
 * carry fenced examples with genuinely frozen Portuguese wire vocabulary that a
 * generic unblank-and-mask-keys pass would trip — `de` and `para` in
 * `docs/spec/graph.md` are required edge keys, costed as a D20 reversal in
 * `notes/2026-08-26-t314-closing-note.md` and not this gate's to break.
 *
 * So: a pinned inventory, which is narrow and honest about being narrow. It
 * makes no claim about any line it does not name.
 *
 * ## What each pin asserts, and why two assertions and not one
 *
 * - **the byte pin** (AT1) — the line at that number equals `after` exactly. It
 *   catches the literal revert, and it also catches an unrelated edit drifting
 *   the line, which is the point: a line that moved deserves to be re-read
 *   rather than to slip past.
 * - **the signal pin** (AT2) — the same line, read RAW rather than
 *   fence-blanked, trips neither `DIACRITIC` nor `STOPWORD`. It catches what the
 *   byte pin cannot: somebody reintroducing the Portuguese as a PARAPHRASE.
 *
 * Neither is redundant. The byte pin has no idea what language it is holding;
 * the signal pin has no idea what the line is supposed to say.
 *
 * ## Why this file is exempt from the repo-wide sweep
 *
 * Its name matches `tests/no-portuguese-[^/]*\.test\.mjs`, one of the four
 * {@link GATE_PATTERNS} of `tests/no-portuguese-repo-sweep.test.mjs`, so that
 * sweep spares it the way it spares every other language gate — a file whose job
 * is to enumerate what is forbidden is written in the forbidden vocabulary by
 * construction, and every `before` below is exactly that. AT4 asserts the match
 * rather than trusting it. It is deliberately NOT added to `LANGUAGE_GATES`:
 * that list's own `AT2 — every enumerated language gate exists` refuses an entry
 * a naming pattern already covers.
 *
 * ## The two blocks pinned PRESENT
 *
 * {@link EXCUSED_BLOCKS}, and neither is a skip. `docs/spec/intake.md` §7 is a
 * captured transcript, re-run on 2026-08-17 and "kept verbatim" by the
 * document's own prose: editing a quoted proof run would misrepresent what that
 * run produced. §2's item example is USER content — intake accepts an item in
 * ANY language, and D24 governs the prose this project writes, so an English
 * example there would illustrate the one case that needs no illustrating. The
 * second is not this ticket's finding: `tests/t313-docs-specs-drift.test.mjs`
 * AT7 pinned it first, t314 re-litigated it and deliberately kept it, and t328's
 * body was written as though the question were open. It was not.
 *
 * AT3 pins both, the same shape `packages/core/test/no-portuguese-core-tests.test.ts`
 * uses for excused lines. Stating them as cases is the point: a block that is
 * merely absent from the inventory looks exactly like a block nobody noticed,
 * and a block nobody noticed is what this whole ticket is about.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DIACRITIC, FENCE, STOPWORD } from '../scripts/no-portuguese-prose.mjs';
import { GATE_PATTERNS } from './no-portuguese-repo-sweep.test.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** This gate's own repo-relative path. AT4 reads it. */
export const SELF = 'tests/no-portuguese-example-payload-content.test.mjs';

/**
 * Every line t328 edited, pinned by bytes and by signal.
 *
 * `before` is what was on disk on 2026-08-26, kept so that AT5 can reintroduce
 * it against a fixture and watch the pin bite. `after` is what has to be there
 * now. `reason` says which of the three buckets the token fell into and cites
 * the source that settled it — a schema, a route, a migration, a constant, or
 * the exact `docs/spec/glossary-wire.md` row.
 *
 * @type {ReadonlyArray<{file: string, line: number, before: string, after: string, reason: string}>}
 */
export const INVENTORY = Object.freeze([
  {
    file: "docs/spec/intake.md",
    line: 168,
    before: "{\"depende_de_trabalho_id\": 101}",
    after: "{\"depends_on_job_id\": 101}",
    reason:
      "retired key: `depende_de_trabalho_id` became `depends_on_job_id` (docs/spec/glossary-wire.md:429; packages/core/src/db/event-validation.ts:244), and the CREATE TABLE twelve lines above in this same file already spells it that way",
  },

  {
    file: "docs/spec/human-escalation.md",
    line: 47,
    before: "{\"motivo\": \"aguardando resposta da pergunta 900\"}",
    after: "{\"reason\": \"awaiting the answer to input request 900\"}",
    reason:
      "retired key: `motivo` became `reason` (docs/spec/glossary-wire.md:278; packages/core/src/repositories/leases.ts). The English rendering is the one specs/events/taxonomy.md:165 already gives the same example",
  },

  {
    file: "docs/spec/transition-hooks.md",
    line: 73,
    before: "        \"url\": \"https://meu-servico.exemplo/cartografo\",",
    after: "        \"url\": \"https://my-service.example/cartografo\",",
    reason:
      "content: an example destination the reader supplies. `.example` is the reserved TLD; the same rendering is used in docs/spec/webhooks-events.md (FR4)",
  },
  {
    file: "docs/spec/transition-hooks.md",
    line: 123,
    before: "{\"valor\": \"uma-string-longa-e-aleatoria-que-eu-escolhi\"}",
    after: "{\"value\": \"a-long-random-string-that-i-chose\"}",
    reason:
      "retired key: `valor` became `value` (docs/spec/glossary-wire.md:642; packages/core/src/routes/hook-secrets.ts:76-78). The value is content the caller chooses, rendered the same way in docs/spec/webhooks-events.md:52 (FR4)",
  },
  {
    file: "docs/spec/transition-hooks.md",
    line: 213,
    before: "Host: meu-servico.exemplo",
    after: "Host: my-service.example",
    reason:
      "content: the example destination's host, same rendering as line 73 (FR4)",
  },
  {
    file: "docs/spec/transition-hooks.md",
    line: 252,
    before: "const signature = `sha256=${createHmac('sha256', segredo).update(rawBody, 'utf8').digest('hex')}`;",
    after: "const signature = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;",
    reason:
      "content: a local variable of an illustrative snippet the reader copies; it names nothing this product emits",
  },
  {
    file: "docs/spec/transition-hooks.md",
    line: 298,
    before: " \"url\":\"https://meu-servico.exemplo/cartografo\",\"last_error\":\"HTTP 502\"}",
    after: " \"url\":\"https://my-service.example/cartografo\",\"last_error\":\"HTTP 502\"}",
    reason:
      "content: the example destination's URL, same rendering as line 73 (FR4)",
  },

  {
    file: "docs/spec/webhooks-events.md",
    line: 51,
    before: "{\"url\": \"https://meu-servico.exemplo/cartografo\",",
    after: "{\"url\": \"https://my-service.example/cartografo\",",
    reason:
      "content: the example destination, same rendering as docs/spec/transition-hooks.md:73 (FR4)",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 52,
    before: " \"segredo\": \"uma-string-longa-e-aleatoria-que-eu-escolhi\",",
    after: " \"secret\": \"a-long-random-string-that-i-chose\",",
    reason:
      "retired key: the body declares `secret` (packages/core/src/routes/webhooks.ts:130, docblock :24-25; docs/spec/glossary-wire.md:628). The value is content, same rendering as docs/spec/transition-hooks.md:123 (FR4)",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 53,
    before: " \"tipos\": [\"job.created\", \"job.transitioned\"],",
    after: " \"filter_types\": [\"job.created\", \"job.transitioned\"],",
    reason:
      "retired key: `tipos` became `filter_types` (packages/core/src/routes/webhooks.ts:132, docblock :24-25; docs/spec/glossary-wire.md:629)",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 69,
    before: " \"url\": \"https://meu-servico.exemplo/cartografo\",",
    after: " \"url\": \"https://my-service.example/cartografo\",",
    reason:
      "content: the example destination, echoed back in the 201 (FR4)",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 70,
    before: " \"tipos\": [\"job.created\", \"job.transitioned\"],",
    after: " \"filter_types\": [\"job.created\", \"job.transitioned\"],",
    reason:
      "retired key: `filter_types` is what Subscription carries back (packages/core/src/repositories/webhooks.ts:68)",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 71,
    before: " \"evento_inicial_id\": 128,",
    after: " \"initial_event_id\": 128,",
    reason:
      "retired key: `evento_inicial_id` became `initial_event_id` (docs/spec/glossary-wire.md:630; packages/core/src/repositories/webhooks.ts:70)",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 72,
    before: " \"criada_em\": \"2026-08-15T12:00:00.000Z\",",
    after: " \"created_at\": \"2026-08-15T12:00:00.000Z\",",
    reason:
      "retired key: `criada_em` became `created_at` (docs/spec/glossary-wire.md:553; packages/core/src/repositories/webhooks.ts:71)",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 73,
    before: " \"desativada_em\": null}",
    after: " \"deactivated_at\": null}",
    reason:
      "retired key: `desativada_em` became `deactivated_at` (docs/spec/glossary-wire.md:631; packages/core/src/repositories/webhooks.ts:72)",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 103,
    before: "GET /v1/webhooks?projeto_id=9  → only that project's",
    after: "GET /v1/webhooks?project_id=9  → only that project's",
    reason:
      "retired query parameter: the route reads `project_id` (packages/core/src/routes/webhooks.ts:158-161; docs/spec/glossary-wire.md:130). Same length as the old spelling, so the arrow column does not move",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 104,
    before: "DELETE /v1/webhooks/3          → the subscription, now with desativada_em",
    after: "DELETE /v1/webhooks/3          → the subscription, now with deactivated_at",
    reason:
      "retired column name: `desativada_em` became `deactivated_at` (docs/spec/glossary-wire.md:631)",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 146,
    before: "Host: meu-servico.exemplo",
    after: "Host: my-service.example",
    reason:
      "content: the example destination's host (FR4)",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 150,
    before: "{\"id\":129,\"type\":\"job.created\",\"project_id\":1,\"execution_id\":2,\"entity\":{\"type\":\"job\",\"id\":7},\"actor\":{\"type\":\"system\",\"ref\":\"control-plane\"},\"occurred_at\":\"2026-08-15T12:00:03.114Z\",\"data\":{\"title\":\"exemplo do doc\",\"entry_node_id\":\"entrada\",\"body\":null,\"acceptance_criteria\":null}}",
    after: "{\"id\":129,\"type\":\"job.created\",\"project_id\":1,\"execution_id\":2,\"entity\":{\"type\":\"job\",\"id\":7},\"actor\":{\"type\":\"system\",\"ref\":\"control-plane\"},\"occurred_at\":\"2026-08-15T12:00:03.114Z\",\"data\":{\"title\":\"doc example\",\"entry_node_id\":\"entry\",\"body\":null,\"acceptance_criteria\":null}}",
    reason:
      "content: a job title the caller supplies and an entry node id that names no node in factory-graphs/** or schema/examples/** — an invented placeholder, not wire vocabulary",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 188,
    before: "const signature = `sha256=${createHmac('sha256', segredo).update(rawBody, 'utf8').digest('hex')}`;",
    after: "const signature = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;",
    reason:
      "content: a local variable of an illustrative snippet the reader copies",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 240,
    before: "             \"segredo has to be a non-empty string\",",
    after: "             \"secret has to be a non-empty string\",",
    reason:
      "retired quotation of server output: the literal the route emits is `secret has to be a non-empty string` (packages/core/src/routes/webhooks.ts:81) — FR5",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 241,
    before: "             \"tipo \\\"nao_existe\\\" is not in the taxonomy (see KNOWN_TYPES)\"]}",
    after: "             \"tipo \\\"does_not_exist\\\" is not in the taxonomy (see KNOWN_TYPES)\"]}",
    reason:
      "content: `nao_existe` is the caller's own unknown type. The `tipo` prefix is FROZEN and stays: packages/core/src/routes/webhooks.ts:106 still emits it, and FR5 says quote the literal rather than invent one (its sibling packages/core/src/routes/events.ts:118 says `type`, which is why the two specs differ here)",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 257,
    before: "// receiver.mjs — CARTOGRAFO_WEBHOOK_SEGREDO=... node receiver.mjs",
    after: "// receiver.mjs — CARTOGRAFO_WEBHOOK_SECRET=... node receiver.mjs",
    reason:
      "content: an environment variable of the reader's own receiver, invented by this document — no hit anywhere in packages/**",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 261,
    before: "const segredo = process.env.CARTOGRAFO_WEBHOOK_SEGREDO;",
    after: "const secret = process.env.CARTOGRAFO_WEBHOOK_SECRET;",
    reason:
      "content: the same invented variable and the local that holds it",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 284,
    before: "    const expected = `sha256=${createHmac('sha256', segredo).update(rawBody, 'utf8').digest('hex')}`;",
    after: "    const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;",
    reason:
      "content: the same local of the illustrative receiver",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 310,
    before: "  -d '{\"url\":\"http://127.0.0.1:8099/cartografo\",\"segredo\":\"'\"$CARTOGRAFO_WEBHOOK_SEGREDO\"'\"}'",
    after: "  -d '{\"url\":\"http://127.0.0.1:8099/cartografo\",\"secret\":\"'\"$CARTOGRAFO_WEBHOOK_SECRET\"'\"}'",
    reason:
      "retired body key `segredo` became `secret` (packages/core/src/routes/webhooks.ts:130); the environment variable beside it is the reader's own content",
  },
  {
    file: "docs/spec/webhooks-events.md",
    line: 316,
    before: "#129 job.created {\"title\":\"demo round\",\"entry_node_id\":\"entrada\",\"body\":null,\"acceptance_criteria\":null}",
    after: "#129 job.created {\"title\":\"demo round\",\"entry_node_id\":\"entry\",\"body\":null,\"acceptance_criteria\":null}",
    reason:
      "content: the entry node id placeholder. The title stays `demo round` because tests/t313-docs-specs-drift.test.mjs AT6 asserts this spec and events-stream.md print the SAME demo round",
  },

  {
    file: "docs/spec/events-stream.md",
    line: 71,
    before: "GET /v1/events/stream?projeto_id=1&tipo=job.transitioned,job.blocked",
    after: "GET /v1/events/stream?project_id=1&type=job.transitioned,job.blocked",
    reason:
      "retired query parameters: the route reads `project_id` and `type` (packages/core/src/routes/events.ts:93-95, docblock :31)",
  },
  {
    file: "docs/spec/events-stream.md",
    line: 115,
    before: "data: {\"id\":1,\"type\":\"job.created\",\"project_id\":1,\"execution_id\":2,\"entity\":{\"type\":\"job\",\"id\":1},\"actor\":{\"type\":\"system\",\"ref\":\"control-plane\"},\"occurred_at\":\"2026-08-14T23:10:11.489Z\",\"data\":{\"title\":\"exemplo do doc\",\"entry_node_id\":\"entrada\",\"body\":null,\"acceptance_criteria\":null}}",
    after: "data: {\"id\":1,\"type\":\"job.created\",\"project_id\":1,\"execution_id\":2,\"entity\":{\"type\":\"job\",\"id\":1},\"actor\":{\"type\":\"system\",\"ref\":\"control-plane\"},\"occurred_at\":\"2026-08-14T23:10:11.489Z\",\"data\":{\"title\":\"doc example\",\"entry_node_id\":\"entry\",\"body\":null,\"acceptance_criteria\":null}}",
    reason:
      "content: a job title the caller supplies and an invented entry node id, rendered the same way as docs/spec/webhooks-events.md:150 (FR4)",
  },
  {
    file: "docs/spec/events-stream.md",
    line: 211,
    before: " \"details\": [\"tipo \\\"nao_existe\\\" is not in the taxonomy (see KNOWN_TYPES)\"]}",
    after: " \"details\": [\"type \\\"does_not_exist\\\" is not in the taxonomy (see KNOWN_TYPES)\"]}",
    reason:
      "retired quotation of server output: packages/core/src/routes/events.ts:118 emits `type \"...\"`, not `tipo \"...\"` — FR5. `nao_existe` is the caller's own unknown type, which is content",
  },
  {
    file: "docs/spec/events-stream.md",
    line: 221,
    before: "{\"error\": \"missing_credential\", \"message\": \"esta rota exige `Authorization: Bearer <token>` — ...\"}",
    after: "{\"error\": \"missing_credential\", \"message\": \"this route requires `Authorization: Bearer <token>` — ...\"}",
    reason:
      "retired quotation of server output: the literal packages/core/src/auth.ts:156 sends, quoted rather than invented — FR5",
  },
  {
    file: "docs/spec/events-stream.md",
    line: 241,
    before: "const query = new URLSearchParams({ tipo: 'job.created,job.transitioned' });",
    after: "const query = new URLSearchParams({ type: 'job.created,job.transitioned' });",
    reason:
      "retired query parameter: the route reads `type` (packages/core/src/routes/events.ts:93-95). A reader who copies this snippet gets a 400 today",
  },
  {
    file: "docs/spec/events-stream.md",
    line: 305,
    before: "#1 job.created {\"title\":\"demo round\",\"entry_node_id\":\"entrada\",\"body\":null,\"acceptance_criteria\":null}",
    after: "#1 job.created {\"title\":\"demo round\",\"entry_node_id\":\"entry\",\"body\":null,\"acceptance_criteria\":null}",
    reason:
      "content: the entry node id placeholder. The title stays `demo round` for AT6's same-round assertion",
  },
  {
    file: "docs/spec/events-stream.md",
    line: 314,
    before: "const stream = new EventSource('/v1/events/stream?tipo=job.transitioned');",
    after: "const stream = new EventSource('/v1/events/stream?type=job.transitioned');",
    reason:
      "retired query parameter: the route reads `type` (packages/core/src/routes/events.ts:93-95)",
  },

  {
    file: "docs/spec/intake-generation.md",
    line: 93,
    before: "201 {rascunho} — status `pendente`, no event, no ticket",
    after: "201 {draft} — status `pending`, no event, no ticket",
    reason:
      "retired: `rascunho` became `draft` (docs/spec/glossary-wire.md:172) and `pendente` became `pending` (docs/spec/glossary-wire.md:303; packages/core/migrations/0006_intake.sql:60 CHECK (status IN ('pending', 'confirmed', 'discarded')))",
  },
]);

/**
 * The two fenced blocks that stay Portuguese, each on a reason somebody recorded.
 *
 * Neither is a skip. Both are D24 applied correctly rather than excused, which
 * is why they are stated here as cases instead of being left as the absence of
 * an inventory entry — an absence looks identical to an oversight, and this
 * ticket exists because of what a previous absence hid.
 *
 * `from`/`to` are the fence's CONTENTS, exclusive of the two fence lines, and
 * AT3 checks the fences are still where the range says before believing
 * anything else.
 *
 * `assertedIn` names the file that carries the presence claim, and it is not
 * always the document. §7's claim is about the document's own text and lives
 * here. §2's claim belongs to `tests/t313-docs-specs-drift.test.mjs` AT7, which
 * had it first, so what this gate reads there is that the PIN still exists — if
 * a later ticket retires AT7, this goes red and names the decision instead of
 * letting §2 drift on nobody's authority.
 */
export const EXCUSED_BLOCKS = Object.freeze([
  Object.freeze({
    name: "intake.md §7's captured transcript",
    file: 'docs/spec/intake.md',
    from: 285,
    to: 301,
    kept: Object.freeze(['refinar', '"migracao"', '"dominio"', '"rotas"']),
    assertedIn: 'docs/spec/intake.md',
    reason:
      'the document says, in its own prose above the block, that the values are "what that run ' +
      'returned, kept verbatim" and that "`refinar` is `refine` now". Correcting the spelling ' +
      'would make the block claim a run that never happened (FR3)',
  }),
  Object.freeze({
    name: "intake.md §2's submitted item",
    file: 'docs/spec/intake.md',
    from: 50,
    to: 55,
    kept: Object.freeze([
      '"Migração 0005"',
      '"Colunas novas em trabalho e as duas tabelas do intake."',
      '"a migração roda do zero"',
    ]),
    assertedIn: 'tests/t313-docs-specs-drift.test.mjs',
    reason:
      'intake accepts an item in ANY language, so a submitted item is USER content, and D24 ' +
      'governs the prose this project writes. An English example there would illustrate the one ' +
      'case that needs no illustrating. t328 was written as if this were open; it was already ' +
      'settled, and the founder confirmed it on 2026-08-26. The whole block is held and not ' +
      'half of it: `"ref": "migracao"` and `"depends_on": ["dominio"]` carry no diacritic and ' +
      'the owning gate cannot see them, but they are fields of the same submitted item, and a ' +
      'half-translated payload is worse than either whole one (FR2)',
  }),
]);

/** One file's lines, off disk, with the trailing newline's empty entry kept. */
function linesOf(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), 'utf8').split('\n');
}

/**
 * The two failures one pin can have, given the line that is actually there.
 *
 * Shared by AT1/AT2, which hand it the disk, and by AT5, which hands it the
 * reintroduced `before` — so the proof runs the same code the gate does rather
 * than a re-implementation that could disagree with it.
 *
 * @param {{file: string, line: number, after: string}} entry One pin.
 * @param {string} actual The line as it stands.
 * @returns {string[]} Empty when the pin holds.
 */
export function violationsOf(entry, actual) {
  const where = `${entry.file}:${String(entry.line)}`;
  const found = [];

  if (actual !== entry.after) {
    found.push(`${where}: expected ${JSON.stringify(entry.after)}, found ${JSON.stringify(actual)}`);
  }

  const diacritic = DIACRITIC.exec(actual);
  if (diacritic !== null) found.push(`${where}: diacritic "${diacritic[0]}" in ${actual.trim()}`);

  const stopword = STOPWORD.exec(actual);
  if (stopword !== null) found.push(`${where}: stopword "${stopword[0]}" in ${actual.trim()}`);

  return found;
}

test('AT1 — every pinned line is byte for byte what it was corrected to', () => {
  const offenders = INVENTORY.flatMap((entry) => {
    const actual = linesOf(entry.file)[entry.line - 1];
    return actual === entry.after
      ? []
      : [
          `${entry.file}:${String(entry.line)}: expected ${JSON.stringify(entry.after)}, ` +
            `found ${JSON.stringify(actual)} — ${entry.reason}`,
        ];
  });

  assert.deepEqual(
    offenders,
    [],
    `a pinned example payload line drifted:\n${offenders.join('\n')}`,
  );
});

test('AT1 — the inventory covers all six specs, and none of the excluded ones', () => {
  const walked = [...new Set(INVENTORY.map((entry) => entry.file))].sort();

  assert.deepEqual(walked, [
    'docs/spec/events-stream.md',
    'docs/spec/human-escalation.md',
    'docs/spec/intake-generation.md',
    'docs/spec/intake.md',
    'docs/spec/transition-hooks.md',
    'docs/spec/webhooks-events.md',
  ]);

  for (const entry of INVENTORY) {
    assert.ok(entry.reason.length > 40, `${entry.file}:${String(entry.line)} has no reason worth reading`);
    assert.notEqual(
      entry.before,
      entry.after,
      `${entry.file}:${String(entry.line)} pins a line it did not change`,
    );
  }
});

test('AT2 — every pinned line, read raw rather than fence-blanked, is clean', () => {
  // RAW on purpose. `proseOf` would blank all of these to spaces — being inside
  // a fence is the whole reason they went unread for as long as they did — so a
  // gate that reused it here would pass on an empty string and prove nothing.
  const offenders = INVENTORY.flatMap((entry) => {
    const actual = linesOf(entry.file)[entry.line - 1];
    const diacritic = DIACRITIC.exec(actual);
    const stopword = STOPWORD.exec(actual);

    if (diacritic === null && stopword === null) return [];

    const why = diacritic === null ? `stopword "${stopword[0]}"` : `diacritic "${diacritic[0]}"`;
    return [`${entry.file}:${String(entry.line)}: ${why} — ${actual.trim().slice(0, 120)}`];
  });

  assert.deepEqual(
    offenders,
    [],
    `a corrected line trips a D24 signal:\n${offenders.join('\n')}`,
  );
});

test('AT3 — the two excused blocks are still there, and no pin reaches into them', () => {
  for (const block of EXCUSED_BLOCKS) {
    const lines = linesOf(block.file);

    // The fences have to still be where the range says they are, or the range
    // is describing somebody else's lines and nothing below means anything.
    // Matched rather than compared: §7's opener is bare and §2's is ```json,
    // and which info string a fence carries is not what this is checking.
    assert.ok(FENCE.test(lines[block.from - 2]), `the fence above ${block.name} moved`);
    assert.ok(FENCE.test(lines[block.to]), `the fence below ${block.name} moved`);

    // Read from wherever the presence claim actually lives: the document for
    // §7, the gate that owns the decision for §2.
    const claim = linesOf(block.assertedIn).join('\n');

    for (const kept of block.kept) {
      assert.ok(
        claim.includes(kept),
        `${block.assertedIn} no longer carries ${kept} for ${block.name}. If that is on ` +
          `purpose, the decision moved and this case has to move with it — ${block.reason}`,
      );
    }

    // And no pin of this ticket reaches inside.
    for (const entry of INVENTORY) {
      const inside =
        entry.file === block.file && entry.line >= block.from && entry.line <= block.to;
      assert.equal(inside, false, `the inventory edits ${block.name} at line ${String(entry.line)}`);
    }
  }

  assert.equal(EXCUSED_BLOCKS.length, 2, 'a third excused block is a decision, not an edit');
});

test('AT4 — this gate is named the way the repo-wide sweep spares a gate', () => {
  assert.equal(
    linesOf(SELF).length > 0,
    true,
    'SELF does not name a file: the pattern below would be tested against nothing',
  );

  assert.ok(
    GATE_PATTERNS.some((pattern) => pattern.test(SELF)),
    `"${SELF}" matches none of the sweep's four naming patterns, so the sweep will read the ` +
      'Portuguese this file exists to quote and go red on its own evidence',
  );
});

test('AT5 — reintroducing a pinned line, on a fixture, turns the pin red', () => {
  // The proof AC4 asks for, run against a fixture in memory and never against
  // the tracked file. `git checkout -p` would put the Portuguese back on disk,
  // and a gate that edits the tree it guards is a gate nobody can trust.
  for (const entry of INVENTORY) {
    assert.ok(
      violationsOf(entry, entry.before).length > 0,
      `${entry.file}:${String(entry.line)}: putting the old line back does not trip the pin`,
    );
  }

  // The one quoted in the closing note, whose revert trips BOTH assertions: the
  // byte pin because the string differs, and the signal pin because `uma` is a
  // STOPWORD. Most entries only trip the first — that is the measurement this
  // ticket started from, and the reason the byte pin exists at all.
  const both = INVENTORY.find(
    (entry) => entry.file === 'docs/spec/transition-hooks.md' && entry.line === 123,
  );
  assert.equal(both?.before, '{"valor": "uma-string-longa-e-aleatoria-que-eu-escolhi"}');
  assert.equal(violationsOf(both, both.before).length, 2);

  // ...and the fixture never touched the tree.
  for (const entry of INVENTORY) {
    assert.equal(
      linesOf(entry.file)[entry.line - 1],
      entry.after,
      `${entry.file}:${String(entry.line)} was written to disk by the proof above`,
    );
  }
});
