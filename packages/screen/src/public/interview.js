/**
 * The screen's first polling island (t433, FR5, RNF-04).
 *
 * Every other view of this screen renders on the request alone, and `/board`'s
 * `<meta refresh>` is the one exception `docs/spec/screen.md` §7 names. This is
 * the second, and it is narrower on purpose: it is loaded only by
 * `/interview/:id`, only while that interview is still running, and all it does
 * is swap the inner HTML of two elements every three seconds.
 *
 * **It is pure progressive enhancement.** Without this file — blocked, failed
 * to load, scripting off — the whole page still works: the start form, the
 * chat, the answer form and both closing buttons are plain HTML, and reloading
 * is the update, exactly as everywhere else on this screen. Its only effect is
 * that nobody has to.
 *
 * **Nothing here builds DOM out of the answer.** The fragment route hands back
 * HTML the server already escaped (`pages.ts`, `map-document.ts`), which is why
 * `innerHTML` is safe to assign here and would not be if this module were
 * assembling markup out of an agent's words itself (D4). That is a decision of
 * the route's shape, not of this file's: `/interview/:id/fragment` answers
 * strings and never the raw conversation.
 *
 * **Focus is the one thing a swap can destroy.** Somebody halfway through
 * typing an answer must not lose it to a poll, so before every swap the island
 * looks at what has focus; if it is inside the exchange and the incoming HTML
 * still declares an element with that id, the typed value goes back in and so
 * does the focus. The id is the handle and not the `name`, and that is the
 * whole reliability of the rule: the answer field is `answer-<question id>`, so
 * a NEW question is a new id and nothing is carried over — while `name` is
 * always `answer` and would happily carry an answer from one question onto the
 * next.
 *
 * The document, `fetch` and the scheduler all arrive as arguments rather than
 * being read from the globals, the same shape `inbox.js` already uses — which
 * is what lets `test/interview.test.ts` drive it in Node against a stub DOM,
 * with no headless browser anywhere in this package.
 */

/** How long between two polls. Three seconds: `docs/spec/screen-interview.md` §3. */
export const POLL_INTERVAL_MS = 3000;

/**
 * Starts the island.
 *
 * It schedules the first poll and asks nothing at once: the page it is running
 * on was rendered from the same projection a moment ago, so an immediate poll
 * would be one round trip that could only confirm what is already on screen.
 *
 * @param {Document} doc Document to swap into.
 * @param {(url: string) => Promise<Response>} request HTTP client (same-origin).
 * @param {number} interviewId The interview this page is showing.
 * @param {(fn: () => void, ms: number) => void} [schedule] Timer, injectable for tests.
 * @returns {{tick: () => Promise<void>}} Handle: one poll, for tests and the console.
 */
export function mount(doc, request, interviewId, schedule) {
  const chat = doc.getElementById('chat');
  const map = doc.getElementById('map');
  const later = schedule === undefined ? (fn, ms) => void setTimeout(fn, ms) : schedule;
  const url = '/interview/' + interviewId + '/fragment';

  /** The id of the field being typed into, when a swap has to preserve one. */
  function focusedFieldId() {
    const active = doc.activeElement;
    if (active === null || active === undefined) return null;
    if (chat === null || !chat.contains(active)) return null;
    return typeof active.id === 'string' && active.id !== '' ? active.id : null;
  }

  /**
   * One poll: ask, swap, and decide whether there is anything left to ask for.
   *
   * A failure — the screen's own server gone, a body that is not JSON — ends
   * this tick and schedules the next one. There is nothing to report to
   * somebody staring at a page that is simply not moving yet, and a poll that
   * gave up on the first hiccup would be worse than one that keeps trying.
   */
  async function tick() {
    let payload = null;
    try {
      const response = await request(url);
      if (response.ok) payload = await response.json();
    } catch {
      payload = null;
    }

    if (payload === null) {
      later(tick, POLL_INTERVAL_MS);
      return;
    }

    const carrying = focusedFieldId();
    const stillThere =
      carrying !== null && typeof payload.chat === 'string'
        ? payload.chat.indexOf('id="' + carrying + '"') !== -1
        : false;
    const typed = stillThere && doc.activeElement ? doc.activeElement.value : '';

    if (chat !== null && typeof payload.chat === 'string') chat.innerHTML = payload.chat;
    if (map !== null && typeof payload.map === 'string') map.innerHTML = payload.map;

    if (stillThere) {
      const restored = doc.getElementById(carrying);
      if (restored !== null) {
        restored.value = typed;
        restored.focus();
      }
    }

    // The whole stopping rule: an interview that is done has nothing left to
    // report, and a page that kept asking would be a page that never stops.
    if (payload.done === true) return;
    later(tick, POLL_INTERVAL_MS);
  }

  later(tick, POLL_INTERVAL_MS);
  return { tick };
}
