#!/usr/bin/env node
/**
 * Fake engine — a controllable CLI the conformance kit runs in place of a real
 * engine.
 *
 * It exists because the kit has to be deterministic and has to run with no CLI
 * installed and no authentication: "the seam is the command construction;
 * swapping the binary for the fake engine is what keeps the suite
 * deterministic" (`docs/formatos/engine-adapter.md:363-366`).
 *
 * All the control comes from the ENVIRONMENT, never from argv. That is
 * deliberate: argv is the channel the adapter uses to deliver
 * `instructions`/`prompt`, and case C2 checks itself against what the process
 * received there. A fake engine configured by flags would compete for that
 * channel with what is being measured. The environment arrives through the
 * `SessionSpec`'s `envOverrides`, which the interface already defines as
 * "opaque additions to the engine process's environment" — that is, the kit
 * configures the fake knowing nothing about the adapter under test.
 *
 * Recognized variables:
 *
 * - `FAKE_ENGINE_RECORD`      path of the JSON sidecar with everything the
 *                             process received (argv, env, cwd, stdin, files
 *                             of the workdir, its own pid and the grandchild's).
 * - `FAKE_ENGINE_LINES`       JSON `[{stream:"stdout"|"stderr",text:string}]`,
 *                             emitted in order.
 * - `FAKE_ENGINE_HEARTBEAT_MS` milliseconds between one line and the next.
 *                             Without it the lines go out all at once, which is
 *                             what C1–C8 ask for; with it they go out one per
 *                             interval, and that is how C9 proves the
 *                             inactivity watchdog re-arms on every output. Once
 *                             the lines run out the process falls through to the
 *                             usual hang/exit behaviour — alive and silent, with
 *                             `FAKE_ENGINE_HANG`.
 * - `FAKE_ENGINE_WRITE_FILES` JSON `{"<name>": "<content>"}`; each entry becomes
 *                             a file in the session's cwd. It is how the fake
 *                             engine "works": an output-in-a-file contract
 *                             (t110) can only be checked if the process can
 *                             actually write it.
 * - `FAKE_ENGINE_EXIT_CODE`   exit code (default 0).
 * - `FAKE_ENGINE_DELAY_MS`    wait before exiting.
 * - `FAKE_ENGINE_HANG`        "1" = never ends on its own (C3).
 * - `FAKE_ENGINE_IGNORE_SIGTERM` "1" = installs a handler that ignores SIGTERM (C4).
 * - `FAKE_ENGINE_SPAWN_CHILD` "1" = leaves a grandchild alive that also ignores
 *                             SIGTERM (C4, "the child that outlives the parent").
 * - `FAKE_ENGINE_VERSION`     answer to `--version` (the verifyCli probe).
 *
 * `--version` is handled BEFORE anything else and without reading stdin: it is
 * the interface's probe that "spends no quota", and it opens no session.
 *
 * No path of this script calls `process.exit()` after writing: in POSIX the
 * stdout of a pipe is asynchronous, and exiting right away truncates the lines
 * case C6 checks one by one. The right way is `process.exitCode` and letting
 * the event loop drain on its own.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const MAX_FILE_SIZE = 64 * 1024;

/**
 * Reads stdin until EOF.
 *
 * This is where invariant 6 (`stdin` closed or redirected to `/dev/null`) pays
 * for itself: with stdin on `/dev/null` the EOF arrives at once; with a pipe
 * the adapter opened and never closes, this `await` never resolves, the sidecar
 * is never written and the kit's case blows its deadline with an explicit
 * message. No extra assertion needs to exist for the adapter that hangs.
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** Top-level files of the workdir, with content — C2's "ephemeral file" path. */
function workdirFiles() {
  const found = {};
  let entries;
  try {
    entries = readdirSync(process.cwd(), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(process.cwd(), entry.name);
    try {
      found[entry.name] =
        statSync(filePath).size > MAX_FILE_SIZE
          ? '<too large for the sidecar>'
          : readFileSync(filePath, 'utf8');
    } catch {
      found[entry.name] = '<unreadable>';
    }
  }
  return found;
}

/**
 * Writes the requested files in the cwd — the fake engine's "work".
 *
 * Top-level names only: the fake creates no directory and does not leave the
 * session's workdir, which is the only thing a session has any right to touch.
 */
function writeRequestedFiles(raw) {
  if (!raw) return;
  let requested;
  try {
    requested = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof requested !== 'object' || requested === null || Array.isArray(requested)) return;

  for (const [name, content] of Object.entries(requested)) {
    writeFileSync(path.join(process.cwd(), path.basename(name)), String(content));
  }
}

function parseLines(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function main() {
  const env = process.env;
  const argv = process.argv.slice(2);

  if (argv.includes('--version')) {
    process.stdout.write(`${env.FAKE_ENGINE_VERSION ?? '9.9.9 (Fake Engine)'}\n`);
    return;
  }

  const stdin = await readStdin();

  // The grandchild comes up BEFORE the sidecar so its pid is recorded even if
  // the adapter kills the parent immediately.
  let grandchildPid = null;
  if (env.FAKE_ENGINE_SPAWN_CHILD === '1') {
    const grandchild = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { stdio: 'ignore' },
    );
    grandchild.unref();
    grandchildPid = grandchild.pid ?? null;
  }

  if (env.FAKE_ENGINE_RECORD) {
    writeFileSync(
      env.FAKE_ENGINE_RECORD,
      JSON.stringify(
        {
          pid: process.pid,
          grandchildPid,
          argv,
          env: { ...env },
          cwd: process.cwd(),
          stdin,
          files: workdirFiles(),
        },
        null,
        2,
      ),
    );
  }

  // After the sidecar, on purpose: the record tells what the process RECEIVED,
  // and a file it wrote itself is not an input.
  writeRequestedFiles(env.FAKE_ENGINE_WRITE_FILES);

  if (env.FAKE_ENGINE_IGNORE_SIGTERM === '1') {
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {});
  }

  // With a heartbeat, the wait comes BEFORE the line: a session whose first
  // line landed at t=0 would give the inactivity watchdog a free reset it never
  // earned, and C9 measures exactly that window.
  const heartbeatMs = Number(env.FAKE_ENGINE_HEARTBEAT_MS ?? 0);
  for (const line of parseLines(env.FAKE_ENGINE_LINES)) {
    if (heartbeatMs > 0) await new Promise((resolve) => setTimeout(resolve, heartbeatMs));
    const stream = line.stream === 'stderr' ? process.stderr : process.stdout;
    stream.write(`${line.text}\n`);
  }

  process.exitCode = Number(env.FAKE_ENGINE_EXIT_CODE ?? 0);

  if (env.FAKE_ENGINE_HANG === '1') {
    setInterval(() => {}, 1000);
    return;
  }

  const wait = Number(env.FAKE_ENGINE_DELAY_MS ?? 0);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

await main();
