/**
 * Acceptance tests of the load script, and the documentation check of the
 * reliability record (t960, AT1-AT3 and AT9).
 *
 * The spawn is injected wherever a test is about the script's own rules, so no
 * case here burns a CPU for longer than it has to: one real run at the end
 * proves the injected shape matches what `node:child_process` really does.
 *
 * Run with: `npm test` at the root, or `node --test scripts/`.
 */

import assert from 'node:assert/strict';
import { spawn as realSpawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { USAGE, burnerCount, parseArgs, runUnderLoad } from './test-under-load.mjs';

const SCRIPT = path.join(import.meta.dirname, 'test-under-load.mjs');
const RELIABILITY_DOC = path.join(import.meta.dirname, '..', 'docs', 'test-reliability.md');

/** A child process, driven by the test instead of by an operating system. */
class FakeChild extends EventEmitter {
  constructor(role) {
    super();
    this.role = role;
    this.signals = [];
  }

  kill(signal = 'SIGTERM') {
    this.signals.push(signal);
    return true;
  }
}

/**
 * A `spawn` that records every child it was asked for.
 *
 * The command is the one spawn whose argv is exactly the caller's; every other
 * spawn is a burner.
 */
function fakeSpawn(command) {
  const children = [];
  const spawn = (file, args) => {
    const isCommand = file === command[0] && args.join(' ') === command.slice(1).join(' ');
    const child = new FakeChild(isCommand ? 'command' : 'burner');
    children.push(child);
    return child;
  };
  return {
    spawn,
    children,
    burners: () => children.filter((child) => child.role === 'burner'),
    command: () => children.find((child) => child.role === 'command'),
  };
}

/** Lets `runUnderLoad` reach its first await, where every child exists. */
const started = () => new Promise((resolve) => setImmediate(resolve));

const COMMAND = ['the-command', '--flag'];

function allKilled(burners) {
  return burners.every((burner) => burner.signals.length > 0);
}

/* ------------------------------------------------------------------- AT1 */

test('AT1 — the burner count is the multiple of the cores, and never zero', () => {
  assert.equal(burnerCount(2, 8), 16);
  assert.equal(burnerCount(0.1, 8), 1);
  assert.equal(burnerCount(1, 8), 8);
  assert.equal(burnerCount(0.5, 3), 2);
});

test('AT1 — runUnderLoad starts exactly that many burners plus one command', async () => {
  const fake = fakeSpawn(COMMAND);
  const running = runUnderLoad(
    { multiple: 2, cores: 8, command: COMMAND },
    { spawn: fake.spawn, signals: new EventEmitter(), log: () => {} },
  );
  await started();

  assert.equal(fake.burners().length, 16);
  assert.equal(fake.children.filter((child) => child.role === 'command').length, 1);

  fake.command().emit('close', 0, null);
  assert.equal(await running, 0);
});

/* ------------------------------------------------------------------- AT2 */

for (const [name, finish, expected] of [
  ['the command exits 0', (command) => command.emit('close', 0, null), 0],
  ['the command exits non-zero', (command) => command.emit('close', 7, null), 7],
  ['the command fails to start', (command) => command.emit('error', new Error('ENOENT')), 127],
  ['the command dies on a signal', (command) => command.emit('close', null, 'SIGKILL'), 137],
]) {
  test(`AT2 — ${name}: every burner is killed and the exit code is ${expected}`, async () => {
    const fake = fakeSpawn(COMMAND);
    const running = runUnderLoad(
      { multiple: 1, cores: 4, command: COMMAND },
      { spawn: fake.spawn, signals: new EventEmitter(), log: () => {} },
    );
    await started();
    assert.equal(allKilled(fake.burners()), false, 'nothing is killed before the command ends');

    finish(fake.command());

    assert.equal(await running, expected);
    assert.equal(fake.burners().length, 4);
    assert.ok(allKilled(fake.burners()), 'a burner survived the end of the command');
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`AT2 — ${signal} kills every burner, reaches the command, and the command decides the code`, async () => {
    const fake = fakeSpawn(COMMAND);
    const signals = new EventEmitter();
    const running = runUnderLoad(
      { multiple: 1, cores: 3, command: COMMAND },
      { spawn: fake.spawn, signals, log: () => {} },
    );
    await started();

    signals.emit(signal);

    assert.ok(allKilled(fake.burners()), 'a burner survived the signal');
    assert.deepEqual(fake.command().signals, [signal], 'the signal has to reach the command');

    fake.command().emit('close', null, signal);
    const code = await running;
    assert.notEqual(code, 0, 'an interrupted command is never a success');
    assert.equal(signals.listenerCount(signal), 0, 'the handlers do not outlive the run');
  });
}

test('AT2 — a synchronous spawn failure of the command is a failed start, with no burner left', async () => {
  const fake = fakeSpawn(COMMAND);
  const spawn = (file, args) => {
    if (file === COMMAND[0]) throw new Error('EINVAL');
    return fake.spawn(file, args);
  };

  const code = await runUnderLoad(
    { multiple: 1, cores: 2, command: COMMAND },
    { spawn, signals: new EventEmitter(), log: () => {} },
  );

  assert.equal(code, 127);
  assert.equal(fake.burners().length, 2);
  assert.ok(allKilled(fake.burners()), 'a burner survived the failed start');
});

test('AT2 — through real processes: the code is the command\'s and no burner is left alive', async () => {
  const burnerPids = [];
  const spawn = (file, args, options) => {
    const child = realSpawn(file, args, { ...options, stdio: 'ignore' });
    if (args[0] !== '-p') burnerPids.push(child.pid);
    return child;
  };

  const code = await runUnderLoad(
    { multiple: 1, cores: 2, command: [process.execPath, '-p', 'process.exit(3)'] },
    { spawn, signals: new EventEmitter(), log: () => {} },
  );

  assert.equal(code, 3);
  assert.equal(burnerPids.length, 2);
  for (const pid of burnerPids) {
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        await sleep(50);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, `burner ${pid} is still alive`);
  }
});

/* ------------------------------------------------------------------- AT3 */

for (const value of ['0', 'abc', '-1']) {
  test(`AT3 — --multiple ${value} exits 2 with the usage line on stderr`, () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--multiple', value], { encoding: 'utf8' });

    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes(USAGE), `no usage line on stderr: ${result.stderr}`);
  });
}

