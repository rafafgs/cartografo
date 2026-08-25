/**
 * The four decisions of the inbox, each one green and each one refused (t212).
 *
 * `inbox.js` is the only module of the screen that touches the DOM, and until
 * now the only thing tested through the fake DOM was the reason field
 * (`inbox-reason-field.test.ts`, t128). Everything the page exists to DO —
 * approve, apply, reject, revert, and what it shows when any of those comes back
 * 4xx or never comes back at all — was uncovered: 69 % of lines and 59 % of
 * functions, with the whole `run` path among the gaps.
 *
 * That gap is exactly where the screen's promise lives. FR8 says an action
 * updates ITS row and never reloads the page, and FR9 says a failure is shown
 * and never swallowed; neither can be checked in a pure function, because both
 * are statements about what happens to elements after an HTTP answer. So this
 * file drives the page against a fake control plane and reads the row back.
 *
 * The DOM is the same stub as t128 (`fake-dom.ts` explains why a browser-shaped
 * dependency is deliberately not taken). What is added here is a scripted
 * control plane: a function from request to answer, so a test can say "this
 * POST comes back 409" or "this one never arrives" without a server.
 *
 * English per D18; the routes are the API's English paths, and the envelope keys
 * (`propostas`, `proposta`, `motivo`, `erro`), the statuses and every visible
 * string are the wire's and the page's Portuguese, untouched by the rename.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { FakeDocument, FakeElement, only } from './fake-dom.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const INBOX_PATH = path.join(PACKAGE_ROOT, 'src', 'public', 'inbox.js');

/** The ids `index.html` declares and `mount` looks up. */
const PAGE_IDS = ['pending-list', 'history-list', 'detail', 'notice', 'refresh'];

/** One request the page made, as the fake control plane saw it. */
interface Exchange {
  url: string;
  method: string;
  /** Already parsed: every body this page sends is JSON. */
  body: unknown;
}

/** What the fake control plane does with one request. */
type Answer =
  | { kind: 'answered'; status: number; text: string }
  | { kind: 'unreachable'; cause: unknown };

/** A JSON answer, which is what the core sends on every route of `/v1`. */
function answers(body: unknown, status = 200): Answer {
  return { kind: 'answered', status, text: JSON.stringify(body) };
}

/** An answer that is not JSON — a proxy or a gateway in the middle wrote it. */
function answersText(text: string, status: number): Answer {
  return { kind: 'answered', status, text };
}

/**
 * The screen's own server never answered.
 *
 * The core being down is NOT this case: the proxy turns that into a
 * `502 control_plane_unavailable`, which is an answer. What is left here is the
 * page losing the server it was served from — a dropped connection, a laptop
 * that slept — and the page owes a message for it just the same (FR9).
 */
function unreachable(cause: unknown): Answer {
  return { kind: 'unreachable', cause };
}

/**
 * `mount`, typed for this test.
 *
 * Written out rather than imported for the reason t128 recorded: the page is
 * never typechecked against a browser, so `Document` does not exist in this
 * package's lib and the stub is what the signature is checked against.
 */
