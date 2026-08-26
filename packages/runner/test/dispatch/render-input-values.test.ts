/**
 * Unit tests for the input-values block of a session's prompt (t267).
 *
 * The sibling file `render-skill-instructions.test.ts` proves the block reaches
 * a real rendered prompt, in the right place. This one proves the three
 * decisions INSIDE it, which are the ones a composed-text assertion states
 * badly:
 *
 * - **which keys are shown**, and in what order of precedence — `properties`,
 *   then `required`, then the whole resolved object. A skill declares its input
 *   as a JSON Schema, and the block shows the values that schema NAMES, not
 *   whatever the projection happened to carry;
 * - **where the cut lands** when the object is large. The cap is in BYTES and
 *   the cut walks backward off UTF-8 continuation bytes, because slicing a rune
 *   in half prints a `U+FFFD` nobody produced;
 * - **that the cut is visible**. A truncated block with no marker is a prompt
 *   that lies by omission: the session reads a complete-looking object and acts
 *   on a partial one.
 *
 * English per D18. The rendered CONTENT stays Portuguese, like every other
 * prompt in this package.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as InputValuesModule from '../../src/dispatch/render-input-values.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/render-input-values.ts';

let cache: typeof InputValuesModule | null = null;

async function loadModule(): Promise<typeof InputValuesModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/render-input-values.ts', import.meta.url).href
  )) as typeof InputValuesModule;
  return cache;
}

/** The JSON text the block fences, pulled back out of the rendered lines. */
function fencedText(lines: readonly string[]): string {
  const open = lines.indexOf('```json');
  assert.ok(open >= 0, `the rendered block carries no fence: ${lines.join('\n')}`);
  const close = lines.indexOf('```', open + 1);
  assert.ok(close > open, `the rendered block never closes its fence: ${lines.join('\n')}`);
  return lines.slice(open + 1, close).join('\n');
}

/** Every line after the closing fence — where the marker lives, when there is one. */
function afterFence(lines: readonly string[]): string[] {
  const open = lines.indexOf('```json');
  const close = lines.indexOf('```', open + 1);
  return lines.slice(close + 1).filter((line) => line !== '');
}

/* -------------------------------------------------------------------------- */
/* Key selection: properties → required → the whole object                     */
/* -------------------------------------------------------------------------- */

test('t267 — `properties` decides the key set when the schema declares one', async () => {
  const { selectInputValues } = await loadModule();

  const declared = {
    type: 'object',
    properties: { triaged_thesis: { type: 'object' }, portfolio: { type: 'object' } },
    required: ['triaged_thesis'],
    additionalProperties: false,
  };

  assert.deepEqual(
    selectInputValues(declared, {
      triaged_thesis: { asset: 'NVLR3' },
      portfolio: { open_positions: 7 },
      noise: 'nothing the skill declares',
    }),
    { triaged_thesis: { asset: 'NVLR3' }, portfolio: { open_positions: 7 } },
    '`properties` is the wider of the two declarations, so it wins over `required`',
  );
});

test('t267 — a declared key the input does not carry is simply left out', async () => {
  const { selectInputValues } = await loadModule();

  // Deliberately NOT a refusal: the only thing that fails a dispatch over
  // missing data is `UnresolvedPlaceholderError`, over a body that names it.
  // This block is a display convenience, and inventing a second gate here would
  // block dispatches the manifest never asked anything of.
  assert.deepEqual(
    selectInputValues({ properties: { a: {}, b: {} } }, { a: 1 }),
    { a: 1 },
  );
});

test('t267 — `required` is the key set when `properties` is absent or unusable', async () => {
  const { selectInputValues } = await loadModule();

  const input = { nota: 'the note from the previous node', noise: 'not declared' };

  assert.deepEqual(
    selectInputValues({ type: 'object', required: ['nota'] }, input),
    { nota: 'the note from the previous node' },
  );
  assert.deepEqual(
    selectInputValues({ properties: ['nota'], required: ['nota'] }, input),
    { nota: 'the note from the previous node' },
    'a `properties` that is not an object is not a key set: the fallback takes over',
  );
});

