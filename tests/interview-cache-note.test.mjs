/**
 * Acceptance test of t466 — `docs/spec/interview.md` §1 records WHY only the
 * byte-stable half of an interview turn is ever read back from the engine's
 * prompt cache.
 *
 * The incident: across sixteen redispatches of one interview job the engine's
 * terminal `result` frame reported a cache READ frozen at the same token count
 * on every turn, while cache CREATED climbed turn over turn — the exact shape
 * of `buildPrompt`'s append-only `## What you already asked, and what came
 * back` block. The explanation is entirely in this repository: every dispatch
 * opens a brand-new engine session (`buildSessionSpec` never sets
 * `resumeFrom`), so the growing per-turn prompt has no NEXT turn of the same
 * session to read it back in.
 *
 * Two properties, and the second is what keeps the first honest:
 *
 * - the paragraph EXISTS, sits after the "recorded plan B." paragraph and
 *   before `## 2.`, and makes the specific claim rather than a vaguer one a
 *   later edit could hollow out — hence the required `resumeFrom`, the two
 *   mentions of the cache, and the citation of `session-spec.ts`;
 * - the CODE FACT the paragraph is built on still holds: `session-spec.ts`
 *   contains no `resumeFrom` at all. The day somebody wires session continuity
 *   into `buildSessionSpec`, this half fails loudly and sends them back to the
 *   paragraph, instead of the document quietly going stale.
 *
 * The swept region deliberately STARTS AFTER the plan-B paragraph: that
 * paragraph already says `resumeFrom` itself, and including it would let the
 * first assertion pass with no new text written at all.
 *
 * Run with: `node --test tests/`
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

const PLAN_B_MARKER = '**What this costs, and the recorded plan B.**';
const SECTION_TWO_HEADING = '\n## 2.';

/**
 * The text of §1 that follows the plan-B paragraph, up to the `## 2.` heading.
 *
 * @returns {string}
 */
function readCacheNoteRegion() {
  const document = readFileSync(path.join(ROOT, 'docs/spec/interview.md'), 'utf8');

  const markerAt = document.indexOf(PLAN_B_MARKER);
  assert.notEqual(
    markerAt,
    -1,
    `docs/spec/interview.md no longer contains "${PLAN_B_MARKER}" — the anchor this ` +
      'test and the t466 paragraph are both placed against.',
  );

  // End of the plan-B paragraph: the first blank line past the marker.
  const paragraphEnd = document.indexOf('\n\n', markerAt);
  assert.notEqual(paragraphEnd, -1, 'the plan-B paragraph runs to the end of the file');

  const headingAt = document.indexOf(SECTION_TWO_HEADING, paragraphEnd);
  assert.notEqual(headingAt, -1, 'docs/spec/interview.md has no `## 2.` heading after §1');

  return document.slice(paragraphEnd, headingAt);
}

test('§1 records why the interview prompt is written to cache but never read back', () => {
  const region = readCacheNoteRegion();

  assert.match(
    region,
    /resumeFrom/,
    'the paragraph must name `resumeFrom` — the key `buildSessionSpec` never sets, which is ' +
      'the whole reason each turn is a new session',
  );

  const cacheMentions = region.match(/cache/gi) ?? [];
  assert.ok(
    cacheMentions.length >= 2,
    `the paragraph must talk about the cache at least twice (read vs. written); found ` +
      `${cacheMentions.length} mention(s)`,
  );

  assert.match(
    region,
    /session-spec\.ts/,
    'the paragraph must cite `session-spec.ts` by name, matching this document’s own ' +
      'citation style',
  );
});

test('buildSessionSpec still never sets resumeFrom', () => {
  const source = readFileSync(
    path.join(ROOT, 'packages/runner/src/dispatch/session-spec.ts'),
    'utf8',
  );

  assert.ok(
    !source.includes('resumeFrom'),
    'packages/runner/src/dispatch/session-spec.ts now mentions `resumeFrom`. If session ' +
      'continuity has been wired in, docs/spec/interview.md §1’s cache paragraph is ' +
      'stale and must be updated or removed.',
  );
});
