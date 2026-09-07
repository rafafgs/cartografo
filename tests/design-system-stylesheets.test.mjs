/**
 * Acceptance test of t470 — `docs/spec/design-system.md`'s preamble describes
 * the second stylesheet as history, not as a present fact.
 *
 * t458 collapsed the two stylesheets into one: `pages.ts`'s `STYLE` constant
 * was deleted, `layout()` links `public/style.css` instead of inlining it, and
 * both halves of the screen read the same `:root` token set. §10 of the
 * document records exactly that. Its preamble did not follow, and went on
 * announcing the divergence in the present tense — the same document saying
 * two contradictory things about the same file, which is the failure mode a
 * contract nobody can trust starts with.
 *
 * Two properties, and they are deliberately tied to each other:
 *
 * - the TREE really has one stylesheet (no `STYLE` constant in `pages.ts`, one
 *   `.css` under `public/`), which is what makes the prose rule below true
 *   rather than merely tidy;
 * - every PREAMBLE sentence that mentions `STYLE` or the two stylesheets
 *   carries a past-tense marker.
 *
 * Only the preamble — everything above `## 1. The foundation` — is swept. §10
 * is where the resolution is recorded and is entitled to say what is true now;
 * the preamble is the document's own account of how it came to exist, and a
 * history written in the present tense is what this gate exists against. If a
 * second stylesheet is ever legitimately reintroduced, the first test fails
 * first and says so.
 *
 * The forbidden phrasings appear in THIS file, which is fine: it lives under
 * `tests/`, outside the swept surface, the same arrangement
 * `removed-loader.test.mjs` uses.
 *
 * Run with: `node --test tests/`
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCUMENT_PATH = path.join(ROOT, 'docs', 'spec', 'design-system.md');
const PAGES_PATH = path.join(ROOT, 'packages', 'screen', 'src', 'pages.ts');
const PUBLIC_DIR = path.join(ROOT, 'packages', 'screen', 'src', 'public');

/** Where the preamble ends and the contract proper begins. */
const FIRST_SECTION_HEADING = '## 1. The foundation';

/** What a sentence has to mention to be swept at all. */
const SUBJECTS = [/\bSTYLE\b/, /\btwo stylesheets\b/i];

/** Any one of these is enough to make a sentence read as history. */
const PAST_MARKERS = [
  /\bwas\b/i,
  /\bwere\b/i,
  /\bused to\b/i,
  /\bno longer\b/i,
  /\bgone\b/i,
  /\buntil\b/i,
  /\bcame to\b/i,
  /\bhad\b/i,
];

const document = readFileSync(DOCUMENT_PATH, 'utf8');

/**
 * The document's preamble as sentences, with markdown line wrapping undone.
 *
 * Splitting on a full stop followed by whitespace keeps `style.css`,
 * `pages.ts` and `§10.` intact — none of them is followed by a space.
 */
function preambleSentences(text) {
  const cut = text.indexOf(FIRST_SECTION_HEADING);
  assert.notEqual(
    cut,
    -1,
    `${FIRST_SECTION_HEADING} is gone from the document; this gate no longer knows where the preamble ends`,
  );

  return text
    .slice(0, cut)
    .replace(/\s+/g, ' ')
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

test('t470 — the tree really does have a single stylesheet', () => {
  const pages = readFileSync(PAGES_PATH, 'utf8');
  assert.ok(
    !/\bconst STYLE\b/.test(pages),
    'pages.ts declares a STYLE constant again — t458 deleted it, and the document says so',
  );
  assert.ok(
    pages.includes('<link rel="stylesheet" href="/style.css">'),
    'pages.ts no longer links /style.css; the single-stylesheet claim in the document is stale',
  );

  const stylesheets = readdirSync(PUBLIC_DIR).filter((entry) => entry.endsWith('.css'));
  assert.deepEqual(
    stylesheets,
    ['style.css'],
    `packages/screen/src/public holds more than one stylesheet: ${stylesheets.join(', ')}`,
  );
});

test('t470 — the preamble speaks of the second stylesheet in the past tense', () => {
  const offenders = preambleSentences(document).filter(
    (sentence) =>
      SUBJECTS.some((subject) => subject.test(sentence)) &&
      !PAST_MARKERS.some((marker) => marker.test(sentence)),
  );

  assert.deepEqual(
    offenders,
    [],
    `the preamble states the two-stylesheet divergence as a present fact:\n${offenders.join('\n\n')}`,
  );
});
