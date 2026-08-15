/**
 * Unit tests of the watchdog budget ceiling (t163, FR8).
 *
 * `resolveBudget` is flowpilot's `min()` rule, generalized: a skill declares how
 * long it needs, the server declares how long anything may take, and the SHORTER
 * of the two wins. A skill can only ever shorten its own leash.
 *
 * The case worth naming is the fourth one. A declared `0` — or anything
 * negative — resolves to the CEILING, never to "no watchdog": treating it as a
 * disable would let a manifest turn off its own safety net through an
 * off-by-one, and the whole point of a budget nobody can raise is that nobody
 * can remove it either.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBudget } from '../../src/engine/resolve-budget.ts';

const CEILING = 300;

test('t163 FR8 — an undeclared budget resolves to the ceiling', () => {
  assert.equal(resolveBudget(undefined, CEILING), CEILING);
});

test('t163 FR8 — a budget above the ceiling clamps to it', () => {
  assert.equal(resolveBudget(CEILING + 1, CEILING), CEILING);
  assert.equal(resolveBudget(86_400, CEILING), CEILING);
});

test('t163 FR8 — a budget at or below the ceiling passes through unchanged', () => {
  assert.equal(resolveBudget(CEILING, CEILING), CEILING);
  assert.equal(resolveBudget(1, CEILING), 1);
  assert.equal(resolveBudget(120, CEILING), 120);
});

test('t163 FR8 — a non-positive budget is "no override", never "no watchdog"', () => {
  assert.equal(resolveBudget(0, CEILING), CEILING);
  assert.equal(resolveBudget(-1, CEILING), CEILING);
  assert.equal(resolveBudget(-86_400, CEILING), CEILING);
});
