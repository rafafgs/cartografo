/**
 * Which actions a proposal offers, given its status (FR6).
 *
 * The safety ladder of principle 5 says a change to the graph passes a human
 * gate. This table IS that gate's shape on screen: a proposal shows exactly the
 * actions the API would accept for the status it is in, and nothing else. An
 * offered button that comes back `409 proposal_not_pending` teaches the person
 * to distrust the screen, which is worse than one button fewer.
 *
 * Pure and side-effect free so it can be tested in Node while running in the
 * browser (`test/actions.test.ts`) — no DOM, no fetch, no import.
 *
 * The names are the API's, because they ARE the route: `approve` is the path of
 * `POST /v1/proposals/:id/approve`. They came in from t111 in Portuguese and
 * were renamed with the rest of the `/v1` surface (t127, FR3/FR4) — this file's
 * own identifiers and the button labels are the tela ticket's scope, not this
 * one's. `approve` and `reject` have no route in core yet; they are spelled the
 * way core will spell them under D18.
 */

/** @typedef {'approve' | 'reject' | 'apply' | 'revert'} ActionName */

/**
 * @typedef {object} ActionDescriptor
 * @property {ActionName} route Last segment of `POST /v1/proposals/:id/<route>`.
 * @property {string} label Button text, in Portuguese, like the rest of the page.
 * @property {boolean} requiresReason Whether a `reason` is mandatory (FR7).
 * @property {string} reasonLabel Visible label — and accessible name — of the reason field, when there is one.
 */

/** Everything a row needs to draw a button and fire it. */
/** @type {Readonly<Record<ActionName, ActionDescriptor>>} */
export const ACTIONS = Object.freeze({
  approve: Object.freeze({
    route: 'approve',
    label: 'Aprovar',
    requiresReason: false,
    reasonLabel: '',
  }),
  reject: Object.freeze({
    route: 'reject',
    label: 'Rejeitar',
    requiresReason: true,
    reasonLabel: 'Por que esta hipótese não vale a pena?',
  }),
  apply: Object.freeze({
    route: 'apply',
    label: 'Aplicar',
    requiresReason: false,
    reasonLabel: '',
  }),
  revert: Object.freeze({
    route: 'revert',
    label: 'Reverter',
    requiresReason: true,
    reasonLabel: 'Por que a versão aplicada está sendo abandonada?',
  }),
});

/**
 * The state machine, written out.
 *
 * `pending` and `approved` are the two states waiting on a person; `applied`
 * is the one that can still be undone; `reverted` and `rejected` are history.
 * English since t226: this is the `status` the API publishes.
 * A rejected proposal is negative knowledge for the topographer (`t110`), which
 * is why it stays on the page as read-only instead of disappearing.
 */
/** @type {Readonly<Record<string, readonly ActionName[]>>} */
const ACTIONS_BY_STATUS = Object.freeze({
  pending: Object.freeze(['approve', 'reject']),
  approved: Object.freeze(['apply']),
  applied: Object.freeze(['revert']),
  reverted: Object.freeze([]),
  rejected: Object.freeze([]),
});

/** Statuses that are still waiting on a person — the "Pendentes" section (FR3). */
export const OPEN_STATUSES = Object.freeze(['pending', 'approved']);

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
