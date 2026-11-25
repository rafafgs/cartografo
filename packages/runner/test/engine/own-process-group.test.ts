/**
 * Which platforms give a session its own process group (t1438, AT7).
 *
 * On Windows `detached` becomes `DETACHED_PROCESS`, which makes the
 * `CREATE_NO_WINDOW` behind `windowsHide` ignored, and the stop there walks the
 * tree by pid, so it needs no group.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as lifecycle from '../../src/engine/process-lifecycle.ts';

test('t1438 AT7 — a session starts its own group everywhere but on win32', () => {
  assert.equal(typeof lifecycle.startsOwnGroup, 'function', 'startsOwnGroup is not exported');
  assert.equal(lifecycle.startsOwnGroup('win32'), false);
  assert.equal(lifecycle.startsOwnGroup('darwin'), true);
  assert.equal(lifecycle.startsOwnGroup('linux'), true);
});
