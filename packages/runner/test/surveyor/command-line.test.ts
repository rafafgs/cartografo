/**
 * Acceptance tests for the surveyor command's own command line (t146).
 *
 * t124 closed `/v1/*` behind a bearer token and gave every caller a way to
 * present one — every caller except this one. The surveyor is a command a
 * person types (`src/surveyor/cli.mjs`), it reads three routes and writes one,
 * and until this ficha it built its client with no token and offered no flag or
 * environment variable to supply one: the command was unconditionally denied,
 * with the generic `GET … respondeu 401` of the HTTP client as its whole
 * explanation.
 *
 * So the claims here are the ones that make the command usable again:
 *
 * 1. argv and the environment become a token, with `--token` winning over
 *    `CARTOGRAFO_TOKEN` — the same precedence the `cartografo` CLI
 *    (`packages/core/src/cli/url.ts`) and the cost lens
 *    (`packages/cost-surveyor/src/cli.ts`) already use, because a person who
 *    exported the variable once should not have to learn a third rule;
 * 2. the positional contract does not move: `<execution_id> [url] [dir]` is what
 *    the spec documents and what the flag has to survive;
 * 3. the token reaches the WIRE — an `Authorization: Bearer …` on the request —
 *    and its absence sends no header at all, which is the honest behaviour the
 *    HTTP client documents (an empty header would look like a credential);
 * 4. a refusal comes back as one actionable line naming what to do, not as the
 *    status code the server answered with.
 *
 * Parsing lives in a module and not in the `.mjs` entry point for the reason
 * `src/synthesizer/synthesize.ts` records: what a test can reach without
 * spawning a process is what stays covered.
 *
 * English per D18; route segments and payload keys stay in Portuguese.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as CommandLineModule from '../../src/surveyor/command-line.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const COMMAND_LINE_MODULE = 'src/surveyor/command-line.ts';

let cache: typeof CommandLineModule | null = null;

/** Loads the module under test, failing loudly while it does not exist yet. */
async function loadCommandLine(): Promise<typeof CommandLineModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, COMMAND_LINE_MODULE)),
    `artifact does not exist yet: packages/runner/${COMMAND_LINE_MODULE}`,
  );
  cache ??= (await import(
    new URL(`../../${COMMAND_LINE_MODULE}`, import.meta.url).href
  )) as typeof CommandLineModule;
  return cache;
}

/** An environment with nothing in it: every parse here declares what it reads. */
const EMPTY_ENV: NodeJS.ProcessEnv = {};

/** Asserts the command is runnable and hands back what it resolved to. */
function runnable(parsed: CommandLineModule.ParsedCommand): CommandLineModule.SurveyorRunOptions {
  assert.equal(parsed.kind, 'run', `expected a runnable command, got ${JSON.stringify(parsed)}`);
  if (parsed.kind !== 'run') throw new Error('unreachable');
  return parsed.options;
}

/** Asserts the command was refused and hands back the message it would print. */
function refusal(parsed: CommandLineModule.ParsedCommand): string {
  assert.equal(parsed.kind, 'usage', `expected a refusal, got ${JSON.stringify(parsed)}`);
  if (parsed.kind !== 'usage') throw new Error('unreachable');
  return parsed.message;
}

/** What one request carried, as the fake `fetch` below saw it. */
interface SeenRequest {
  url: string;
  authorization: string | null;
}

/**
 * A `fetch` that records what it was asked and answers whatever it was told to.
 *
 * @param seen Accumulator the test asserts on.
 * @param status Status to answer with.
 * @param body JSON body to answer with.
 * @returns The implementation to inject into the client.
 */
function recordingFetch(seen: SeenRequest[], status = 200, body: unknown = { metricas: [] }): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url: target, authorization: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('AT1 — the token comes off the command line, in either spelling, from any position', async () => {
  const { parseArguments } = await loadCommandLine();

  const spaced = runnable(
    parseArguments(['7', 'http://127.0.0.1:9999', '/tmp/surveyor', '--token', 'abc'], EMPTY_ENV),
  );
  assert.equal(spaced.token, 'abc');
  assert.equal(spaced.executionId, 7);
  assert.equal(spaced.url, 'http://127.0.0.1:9999');
  assert.equal(spaced.workingDir, '/tmp/surveyor');

  // Same command with the flag first: the three positionals still land where
  // the spec says they land.
  const leading = runnable(
    parseArguments(['--token=abc', '7', 'http://127.0.0.1:9999', '/tmp/surveyor'], EMPTY_ENV),
  );
  assert.deepEqual(leading, spaced);
});

test('AT2 — with no flag, the token comes from CARTOGRAFO_TOKEN', async () => {
  const { parseArguments, ENV_TOKEN } = await loadCommandLine();

  assert.equal(ENV_TOKEN, 'CARTOGRAFO_TOKEN');
  const options = runnable(parseArguments(['7'], { [ENV_TOKEN]: '  from-the-shell  ' }));
  assert.equal(options.token, 'from-the-shell');
});

