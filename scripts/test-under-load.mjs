/**
 * Runs a command while N processes burn every CPU they can get (t960).
 *
 * The suite used to go red on a machine busy with other worktrees and green on
 * a quiet one, and nobody could reproduce the difference on demand. This is the
 * reproduction: N = round(multiple x cores) busy loops, at least one, for as
 * long as the command runs. `docs/test-reliability.md` holds what it measured.
 *
 * The burners always die with the command, whichever way it ends. A burner also
 * watches its own parent, because `SIGKILL` on this script runs no handler and a
 * busy loop left behind would quietly skew every later measurement.
 *
 * Output of the command is inherited, not captured, for the reason
 * `run-all-tests.mjs` gives. The two lines this script adds go to stderr, so
 * they never mix with what a caller parses from the command's stdout.
 *
 * Same shape as `run-all-tests.mjs`: exported functions plus a CLI, zero
 * dependencies, with `spawn` injectable so the rules can be tested without
 * burning anything.
 *
 * CLI use: `node scripts/test-under-load.mjs [--multiple <x>] [--cores <n>] [-- <command...>]`
 * (the root `npm run test:load`).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';

export const USAGE =
  'usage: node scripts/test-under-load.mjs [--multiple <x>] [--cores <n>] [-- <command...>]';

const DEFAULT_MULTIPLE = 2;
const DEFAULT_COMMAND = Object.freeze(['npm', 'test']);

/** What a shell reports for a command that could not be started. */
const FAILED_TO_START = 127;

/** Signals that stop a run. */
const STOP_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);

/**
 * One busy loop.
 *
 * It looks up from the work once a second to check its parent is still the one
 * that started it: when the parent dies, `ppid` changes and the burner leaves.
 */
const BURNER_SOURCE = `
const parent = process.ppid;
for (;;) {
  const until = Date.now() + 1000;
  while (Date.now() < until);
  if (process.ppid !== parent) process.exit(0);
}
`;

/**
 * Reads the command line.
 *
 * @param {string[]} argv Arguments after the script's own path.
 * @returns {{help: true} | {error: string} |
 *   {multiple: number, cores: number | undefined, command: string[]}}
 */
export function parseArgs(argv) {
  let multiple = DEFAULT_MULTIPLE;
  let cores;
  let command = [...DEFAULT_COMMAND];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help') return { help: true };

    if (argument === '--') {
      const rest = argv.slice(index + 1);
      if (rest.length > 0) command = rest;
      break;
    }

    if (argument === '--multiple') {
      multiple = Number(argv[index + 1]);
      if (!Number.isFinite(multiple) || multiple <= 0) {
        return { error: `--multiple must be a number above zero, got: ${argv[index + 1]}` };
      }
      index += 1;
      continue;
    }

    if (argument === '--cores') {
      cores = Number(argv[index + 1]);
      if (!Number.isInteger(cores) || cores <= 0) {
        return { error: `--cores must be a whole number above zero, got: ${argv[index + 1]}` };
      }
      index += 1;
      continue;
    }

    return { error: `unknown argument: ${argument}` };
  }

  return { multiple, cores, command };
}

/**
 * How many burners a multiple asks for.
 *
 * @param {number} multiple
 * @param {number} cores
 * @returns {number} `round(multiple x cores)`, at least 1.
 */
export function burnerCount(multiple, cores) {
  return Math.max(1, Math.round(multiple * cores));
}

/**
 * Starts the burners and the command, and resolves when the command has ended
 * and every burner has been told to stop.
 *
 * A stop signal is forwarded and does not resolve anything by itself: the
 * command decides how it ends, so a suite that cleans up on SIGTERM still gets
 * to. The burners die at once, because nothing has to wait for them.
 *
 * @param {{multiple: number, cores?: number, command: string[]}} options
 * @param {{spawn?: Function, signals?: NodeJS.EventEmitter, log?: (line: string) => void}} [seams]
 * @returns {Promise<number>} The command's exit code. A command that dies on a
 *   signal is `128 + signal number` and one that never started is 127, so none
 *   of the failures can read as 0.
 */
export async function runUnderLoad(
  { multiple, cores = os.availableParallelism(), command },
  { spawn = nodeSpawn, signals = process, log = (line) => console.error(line) } = {},
) {
  const count = burnerCount(multiple, cores);
  const burners = [];
  for (let index = 0; index < count; index += 1) {
    const burner = spawn(process.execPath, ['-e', BURNER_SOURCE], { stdio: 'ignore' });
    // A burner that could not start, or one that died, is load this run lacks.
    // It is no reason to fail a command that ran.
    burner.on('error', () => {});
    burners.push(burner);
  }

  const stopBurners = () => {
    for (const burner of burners) burner.kill('SIGKILL');
  };

  const startedAt = Date.now();
  log(`test-under-load: ${count} burners, load average ${os.loadavg().map((value) => value.toFixed(2)).join(' ')}`);

  const code = await new Promise((resolve) => {
    let child;
    const handlers = new Map();
    const finish = (value) => {
      for (const [signal, handler] of handlers) signals.off(signal, handler);
      stopBurners();
      resolve(value);
    };

    try {
      child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
    } catch {
      finish(FAILED_TO_START);
      return;
    }

    for (const signal of STOP_SIGNALS) {
      const handler = () => {
        stopBurners();
        child.kill(signal);
      };
      handlers.set(signal, handler);
      signals.on(signal, handler);
    }

    child.on('error', () => finish(FAILED_TO_START));
    child.on('close', (exitCode, signal) => {
      finish(exitCode ?? 128 + (os.constants.signals[signal] ?? 0));
    });
  });

  log(`test-under-load: exit ${code} after ${Math.round((Date.now() - startedAt) / 1000)}s`);
  return code;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.error) {
    console.error(parsed.error);
    console.error(USAGE);
    return 2;
  }

  return runUnderLoad(parsed);
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main();
}
