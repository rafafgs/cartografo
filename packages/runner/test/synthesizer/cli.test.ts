/**
 * Acceptance tests of the `synthesize` command line (t115, AT5).
 *
 * The command is the only thing a person touches, so its contract is checked
 * where a person meets it: the real entrypoint, spawned as a process, with its
 * exit code read back. `2` is reserved for "you typed it wrong" and kept apart
 * from `1` ("it ran and could not finish") — a caller that cannot tell those
 * apart cannot retry either of them sensibly.
 *
 * `--classe` is required and never inferred: D8 puts the naming of the class in
 * the user's hands, and a command that guesses a name registers a lineage
 * nobody chose.
 *
 * Argument parsing itself is exercised through the exported function rather
 * than the process, because the interesting claim — `--saida` overrides the
 * default draft path — is a decision, not an I/O effect, and proving it by
 * running a whole synthesis would prove the engine instead.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as SynthesisModule from '../../src/synthesizer/synthesize.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_PATH = path.join(PACKAGE_ROOT, 'src', 'synthesizer', 'cli.mjs');
const MODULE_PATH = 'src/synthesizer/synthesize.ts';

let cache: typeof SynthesisModule | null = null;

async function loadSynthesis(): Promise<typeof SynthesisModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/synthesizer/synthesize.ts', import.meta.url).href
  )) as typeof SynthesisModule;
  return cache;
}

/** Runs the real entrypoint and gives back what a shell would see. */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  assert.ok(existsSync(CLI_PATH), 'artifact does not exist yet: packages/runner/src/synthesizer/cli.mjs');

  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('AT5 — a missing --classe exits 2 without touching anything', () => {
  const result = runCli(['uma declaração de problema em linguagem natural']);

  assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /--classe/, 'the message names the flag that is missing');
});

test('AT5 — a missing declaration exits 2', () => {
  const result = runCli(['--classe', 'artigo-revisado']);

  assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /declara/i, 'the message names what is missing');
});

test('AT5 — --help prints the flow and the mandatory next step by hand', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /cartografo import/, 'the manual next step is the whole gate (D10)');
  assert.match(result.stdout, /--classe/);
  // Built from a string and not a regex literal: `--saida` is the user-facing
  // flag, a frozen surface, not an identifier of ours (D18/FR2).
  assert.match(result.stdout, new RegExp('--saida'));
  assert.match(result.stdout, /rascunho/, 'what the command produces is a draft, and says so');
});

test('AT5 — --saida overrides the default draft path', async () => {
  const { parseArguments } = await loadSynthesis();

  const byDefault = parseArguments(['uma declaração', '--classe', 'artigo-revisado']);
  assert.equal(byDefault.kind, 'run');
  assert.ok(byDefault.kind === 'run');
  assert.equal(byDefault.options.className, 'artigo-revisado');
  assert.equal(byDefault.options.declaration, 'uma declaração');
  assert.equal(
    byDefault.options.outputPath,
    undefined,
    'no --saida means the default is resolved from the class name, later',
  );

  const overridden = parseArguments([
    'uma declaração',
    '--classe',
    'artigo-revisado',
    '--saida',
    '/tmp/outro-lugar.json',
  ]);
  assert.ok(overridden.kind === 'run');
  assert.equal(overridden.options.outputPath, '/tmp/outro-lugar.json');
});

test('AT5 — the default draft path is <classe>.grafo.rascunho.json in the current directory', async () => {
  const { resolveOutputPath } = await loadSynthesis();

  assert.equal(
    resolveOutputPath('artigo-revisado', undefined, '/work'),
    path.join('/work', 'artigo-revisado.grafo.rascunho.json'),
  );
  assert.equal(
    resolveOutputPath('artigo-revisado', 'saida.json', '/work'),
    path.resolve('/work', 'saida.json'),
  );
});

test('AT5 — --url and --timeout are optional and parsed when given', async () => {
  const { parseArguments } = await loadSynthesis();

  const parsed = parseArguments([
    'uma declaração',
    '--classe',
    'artigo-revisado',
    '--url',
    'http://127.0.0.1:9999',
    '--timeout',
    '120',
  ]);

  assert.ok(parsed.kind === 'run');
  assert.equal(parsed.options.url, 'http://127.0.0.1:9999');
  assert.equal(parsed.options.timeoutSeconds, 120);
});
