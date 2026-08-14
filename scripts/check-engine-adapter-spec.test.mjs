/**
 * Acceptance tests of the EngineAdapter spec gate's tsc step (t137).
 *
 * The bug this pins down: check [5] invoked `npx --yes typescript ...`, which
 * names a PACKAGE where npx wants a BINARY. npm only infers a binary from a
 * package name when the package exposes exactly one; typescript exposed two
 * (`tsc` and `tsserver`) up to 6.x, so the invocation died with
 * `npm error could not determine executable to run` and the gate went red for
 * a reason that had nothing to do with the document it checks.
 *
 * Why these tests do not simply run the script and assert exit 0: typescript
 * 7.0.2 dropped `tsserver` from its bin map, so the ambiguous form resolves
 * today by accident, and `npx --yes typescript` floats to whatever `latest`
 * is. A test written against today's registry would be green on the broken
 * script and would go red again on its own the day a second bin comes back.
 *
 * So AT1/AT3 run the gate against a stub `npx` that emulates npm's resolution
 * against the two-bin typescript — the bench's condition, frozen and offline.
 * AT2 keeps the ticket's literal Definition of Done: the real script, real
 * npx, exit 0.
 *
 * Run with: `npm test` at the root.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'check-engine-adapter-spec.sh');

/**
 * A stand-in for `npx` that resolves a binary the way npm 11 does, against a
 * typescript package that exposes two bins.
 *
 * `tsc` is the only name it resolves: `tsserver` is the second bin whose mere
 * existence is what makes the package name ambiguous, and the gate never asks
 * for it. Everything else gets npm's own message, verbatim.
 */
const NPX_STUB = `#!/usr/bin/env bash
set -u

printf '%s\\n' "$*" >> "$STUB_LOG"

command_name=""

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)    shift ;;
    --package)   shift 2 ;;
    --package=*) shift ;;
    --)          shift; command_name="\${1-}"; break ;;
    -*)          shift ;;
    *)           command_name="$1"; break ;;
  esac
done

if [ "$command_name" = "tsc" ]; then
  if [ "\${STUB_TSC_EXIT:-0}" -ne 0 ]; then
    printf 'stub.ts(1,1): error TS0000: simulated compiler failure\\n' >&2
    exit "$STUB_TSC_EXIT"
  fi
  exit 0
fi

printf 'npm error could not determine executable to run\\n' >&2
exit 1
`;

/** Installs the stub in a throwaway directory and returns how to run under it. */
function withStubbedNpx(t, { tscExit = 0 } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t137-npx-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const stubPath = path.join(base, 'npx');
  const logPath = path.join(base, 'invocations.log');
  writeFileSync(stubPath, NPX_STUB, 'utf8');
  chmodSync(stubPath, 0o755);
  writeFileSync(logPath, '', 'utf8');

  const result = spawnSync('bash', [SCRIPT_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${base}${path.delimiter}${process.env.PATH}`,
      STUB_LOG: logPath,
      STUB_TSC_EXIT: String(tscExit),
    },
  });

  return { result, invocations: readFileSync(logPath, 'utf8').trim() };
}

test('AT1 — the tsc step resolves a binary even when the package exposes two', (t) => {
  const { result, invocations } = withStubbedNpx(t);

  assert.equal(
    result.status,
    0,
    'the gate went red under a two-bin typescript, which is the t137 bug.\n' +
      `npx was called as:\n  ${invocations || '(never called)'}\n` +
      `--- script output ---\n${result.stdout}${result.stderr}`,
  );
  assert.doesNotMatch(
    result.stdout,
    /could not determine executable to run/,
    'npx was asked to guess a binary from a package name',
  );
  assert.match(result.stdout, /All checks passed\./);
});

test('AT2 — DoD: the real script still exits 0 against the real toolchain', () => {
  const result = spawnSync('bash', [SCRIPT_PATH], { cwd: ROOT, encoding: 'utf8' });

  assert.equal(
    result.status,
    0,
    `scripts/check-engine-adapter-spec.sh failed:\n${result.stdout}${result.stderr}`,
  );
  assert.doesNotMatch(result.stdout, /^\s*FAIL/m, 'a check reported FAIL');
});

test('AT3 — a failing compiler still reds the gate (the fix is not vacuous)', (t) => {
  const { result } = withStubbedNpx(t, { tscExit: 2 });

  assert.equal(result.status, 1, 'tsc rejected the blocks and the gate still passed');
  assert.match(result.stdout, /FAIL tsc rejected the typescript blocks/);
  assert.match(result.stdout, /simulated compiler failure/, 'the compiler output was swallowed');
});
