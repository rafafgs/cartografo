/**
 * The inbox itself: list, detail, and the four decisions (FR3–FR9).
 *
 * Native ES module, no framework and no bundler — the page is loaded from the
 * screen's own server, so every call here is same-origin and `/v1/*` is proxied
 * to the control plane. This module is the only piece that touches the DOM; the
 * two rules worth being sure about (which actions a status offers, how a
 * semantic diff reads) live in `actions.js` and `diff.js`, tested in Node.
 *
 * The document and `fetch` arrive as arguments instead of being read from the
 * globals. That keeps the browser out of this file's dependencies, the same way
 * `consultarSaude` takes its `fetch` in `src/index.ts`.
 *
 * Two deliberate absences, both out of scope: no polling or websocket — the
 * list changes on "Refresh" or after a successful action on one row — and no
 * pagination, which is honest at the scale of the PoC and revisited when a real
 * inbox gets long.
 *
 * Every string this module shows reads in English since t310, including the two
 * synthetic error codes below. Those are this page's own invention — the proxy's
 * `control_plane_unavailable` is a wire code and was already English — so they
 * carry no glossary entry and nothing depends on their old spelling.
 */

import { ACTIONS, isOpen, resolveActionsForStatus } from './actions.js';
import { renderOperations } from './diff.js';

/** List endpoint. Filtering happens upstream; the screen only asks. */
const LIST_URL = '/v1/proposals';

/**
 * Starts the page.
 *
 * @param {Document} doc Document to render into.
 * @param {typeof fetch} request HTTP client (same-origin, proxied to the core).
 * @returns {{reload: () => Promise<void>}} Handle, mostly for the console.
 */
