/**
 * Acceptance tests of the whole-suite runner and its failure summary (t1032).
 *
 * The spawn is injected wherever a test is about the script's own rules, so no
 * case here launches the suite inside itself. AT11 runs one real child over a
 * tiny temp directory, to prove the injected shape matches `node:child_process`.
 *
 * The two fixtures below are real `node --test` captures (Node 25.6.1, stdout
 * piped), with the stack frames cut down: one in the spec grammar, one in TAP.
 *
 * Run with: `npm test` at the root, or `node --test scripts/`.
 */

import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GROUPS, extractFailingTests, renderSummary, runGroups } from './run-all-tests.mjs';

const SPEC = `▶ suite one
  ✖ inner fails (8.22425ms)
  ✔ inner passes (0.904292ms)
✖ suite one (34.579ms)
✖ top level fails (0.973584ms)
✔ ok (0.227542ms)
ℹ tests 4
ℹ suites 1
ℹ pass 2
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2099.204416

✖ failing tests:

test at test/a.test.mjs:4:3
✖ inner fails (8.22425ms)
  AssertionError [ERR_ASSERTION]: 1 == 2
      at TestContext.<anonymous> (file:///tmp/fx/a.test.mjs:4:36)
      at Test.run (node:internal/test_runner/test:1118:25) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 1,
    expected: 2,
    operator: '==',
    diff: 'simple'
  }

test at test/a.test.mjs:7:1
✖ top level fails (0.973584ms)
  Error: boom
      at TestContext.<anonymous> (file:///tmp/fx/a.test.mjs:7:39)
      at Test.run (node:internal/test_runner/test:1118:25)
`;

const TAP = `TAP version 13
# Subtest: suite one
    # Subtest: inner fails
    not ok 1 - inner fails
      ---
      duration_ms: 2.858959
      type: 'test'
      location: '/tmp/fx/a.test.mjs:4:3'
      failureType: 'testCodeFailure'
      error: '1 == 2'
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: 2
      actual: 1
      operator: '=='
      stack: |-
        TestContext.<anonymous> (file:///tmp/fx/a.test.mjs:4:36)
      ...
    # Subtest: inner passes
    ok 2 - inner passes
      ---
      duration_ms: 0.931083
      type: 'test'
      ...
    1..2
not ok 1 - suite one
  ---
  duration_ms: 5.761375
  type: 'suite'
  location: '/tmp/fx/a.test.mjs:3:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: top level fails
not ok 2 - top level fails
  ---
  duration_ms: 0.186792
  type: 'test'
  location: '/tmp/fx/a.test.mjs:7:1'
  failureType: 'testCodeFailure'
  error: 'boom'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: ok
ok 3 - ok
  ---
  duration_ms: 0.1
  type: 'test'
  ...
1..3
# tests 4
# fail 2
`;

/** The failing-tests section of a spec capture, for the given `[name, file]` pairs. */
function specFailures(pairs) {
  const stanzas = pairs.map(
    ([name, file], index) =>
      `test at ${file}:${index + 1}:1\n✖ ${name} (1.5ms)\n  Error: boom\n      at x (y:1:1)\n`,
  );
  return `ℹ tests ${pairs.length}\nℹ fail ${pairs.length}\n\n✖ failing tests:\n\n${stanzas.join('\n')}`;
}

/** A child process, driven by the test instead of by an operating system. */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
}

/**
 * A `spawn` that hands out one scripted child per call. Each script receives
 * the child and drives it (emit data, then `close` or `error`).
 */
function scriptedSpawn(scripts) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new FakeChild();
    const script = scripts[calls.length];
    calls.push({ command, args, options, child });
    setImmediate(() => script?.(child));
    return child;
  };
  return { spawn, calls };
}

/** A writable sink that remembers what it was given, in order. */
function sink(log = [], tag = 'out') {
  return {
    log,
    text: () => log.filter((entry) => entry.tag === tag).map((entry) => entry.chunk).join(''),
    write(chunk) {
      log.push({ tag, chunk: String(chunk) });
      return true;
    },
  };
}

const TWO = [
  { name: 'workspaces', command: 'a', args: [] },
  { name: 'root', command: 'b', args: [] },
];

const run = (scripts, extra = {}) => {
  const fake = scriptedSpawn(scripts);
  const stdout = sink();
  const stderr = sink([], 'err');
  const done = runGroups(TWO, { spawn: fake.spawn, stdout, stderr, isTTY: false, env: {}, ...extra });
  return { done, fake, stdout, stderr };
};

const exits = (code, chunk = '') => (child) => {
  if (chunk) child.stdout.emit('data', Buffer.from(chunk));
  child.emit('close', code, null);
};

