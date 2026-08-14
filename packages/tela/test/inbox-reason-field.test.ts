/**
 * Acceptance tests for the reason field of Rejeitar and Reverter (t128, FR7).
 *
 * The alpha round on `t111` found the field with a placeholder and nothing
 * else: no `<label>`, no `aria-label`. A placeholder is a hint, not a name —
 * it is gone the moment someone types, and a reader that reaches the field
 * afterwards has nothing to announce. The two decisions the screen exists to
 * support (reject a hypothesis, abandon an applied version) are the two that
 * take a written justification, so this is the field on the page that most has
 * to say what it is for.
 *
 * What is pinned here is the behaviour, not the markup: `accessibleNameOf`
 * resolves the name the way a reader would (`aria-label`, or a `<label>` tied
 * by `for`/`id`), so the page is free to change how it gets there as long as
 * the name is there. `fake-dom.ts` explains why the DOM is a stub.
 *
 * Action names are the API's vocabulary — `reject` IS the last segment of
 * `POST /v1/proposals/:id/reject` — and not this package's own identifiers, so
 * they follow the `/v1` surface: they came in from t111 in Portuguese and were
 * renamed to English with the rest of it (t127, FR3/FR4, D18). The button
 * labels this file clicks by ("Rejeitar", "Reverter") are the visible text and
 * stay in Portuguese, like the rest of the page: the key and the label are two
 * different vocabularies and only one of them moved.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ActionsModule from '../src/public/actions.js';
import { accessibleNameOf, FakeDocument, FakeElement, only } from './fake-dom.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const INBOX_PATH = path.join(PACKAGE_ROOT, 'src', 'public', 'inbox.js');

/** The ids `index.html` declares and `mount` looks up. */
const PAGE_IDS = ['pending-list', 'history-list', 'detail', 'notice', 'refresh'];

/**
 * `mount`, typed for this test.
 *
 * `inbox.js` documents its parameters as `Document` and `typeof fetch`, and
 * `Document` does not exist in this package's lib (`ES2023` plus `@types/node`,
 * no DOM) — the page is never typechecked against a browser. So the shape used
 * here is written out instead of imported, and the stub is what it is checked
 * against.
 */
type Mount = (
  doc: FakeDocument,
  request: (url: string, options?: { method?: string; body?: string }) => Promise<Response>,
) => { reload: () => Promise<void> };

async function loadMount(): Promise<Mount> {
  assert.ok(existsSync(INBOX_PATH), 'artifact does not exist yet: packages/tela/src/public/inbox.js');
  const module = (await import(new URL('../src/public/inbox.js', import.meta.url).href)) as {
    mount: Mount;
  };
  return module.mount;
}

async function loadActions(): Promise<typeof ActionsModule> {
  return (await import(
    new URL('../src/public/actions.js', import.meta.url).href
  )) as typeof ActionsModule;
}

/** Lets whatever the page fired without awaiting settle before assertions. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Mounts the page over a control plane that answers with `proposals`.
 *
 * The detail pane asks for one proposal at a time; nothing in these tests
 * reaches a POST, since opening the reason field is what is under test and it
 * never calls the API.
 *
 * The route is English and the envelope keys are not: `inbox.js` reads
 * `propostas` / `proposta` out of the body. t127 renamed the paths of `/v1`,
 * not the shape of what comes back through them.
 */
