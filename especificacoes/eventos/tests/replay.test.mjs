// Replay proof (t98, acceptance test 3).
//
// The quality non-negotiable is "replayability by event sourcing": the final
// state of an execution has to come out of the log and out of nothing else.
// This test folds the example log with the reducer and compares it against an
// expected state computed by hand from that same log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOG = fileURLToPath(new URL('../exemplos/example-log.jsonl', import.meta.url));
const EXPECTED = fileURLToPath(new URL('../exemplos/expected-final-state.json', import.meta.url));
const REDUCER = '../reducers/reconstruct-state.mjs';

function readLog() {
  return readFileSync(LOG, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test('reconstructState reproduces the expected final state', async () => {
  const { reconstructState } = await import(REDUCER);
  const events = readLog();
  const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));

  assert.deepStrictEqual(reconstructState(events), expected);
});

test('reconstructState is deterministic and does not depend on the reading order', async () => {
  const { reconstructState } = await import(REDUCER);
  const events = readLog();

  assert.deepStrictEqual(reconstructState(events), reconstructState([...events].reverse()));
});

test('reconstructState does not mutate the list of events it receives', async () => {
  const { reconstructState } = await import(REDUCER);
  const events = readLog();
  const before = JSON.stringify(events);

  reconstructState(events);

  assert.equal(JSON.stringify(events), before);
});

test('an empty log reconstructs an empty state', async () => {
  const { reconstructState } = await import(REDUCER);

  assert.deepStrictEqual(reconstructState([]), {
    jobs: {},
    sessions: {},
    input_requests: {},
    leases: {},
    current_graph_version: {},
    // The sixth projection came in with D21 (t245). Empty is the complete
    // shape: a round nobody declared finished is a missing key, never `null`.
    executions: {},
  });
});