test('AT3 — the flag wins over the environment, and blank is the same as absent', async () => {
  const { parseArguments, ENV_TOKEN } = await loadCommandLine();

  const both = runnable(parseArguments(['7', '--token', 'typed'], { [ENV_TOKEN]: 'exported' }));
  assert.equal(both.token, 'typed');

  // Nothing anywhere sends no header at all: an empty `Authorization` would
  // look like a credential to whoever reads the server's log.
  assert.equal(runnable(parseArguments(['7'], EMPTY_ENV)).token, undefined);
  assert.equal(runnable(parseArguments(['7'], { [ENV_TOKEN]: '   ' })).token, undefined);
});

test('AT4 — the positional contract of the spec is unchanged', async () => {
  const { parseArguments, DEFAULT_URL } = await loadCommandLine();

  const bare = runnable(parseArguments(['7'], EMPTY_ENV));
  assert.equal(bare.executionId, 7);
  assert.equal(bare.url, DEFAULT_URL);
  assert.equal(bare.workingDir, undefined);

  assert.match(refusal(parseArguments([], EMPTY_ENV)), /execution_id/);
  assert.match(refusal(parseArguments(['nao-e-numero'], EMPTY_ENV)), /execution_id/);
  assert.match(refusal(parseArguments(['7', 'url', 'dir', 'extra'], EMPTY_ENV)), /extra/);
});

test('AT5 — a flag with no value is refused, and the usage text says how to pass one', async () => {
  const { parseArguments, USAGE } = await loadCommandLine();

  assert.match(refusal(parseArguments(['7', '--token'], EMPTY_ENV)), /--token/);
  assert.match(refusal(parseArguments(['7', '--token='], EMPTY_ENV)), /--token/);
  assert.match(refusal(parseArguments(['7', '--token', '--other'], EMPTY_ENV)), /--token/);
  assert.match(refusal(parseArguments(['7', '--nope', 'x'], EMPTY_ENV)), /--nope/);

  assert.ok(USAGE.includes('--token'), `the usage text does not mention --token:\n${USAGE}`);
  assert.ok(
    USAGE.includes('CARTOGRAFO_TOKEN'),
    `the usage text does not mention CARTOGRAFO_TOKEN:\n${USAGE}`,
  );

  // t230 — the DISPLAYED name of the positional is English (D20 §5.1). The
  // `execucao_id` this command later sends inside a `/v1` body is the frozen
  // hypothesis vocabulary and is a different thing entirely.
  assert.ok(USAGE.includes('<execution_id>'), `the usage text still shows the old positional:\n${USAGE}`);
  assert.ok(!USAGE.includes('execucao_id'), `the usage text still shows execucao_id:\n${USAGE}`);
});

test('AT6 — the token reaches the wire as a bearer, and its absence sends no header', async () => {
  const { parseArguments, createClient } = await loadCommandLine();
  const seen: SeenRequest[] = [];

  const withToken = createClient(
    runnable(parseArguments(['7', 'http://127.0.0.1:9999', '--token', 'abc'], EMPTY_ENV)),
    recordingFetch(seen),
  );
  await withToken.metricsByVersion(7);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:9999/v1/executions/7/metrics-by-version');
  assert.equal(seen[0].authorization, 'Bearer abc');

  const anonymous = createClient(
    runnable(parseArguments(['7', 'http://127.0.0.1:9999'], EMPTY_ENV)),
    recordingFetch(seen),
  );
  await anonymous.metricsByVersion(7);

  assert.equal(seen.length, 2);
  assert.equal(seen[1].authorization, null);
});

test('AT7 — a refused request becomes one actionable line, not the status code', async () => {
  const { parseArguments, createClient, isDenied, deniedMessage } = await loadCommandLine();
  const seen: SeenRequest[] = [];

  const client = createClient(
    runnable(parseArguments(['7', 'http://127.0.0.1:9999'], EMPTY_ENV)),
    recordingFetch(seen, 401, { erro: 'credencial_ausente' }),
  );

  const denial = await client.metricsByVersion(7).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(denial !== null, 'a 401 has to reach the command as an error');
  assert.ok(isDenied(denial), `a 401 was not recognized as a denial: ${String(denial)}`);

  const message = deniedMessage('http://127.0.0.1:9999');
  assert.ok(message.includes('http://127.0.0.1:9999'), message);
  assert.ok(message.includes('CARTOGRAFO_TOKEN'), message);
  assert.ok(message.includes('--token'), message);

  // Anything else stays what it is: a 404 is a domain answer this command does
  // not turn into advice about tokens.
  const missing = createClient(
    runnable(parseArguments(['7', 'http://127.0.0.1:9999'], EMPTY_ENV)),
    recordingFetch(seen, 404, { erro: 'nao_encontrado' }),
  );
  const other = await missing.metricsByVersion(7).then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(isDenied(other), false);
  assert.equal(isDenied(new Error('boom')), false);
});