export function mount(doc, request) {
  const pendingList = doc.getElementById('pending-list');
  const historyList = doc.getElementById('history-list');
  const detail = doc.getElementById('detail');
  const notice = doc.getElementById('notice');
  const refresh = doc.getElementById('refresh');

  /**
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   */
  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    // Always textContent, never innerHTML: everything on this page comes from
    // the API, and a proposal is written by an agent (D4 treats agent-authored
    // content as an injection vector).
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** @param {Element} node @param {...Element} children */
  function fill(node, ...children) {
    node.replaceChildren(...children);
    return node;
  }

  /**
   * Serial number behind the id of each reason field.
   *
   * Not derived from the proposal id: that value comes from the API, and a
   * `for`/`id` pair breaks on anything with a space in it. Two rows can have a
   * field open at the same time and a duplicate id would aim both labels at the
   * first one, so the counter is per field, not per action.
   */
  let fieldCount = 0;

  /**
   * One HTTP call, with failures already turned into a body.
   *
   * The proxy answers `502 control_plane_unavailable` when the core is down,
   * so the only failure left here is the screen's own server being gone.
   *
   * @param {string} url
   * @param {RequestInit} [options]
   * @returns {Promise<{ok: boolean, status: number, body: any}>}
   */
  async function call(url, options) {
    let response;
    let text;
    try {
      response = await request(url, options);
      text = await response.text();
    } catch (cause) {
      return {
        ok: false,
        status: 0,
        body: {
          error: 'screen_unresponsive',
          message: `the screen did not answer (${cause instanceof Error ? cause.message : 'network failure'})`,
        },
      };
    }

    let body = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: 'unreadable_response', message: text.slice(0, 200) };
      }
    }
    return { ok: response.ok, status: response.status, body };
  }

  /**
   * The human-readable half of an error body, in the core's own vocabulary.
   *
   * `error` + `message` is what every error of the API carries since t226 — and
   * what the screen's OWN proxy carries since t255, which is four tickets in
   * which this function met `{erro, mensagem}` from `proxy.ts` and fell through
   * to the bare status line with the real message right there in the body.
   * The status line is the fallback for the one error the core does NOT write
   * itself: Fastify's own 404, which is exactly what a screen pointed at a
   * control plane without the inbox routes gets back — a real message beats
   * "failure 404" there.
   *
   * @param {any} body
   * @param {number} status
   */
  function messageOf(body, status) {
    if (body === null || typeof body !== 'object') return `failure ${status}`;
    if (typeof body.message === 'string' && body.message !== '') {
      return typeof body.error === 'string' ? `${body.error}: ${body.message}` : body.message;
    }
    if (typeof body.error === 'string') return body.error;
    if (typeof body.message === 'string' && body.message !== '') return body.message;
    return `failure ${status}`;
  }

  /** Accepts `{proposals: [...]}` or a bare array — the envelope is t111's call. */
  function proposalsOf(body) {
    if (Array.isArray(body)) return body;
    if (body !== null && typeof body === 'object' && Array.isArray(body.proposals)) {
      return body.proposals;
    }
    return [];
  }

  /** Accepts `{proposal: {...}}` or the proposal itself. */
  function proposalOf(body) {
    if (body === null || typeof body !== 'object') return null;
    if (body.proposal !== undefined && body.proposal !== null) return body.proposal;
    return body.id === undefined ? null : body;
  }

  /** A value that is not text (evidence, metric) shown without pretending. */
  function asText(value) {
    if (value === undefined || value === null) return '—';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '—';
    }
  }

  function setNotice(text, isError) {
    notice.textContent = text;
    notice.classList.toggle('error', isError === true);
  }

  /* ----------------------------------------------------------------- detail */

  /**
   * Loads and shows one proposal in full (FR4/FR5).
   *
   * @param {string|number} id
   */
  async function showDetail(id) {
    fill(detail, el('p', 'muted', `loading proposal #${id}…`));

    const { ok, status, body } = await call(`${LIST_URL}/${id}`);
    const proposal = proposalOf(body);
    if (!ok || proposal === null) {
      fill(detail, el('p', 'error', messageOf(body, status)));
      return;
    }

    const blocks = [
      el('h3', undefined, `Proposal #${proposal.id} — ${proposal.status ?? 'no status'}`),
      field('Graph', proposal.graph_id),
      field('Target version', proposal.target_version),
    ];

    const diff = el('div', 'diff');
    diff.append(el('h4', undefined, 'Semantic diff'));
    for (const line of renderOperations(proposal.operations)) {
      diff.append(el('p', `op ${lineClass(line)}`, line));
    }
    blocks.push(diff);

    blocks.push(block('Evidence', asText(proposal.evidence)));
    blocks.push(block('Expected metric', asText(proposal.expected_metric)));
    if (proposal.result !== undefined && proposal.result !== null) {
      blocks.push(block('Result', asText(proposal.result)));
    }
    if (proposal.rejection_reason) blocks.push(block('Rejection reason', proposal.rejection_reason));
    if (proposal.revert_reason) blocks.push(block('Revert reason', proposal.revert_reason));

    fill(detail, ...blocks);
  }

  /** Colours a diff line by its leading sign, without parsing it again. */
  function lineClass(line) {
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'remove';
    if (line.startsWith('~')) return 'change';
    return 'unknown';
  }

  function field(label, value) {
    const node = el('p', 'field');
    node.append(el('span', 'label', `${label}: `), el('span', 'value', asText(value)));
    return node;
  }

  function block(label, value) {
    const node = el('div', 'block');
    node.append(el('h4', undefined, label), el('pre', undefined, value));
    return node;
  }

  /* ------------------------------------------------------------------- rows */

  /**
   * One row: the proposal, its valid actions, and the space where this row's
   * own error or new status shows up (FR8/FR9 — never a page reload, never a
   * silent failure).
   *
   * @param {any} proposal
   */
  function renderRow(proposal) {
    const row = el('li', 'proposal');

    const head = el('p', 'head');
    const title = el('button', 'link', `#${proposal.id} · ${proposal.graph_id ?? 'no graph'}`);
    title.type = 'button';
    title.addEventListener('click', () => {
      void showDetail(proposal.id);
    });
    const status = el('span', 'status', proposal.status ?? 'no status');
    head.append(title, status);

    const version = el('p', 'version');
    if (proposal.applied_version_id) version.textContent = `version ${proposal.applied_version_id}`;

    const message = el('p', 'message');
    const controls = el('p', 'actions');
    row.append(head, version, controls, message);

    /** Rebuilds the buttons for the status the row is in now. */
    function drawActions(currentStatus) {
      const names = resolveActionsForStatus(currentStatus);
      if (names.length === 0) {
        fill(controls, el('span', 'muted', 'read only'));
        return;
      }

      const buttons = names.map((name) => {
        const action = ACTIONS[name];
        const button = el('button', 'action', action.label);
        button.type = 'button';
        button.addEventListener('click', () => {
          void start(name);
        });
        return button;
      });
      fill(controls, ...buttons);
    }

    /**
     * Fires an action, asking for a reason first when the action needs one
     * (FR7: reject and revert do, approve and apply do not).
     *
     * @param {'approve'|'reject'|'apply'|'revert'} name
     */
    function start(name) {
      const action = ACTIONS[name];
      if (!action.requiresReason) {
        void run(name, undefined);
        return;
      }

      const form = el('span', 'reason');

      // The question is a real <label>, not a placeholder. A placeholder is a
      // hint: it disappears at the first keystroke, and it is not a name a
      // screen reader can count on — which leaves the one field on this page
      // that takes a written justification unable to say what it is for.
      const fieldId = `reason-${(fieldCount += 1)}`;
      const label = el('label', 'reason-label', action.reasonLabel);
      label.htmlFor = fieldId;
      const input = el('input', 'reason-input');
      input.id = fieldId;
      input.type = 'text';
      const confirm = el('button', 'action', `Confirm ${action.label.toLowerCase()}`);
      confirm.type = 'button';
      confirm.disabled = true;
      const cancel = el('button', 'link', 'cancel');
      cancel.type = 'button';

      input.addEventListener('input', () => {
        confirm.disabled = input.value.trim() === '';
      });
      confirm.addEventListener('click', () => {
        void run(name, input.value.trim());
      });
      cancel.addEventListener('click', () => {
        drawActions(proposal.status);
        message.textContent = '';
      });

      form.append(label, input, confirm, cancel);
      fill(controls, form);
      input.focus();
    }

    /**
     * Calls the API and updates THIS row — the whole point of FR8.
     *
     * @param {'approve'|'reject'|'apply'|'revert'} name
     * @param {string|undefined} reason
     */
    async function run(name, reason) {
      fill(controls, el('span', 'muted', `${ACTIONS[name].label.toLowerCase()}…`));
      message.textContent = '';
      message.classList.remove('error');

      const { ok, status: code, body } = await call(`${LIST_URL}/${proposal.id}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reason === undefined ? {} : { reason }),
      });

      if (!ok) {
        message.textContent = messageOf(body, code);
        message.classList.add('error');
        drawActions(proposal.status);
        return;
      }

      const updated = proposalOf(body);
      const previousStatus = proposal.status;
      Object.assign(proposal, updated ?? {});
      status.textContent = proposal.status ?? 'no status';

      const newVersion = body?.graph_version?.id ?? proposal.applied_version_id;
      if (newVersion) version.textContent = `version ${newVersion}`;

      message.textContent =
        isOpen(previousStatus) && !isOpen(proposal.status)
          ? 'done — it leaves the pending list on the next "Refresh"'
          : '';
      drawActions(proposal.status);
      void showDetail(proposal.id);
    }

    drawActions(proposal.status);
    return row;
  }

  /* ------------------------------------------------------------------- list */

  /** Reloads both sections from the API (FR3). */
  async function reload() {
    setNotice('loading…', false);

    const { ok, status, body } = await call(LIST_URL);
    if (!ok) {
      setNotice(messageOf(body, status), true);
      return;
    }

    const proposals = proposalsOf(body);
    const open = proposals.filter((proposal) => isOpen(proposal.status));
    const history = proposals.filter((proposal) => !isOpen(proposal.status));

    fill(
      pendingList,
      ...(open.length === 0 ? [el('li', 'muted', 'no proposal waiting for a decision')] : open.map(renderRow)),
    );
    fill(
      historyList,
      ...(history.length === 0 ? [el('li', 'muted', 'nothing decided yet')] : history.map(renderRow)),
    );

    setNotice(`${proposals.length} proposal(s)`, false);
  }

  refresh.addEventListener('click', () => {
    void reload();
  });
  void reload();

  return { reload };
}
