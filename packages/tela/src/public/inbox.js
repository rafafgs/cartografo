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
 * list changes on "Atualizar" or after a successful action on one row — and no
 * pagination, which is honest at the scale of the PoC and revisited when a real
 * inbox gets long.
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
   * One HTTP call, with failures already turned into a body.
   *
   * The proxy answers `502 control_plane_indisponivel` when the core is down,
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
          erro: 'tela_sem_resposta',
          mensagem: `a tela não respondeu (${cause instanceof Error ? cause.message : 'falha de rede'})`,
        },
      };
    }

    let body = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = { erro: 'resposta_ilegivel', mensagem: text.slice(0, 200) };
      }
    }
    return { ok: response.ok, status: response.status, body };
  }

  /**
   * The human-readable half of an error body, in the core's own vocabulary.
   *
   * `erro` + `mensagem` is what every error of the API carries. `message` is
   * the fallback for the one error the core does NOT write itself: Fastify's
   * own 404, which is exactly what a screen pointed at a control plane without
   * the inbox routes gets back — a real message beats "falha 404" there.
   *
   * @param {any} body
   * @param {number} status
   */
  function messageOf(body, status) {
    if (body === null || typeof body !== 'object') return `falha ${status}`;
    if (typeof body.mensagem === 'string' && body.mensagem !== '') {
      return typeof body.erro === 'string' ? `${body.erro}: ${body.mensagem}` : body.mensagem;
    }
    if (typeof body.erro === 'string') return body.erro;
    if (typeof body.message === 'string' && body.message !== '') return body.message;
    return `falha ${status}`;
  }

  /** Accepts `{propostas: [...]}` or a bare array — the envelope is t111's call. */
  function proposalsOf(body) {
    if (Array.isArray(body)) return body;
    if (body !== null && typeof body === 'object' && Array.isArray(body.propostas)) {
      return body.propostas;
    }
    return [];
  }

  /** Accepts `{proposta: {...}}` or the proposal itself. */
  function proposalOf(body) {
    if (body === null || typeof body !== 'object') return null;
    if (body.proposta !== undefined && body.proposta !== null) return body.proposta;
    return body.id === undefined ? null : body;
  }

  /** A value that is not text (evidência, métrica) shown without pretending. */
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
    fill(detail, el('p', 'muted', `carregando proposta #${id}…`));

    const { ok, status, body } = await call(`${LIST_URL}/${id}`);
    const proposal = proposalOf(body);
    if (!ok || proposal === null) {
      fill(detail, el('p', 'error', messageOf(body, status)));
      return;
    }

    const blocks = [
      el('h3', undefined, `Proposta #${proposal.id} — ${proposal.status ?? 'sem status'}`),
      field('Grafo', proposal.grafo_id),
      field('Versão-alvo', proposal.versao_alvo),
    ];

    const diff = el('div', 'diff');
    diff.append(el('h4', undefined, 'Diff semântico'));
    for (const line of renderOperations(proposal.operacoes)) {
      diff.append(el('p', `op ${lineClass(line)}`, line));
    }
    blocks.push(diff);

    blocks.push(block('Evidência', asText(proposal.evidencia)));
    blocks.push(block('Métrica esperada', asText(proposal.metrica_esperada)));
    if (proposal.resultado !== undefined && proposal.resultado !== null) {
      blocks.push(block('Resultado', asText(proposal.resultado)));
    }
    if (proposal.motivo_rejeicao) blocks.push(block('Motivo da rejeição', proposal.motivo_rejeicao));
    if (proposal.motivo_reversao) blocks.push(block('Motivo da reversão', proposal.motivo_reversao));

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
    const title = el('button', 'link', `#${proposal.id} · ${proposal.grafo_id ?? 'sem grafo'}`);
    title.type = 'button';
    title.addEventListener('click', () => {
      void showDetail(proposal.id);
    });
    const status = el('span', 'status', proposal.status ?? 'sem status');
    head.append(title, status);

    const version = el('p', 'version');
    if (proposal.versao_aplicada_id) version.textContent = `versão ${proposal.versao_aplicada_id}`;

    const message = el('p', 'message');
    const controls = el('p', 'actions');
    row.append(head, version, controls, message);

    /** Rebuilds the buttons for the status the row is in now. */
    function drawActions(currentStatus) {
      const names = resolveActionsForStatus(currentStatus);
      if (names.length === 0) {
        fill(controls, el('span', 'muted', 'somente leitura'));
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
      const input = el('input', 'reason-input');
      input.type = 'text';
      input.placeholder = action.reasonLabel;
      const confirm = el('button', 'action', `Confirmar ${action.label.toLowerCase()}`);
      confirm.type = 'button';
      confirm.disabled = true;
      const cancel = el('button', 'link', 'cancelar');
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

      form.append(input, confirm, cancel);
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
        body: JSON.stringify(reason === undefined ? {} : { motivo: reason }),
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
      status.textContent = proposal.status ?? 'sem status';

      const newVersion = body?.grafo_versao?.id ?? proposal.versao_aplicada_id;
      if (newVersion) version.textContent = `versão ${newVersion}`;

      message.textContent =
        isOpen(previousStatus) && !isOpen(proposal.status)
          ? 'concluída — sai dos pendentes no próximo "Atualizar"'
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
    setNotice('carregando…', false);

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
      ...(open.length === 0 ? [el('li', 'muted', 'nenhuma proposta esperando decisão')] : open.map(renderRow)),
    );
    fill(
      historyList,
      ...(history.length === 0 ? [el('li', 'muted', 'nada decidido ainda')] : history.map(renderRow)),
    );

    setNotice(`${proposals.length} proposta(s)`, false);
  }

  refresh.addEventListener('click', () => {
    void reload();
  });
  void reload();

  return { reload };
}