type Mount = (
  doc: FakeDocument,
  request: (
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<Response>,
) => { reload: () => Promise<void> };

async function loadMount(): Promise<Mount> {
  assert.ok(existsSync(INBOX_PATH), 'artifact does not exist yet: packages/screen/src/public/inbox.js');
  const module = (await import(new URL('../src/public/inbox.js', import.meta.url).href)) as {
    mount: Mount;
  };
  return module.mount;
}

/**
 * Lets everything the page fired without awaiting settle.
 *
 * More than one round because an action is a chain of them: the POST, reading
 * its body, then the detail pane the row reloads on success.
 */
async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** The page, mounted over a scripted control plane. */
interface Inbox {
  doc: FakeDocument;
  /** Every request since the first render; the mount's own load is not in it. */
  calls: Exchange[];
  reload: () => Promise<void>;
}

async function openInbox(route: (exchange: Exchange) => Answer): Promise<Inbox> {
  const mount = await loadMount();
  const doc = new FakeDocument(PAGE_IDS);
  const calls: Exchange[] = [];

  const request = async (
    url: string,
    options?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> => {
    const exchange: Exchange = {
      url,
      method: options?.method ?? 'GET',
      body: options?.body === undefined ? undefined : JSON.parse(options.body),
    };
    calls.push(exchange);

    const answer = route(exchange);
    if (answer.kind === 'unreachable') throw answer.cause;
    return new Response(answer.text, {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  const page = mount(doc, request);
  await page.reload();
  await settle();
  // The first load is setup, not the subject: from here on `calls` is exactly
  // what the test's own clicks caused.
  calls.length = 0;
  return { doc, calls, reload: page.reload };
}

/**
 * A control plane that lists proposals and serves them one by one.
 *
 * `act` is what makes each test its own: it answers the POST of an action, and
 * it is where a 409, an unreadable body or a silence gets scripted.
 */
function controlPlane(
  proposals: readonly Record<string, unknown>[],
  act: (action: string, exchange: Exchange) => Answer = () => answers({}, 500),
): (exchange: Exchange) => Answer {
  return (exchange) => {
    const acted = /\/v1\/proposals\/(?<id>[^/]+)\/(?<action>[a-z]+)$/.exec(exchange.url);
    if (acted !== null) return act(acted.groups?.action ?? '', exchange);

    const one = /\/v1\/proposals\/(?<id>[^/]+)$/.exec(exchange.url);
    if (one !== null) {
      const found = proposals.find((proposal) => String(proposal.id) === one.groups?.id);
      return found === undefined ? answers({ error: 'unknown_proposal' }, 404) : answers({ proposal: found });
    }

    return answers({ proposals: proposals });
  };
}

/** The one request matching, with a readable failure when there is not exactly one. */
function onlyCall(calls: Exchange[], what: string): Exchange {
  if (calls.length !== 1) throw new Error(`expected exactly one ${what}, found ${calls.length}`);
  return calls[0];
}

/** The single POST of an action — every test here fires exactly one. */
function postOf(calls: Exchange[]): Exchange {
  return onlyCall(
    calls.filter((call) => call.method === 'POST'),
    'POST of the action',
  );
}

/** The rows of a section, in the order they were rendered. */
function rowsOf(doc: FakeDocument, listId: string): FakeElement[] {
  return doc.require(listId).byClass('proposal');
}

/** The single row of a section. */
function rowOf(doc: FakeDocument, listId: string): FakeElement {
  return only(rowsOf(doc, listId), `row in #${listId}`);
}

/** Clicks the action button whose label matches — `Aprovar`, `Reverter`. */
function clickAction(row: FakeElement, label: string): void {
  only(
    row.byClass('action').filter((node) => node.textContent === label),
    `button "${label}" in the row`,
  ).click();
}

/** The labels of the buttons the row is offering right now. */
function actionLabels(row: FakeElement): string[] {
  return row.byClass('action').map((node) => node.textContent);
}

/** The row's own message line — where FR9 puts a failure. */
function messageOf(row: FakeElement): FakeElement {
  return only(row.byClass('message'), 'message line of the row');
}

/** The row's status badge. */
function statusOf(row: FakeElement): FakeElement {
  return only(row.byClass('status'), 'status of the row');
}

/** Fills in the reason field and confirms, which is how reject and revert run. */
function confirmWithReason(row: FakeElement, reason: string): void {
  const input = only(row.byClass('reason-input'), 'reason field');
  input.typeText(reason);
  only(
    row.byClass('action').filter((node) => node.textContent.startsWith('Confirmar')),
    'confirm button',
  ).click();
}

const PENDING = { id: 7, graph_id: 'grafo-fabrica-1', status: 'pending', operations: [] };
const APPROVED = { id: 8, graph_id: 'grafo-fabrica-1', status: 'approved', operations: [] };
const APPLIED = {
  id: 9,
  graph_id: 'grafo-fabrica-1',
  status: 'applied',
  applied_version_id: 'abc123',
  operations: [],
};

test('approve — the row takes the new status without the page reloading', async () => {
  // Stateful on purpose: the row reloads the detail pane after a decision, and a
  // fake that kept answering `pendente` there would be testing the fake.
  const stored: Record<string, unknown>[] = [{ ...PENDING }];
  const { doc, calls } = await openInbox(
    controlPlane(stored, () => {
      stored[0] = { ...PENDING, status: 'approved' };
      return answers({ proposal: stored[0] });
    }),
  );
  const row = rowOf(doc, 'pending-list');

  clickAction(row, 'Aprovar');
  await settle();

  const posted = postOf(calls);
  assert.equal(posted.url, '/v1/proposals/7/approve');
  assert.deepEqual(posted.body, {}, 'approve carries no reason (FR7)');

  assert.equal(statusOf(row).textContent, 'approved');
  assert.deepEqual(actionLabels(row), ['Aplicar'], 'the row now offers what the new status allows');
  assert.equal(messageOf(row).textContent, '', 'a proposal still open says nothing extra');
  assert.equal(
    doc.require('detail').byTag('h3')[0]?.textContent,
    'Proposta #7 — approved',
    'the detail pane follows the decision',
  );
});

test('apply — the version that came out of it appears on the row', async () => {
  const { doc } = await openInbox(
    controlPlane([APPROVED], () =>
      answers({
        proposal: { ...APPROVED, status: 'applied', applied_version_id: 'v-999' },
        graph_version: { id: 'v-999' },
      }),
    ),
  );
  const row = rowOf(doc, 'pending-list');

  clickAction(row, 'Aplicar');
  await settle();

  assert.equal(statusOf(row).textContent, 'applied');
  assert.equal(only(row.byClass('version'), 'version line').textContent, 'versão v-999');
  assert.deepEqual(actionLabels(row), ['Reverter']);
  assert.equal(
    messageOf(row).textContent,
    'concluída — sai dos pendentes no próximo "Atualizar"',
    'a proposal that left the open statuses says where it went',
  );
});

test('reject — the reason travels in the body, and the row becomes read-only', async () => {
  const { doc, calls } = await openInbox(
    controlPlane([PENDING], () => answers({ proposal: { ...PENDING, status: 'rejected' } })),
  );
  const row = rowOf(doc, 'pending-list');

  clickAction(row, 'Rejeitar');
  const confirm = only(
    row.byClass('action').filter((node) => node.textContent.startsWith('Confirmar')),
    'confirm button',
  );
  assert.equal(confirm.disabled, true, 'nothing is sent before there is a reason');
  only(row.byClass('reason-input'), 'reason field').typeText('   ');
  assert.equal(confirm.disabled, true, 'and whitespace is not a reason');

  confirmWithReason(row, '  a evidência não sustenta a hipótese  ');
  await settle();

  const posted = postOf(calls);
  assert.equal(posted.url, '/v1/proposals/7/reject');
  assert.deepEqual(posted.body, { reason: 'a evidência não sustenta a hipótese' });

  assert.deepEqual(actionLabels(row), [], 'a rejected proposal offers nothing');
  assert.equal(only(row.byClass('muted'), 'read-only mark').textContent, 'somente leitura');
});

test('revert — the same, from the history section', async () => {
  const { doc, calls } = await openInbox(
    controlPlane([APPLIED], () => answers({ proposal: { ...APPLIED, status: 'reverted' } })),
  );
  const row = rowOf(doc, 'history-list');

  clickAction(row, 'Reverter');
  confirmWithReason(row, 'a métrica não se sustentou em produção');
  await settle();

  const posted = postOf(calls);
  assert.equal(posted.url, '/v1/proposals/9/revert');
  assert.deepEqual(posted.body, { reason: 'a métrica não se sustentou em produção' });
  assert.equal(statusOf(row).textContent, 'reverted');
});

test('a refused action leaves the row exactly as it was, and says why', async () => {
  const { doc, calls } = await openInbox(
    controlPlane([PENDING], () =>
      answers({ error: 'proposal_not_pending', message: 'a proposta 7 já foi decidida' }, 409),
    ),
  );
  const row = rowOf(doc, 'pending-list');

  clickAction(row, 'Aprovar');
  await settle();

  assert.equal(messageOf(row).textContent, 'proposal_not_pending: a proposta 7 já foi decidida');
  assert.equal(messageOf(row).classList.contains('error'), true);
  assert.equal(statusOf(row).textContent, 'pending', 'a refusal changes nothing');
  assert.deepEqual(actionLabels(row), ['Aprovar', 'Rejeitar'], 'and the buttons come back');
  assert.deepEqual(
    calls.map((call) => call.method),
    ['POST'],
    'nothing else is asked of the API after a refusal',
  );
});

test("a failure says why in the core's own vocabulary, whatever shape it arrived in", async () => {
  const failures = [
    { answer: answers({ message: 'sem código de erro' }, 422), shown: 'sem código de erro' },
    { answer: answers({ error: 'invalid_graph' }, 422), shown: 'invalid_graph' },
    {
      // Fastify's own 404 — the one error the core does not write itself, which
      // is what a screen pointed at a control plane without these routes gets.
      answer: answers({ message: 'Route POST:/v1/proposals/7/approve not found' }, 404),
      shown: 'Route POST:/v1/proposals/7/approve not found',
    },
    { answer: answersText('', 500), shown: 'falha 500' },
    { answer: answersText('<html>Bad Gateway</html>', 502), shown: 'resposta_ilegivel: <html>Bad Gateway</html>' },
    {
      answer: unreachable(new TypeError('fetch failed')),
      shown: 'tela_sem_resposta: a tela não respondeu (fetch failed)',
    },
    {
      // Not everything thrown at a `fetch` is an `Error`.
      answer: unreachable('ECONNRESET'),
      shown: 'tela_sem_resposta: a tela não respondeu (falha de rede)',
    },
  ];

  for (const failure of failures) {
    const { doc } = await openInbox(controlPlane([PENDING], () => failure.answer));
    const row = rowOf(doc, 'pending-list');

    clickAction(row, 'Aprovar');
    await settle();

    assert.equal(messageOf(row).textContent, failure.shown);
    assert.equal(messageOf(row).classList.contains('error'), true);
    assert.deepEqual(actionLabels(row), ['Aprovar', 'Rejeitar']);
  }
});

test('an answer with no proposal in it leaves the row on what it already knew', async () => {
  const { doc } = await openInbox(controlPlane([PENDING], () => answers({ ok: true })));
  const row = rowOf(doc, 'pending-list');

  clickAction(row, 'Aprovar');
  await settle();

  assert.equal(statusOf(row).textContent, 'pending');
  assert.deepEqual(actionLabels(row), ['Aprovar', 'Rejeitar']);
});

test('the title opens the proposal in full, diff included', async () => {
  const detailed = {
    id: 11,
    graph_id: 'grafo-fabrica-1',
    status: 'pending',
    target_version: 'sha256:abc',
    evidence: { execucoes: 12, falhas: 3 },
    expected_metric: 'retrabalho abaixo de 20%',
    result: 'ainda não medido',
    rejection_reason: 'não se aplica',
    revert_reason: 'não se aplica',
    operations: [
      { type: 'add_node', node: { id: 'red-team', node_type: 'gate' } },
      { type: 'remove_node', node_id: 'deploy' },
      { type: 'change_node_field', node_id: 'testar', field: 'timeout', from: 60, to: 120 },
      { type: 'uma_coisa_nova' },
    ],
  };
  const { doc, calls } = await openInbox(controlPlane([detailed]));
  const row = rowOf(doc, 'pending-list');

  only(row.byClass('link'), 'title of the row').click();
  await settle();

  assert.deepEqual(
    calls.map((call) => call.url),
    ['/v1/proposals/11'],
    'opening a proposal is one GET, not a page reload',
  );

  const detail = doc.require('detail');
  assert.equal(only(detail.byTag('h3'), 'title').textContent, 'Proposta #11 — pending');
  assert.deepEqual(
    detail.byClass('op').map((line) => line.className),
    ['op add', 'op remove', 'op change', 'op unknown'],
    'each diff line is coloured by what it does, without being parsed again',
  );

  const shown = detail.byTag('pre').map((node) => node.textContent);
  assert.equal(shown[0], JSON.stringify(detailed.evidence, null, 2), 'evidence that is not text is shown as JSON');
  assert.deepEqual(shown.slice(1), [
    'retrabalho abaixo de 20%',
    'ainda não medido',
    'não se aplica',
    'não se aplica',
  ]);
});

test('a proposal the API refuses shows the failure in the pane, not an empty one', async () => {
  const { doc } = await openInbox((exchange) =>
    exchange.url === '/v1/proposals'
      ? answers({ proposals: [PENDING] })
      : answers({ error: 'unknown_proposal', message: 'não existe proposta 7' }, 404),
  );

  only(rowOf(doc, 'pending-list').byClass('link'), 'title of the row').click();
  await settle();

  assert.equal(
    only(doc.require('detail').byClass('error'), 'failure in the pane').textContent,
    'unknown_proposal: não existe proposta 7',
  );
});

test('a 200 that carries no proposal is a failure too, not a blank pane', async () => {
  const { doc } = await openInbox((exchange) =>
    exchange.url === '/v1/proposals' ? answers({ proposals: [PENDING] }) : answers({ proposals: [] }),
  );

  only(rowOf(doc, 'pending-list').byClass('link'), 'title of the row').click();
  await settle();

  assert.equal(only(doc.require('detail').byClass('error'), 'failure in the pane').textContent, 'falha 200');
});

test('a proposal missing fields renders without pretending it has them', async () => {
  const bare = { id: 12 };
  const { doc } = await openInbox(controlPlane([bare]));
  const row = rowOf(doc, 'history-list');

  assert.equal(only(row.byClass('link'), 'title').textContent, '#12 · sem grafo');
  assert.equal(statusOf(row).textContent, 'sem status');
  assert.deepEqual(actionLabels(row), [], 'an unknown status is read-only, never an exception');

  only(row.byClass('link'), 'title').click();
  await settle();

  const detail = doc.require('detail');
  assert.equal(only(detail.byTag('h3'), 'title').textContent, 'Proposta #12 — sem status');
  assert.deepEqual(
    detail.byClass('op').map((line) => line.textContent),
    ['nenhuma alteração'],
  );
  assert.deepEqual(
    detail.byTag('pre').map((node) => node.textContent),
    ['—', '—'],
    'evidence and metric that are not there say so',
  );
});

test('a list the API refuses is said out loud instead of showing an empty inbox', async () => {
  const { doc } = await openInbox(() =>
    answers({ error: 'control_plane_unavailable', message: 'o núcleo não respondeu' }, 502),
  );

  const notice = doc.require('notice');
  assert.equal(notice.textContent, 'control_plane_unavailable: o núcleo não respondeu');
  assert.equal(notice.classList.contains('error'), true);
  assert.deepEqual(rowsOf(doc, 'pending-list'), [], 'no row is invented out of a failure');
});

test('an empty inbox says so in both sections', async () => {
  const { doc } = await openInbox(controlPlane([]));

  assert.equal(doc.require('pending-list').textContent, 'nenhuma proposta esperando decisão');
  assert.equal(doc.require('history-list').textContent, 'nada decidido ainda');
  assert.equal(doc.require('notice').textContent, '0 proposta(s)');
  assert.equal(doc.require('notice').classList.contains('error'), false);
});

test('the list envelope may be an array, and anything else is no proposals at all', async () => {
  const asArray = await openInbox(() => answers([PENDING, APPLIED]));
  assert.equal(asArray.doc.require('notice').textContent, '2 proposta(s)');
  assert.equal(rowsOf(asArray.doc, 'pending-list').length, 1);
  assert.equal(rowsOf(asArray.doc, 'history-list').length, 1);

  const asNonsense = await openInbox(() => answers('nem lista nem envelope'));
  assert.equal(asNonsense.doc.require('notice').textContent, '0 proposta(s)');
});

test('Atualizar asks the API again', async () => {
  const { doc, calls } = await openInbox(controlPlane([PENDING]));

  doc.require('refresh').click();
  await settle();

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    ['GET /v1/proposals'],
    'the button reloads the list, and only the list',
  );
  assert.equal(rowsOf(doc, 'pending-list').length, 1);
});
