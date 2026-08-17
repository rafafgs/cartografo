/**
 * Acceptance tests for the intake command's own command line (t144, AT2).
 *
 * The split is the surveyor's (t146) and the synthesizer's, for the reason
 * `src/synthesizer/synthesize.ts` records: what a test can reach without
 * spawning a process is what stays covered. So argv, the environment, the
 * credential and the refusal messages live in a module, and `cli.mjs` keeps only
 * what genuinely needs a process.
 *
 * The credential is wired in from the first commit on purpose. t146 exists
 * because the surveyor shipped without one: every call came back a bare `401`,
 * with `GET … respondeu 401` as its whole explanation. Precedence is `--token` >
 * `CARTOGRAFO_TOKEN` > nothing, which is the rule `packages/core/src/cli/url.ts`,
 * the cost lens, the surveyor and the synthesizer already use — a fifth rule for
 * a fifth command would be a fifth thing to remember, and the person running all
 * of them is one person.
 *
 * English per D18; the flags a person types (`--classe`, `--dir`) and the
 * payload keys stay as they are published.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as CommandLineModule from '../../src/intake/command-line.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const COMMAND_LINE_MODULE = 'src/intake/command-line.ts';

/** The request in natural language: one positional argument, quoted. */
const REQUEST = 'Fechar a camada de intake com portao humano.';

/** An environment with nothing in it: every parse here declares what it reads. */
const EMPTY_ENV: NodeJS.ProcessEnv = {};

let cache: typeof CommandLineModule | null = null;

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

