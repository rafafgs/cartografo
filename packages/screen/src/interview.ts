/**
 * The interview, as two columns of HTML: the exchange on the left, the map it
 * is drawing on the right (t433, RF-15, RF-16, RF-21).
 *
 * Pure and framework-free, in the same spirit as `map-document.ts`: no HTTP, no
 * import from `packages/core`, no clock. It takes the conversation projection
 * (`docs/spec/interview.md` §3) — and, since t460, the report a control plane
 * already answered — and gives back strings, which is exactly what makes `GET
 * /interview/:id` and `GET /interview/:id/fragment` incapable of disagreeing
 * about what the page says. Both call the same three functions, and the last
 * two exist only so a poll can swap what the first one drew.
 *
 * The purity survives the new panel because the CALL is not here: `pages.ts`
 * asks `POST /v1/graphs/validate` and hands the answer down, so this module
 * still knows nothing about a network.
 *
 * ## It reads the projection, never the mechanism
 *
 * Nothing here knows there is a job, a session or an input request underneath.
 * That is Rafael's design constraint of 2026-09-05 restated as a type: the
 * recorded plan B of `interview.md` §1 (a dedicated chat session instead of one
 * dispatch per question) changes the mechanism and changes nothing here,
 * because the page never saw the mechanism in the first place.
 *
 * ## The vocabulary is the page's, not the platform's (FR10)
 *
 * A person having a conversation is not told about jobs, runners or input
 * requests: they see an interview, a map, steps, questions and answers. That
 * rule is about what a person READS — the route paths, the `data-*` markers and
 * the class names below are identifiers and are untouched by it — and
 * `test/interview.test.ts` sweeps every string this module emits for the three
 * words it forbids.
 *
 * ## Which state wins, and why `done` is checked before `thinking`
 *
 * In order: the open question, then the finished state, then "thinking". The
 * projection makes `thinking` and `done` mutually exclusive already, so the
 * order between those two changes nothing — what the order DOES settle is the
 * fourth case the projection allows and does not name: nothing pending, not
 * done, and no session open yet, which is every interview between the moment it
 * is started and the moment a runner picks it up. That reads as "working on it"
 * to the person waiting, so "thinking" is the default and not a state of its
 * own.
 *
 * ## Escaping, with no exception
 *
 * Every question, context, recommendation, option and answer below was written
 * by an agent or typed by a person, and passes through `escapeHtml` — the same
 * rule `pages.ts` and `map-document.ts` state for their own content (D4).
 */

import type { Conversation, ConversationTurn, PendingQuestion } from './client.ts';
import { renderMapDocument, type MapDocumentGraph, type MapDocumentManifest } from './map-document.ts';
import type { McpServerSuggestion } from './mcp-catalog.ts';
import { escapeHtml } from './pages.ts';
import { renderReport } from './public/graph-soundness.js';

/** What the map column says while the interview has drawn nothing yet. */
const NOTHING_TO_DRAW = 'nothing to draw yet';

/** The one line above the draft's remaining problems, and what it frames them as. */
const PROGRESS_LEAD = 'If this map were registered right now:';

/**
 * The engine a suggestion's command is written for when nothing recorded one.
 *
 * A literal, and NOT an import of `pages.ts`'s own `DEFAULT_ENGINE`: the two
 * modules already import each other (this one takes `escapeHtml` from there,
 * that one takes `renderChat` from here), and a second name crossing the same
 * bidirectional edge buys nothing. Both spell the same string, and
 * `test/interview.test.ts` reads it off the rendered page.
 */
const DEFAULT_ENGINE = 'claude-code';

/** What every suggestion says about itself, verbatim, and by whose authority. */
const MCP_DISCLAIMER =
  'not reviewed by anyone on your side; configure its credentials on the engine, not here.';

/** What a suggestion says instead of a command when none is evidenced. */
const NO_COMMAND_LINE = 'no known add command; see its homepage';