async function openInbox(proposals: readonly Record<string, unknown>[]): Promise<FakeDocument> {
  const mount = await loadMount();
  const doc = new FakeDocument(PAGE_IDS);

  const request = async (url: string): Promise<Response> => {
    const match = /\/v1\/proposals\/(?<id>[^/]+)$/.exec(url);
    const body =
      match === null
        ? { propostas: proposals }
        : { proposta: proposals.find((proposal) => String(proposal.id) === match.groups?.id) };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const page = mount(doc, request);
  await page.reload();
  await tick();
  return doc;
}

/** The rows of a section, in the order they were rendered. */
function rowsOf(doc: FakeDocument, listId: string): FakeElement[] {
  return doc.require(listId).byClass('proposal');
}

/** Clicks the action button whose label matches — "Rejeitar", "Reverter". */
function clickAction(row: FakeElement, label: string): void {
  const button = only(
    row.byClass('action').filter((node) => node.textContent === label),
    `button "${label}" in the row`,
  );
  button.click();
}

const PENDING = { id: 7, grafo_id: 'grafo-fabrica-1', status: 'pendente', operacoes: [] };
const OTHER_PENDING = { id: 8, grafo_id: 'grafo-fabrica-1', status: 'pendente', operacoes: [] };
const APPLIED = {
  id: 9,
  grafo_id: 'grafo-fabrica-1',
  status: 'aplicada',
  versao_aplicada_id: 'abc123',
  operacoes: [],
};

test('AT1 — the reason field of Rejeitar has an accessible name', async () => {
  const doc = await openInbox([PENDING]);
  const row = only(rowsOf(doc, 'pending-list'), 'pending row');

  clickAction(row, 'Rejeitar');

  const input = only(row.byClass('reason-input'), 'reason field');
  const { ACTIONS } = await loadActions();
  assert.equal(
    accessibleNameOf(row, input),
    ACTIONS.reject.reasonLabel,
    'the reason field must say what it is for; a placeholder is not a name',
  );
});

test('AT2 — the reason field of Reverter has an accessible name', async () => {
  const doc = await openInbox([APPLIED]);
  const row = only(rowsOf(doc, 'history-list'), 'history row');

  clickAction(row, 'Reverter');

  const input = only(row.byClass('reason-input'), 'reason field');
  const { ACTIONS } = await loadActions();
  assert.equal(accessibleNameOf(row, input), ACTIONS.revert.reasonLabel);
});

test('AT3 — the name is tied to the field, and survives someone typing into it', async () => {
  const doc = await openInbox([PENDING]);
  const row = only(rowsOf(doc, 'pending-list'), 'pending row');

  clickAction(row, 'Rejeitar');
  const input = only(row.byClass('reason-input'), 'reason field');
  const before = accessibleNameOf(row, input);

  // The reproduction, literally: the placeholder is gone from here on.
  input.typeText('a evidência não sustenta a hipótese');

  assert.notEqual(before, '');
  assert.equal(
    accessibleNameOf(row, input),
    before,
    'the name must come from something that outlives the first keystroke',
  );

  // And it is a real pairing, not a label that happens to sit nearby.
  const label = only(row.byTag('label'), 'label in the row');
  assert.notEqual(input.id, '', 'the field needs an id for a label to point at');
  assert.equal(label.getAttribute('for'), input.id);
});

test('AT4 — two rows with the field open keep one name each', async () => {
  const doc = await openInbox([PENDING, OTHER_PENDING]);
  const [first, second] = rowsOf(doc, 'pending-list');

  clickAction(first, 'Rejeitar');
  clickAction(second, 'Rejeitar');

  const firstInput = only(first.byClass('reason-input'), 'reason field of the first row');
  const secondInput = only(second.byClass('reason-input'), 'reason field of the second row');

  assert.notEqual(
    firstInput.id,
    secondInput.id,
    'two ids the same on one page point every label at the first field',
  );

  const page = doc.require('pending-list');
  const { ACTIONS } = await loadActions();
  // Resolved over the whole list, which is where a duplicate id would show up.
  assert.equal(accessibleNameOf(page, firstInput), ACTIONS.reject.reasonLabel);
  assert.equal(accessibleNameOf(page, secondInput), ACTIONS.reject.reasonLabel);
});

test('AT5 — cancelling puts the buttons back and leaves no orphan label', async () => {
  const doc = await openInbox([PENDING]);
  const row = only(rowsOf(doc, 'pending-list'), 'pending row');

  clickAction(row, 'Rejeitar');
  only(row.byClass('link').filter((node) => node.textContent === 'cancelar'), 'cancel button').click();

  assert.deepEqual(
    row.byClass('action').map((node) => node.textContent),
    ['Aprovar', 'Rejeitar'],
  );
  assert.deepEqual(row.byTag('label'), [], 'the label goes away with the field it names');
});