/** Asserts the command is runnable and hands back what it resolved to. */
function runnable(parsed: CommandLineModule.ParsedCommand): CommandLineModule.IntakeRunOptions {
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
 * @returns The implementation to inject.
 */
function recordingFetch(
  seen: SeenRequest[],
  status = 200,
  body: unknown = { classes: [] },
): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url: target, authorization: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('AT2 — the request is positional and --classe is required; either missing is a refusal', async () => {
  const { parseArguments } = await loadCommandLine();

  assert.match(
    refusal(parseArguments([REQUEST], EMPTY_ENV)),
    new RegExp('--classe'),
    'the message names the flag that is missing',
  );
  assert.match(
    refusal(parseArguments(['--classe', 'desenvolvimento-de-software'], EMPTY_ENV)),
    /request/i,
    'the message names what is missing',
  );
  assert.match(
    refusal(parseArguments([REQUEST, 'sobra', '--classe', 'x'], EMPTY_ENV)),
    /2|quote/i,
    'the request is ONE argument; two of them is a missing pair of quotes',
  );
});

test('AT2 — --url, --dir and --token have defaults, and each one overrides its own', async () => {
  const { parseArguments, DEFAULT_URL } = await loadCommandLine();

  const bare = runnable(parseArguments([REQUEST, '--classe', 'nota-curta'], EMPTY_ENV));
  assert.equal(bare.request, REQUEST);
  assert.equal(bare.className, 'nota-curta');
  assert.equal(bare.url, DEFAULT_URL);
  assert.equal(bare.workingDir, undefined, 'no --dir means a temporary directory, resolved later');
  assert.equal(bare.token, undefined);

  const given = runnable(
    parseArguments(
      [
        REQUEST,
        '--classe',
        'nota-curta',
        '--url',
        'http://127.0.0.1:9999',
        '--dir',
        '/tmp/cartografo-intake',
        '--token',
        'typed',
      ],
      EMPTY_ENV,
    ),
  );
  assert.equal(given.url, 'http://127.0.0.1:9999');
  assert.equal(given.workingDir, '/tmp/cartografo-intake');
  assert.equal(given.token, 'typed');
});

test('AT2 — the token precedence is --token, then CARTOGRAFO_TOKEN, then none', async () => {
  const { parseArguments, ENV_TOKEN } = await loadCommandLine();

  assert.equal(ENV_TOKEN, 'CARTOGRAFO_TOKEN');

  const fromEnv = runnable(
    parseArguments([REQUEST, '--classe', 'nota-curta'], { [ENV_TOKEN]: '  exported  ' }),
  );
  assert.equal(fromEnv.token, 'exported');

  const both = runnable(
    parseArguments([REQUEST, '--classe', 'nota-curta', '--token', 'typed'], {
      [ENV_TOKEN]: 'exported',
    }),
  );
  assert.equal(both.token, 'typed');

  // Nothing anywhere sends no header at all: an empty `Authorization` would look
  // like a credential to whoever reads the server's log.
  assert.equal(runnable(parseArguments([REQUEST, '--classe', 'x'], EMPTY_ENV)).token, undefined);
  assert.equal(
    runnable(parseArguments([REQUEST, '--classe', 'x'], { [ENV_TOKEN]: '   ' })).token,
    undefined,
  );
});

test('AT2 — an unknown flag, and a flag with no value, are both refused', async () => {
  const { parseArguments, HELP } = await loadCommandLine();

  assert.match(refusal(parseArguments([REQUEST, '--nope', 'x'], EMPTY_ENV)), new RegExp('--nope'));
  assert.match(
    refusal(parseArguments([REQUEST, '--classe'], EMPTY_ENV)),
    new RegExp('--classe'),
    'a dangling flag is a typo, not an empty value',
  );
  assert.match(
    refusal(parseArguments([REQUEST, '--classe', '--url', 'x'], EMPTY_ENV)),
    new RegExp('--classe'),
  );

  assert.ok(HELP.includes('--classe'), `the help text does not mention --classe:\n${HELP}`);
  assert.ok(HELP.includes('--token'), `the help text does not mention --token:\n${HELP}`);
  assert.ok(
    HELP.includes('CARTOGRAFO_TOKEN'),
    `the help text does not mention the variable that spares typing the flag:\n${HELP}`,
  );
});

test('AT2 — --help is asked for explicitly and answers before anything else', async () => {
  const { parseArguments } = await loadCommandLine();

  assert.equal(parseArguments(['--help'], EMPTY_ENV).kind, 'help');
  assert.equal(parseArguments(['-h'], EMPTY_ENV).kind, 'help');
  // Even with a command line that would otherwise be refused.
  assert.equal(parseArguments(['--help', '--nope'], EMPTY_ENV).kind, 'help');
});

test('AT2 — the token reaches the wire as a bearer, and its absence sends no header', async () => {
  const { parseArguments, createClient, createReader } = await loadCommandLine();
  const seen: SeenRequest[] = [];

  const options = runnable(
    parseArguments(
      [REQUEST, '--classe', 'nota-curta', '--url', 'http://127.0.0.1:9999', '--token', 'abc'],
      EMPTY_ENV,
    ),
  );

  await createReader(options, recordingFetch(seen)).fetchClasses();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:9999/v1/classes');
  assert.equal(seen[0].authorization, 'Bearer abc');

  await createClient(options, recordingFetch(seen, 201, { draft: { id: 1 } })).criarIntake({
    class: 'nota-curta',
    request: REQUEST,
    items: [{ ref: 'a', title: 'Uma' }],
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].url, 'http://127.0.0.1:9999/v1/intake');
  assert.equal(seen[1].authorization, 'Bearer abc');

  const anonymous = runnable(
    parseArguments([REQUEST, '--classe', 'nota-curta', '--url', 'http://127.0.0.1:9999'], EMPTY_ENV),
  );
  await createReader(anonymous, recordingFetch(seen)).fetchClasses();
  assert.equal(seen.length, 3);
  assert.equal(seen[2].authorization, null);
});

test('AT2 — a refused credential becomes one actionable line, not the status code', async () => {
  const { isDenied, deniedMessage } = await loadCommandLine();

  const message = deniedMessage('http://127.0.0.1:9999');
  assert.ok(message.includes('http://127.0.0.1:9999'), message);
  assert.ok(message.includes('CARTOGRAFO_TOKEN'), message);
  assert.ok(message.includes('--token'), message);

  // Structural, so it survives an error raised by a module instance this one did
  // not import — the reader and the client raise two different classes.
  assert.equal(isDenied({ status: 401 }), true);
  assert.equal(isDenied({ status: 404 }), false);
  assert.equal(isDenied(new Error('boom')), false);
});
