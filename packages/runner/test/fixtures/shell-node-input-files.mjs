#!/usr/bin/env node
/**
 * The command a `shell` node runs in the input-file suite (t689).
 *
 * The sibling of `shell-node.mjs`, reporting what the process SAW instead of how
 * it was called: every argument that names an existing file is read at the
 * instant the process starts, which is the moment FR6 promises the files exist.
 *
 * Variables:
 *
 * - `SHELL_NODE_RECORD`  path of the JSON sidecar: `{ argv, files, cwd }`, where
 *                        `files` has one `{ arg, content }` per argument that is
 *                        a readable file.
 * - `SHELL_NODE_EXIT_CODE`  exit code (default 0).
 * - `SHELL_NODE_HOLD`    when `1`, the process stays alive until it is signalled,
 *                        so a test can cancel a session that is really running.
 * - `SHELL_NODE_REPORT`  the JSON object printed inside the fence.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';

const env = process.env;
const argv = process.argv.slice(2);

const files = [];
for (const arg of argv) {
  try {
    if (statSync(arg).isFile()) files.push({ arg, content: readFileSync(arg, 'utf8') });
  } catch {
    // not a file: an ordinary argument
  }
}

if (env.SHELL_NODE_RECORD) {
  writeFileSync(env.SHELL_NODE_RECORD, JSON.stringify({ argv, files, cwd: process.cwd() }));
}

process.stdout.write('the deterministic step ran, with no model in it\n');
process.stdout.write('```resultado\n');
process.stdout.write(
  `${env.SHELL_NODE_REPORT ?? JSON.stringify({ resultado: 'aprovado', outcome: 'pass', evidencia: 'read the files' })}\n`,
);
process.stdout.write('```\n');

if (env.SHELL_NODE_HOLD === '1') {
  process.on('SIGTERM', () => {
    process.exit(143);
  });
  setInterval(() => {}, 1000);
} else {
  process.exitCode = Number(env.SHELL_NODE_EXIT_CODE ?? 0);
}