test('AT3 — --help prints the usage line on stdout and exits 0', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(USAGE), `no usage line on stdout: ${result.stdout}`);
});

test('AT3 — the defaults: npm test, at a multiple of 2', () => {
  const parsed = parseArgs([]);

  assert.deepEqual(parsed.command, ['npm', 'test']);
  assert.equal(parsed.multiple, 2);
});

test('AT3 — everything after -- is the command, and --cores overrides the machine', () => {
  const parsed = parseArgs(['--multiple', '0.5', '--cores', '4', '--', 'node', '--test', 'x.mjs']);

  assert.deepEqual(parsed.command, ['node', '--test', 'x.mjs']);
  assert.equal(parsed.multiple, 0.5);
  assert.equal(parsed.cores, 4);
});

for (const argv of [['--cores', '0'], ['--cores', 'many'], ['--multiple'], ['--nonsense']]) {
  test(`AT3 — ${argv.join(' ')} is a usage error`, () => {
    assert.ok(parseArgs(argv).error, JSON.stringify(parseArgs(argv)));
  });
}

test('AT3 — the root package.json has the npm entry, and it runs this script', () => {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));

  assert.equal(manifest.scripts['test:load'], 'node scripts/test-under-load.mjs');
});

/* ------------------------------------------------------------------- AT9 */

/** Every name the classification table must cover (FR4). */
const CLASSIFIED = [
  't371 AT6',
  'C9',
  'C3',
  't400',
  't678 AT3/AT4',
  't678 AT8',
  'cli-watch AT1',
  'cli-watch AT3a',
  'cli-watch AT5',
  'dispatch.test.ts',
];

/**
 * The classification table's rows as cell arrays.
 *
 * It is the table under the `## Classification` heading, and it stops at the
 * next heading: another table in the document naming the same test is a
 * measurement, not a verdict.
 */
function classificationRows(markdown) {
  const section = markdown.split(/^## /m).find((part) => part.startsWith('Classification'));
  assert.ok(section, 'docs/test-reliability.md has no "## Classification" section');
  return section
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
}

test('AT9 — the reliability record classifies every test with one cause and its evidence', () => {
  assert.ok(existsSync(RELIABILITY_DOC), 'docs/test-reliability.md does not exist');
  const rows = classificationRows(readFileSync(RELIABILITY_DOC, 'utf8'));
  const [header, ...body] = rows;
  assert.deepEqual(header.slice(0, 3), ['Test', 'Cause', 'Evidence']);

  for (const name of CLASSIFIED) {
    const row = body.find((cells) => cells[0].replaceAll('`', '') === name);
    assert.ok(row, `no classification row for ${name}`);

    const causes = row[1].match(/\([a-d]\)/g) ?? [];
    assert.equal(causes.length, 1, `${name} must name exactly one cause, found: ${row[1]}`);
    assert.ok(row[2].length > 0, `${name} has an empty evidence cell`);
  }
});