/** Every line of a rendered tail that carries a test entry. */
const entryLines = (tail) => tail.split('\n').filter((line) => line.startsWith('  ✖ '));

test('AT1: spec output from two groups yields the failing leaves, grouped in GROUPS order', async () => {
  const entries = extractFailingTests(SPEC);
  assert.deepEqual(entries, [
    { name: 'inner fails', file: 'test/a.test.mjs' },
    { name: 'top level fails', file: 'test/a.test.mjs' },
  ]);

  const results = [
    { name: 'workspaces', status: 1, failing: entries },
    { name: 'root', status: 1, failing: extractFailingTests(specFailures([['root one', 'tests/x.test.mjs']])) },
  ];
  const tail = renderSummary(results);
  const lines = tail.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('  ✖ ')).length, 3);
  assert.ok(tail.includes('Failing tests:'));
  assert.ok(!tail.includes('suite one'), 'a parent that failed only through a subtest is not listed');
  assert.ok(tail.indexOf('inner fails') < tail.indexOf('top level fails'));
  assert.ok(tail.indexOf('top level fails') < tail.indexOf('root one'));
  assert.ok(tail.includes('test/a.test.mjs'));
  assert.ok(tail.includes('tests/x.test.mjs'));

  const mixed = renderSummary([
    { name: 'workspaces', status: 0, failing: [] },
    { name: 'root', status: 1, failing: results[1].failing },
  ]);
  const block = mixed.slice(mixed.indexOf('Failing tests:'));
  assert.ok(!block.includes('workspaces'), 'a green group has no heading in the block');
  assert.ok(block.includes('root'));
});

test('AT2: the block is bounded by 15 entries, 120 characters a name, and 1,400 characters', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `test number ${i}`, file: 'a.test.mjs' }));
  const short = renderSummary([{ name: 'workspaces', status: 1, failing: many }, { name: 'root', status: 0, failing: [] }]);
  assert.equal(entryLines(short).length, 15);
  assert.ok(short.includes('+25 more'));
  assert.ok(short.length <= 1400);

  const long = Array.from({ length: 40 }, (_, i) => ({ name: `${i} ${'x'.repeat(300)}`, file: 'packages/runner/test/a.test.ts' }));
  const tail = renderSummary([{ name: 'workspaces', status: 1, failing: long }, { name: 'root', status: 1, failing: [] }]);
  assert.ok(tail.length <= 1400, `tail is ${tail.length} characters`);
  assert.ok(tail.startsWith('\nFAIL  workspaces\nFAIL  root\n'));
  for (const line of entryLines(tail)) {
    const name = line.slice('  ✖ '.length).split(' (packages')[0];
    assert.ok(name.length <= 120, `a name of ${name.length} characters`);
    assert.ok(name.endsWith('…'));
  }
  const more = Number(/\+(\d+) more/.exec(tail)?.[1]);
  assert.ok(entryLines(tail).length < 15, 'the character budget wins over the entry cap');
  assert.equal(entryLines(tail).length + more, 40);
});

test('AT3: a red group with no extractable test says so; a signal or a spawn error counts as exit 1', async () => {
  const { done, stdout } = run([
    exits(1, 'Error: Cannot find module\n'),
    (child) => child.emit('close', null, 'SIGKILL'),
  ]);
  const { results } = await done;
  assert.deepEqual(results.map((r) => r.status), [1, 1]);
  const tail = renderSummary(results);
  assert.ok(tail.includes('workspaces failed with exit 1, no failing test found in its output'));
  assert.ok(tail.includes('root failed with exit 1, no failing test found in its output'));
  assert.ok(stdout.text().includes('Cannot find module'));

  const errored = run([(child) => child.emit('error', new Error('spawn a ENOENT')), exits(0)]);
  const outcome = await errored.done;
  assert.equal(outcome.results[0].status, 1);
  assert.ok(renderSummary(outcome.results).includes('workspaces failed with exit 1, no failing test found in its output'));
});

test('AT4: all groups green: the tail is the blank line and the PASS lines, nothing else', async () => {
  const { done } = run([exits(0, 'ℹ pass 3\n'), exits(0)]);
  const { results, allPassed } = await done;
  assert.equal(allPassed, true);
  assert.equal(renderSummary(results), '\nPASS  workspaces\nPASS  root\n');
  assert.ok(!renderSummary(results).includes('Failing tests:'));
});

