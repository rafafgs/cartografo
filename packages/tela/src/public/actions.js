/**
 * Which actions a proposal offers, given its status (FR6).
 *
 * The safety ladder of principle 5 says a change to the graph passes a human
 * gate. This table IS that gate's shape on screen: a proposal shows exactly the
 * actions the API would accept for the status it is in, and nothing else. An
 * offered button that comes back `409 proposta_nao_pendente` teaches the person
 * to distrust the screen, which is worse than one button fewer.
 *
 * Pure and side-effect free so it can be tested in Node while running in the
 * browser (`test/actions.test.ts`) — no DOM, no fetch, no import.
 *
 * The names are the API's, in Portuguese, because they ARE the route: `aprovar`
 * is the path of `POST /v1/propostas/:id/aprovar` (D18 covers this package's
 * own identifiers, not the protocol's vocabulary).
 */

/** @typedef {'aprovar' | 'rejeitar' | 'aplicar' | 'reverter'} ActionName */

/**
 * @typedef {object} ActionDescriptor
 * @property {ActionName} route Last segment of `POST /v1/propostas/:id/<route>`.
 * @property {string} label Button text, in Portuguese, like the rest of the page.
 * @property {boolean} requiresReason Whether a `motivo` is mandatory (FR7).
 * @property {string} reasonLabel Placeholder of the reason field, when there is one.
 */

/** Everything a row needs to draw a button and fire it. */
/** @type {Readonly<Record<ActionName, ActionDescriptor>>} */
export const ACTIONS = Object.freeze({
  aprovar: Object.freeze({
    route: 'aprovar',
    label: 'Aprovar',
    requiresReason: false,
    reasonLabel: '',
  }),
  rejeitar: Object.freeze({
    route: 'rejeitar',
    label: 'Rejeitar',
    requiresReason: true,
    reasonLabel: 'Por que esta hipótese não vale a pena?',
  }),
  aplicar: Object.freeze({
    route: 'aplicar',
    label: 'Aplicar',
    requiresReason: false,
    reasonLabel: '',
  }),
  reverter: Object.freeze({
    route: 'reverter',
    label: 'Reverter',
    requiresReason: true,
    reasonLabel: 'Por que a versão aplicada está sendo abandonada?',
  }),
});

/**
 * The state machine, written out.
 *
 * `pendente` and `aprovada` are the two states waiting on a person; `aplicada`
 * is the one that can still be undone; `revertida` and `rejeitada` are history.
 * A rejected proposal is negative knowledge for the topographer (`t110`), which
 * is why it stays on the page as read-only instead of disappearing.
 */
/** @type {Readonly<Record<string, readonly ActionName[]>>} */
const ACTIONS_BY_STATUS = Object.freeze({
  pendente: Object.freeze(['aprovar', 'rejeitar']),
  aprovada: Object.freeze(['aplicar']),
  aplicada: Object.freeze(['reverter']),
  revertida: Object.freeze([]),
  rejeitada: Object.freeze([]),
});

/** Statuses that are still waiting on a person — the "Pendentes" section (FR3). */
export const OPEN_STATUSES = Object.freeze(['pendente', 'aprovada']);

/**
 * Actions valid for a status.
 *
 * Fails safe: an unknown status — a vocabulary the core grew and this screen
 * has not learned yet — is read-only, never an exception in the middle of a
 * render.
 *
 * @param {string} status Status as it came from the API.
 * @returns {ActionName[]} Action names, in the order they should appear.
 */
export function resolveActionsForStatus(status) {
  if (typeof status !== 'string') return [];
  if (!Object.hasOwn(ACTIONS_BY_STATUS, status)) return [];
  return [...ACTIONS_BY_STATUS[status]];
}

/**
 * Is this proposal still waiting on a human decision?
 *
 * @param {string} status Status as it came from the API.
 * @returns {boolean} `true` for the inbox, `false` for the history.
 */
export function isOpen(status) {
  return OPEN_STATUSES.includes(status);
}
