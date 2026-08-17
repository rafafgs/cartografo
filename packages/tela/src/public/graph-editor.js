/**
 * The graph configuration screen (t170).
 *
 * D11 put graph editing after observability, and after the proposal inbox; both
 * shipped, and this is the piece that was still missing — a place where a person
 * changes the topology of a graph without hand-writing a JSON body.
 *
 * ## It has no privilege, and no shortcut
 *
 * A graph moves through ONE door: a proposal, applied. So saving here is
 * literally the three calls a scripted client would make —
 * `POST /v1/proposals` → `/approve` → `/apply` — and nothing else. There is no
 * new route in `packages/core`, no bulk write, no "just this once". The gate
 * that refuses an unsound graph is the same gate that refuses the topographer's
 * proposals, and when it does, its reasons come to the page through
 * `graph-soundness.js` instead of being swallowed.
 *
 * Approve is auto-chained after create on purpose, and that is the one place
 * this page departs from the inbox's rhythm: the human who just edited the
 * graph IS the human the gate would ask, and a second click on their own draft
 * would be ceremony, not judgement. A topographer's proposal still stops at
 * `pendente` and still waits for someone in `/` (README, princípio 5).
 *
 * ## What is editable, and what is not
 *
 * `id`, `node_type` and `engine` of an EXISTING node have no control here.
 * The first two are the node's identity — edges, telemetry and past proposals
 * all point at an id, and the core's own `CHANGEABLE_FIELDS` comment says
 * swapping one "is an operation of its own, not a field swap". `engine` is
 * execution policy, and editing policy is the separate ticket that has a schema
 * to design first. The three are shown, read-only, next to the sentence that
 * says what to do instead: remove the node and re-add it.
 *
 * ## Same rules as the rest of this half of the screen
 *
 * Native ES module, no framework and no bundler. The document and `fetch`
 * arrive as arguments, which is what lets the page be driven from Node
 * (`test/graph-editor-acceptance.test.ts`). Everything rendered goes in through
 * `textContent`, never `innerHTML`: a node came from an agent-authored graph,
 * and D4 treats agent-authored content as an injection vector — the same rule
 * `inbox.js` follows.
 *
 * The wire keys (`graph_id`, `target_version`, `operations`, `evidence`,
 * `expected_metric`, `proposal`, `graph_version`) went English with the API in
 * t226; every string the browser SHOWS stays Portuguese (t133, exceptions 9 and
 * 10), and so do `MANUAL_EVIDENCE`/`MANUAL_METRIC` below, which are the frozen
 * hypothesis shape `domain/hypothesis.ts` owns and D20 does not unfreeze.
 */

import { diffGraphs, FROZEN_NODE_FIELDS } from './graph-operations.js';
import { renderReport } from './graph-soundness.js';

/** Where the classes, the lineages and the versions are read from. */
const CLASSES_URL = '/v1/classes';
const GRAPHS_URL = '/v1/graphs';
const VERSIONS_URL = '/v1/graph-versions';
const PROPOSALS_URL = '/v1/proposals';

/**
 * The evidence every proposal written here carries.
 *
 * `POST /v1/proposals` demands `evidence` and `expected_metric` because a
 * proposal is a HYPOTHESIS (D15) — and a person dragging a node is not making
 * one. Inventing a metric to satisfy the field would be worse than admitting
 * the gap, so the two are fixed, inert and honest about where the change came
 * from. Nothing in this flow calls `/outcome`, which is the only route that
 * ever reads the metric's shape.
 */
export const MANUAL_EVIDENCE = Object.freeze({
  fonte: 'tela-configuracao',
  observacao: 'edição manual via tela de configuração do grafo',
});

/** The inert metric that goes with it. */
export const MANUAL_METRIC = Object.freeze({
  nome: 'edição manual (sem métrica)',
  direcao: 'sobe',
  de: 0,
  para: 0,
});

/** What a brand-new node starts with, so the shape is visible before it is filled. */
const EMPTY_CONTRACT = {
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  checks: [],
};

/** Said next to the three fields no client can swap on an existing node. */
const FROZEN_NOTE = 'remova e recrie o nó para mudar isso';