test('AT5: output streams to the sinks as it arrives, not when the child closes', async () => {
  let closeChild;
  const order = [];
  const fake = scriptedSpawn([
    (child) => {
      child.stdout.emit('data', Buffer.from('first chunk\n'));
      child.stderr.emit('data', Buffer.from('warning\n'));
      closeChild = () => {
        order.push('close');
        child.emit('close', 0, null);
      };
    },
    exits(0),
  ]);
  const log = [];
  const stdout = sink(log, 'out');
  const stderr = sink(log, 'err');
  const original = stdout.write.bind(stdout);
  stdout.write = (chunk) => {
    order.push(`out:${String(chunk).trim()}`);
    return original(chunk);
  };
  const done = runGroups(TWO, { spawn: fake.spawn, stdout, stderr, isTTY: false, env: {} });

  while (!closeChild) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['out:first chunk'], 'the chunk is out before the child closes');
  assert.equal(stderr.text(), 'warning\n');
  closeChild();
  await done;
  assert.deepEqual(order, ['out:first chunk', 'close']);
});

test('AT6: the second group still runs after the first fails; results keep their order', async () => {
  const { done, fake } = run([exits(1), exits(0)]);
  const { results, allPassed } = await done;
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['workspaces', 1], ['root', 0]]);
  assert.equal(allPassed, false);

  const green = await run([exits(0), exits(0)]).done;
  assert.equal(green.allPassed, true);
  assert.equal((await run([exits(0), exits(2)]).done).allPassed, false);
});

test('AT7: ANSI-coloured spec output extracts the same entries as the plain output', () => {
  const coloured = SPEC.replace(/^✖ (.*) \((.*)\)$/gm, '\u001b[31m✖ $1 \u001b[90m($2)\u001b[39m\u001b[39m')
    .replace(/^✖ failing tests:/m, '\u001b[31m✖ failing tests:\u001b[39m');
  assert.notEqual(coloured, SPEC);
  assert.deepEqual(extractFailingTests(coloured), extractFailingTests(SPEC));
});

test('AT8: TAP output yields only failing leaves, with files from location', () => {
  assert.deepEqual(extractFailingTests(TAP), [
    { name: 'inner fails', file: '/tmp/fx/a.test.mjs' },
    { name: 'top level fails', file: '/tmp/fx/a.test.mjs' },
  ]);
});

test('AT9: the same test failing in two workspace sections is listed once', () => {
  const twice = `${SPEC}\n> other@1.0.0 test\n${SPEC}`;
  assert.equal(extractFailingTests(twice).length, 2);
  const otherFile = specFailures([['inner fails', 'packages/b/test/a.test.mjs']]);
  assert.equal(extractFailingTests(`${SPEC}\n${otherFile}`).length, 3, 'same name in another file is another test');
});

test('AT10: FORCE_COLOR=1 only when the parent is a terminal and the caller set no colour variable', async () => {
  const envOf = async (isTTY, env) => {
    const { done, fake } = run([exits(0), exits(0)], { isTTY, env });
    await done;
    return fake.calls[0].options.env;
  };
  assert.equal((await envOf(true, { PATH: '/bin' })).FORCE_COLOR, '1');
  assert.equal((await envOf(true, { PATH: '/bin' })).PATH, '/bin');
  assert.equal((await envOf(false, { PATH: '/bin' })).FORCE_COLOR, undefined);
  assert.equal((await envOf(true, { NO_COLOR: '1' })).FORCE_COLOR, undefined);
  assert.equal((await envOf(true, { FORCE_COLOR: '0' })).FORCE_COLOR, '0');

  const { done, fake } = run([exits(0), exits(0)], { isTTY: false, env: {} });
  await done;
  assert.deepEqual(fake.calls[0].options.stdio, ['inherit', 'pipe', 'pipe']);
});

test('AT11: one real child over node --test yields the failing test and its file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'run-all-tests-'));
  try {
    const file = path.join(dir, 'broken.test.mjs');
    writeFileSync(
      file,
      "import test from 'node:test';\ntest('the broken one', () => { throw new Error('boom'); });\ntest('a fine one', () => {});\n",
    );
    // Under `node --test` this process carries NODE_TEST_CONTEXT, which makes a
    // nested `node --test` speak the runner's wire format instead of a reporter.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const stdout = sink();
    const { results, allPassed } = await runGroups(
      [{ name: 'real', command: process.execPath, args: ['--test', file] }],
      { spawn: realSpawn, stdout, stderr: sink([], 'err'), isTTY: false, env },
    );
    assert.equal(allPassed, false);
    assert.equal(results[0].status, 1);
    assert.equal(results[0].failing.length, 1);
    assert.equal(results[0].failing[0].name, 'the broken one');
    assert.ok(results[0].failing[0].file.endsWith('broken.test.mjs'), results[0].failing[0].file);
    assert.ok(stdout.text().includes('the broken one'), 'the live stream still carries the reporter');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GROUPS is unchanged: workspaces first, then root', () => {
  assert.deepEqual(GROUPS.map((group) => group.name), ['workspaces', 'root']);
});
