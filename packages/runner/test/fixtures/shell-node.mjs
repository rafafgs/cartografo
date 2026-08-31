#!/usr/bin/env node
/**
 * The command a `shell` node runs, in the suite (t332).
 *
 * The sibling of `fake-engine.mjs`, and deliberately much smaller: there is no
 * engine to fake here. A shell node's command is an ordinary program, and what
 * the tests need out of it is the three shapes the report protocol can take —
 * a valid fenced block, a broken one, and none at all — plus an exit code they
 * choose.
 *
 * All the control comes from the ENVIRONMENT, like the fake engine's, and here
 * that is not only convention: it is what FR4 makes observable. A shell node's
 * child sees nothing of the runner's environment unless the manifest allowlisted
 * it, so everything below arrives through `envOverrides`, the channel the
 * dispatch layers on top for exactly one session.
 *
 * Recognized variables:
 *
 * - `SHELL_NODE_REPORT`  the JSON object to print inside the fence. Absent, the
 *                        block is printed with a default report; the literal
 *                        `none` prints no block at all; the literal `garbled`
 *                        prints a fence whose contents are not JSON.
 * - `SHELL_NODE_EXIT_CODE`  exit code (default 0).
 * - `SHELL_NODE_RECORD`  path of a JSON sidecar with what the process received —
 *                        argv, env and cwd. It is how a test proves the argv
 *                        arrived unmodified and the environment arrived closed.
 *
 * No `process.exit()` after writing, for the reason `fake-engine.mjs` records:
 * the stdout of a pipe is asynchronous, and exiting right away truncates the
 * lines the adapter is supposed to deliver.
 */

import { writeFileSync } from 'node:fs';

const env = process.env;

if (env.SHELL_NODE_RECORD) {
  writeFileSync(
    env.SHELL_NODE_RECORD,
    JSON.stringify({ argv: process.argv.slice(2), env: { ...env }, cwd: process.cwd() }, null, 2),
  );
}

process.stdout.write('the deterministic step ran, with no model in it\n');

const report = env.SHELL_NODE_REPORT ?? '';
if (report !== 'none') {
  process.stdout.write('```resultado\n');
  process.stdout.write(
    report === 'garbled'
      ? '{ this was never JSON\n'
      : `${report === '' ? JSON.stringify({ nota: 'the shell node did the step' }) : report}\n`,
  );
  process.stdout.write('```\n');
}

process.exitCode = Number(env.SHELL_NODE_EXIT_CODE ?? 0);