/** The one line above the candidates: where they came from, and what they are not. */
const MCP_INTRO =
  'Nothing this engine reports covers that. These come from the official MCP registry — cartografo suggests, and never installs.';

/** The map as the interview reports it: a graph document and one manifest per step. */
interface DraftShape {
  graph: MapDocumentGraph;
  skills?: MapDocumentManifest[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads `conversation.draft` as a drawable map, or says it is not one.
 *
 * `draft` arrives as `unknown` and that is honest — it is an agent's report,
 * checked upstream against the step's own output schema and against nothing
 * this package declares. A draft with no `graph` is not half a map, it is
 * nothing to draw, and it renders the same placeholder an absent one does.
 *
 * @param draft The projection's `draft`, as it came.
 * @returns The graph and its manifests, or `undefined`.
 */
export function draftToDraw(draft: unknown): DraftShape | undefined {
  if (!isObject(draft)) return undefined;
  const graph = draft.graph;
  if (!isObject(graph) || !Array.isArray(graph.nodes)) return undefined;
  const skills = Array.isArray(draft.skills) ? (draft.skills as MapDocumentManifest[]) : undefined;
  return { graph: graph as unknown as MapDocumentGraph, skills };
}

/** One closed exchange: what was asked, and what came back. */
function turnHtml(turn: ConversationTurn, index: number): string {
  const signature = [turn.answered_by, turn.at]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => escapeHtml(part))
    .join(' · ');

  return (
    `<article class="turn" data-turn="${index}">` +
    `<p class="asked">${escapeHtml(turn.question)}</p>` +
    `<p class="said">${escapeHtml(turn.answer)}</p>` +
    (signature === '' ? '' : `<p class="signature">${signature}</p>`) +
    `</article>`
  );
}

/**
 * The command that adds one candidate on the engine this project records.
 *
 * Two engines have a measured `mcp add` shape in this repository, and an
 * `engine` setting is free text an operator wrote — so anything else is not a
 * failure to render, it is a candidate with no command, exactly like one whose
 * registry entry offered no runnable package. The two cases collapse here
 * deliberately: to the person reading, "we do not know your CLI" and "we do not
 * know this server's runtime" are the same instruction, which is to go and read
 * its homepage.
 *
 * @param suggestion The candidate.
 * @param engine The `engine` setting in force.
 * @returns The command, or `null` when none is evidenced.
 */
function addCommand(suggestion: McpServerSuggestion, engine: string): string | null {
  if (engine === 'claude-code') return suggestion.install.claude_code;
  if (engine === 'codex') return suggestion.install.codex;
  return null;
}

/**
 * The candidates for a capability nobody on this machine covers (RF-20).
 *
 * Read the markup twice, because two of its absences are the requirement and
 * not an oversight: there is **no `<form>` and no `<button>`** anywhere in this
 * block, and the ONLY `href` it emits is a candidate's own `homepage`. §1.4 of
 * the requirements says this suggests and never installs, and a page that
 * offered a one-click "add it" would be installing — through the person's hand,
 * on a server nobody on their side reviewed (D4's reading of an imported
 * capability as an injection vector).
 *
 * The command is a `<pre><code>` to copy, the same shape the check page's own
 * fix actions take (`pages.ts`'s `commandBlock`) — repeated rather than
 * imported, because that helper is private to a page whose vocabulary this
 * column does not share.
 *
 * @param suggestions The candidates, at most three.
 * @param engine The `engine` setting, for which command to show.
 * @returns The block, or an empty string when there is nothing to suggest.
 */
function suggestionsHtml(suggestions: McpServerSuggestion[], engine: string): string {
  if (suggestions.length === 0) return '';

  const cards = suggestions
    .map((suggestion) => {
      const command = addCommand(suggestion, engine);
      const how =
        command === null
          ? `<p class="no-command">${NO_COMMAND_LINE}</p>`
          : `<pre><code>${escapeHtml(command)}</code></pre>`;
      const where =
        suggestion.homepage === null
          ? ''
          : `<p class="homepage"><a href="${escapeHtml(suggestion.homepage)}">${escapeHtml(suggestion.homepage)}</a></p>`;

      return (
        `<article class="mcp-suggestion">` +
        `<h3>${escapeHtml(suggestion.name)}</h3>` +
        `<p class="what">${escapeHtml(suggestion.description)}</p>` +
        how +
        where +
        `<p class="caveat">${MCP_DISCLAIMER}</p>` +
        `</article>`
      );
    })
    .join('');

  return `<div class="mcp-suggestions"><p class="lead">${MCP_INTRO}</p>${cards}</div>`;
}

/**
 * The open question, with everything it takes to decide and the form to answer.
 *
 * The card carries all five fields the projection publishes, for the same
 * reason `questionCard` does on `/input-requests`: whoever answers has to be
 * able to decide without opening the repository.
 *
 * The answer field carries a visible `<label>` tied by `for`/`id` and not just
 * a placeholder — a placeholder disappears at the first character typed and is
 * not a reliable accessible name (t128, and `questions-answer-field.test.ts`).
 * The id is the question's own, which is also what tells a poll whether the
 * SAME question is still open: a new question means a new id, and the island
 * then carries nothing over.
 *
 * The options are buttons that copy into the field, exactly `questionCard`'s
 * pattern — with the script outside this fragment, in the page, so that a swap
 * of the column's contents never takes it away.
 *
 * Since t373 the card can carry a fourth thing, and only ever between the `<dl>`
 * and the form: the candidates for a server the question asks for and this
 * machine does not have. They arrive already resolved — this module still makes
 * no call of its own — and an empty list draws nothing at all, which is what
 * every existing call site gets by leaving the parameter off.
 */
function pendingHtml(
  pending: PendingQuestion,
  interviewId: number,
  suggestions: McpServerSuggestion[] = [],
  engine: string = DEFAULT_ENGINE,
): string {
  const field = (label: string, value: string | null): string =>
    value === null || value.trim() === ''
      ? ''
      : `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`;

  const options =
    pending.options === null || pending.options.length === 0
      ? ''
      : `<div class="options">${pending.options
          .map(
            (option) =>
              `<button type="button" data-option="${escapeHtml(option)}">${escapeHtml(option)}</button>`,
          )
          .join('')}</div>`;

  const fieldId = `answer-${pending.id}`;

  return (
    `<article class="asking" data-state="asking" data-question="${pending.id}">` +
    `<p class="asked">${escapeHtml(pending.question)}</p>` +
    `<dl>${field('why it matters', pending.context)}${field('what I would take', pending.recommendation)}${field('if you just accept', pending.default)}</dl>` +
    suggestionsHtml(suggestions, engine) +
    `<form method="post" action="/interview/${interviewId}/answer">` +
    options +
    `<label for="${fieldId}">your answer</label>` +
    `<textarea id="${fieldId}" name="answer" required>${escapeHtml(pending.default ?? '')}</textarea>` +
    `<p><button type="submit">send</button></p>` +
    `</form>` +
    `</article>`
  );
}

/**
 * The closing state: the interview is over, and there are two things to do with
 * what it drew (RF-24, RF-25).
 *
 * Two plain forms and no script at all. The download is a form POST rather than
 * a link because the bytes are built from a draft the server re-reads at write
 * time, and a GET that produced a file would be a GET that had to carry it.
 */
function doneHtml(interviewId: number, drawable: boolean): string {
  if (!drawable) {
    return (
      `<article class="closing" data-state="done">` +
      `<p>The interview is over, and it left no map behind — there is nothing to keep.</p>` +
      `</article>`
    );
  }

  return (
    `<article class="closing" data-state="done">` +
    `<p>The interview is over. Keep this map, or take it with you.</p>` +
    `<form method="post" action="/interview/${interviewId}/register">` +
    `<button type="submit">register this map</button>` +
    `</form>` +
    `<form method="post" action="/interview/${interviewId}/export">` +
    `<button type="submit">download it as a bundle</button>` +
    `</form>` +
    `</article>`
  );
}

/** Nothing to answer and nothing finished: somebody is working on the next question. */
function thinkingHtml(): string {
  return (
    `<article class="thinking" data-state="thinking">` +
    `<p>Working on the next question…</p>` +
    `</article>`
  );
}

/**
 * The left column: every closed turn, then whatever the interview is doing now.
 *
 * @param conversation The exchange, as the projection reports it.
 * @param interviewId The interview this page is showing — it addresses the forms.
 * @param suggestions MCP servers to offer beside the open question (t373); the
 *   caller resolves them, and `[]` — the default — draws none.
 * @param engine The `engine` setting, for which add command a suggestion shows.
 * @returns The column's inner HTML, ready to drop into `#chat`.
 */
export function renderChat(
  conversation: Conversation,
  interviewId: number,
  suggestions: McpServerSuggestion[] = [],
  engine: string = DEFAULT_ENGINE,
): string {
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const history = turns.map(turnHtml).join('');

  const now =
    conversation.pending !== null && conversation.pending !== undefined
      ? pendingHtml(conversation.pending, interviewId, suggestions, engine)
      : conversation.done
        ? doneHtml(interviewId, draftToDraw(conversation.draft) !== undefined)
        : thinkingHtml();

  const opening =
    history === '' && conversation.pending === null && !conversation.done
      ? `<p class="empty">Nothing has been asked yet.</p>`
      : '';

  return `${opening}${history}${now}`;
}

/**
 * The right column: the map as it stands, through the one renderer there is.
 *
 * The manifests handed to `renderMapDocument` are the draft's own, and they
 * carry no `hash` while an interview is running — so RF-20's external-I/O line
 * never appears mid-interview, by construction rather than by omission
 * (`matchesPin` wants all three of id, version and hash). The same renderer
 * draws it whole on `/graphs/:class`, where the pins are closed.
 *
 * @param draft The projection's `draft`, as it came.
 * @returns The column's inner HTML, ready to drop into `#map`.
 */
export function renderMap(draft: unknown): string {
  const drawable = draftToDraw(draft);
  if (drawable === undefined) return `<p class="empty">${NOTHING_TO_DRAW}</p>`;
  return renderMapDocument(drawable.graph, drawable.skills);
}

/**
 * The right column's second panel: what this draft would still fail on (t460).
 *
 * The interview is the only thing that shapes the map
 * (`docs/spec/interview.md` §5), and until this ticket nothing judged what it
 * was shaping until somebody pressed register — after sixteen answers, which is
 * the worst possible moment to learn that four edges never got a label. So the
 * page asks the control plane the same question the register path asks
 * (`POST /v1/graphs/validate`) and draws the answer beside the map.
 *
 * **It reports and never blocks.** A draft is expected to be incomplete for
 * most of an interview — `map-document.ts`'s whole "to be defined" posture — so
 * this panel disables no form, hides no action and refuses nothing. It is the
 * same information the soundness gate would give, given early.
 *
 * The prose is `public/graph-soundness.js`'s, unmodified: the browser already
 * renders the identical report shape with it on the graph editor, and a second
 * wording of the four rules would be a second thing to keep in step with the
 * control plane. What is added here is only markup and escaping — the lines
 * name node and edge ids that came out of an agent's draft, and they pass
 * through `escapeHtml` like every other borrowed string on this page (D4).
 *
 * @param report The control plane's `{valid, structure, soundness}`, or nothing
 *   at all when there is no draft to judge yet.
 * @returns The panel's inner HTML, or an empty string when there is none.
 */
export function renderMapProgress(report: unknown): string {
  if (report === undefined || report === null) return '';

  const lines = renderReport(report)
    .map((line) => `<p class="problem">${escapeHtml(line)}</p>`)
    .join('');

  return `<div class="problems"><p class="lead">${PROGRESS_LEAD}</p>${lines}</div>`;
}