/** Human label of each field, so the page is not a list of raw key names. */
const FIELD_LABELS = {
  id: 'id',
  node_type: 'tipo do nó (work ou gate)',
  engine: 'engine',
  role: 'papel',
  description: 'descrição',
  contract: 'contrato (JSON: input_schema, output_schema, checks)',
  from: 'de',
  to: 'para',
  condition: 'condição',
};

/**
 * Starts the page.
 *
 * @param {Document} doc Document to render into.
 * @param {typeof fetch} request HTTP client (same-origin, proxied to the core).
 * @returns {{
 *   ready: Promise<void>,
 *   loadClasses: () => Promise<void>,
 *   loadGraph: (graphId?: string) => Promise<void>,
 *   save: () => Promise<void>,
 *   state: () => {graphId: string|null, versionId: string|null, appliedVersionId: string|null},
 * }} Handle, for the console and for the acceptance tests.
 */
export function mount(doc, request) {
  const picker = doc.getElementById('graph-picker');
  const loadButton = doc.getElementById('load');
  const notice = doc.getElementById('notice');
  const base = doc.getElementById('base');
  const nodeList = doc.getElementById('node-list');
  const edgeList = doc.getElementById('edge-list');
  const addNode = doc.getElementById('add-node');
  const addEdge = doc.getElementById('add-edge');
  const saveButton = doc.getElementById('save');
  const problems = doc.getElementById('problems');
  const result = doc.getElementById('result');

  /* ------------------------------------------------------------- the state */

  /** Lineage being edited, and the version the edits sit on top of. */
  let graphId = null;
  let versionId = null;

  /** The snapshot as it was loaded — the left side of every diff. */
  let loaded = null;

  /**
   * One entry per node on screen.
   *
   * The contract travels as TEXT and is only parsed on save: a half-typed JSON
   * object is a normal state of an editor, not an error to shout about at every
   * keystroke, and parsing eagerly would throw the text away the moment it
   * stopped being valid.
   *
   * @type {{node: Record<string, unknown>, fresh: boolean, contractText: string}[]}
   */
  let nodeEntries = [];

  /** @type {Record<string, unknown>[]} */
  let edgeEntries = [];

  /** Version written by the last successful save, or `null`. */
  let appliedVersionId = null;

  /** Serial number behind each `for`/`id` pair; ids of the API never enter one. */
  let fieldCount = 0;

  /* ------------------------------------------------------------- rendering */

  /**
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   */
  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    // Always textContent, never innerHTML: a node id, a role or a condition was
    // written by an agent into a graph document (D4).
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** @param {Element} node @param {...Element} children */
  function fill(node, ...children) {
    node.replaceChildren(...children);
    return node;
  }

  function setNotice(text, isError) {
    notice.textContent = text;
    notice.classList.toggle('error', isError === true);
  }

  /** A label tied to its control by `for`/`id`, never a placeholder (t128). */
  function labelled(control, field) {
    const line = el('p', 'field');
    const id = `graph-field-${(fieldCount += 1)}`;
    const label = el('label', 'field-label', FIELD_LABELS[field] ?? field);
    label.htmlFor = id;
    control.id = id;
    control.setAttribute('data-campo', field);
    line.append(label, control);
    return line;
  }

  /**
   * One editable field.
   *
   * @param {string} tag `input` or `textarea`.
   * @param {string} field Name under `data-campo`.
   * @param {string} value Current text.
   * @param {(value: string) => void} onInput What the typing writes into.
   */
  function textField(tag, field, value, onInput) {
    const control = el(tag, 'field-input');
    if (tag === 'input') control.type = 'text';
    control.value = value;
    control.addEventListener('input', () => {
      onInput(control.value);
    });
    return labelled(control, field);
  }

  /** The same, as a closed list — used by `node_type`, whose vocabulary is two words. */
  function choiceField(field, choices, value, onInput) {
    const control = el('select', 'field-input');
    // Options first, then the value: a `<select>` refuses a value it has no
    // option for, and the order is the difference between showing the node's
    // type and showing the first choice.
    control.append(
      ...choices.map((choice) => {
        const option = el('option', undefined, choice);
        option.value = choice;
        return option;
      }),
    );
    control.value = value;
    control.addEventListener('input', () => {
      onInput(control.value);
    });
    return labelled(control, field);
  }

  /** A value shown and not offered for editing, with the reason next to it. */
  function frozenField(field, value) {
    const line = el('p', 'field frozen');
    line.setAttribute('data-frozen', field);
    line.append(
      el('span', 'field-label', `${FIELD_LABELS[field] ?? field}: `),
      el('span', 'field-value', value === undefined || value === '' ? '—' : String(value)),
    );
    return line;
  }

  /** A `skill_ref` part, as its own control (`skill_ref.id`, `.version`, `.hash`). */
  function skillField(node, part) {
    const reference = isObject(node.skill_ref) ? node.skill_ref : {};
    const current = typeof reference[part] === 'string' ? reference[part] : '';
    return textField('input', `skill_ref.${part}`, current, (value) => {
      const next = isObject(node.skill_ref) ? { ...node.skill_ref } : {};
      next[part] = value;
      node.skill_ref = next;
    });
  }

  /**
   * One node.
   *
   * A node that exists in the loaded snapshot shows `id`, `node_type` and
   * `engine` read-only, with the sentence that says what to do instead. A node
   * being born has no identity to protect yet, so all three are typed here and
   * travel inside the single `adicionar_no` operation.
   */
  function renderNode(entry) {
    const node = entry.node;
    const card = el('li', entry.fresh ? 'card fresh' : 'card');
    card.setAttribute('data-node', typeof node.id === 'string' ? node.id : '');
    if (entry.fresh) card.setAttribute('data-new', 'true');

    const head = el('p', 'head');
    const title = el('span', 'title', entry.fresh ? 'nó novo' : `nó ${String(node.id)}`);
    const remove = el('button', 'action', 'Remover nó');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      removeNode(entry);
    });
    head.append(title, remove);
    card.append(head);

    if (entry.fresh) {
      card.append(
        textField('input', 'id', String(node.id ?? ''), (value) => {
          node.id = value;
          card.setAttribute('data-node', value);
          title.textContent = value === '' ? 'nó novo' : `nó ${value}`;
        }),
        choiceField('node_type', ['work', 'gate'], String(node.node_type ?? 'work'), (value) => {
          node.node_type = value;
        }),
        textField('input', 'engine', String(node.engine ?? ''), (value) => {
          node.engine = value;
        }),
      );
    } else {
      const frozen = el('div', 'frozen-block');
      for (const field of FROZEN_NODE_FIELDS) frozen.append(frozenField(field, node[field]));
      frozen.append(el('p', 'muted', FROZEN_NOTE));
      card.append(frozen);
    }

    card.append(
      textField('input', 'role', String(node.role ?? ''), (value) => {
        node.role = value;
      }),
      textField('input', 'description', String(node.description ?? ''), (value) => {
        node.description = value;
      }),
      skillField(node, 'id'),
      skillField(node, 'version'),
      skillField(node, 'hash'),
      textField('textarea', 'contract', entry.contractText, (value) => {
        entry.contractText = value;
      }),
    );

    return card;
  }

  /** One edge. Both ends are editable: changing one is a removal plus an addition. */
  function renderEdge(edge) {
    const card = el('li', 'card');
    card.setAttribute('data-edge', `${String(edge.from ?? '')} ${String(edge.to ?? '')}`);

    const head = el('p', 'head');
    const title = el('span', 'title', describeEdge(edge));
    const remove = el('button', 'action', 'Remover aresta');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      removeEdge(edge);
    });
    head.append(title, remove);

    const retitle = () => {
      title.textContent = describeEdge(edge);
      card.setAttribute('data-edge', `${String(edge.from ?? '')} ${String(edge.to ?? '')}`);
    };

    card.append(
      head,
      textField('input', 'from', String(edge.from ?? ''), (value) => {
        edge.from = value;
        retitle();
      }),
      textField('input', 'to', String(edge.to ?? ''), (value) => {
        edge.to = value;
        retitle();
      }),
      textField('input', 'condition', String(edge.condition ?? ''), (value) => {
        edge.condition = value;
      }),
      textField('input', 'description', String(edge.description ?? ''), (value) => {
        edge.description = value;
      }),
    );

    return card;
  }

  function describeEdge(edge) {
    return `${String(edge.from ?? '—')} → ${String(edge.to ?? '—')}`;
  }

  /** Redraws both lists. Called on load and whenever a card comes or goes. */
  function draw() {
    fill(
      nodeList,
      ...(nodeEntries.length === 0
        ? [el('li', 'muted', 'nenhum nó — este grafo não atravessaria nada')]
        : nodeEntries.map(renderNode)),
    );
    fill(
      edgeList,
      ...(edgeEntries.length === 0
        ? [el('li', 'muted', 'nenhuma aresta')]
        : edgeEntries.map(renderEdge)),
    );
  }

  /* --------------------------------------------------------------- editing */

  function removeNode(entry) {
    const id = typeof entry.node.id === 'string' ? entry.node.id : '';
    nodeEntries = nodeEntries.filter((candidate) => candidate !== entry);

    // The edges that touched it go with it, and the page SAYS so. Leaving them
    // behind would only earn a structure error on save; removing them without a
    // word would be the page deciding something on its own.
    const orphans = new Set(
      id === '' ? [] : edgeEntries.filter((edge) => edge.from === id || edge.to === id),
    );
    edgeEntries = edgeEntries.filter((edge) => !orphans.has(edge));
    const dropped = orphans.size;

    draw();
    setNotice(
      dropped === 0
        ? `nó "${id}" removido do rascunho`
        : `nó "${id}" removido do rascunho, junto com ${dropped} aresta(s) que o tocavam`,
      false,
    );
  }

  function removeEdge(edge) {
    edgeEntries = edgeEntries.filter((candidate) => candidate !== edge);
    draw();
    setNotice(`aresta ${describeEdge(edge)} removida do rascunho`, false);
  }

  /* ------------------------------------------------------------------ HTTP */

  /**
   * One HTTP call, with failures already turned into a body.
   *
   * Same shape as `inbox.js`: the proxy answers `502 control_plane_indisponivel`
   * when the core is down, so what is left here is the screen's own server
   * being gone.
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
          error: 'tela_sem_resposta',
          message: `a tela não respondeu (${cause instanceof Error ? cause.message : 'falha de rede'})`,
        },
      };
    }

    let body = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: 'resposta_ilegivel', message: text.slice(0, 200) };
      }
    }
    return { ok: response.ok, status: response.status, body };
  }

  /** Posts a JSON body; every write of this page goes through here. */
  function post(url, body) {
    return call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** The human-readable half of an error body, in the core's own vocabulary. */
  function messageOf(body, status) {
    if (!isObject(body)) return `falha ${status}`;
    if (typeof body.message === 'string' && body.message !== '') {
      return typeof body.error === 'string' ? `${body.error}: ${body.message}` : body.message;
    }
    if (typeof body.error === 'string') return body.error;
    if (typeof body.message === 'string' && body.message !== '') return body.message;
    return `falha ${status}`;
  }

  /* --------------------------------------------------------------- loading */

  /** Fills the picker with the registered classes (FR1). */
  async function loadClasses() {
    setNotice('carregando classes…', false);
    const answer = await call(CLASSES_URL);
    if (!answer.ok) {
      setNotice(messageOf(answer.body, answer.status), true);
      return;
    }

    // `GET /v1/classes` lists base lineages only — a variant is not offered
    // here, and editing one is out of scope (D13, `t118`).
    const classes = isObject(answer.body) && Array.isArray(answer.body.classes)
      ? answer.body.classes
      : [];

    fill(
      picker,
      ...classes.map((entry) => {
        const option = el('option', undefined, `${String(entry.class)} (${String(entry.graph_id)})`);
        option.value = String(entry.graph_id);
        return option;
      }),
    );

    setNotice(
      classes.length === 0
        ? 'nenhuma classe registrada ainda — importe um grafo de fábrica primeiro'
        : `${classes.length} classe(s) registrada(s)`,
      false,
    );
  }

  /**
   * Loads the current version of one lineage and draws it (FR1).
   *
   * Two reads and not one: the lineage says which version holds now, and the
   * version carries the snapshot. Both are public routes; nothing here knows
   * that a database exists.
   */
  async function loadGraph(chosen) {
    const wanted = chosen ?? picker.value;
    if (typeof wanted !== 'string' || wanted === '') {
      setNotice('escolha um grafo para carregar', true);
      return;
    }

    setNotice(`carregando ${wanted}…`, false);
    fill(problems);
    fill(result);
    appliedVersionId = null;

    const lineage = await call(`${GRAPHS_URL}/${encodeURIComponent(wanted)}`);
    if (!lineage.ok) {
      setNotice(messageOf(lineage.body, lineage.status), true);
      return;
    }

    const graph = isObject(lineage.body) ? lineage.body.graph : undefined;
    const current = isObject(graph) ? graph.current_version_id : null;
    if (typeof current !== 'string' || current === '') {
      setNotice('este grafo não aponta para versão corrente nenhuma', true);
      return;
    }

    const version = await call(`${VERSIONS_URL}/${encodeURIComponent(current)}`);
    if (!version.ok) {
      setNotice(messageOf(version.body, version.status), true);
      return;
    }

    const row = isObject(version.body) ? version.body.graph_version : undefined;
    const snapshot = isObject(row) ? row.snapshot : undefined;
    if (!isObject(snapshot)) {
      setNotice('a versão veio sem snapshot; não há o que editar', true);
      return;
    }

    graphId = wanted;
    versionId = current;
    loaded = clone(snapshot);

    nodeEntries = (Array.isArray(snapshot.nodes) ? snapshot.nodes : [])
      .filter(isObject)
      .map((node) => ({
        node: clone(node),
        fresh: false,
        contractText: asJsonText(node.contract),
      }));
    edgeEntries = (Array.isArray(snapshot.edges) ? snapshot.edges : []).filter(isObject).map(clone);

    fill(
      base,
      el('span', 'label', 'editando '),
      el('span', 'value', `${String(snapshot.problem_class ?? wanted)} · versão ${current}`),
    );

    draw();
    setNotice(`${nodeEntries.length} nó(s) e ${edgeEntries.length} aresta(s) carregados`, false);
  }

  /* ----------------------------------------------------------------- saving */

  /**
   * The edited document, or `null` when the page can already say what is wrong.
   *
   * Refusing here rather than at the API is not the page taking over the gate's
   * job: these are the failures that would come back as a generic `400` about a
   * malformed operation, which says nothing about WHICH node someone mistyped.
   * Everything a graph can be wrong about still goes to the gate.
   */
  function buildDocument() {
    const complaints = [];
    const nodes = [];
    const seen = new Set();

    for (const entry of nodeEntries) {
      const node = { ...entry.node };
      const id = typeof node.id === 'string' ? node.id.trim() : '';
      if (id === '') {
        complaints.push('há um nó sem id: todo nó precisa de um id antes de salvar');
        continue;
      }
      if (seen.has(id)) complaints.push(`o id de nó "${id}" aparece mais de uma vez`);
      seen.add(id);
      node.id = id;

      try {
        node.contract = JSON.parse(entry.contractText);
      } catch (cause) {
        complaints.push(
          `o contrato do nó "${id}" não é JSON válido: ${cause instanceof Error ? cause.message : 'erro de parse'}`,
        );
      }

      // An optional field left blank is an absent field, not an empty one.
      for (const field of ['description', 'engine']) {
        if (node[field] === '' || node[field] === undefined) delete node[field];
      }
      nodes.push(node);
    }

    const edges = [];
    for (const edge of edgeEntries) {
      const from = typeof edge.from === 'string' ? edge.from.trim() : '';
      const to = typeof edge.to === 'string' ? edge.to.trim() : '';
      if (from === '' || to === '') {
        complaints.push('há uma aresta sem as duas pontas: preencha "de" e "para" antes de salvar');
        continue;
      }
      const copy = { ...edge, from, to };
      if (copy.description === '' || copy.description === undefined) delete copy.description;
      edges.push(copy);
    }

    if (complaints.length > 0) {
      showLines(complaints, true);
      setNotice('nada foi enviado: o rascunho ainda tem problema', true);
      return null;
    }
    return { ...loaded, nodes, edges };
  }

  /** Writes one line per problem, in the page's one place for them. */
  function showLines(lines, isError) {
    fill(problems, ...lines.map((line) => el('p', isError ? 'problem error' : 'problem', line)));
  }

  /** A "Recarregar" button, which is the only thing this page ever retries with. */
  function reloadAction(label) {
    const button = el('button', 'action', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      void loadGraph(graphId ?? undefined);
    });
    return button;
  }

  /**
   * Create → approve → apply, stopping at the first failure (FR5, FR6).
   *
   * Nothing is retried automatically, at any step. A `409` in particular is the
   * base having moved while someone was editing, and the only honest answer is
   * to reload and look at what changed — rebasing a diff silently is exactly the
   * kind of helpfulness that writes a version nobody decided on.
   */
  async function save() {
    fill(problems);
    fill(result);

    if (graphId === null || versionId === null || loaded === null) {
      setNotice('carregue um grafo antes de salvar', true);
      return;
    }

    const edited = buildDocument();
    if (edited === null) return;

    const operations = diffGraphs(loaded, edited);
    if (operations.length === 0) {
      setNotice('nenhuma alteração para salvar', false);
      return;
    }

    setNotice(`enviando ${operations.length} operação(ões)…`, false);

    const created = await post(PROPOSALS_URL, {
      graph_id: graphId,
      target_version: versionId,
      operations,
      evidence: MANUAL_EVIDENCE,
      expected_metric: MANUAL_METRIC,
    });
    if (!created.ok) {
      refuse(created, 'a proposta não foi criada');
      return;
    }

    const proposal = isObject(created.body) ? created.body.proposal : undefined;
    const proposalId = isObject(proposal) ? proposal.id : undefined;
    if (proposalId === undefined || proposalId === null) {
      setNotice('a API criou a proposta sem devolver o id dela', true);
      return;
    }

    const approved = await post(`${PROPOSALS_URL}/${String(proposalId)}/approve`, {});
    if (!approved.ok) {
      refuse(approved, `a proposta #${String(proposalId)} não foi aprovada`);
      return;
    }

    const applied = await post(`${PROPOSALS_URL}/${String(proposalId)}/apply`, {});
    if (!applied.ok) {
      refuse(applied, `a proposta #${String(proposalId)} foi recusada ao aplicar`);
      return;
    }

    const written = isObject(applied.body) ? applied.body.graph_version : undefined;
    const newVersion = isObject(written) && typeof written.id === 'string' ? written.id : null;
    appliedVersionId = newVersion;

    // The page does NOT navigate away: whoever saved may want to keep editing,
    // and the way to do it is on top of the version that just came into being.
    fill(
      result,
      el('p', 'ok', newVersion === null ? 'aplicada' : `versão nova: ${newVersion}`),
      reloadAction('Recarregar'),
    );
    setNotice('aplicada', false);
  }

  /**
   * Shows why a step failed, in the vocabulary of the step that failed (FR6).
   *
   * Three shapes, and each one is a different conversation:
   * - `422 grafo_invalido` carries the whole gate report, which becomes one
   *   prose line per problem (`graph-soundness.js`);
   * - `422 inapplicable_operation` / `version_without_effect` already wrote a
   *   sentence about the snapshot, and it is shown as it came;
   * - `409 stale_proposal` is the base having moved, and the answer is
   *   a button, not a retry.
   */
  function refuse(answer, headline) {
    const body = isObject(answer.body) ? answer.body : {};

    if (answer.status === 422 && body.error === 'invalid_graph') {
      showLines(renderReport(body), true);
      setNotice(`${headline}: o portão de soundness reprovou`, true);
      return;
    }

    if (answer.status === 409 && body.error === 'stale_proposal') {
      showLines(['a base do grafo mudou enquanto você editava'], true);
      problems.append(reloadAction('Recarregar'));
      setNotice(headline, true);
      return;
    }

    showLines([messageOf(body, answer.status)], true);
    setNotice(headline, true);
  }

  /* ---------------------------------------------------------------- wiring */

  loadButton.addEventListener('click', () => {
    void loadGraph();
  });
  addNode.addEventListener('click', () => {
    nodeEntries.push({
      node: { id: '', role: '', node_type: 'work', skill_ref: { id: '', version: '', hash: '' } },
      fresh: true,
      contractText: asJsonText(EMPTY_CONTRACT),
    });
    draw();
    setNotice('nó novo no rascunho — preencha id, papel, skill e contrato', false);
  });
  addEdge.addEventListener('click', () => {
    edgeEntries.push({ from: '', to: '', condition: '' });
    draw();
    setNotice('aresta nova no rascunho', false);
  });
  saveButton.addEventListener('click', () => {
    void save();
  });

  draw();
  const ready = loadClasses();

  return {
    ready,
    loadClasses,
    loadGraph,
    save,
    state: () => ({ graphId, versionId, appliedVersionId }),
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A deep copy that shares nothing with what the API handed over. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** A value as editable JSON text, with an honest fallback for the unprintable. */
function asJsonText(value) {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}