test('t267 — with neither declared, the whole resolved input is shown', async () => {
  const { selectInputValues } = await loadModule();

  const input = { triaged_thesis: { asset: 'NVLR3' }, portfolio: { open_positions: 7 } };

  for (const declared of [{}, null, undefined, 'not even a schema', { required: 'nota' }]) {
    assert.deepEqual(
      selectInputValues(declared, input),
      input,
      `an unusable declaration (${JSON.stringify(declared) ?? 'undefined'}) shows everything`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* The rendered block, and the cap                                             */
/* -------------------------------------------------------------------------- */

test('t267 — the block is the heading, the fenced JSON, and nothing else under the cap', async () => {
  const { renderInputValues, INPUT_VALUES_CAP_BYTES } = await loadModule();

  assert.equal(INPUT_VALUES_CAP_BYTES, 65_536, 'the cap is 65.536 bytes (64 KB)');

  const input = { nota: 'the note from the previous node' };
  const lines = renderInputValues({ required: ['nota'] }, input);

  assert.equal(lines[0], '### Input values');
  assert.equal(
    fencedText(lines),
    JSON.stringify({ nota: 'the note from the previous node' }, null, 2),
    'pretty-printed with two spaces, the same shape every other fenced section uses',
  );
  assert.deepEqual(
    afterFence(lines),
    [],
    'under the cap there is nothing after the fence: a marker with nothing to mark is noise',
  );
});

/**
 * The floor under the cap, and the only permanent artifact of t298's calibration.
 *
 * The number is not a preference: it is the largest input-values block a real
 * traversal has carried — the `red-team` node of `asymmetric-bets`, at 39.092
 * bytes, in the third real bets run (`notes/2026-08-18-third-bets-run.md`, hole
 * 1). At the 16 KB cap that block lost `premissas` and `assimetria`, both
 * `required` by the skill reading them, and the session escalated over an
 * environment limit instead of proceeding.
 *
 * So the assertion is a one-way ratchet rather than an equality: raising the cap
 * is somebody's measurement, lowering it under this number is re-opening a human
 * gate production has already paid for once.
 */
test('t298 — the cap never regresses under the bets bundle\'s confirmed real maximum', async () => {
  const { INPUT_VALUES_CAP_BYTES } = await loadModule();

  const BETS_REAL_MAXIMUM_BYTES = 39_092;

  assert.ok(
    INPUT_VALUES_CAP_BYTES >= BETS_REAL_MAXIMUM_BYTES,
    `the cap (${INPUT_VALUES_CAP_BYTES}) is under the largest block a real traversal ` +
      `carried (${BETS_REAL_MAXIMUM_BYTES}, notes/2026-08-18-third-bets-run.md): the ` +
      'red team would lose required keys again and escalate over the cut',
  );
});

test('t267 — over the cap the JSON is cut to the cap and the marker names both sizes', async () => {
  const { renderInputValues, INPUT_VALUES_CAP_BYTES } = await loadModule();

  // All ASCII on purpose: the cut lands exactly on the cap, so the byte count
  // in the marker is arithmetic rather than an approximation.
  const input = { x: 'a'.repeat(80_000) };
  const whole = JSON.stringify(input, null, 2);
  const originalBytes = Buffer.byteLength(whole, 'utf8');
  assert.equal(originalBytes, 80_013, 'the fixture has to be over the cap, and by a known amount');

  const lines = renderInputValues({ properties: { x: { type: 'string' } } }, input);
  const shown = fencedText(lines);

  assert.equal(
    Buffer.byteLength(shown, 'utf8'),
    INPUT_VALUES_CAP_BYTES,
    'the fence carries exactly the cap, never the whole object',
  );
  assert.equal(shown, whole.slice(0, INPUT_VALUES_CAP_BYTES), 'and it is the HEAD that survives');

  const marker = afterFence(lines);
  assert.equal(marker.length, 1, 'one marker line, immediately after the closing fence');
  assert.ok(marker[0].includes('65.536'), `the marker names what is shown: ${marker[0]}`);
  assert.ok(marker[0].includes('80.013'), `and what the object really weighed: ${marker[0]}`);
  assert.ok(
    marker[0].includes('GET /v1/jobs/:id/context'),
    `and where the whole object still lives: ${marker[0]}`,
  );
});

test('t267 — the cut walks backward off a continuation byte, never through a rune', async () => {
  const { renderInputValues, INPUT_VALUES_CAP_BYTES } = await loadModule();

  // `{\n  "xy": "` is 11 bytes, and every `\u00e9` after it is 2 — so the cap
  // lands on an ODD offset inside the run, which is the middle of a character.
  // The fix costs one byte; not walking back prints a `U+FFFD` no node produced.
  //
  // Written as an escape and not as a literal (t314): the character is here for
  // its BYTE WIDTH and not as a word, so the assertion below states the width
  // outright rather than leaving it to be read off the source encoding.
  const RUNE = '\u00e9';
  assert.equal(Buffer.byteLength(RUNE, 'utf8'), 2, 'the whole fixture rests on this');
  const input = { xy: RUNE.repeat(40_000) };
  const whole = JSON.stringify(input, null, 2);
  assert.equal(whole.indexOf(RUNE), 11, 'the fixture puts the run at an odd byte offset');
  assert.ok(Buffer.byteLength(whole, 'utf8') > INPUT_VALUES_CAP_BYTES);

  const shown = fencedText(renderInputValues({}, input));
  const bytes = Buffer.byteLength(shown, 'utf8');

  assert.equal(bytes, INPUT_VALUES_CAP_BYTES - 1, 'exactly one byte is given back, and no more');
  assert.ok(!shown.includes('�'), 'nothing decodes to a replacement character');
  assert.ok(
    Buffer.from(shown, 'utf8').equals(
      Buffer.from(whole, 'utf8').subarray(0, INPUT_VALUES_CAP_BYTES - 1),
    ),
    'and what survives is the head of the real bytes, re-encoded unchanged',
  );

  const marker = afterFence(renderInputValues({}, input));
  assert.equal(marker.length, 1);
  assert.ok(
    marker[0].includes('65.535'),
    `the marker reports what is really shown, not the cap it aimed at: ${marker[0]}`,
  );
});

test('t267 — an empty selection still renders, and says so as JSON', async () => {
  const { renderInputValues } = await loadModule();

  // The manifest declares `nota` and the projection carries none: what the
  // session gets is an honest empty object, which is a fact it can act on.
  assert.equal(fencedText(renderInputValues({ required: ['nota'] }, {})), '{}');
});
