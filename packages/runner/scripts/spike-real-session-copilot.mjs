#!/usr/bin/env node
/**
 * Manual proof: a real session, with the real `copilot` CLI (t676).
 *
 * NOT a CI test, and it must not become one — the same division
 * `spike-real-session.mjs` and `spike-real-session-codex.mjs` set up. The suite
 * runs against the fake engine so it depends on no binary, credential or
 * network; this is the manual gate on the other side, the half the conformance
 * kit cannot prove because it has no real CLI.
 *
 * Two modes, picked by `COPILOT_SPIKE_MODE`:
 *
 * - `stub` (`npm run spike:copilot:stub`): NO GitHub credential. The CLI is
 *   pointed at `stub-openai-provider.mjs` through BYOK (`COPILOT_PROVIDER_BASE_URL`;
 *   `copilot help environment`: "GitHub authentication is not required"), in a
 *   throwaway `COPILOT_HOME`. It proves everything this adapter and the runner
 *   own, with a scripted model: the lifecycle (`onEngineRef`, `onFinished`,
 *   `completed` / exit 0), the JSONL frames reaching `onOutput`, the decoder
 *   turning them into text, an escalation DETECTED in that text
 *   (`parseInputRequest`), a tool call that writes a file in the working
 *   directory, and `session.opened` / `session.finished` validating with ajv
 *   against the taxonomy schemas.
 * - `github` (`npm run spike:copilot`, the default): no BYOK, the CLI's own
 *   routing. It needs a credentialed account (`copilot login`, or one of
 *   `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`). It proves what the stub
 *   cannot: that a real model, with these instructions, actually WORKED — the
 *   file the prompt asked for exists with the requested content. Exiting 0
 *   proves nothing about that.
 *
 * **State of the `github` proof: PENDING the external operator's run.** The
 * founder's account has no usable Copilot access. A headless prompt against
 * GitHub's routing exits 1 at once with
 *
 *     Error: Access denied by policy settings (Request ID: …)
 *
 * after the CLI had already emitted a `session.warning` frame saying
 * "Third-party MCP servers are disabled by your organization's Copilot policy.
 * Only built-in servers are available.". Nothing here was proven against GitHub's
 * model routing; the `stub` mode proves the adapter, not the model. Whoever has a
 * Copilot subscription closes it by installing the CLI, logging in and running
 * this script once, unchanged:
 *
 *     npm install -g @github/copilot
 *     copilot login                # or export COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN
 *     cd packages/runner && npm run spike:copilot
 *
 * The binary: `copilot` on the PATH, else `COPILOT_BINARY_PATH`, else
 * `npx -y @github/copilot@1.0.95` (the version this adapter was measured against).
 *
 * The JSONL is a local evidence artifact, not a table: the adapter writes to no
 * database (D1 — the listener is the only output).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import AjvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';

import { CopilotAdapter } from '../src/engine/copilot-adapter.ts';
import { buildCommand, buildEnvironment } from '../src/engine/copilot-command.ts';
import { parseInputRequest } from '../src/dispatch/parse-input-request.ts';
import { decodeCopilotSessionText } from '../src/dispatch/session-text.ts';
import { startStubProvider } from './stub-openai-provider.mjs';

const Ajv2020 = AjvModule.default ?? AjvModule;
const addFormats = formatsModule.default ?? formatsModule;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCHEMAS_DIR = join(REPO_ROOT, 'specs/events/schemas');
const MANIFEST = join(REPO_ROOT, 'specs/formats/examples/skill-manifest.develop.json');

/** The version the adapter was measured against, used when nothing is installed. */
const MEASURED_VERSION = '1.0.95';

const REQUESTED_FILE = 'PROOF-T676.md';
const PHRASE = 'real session of the Copilot EngineAdapter';
const TIMEOUT_SECONDS = 300;

const MODE = (process.env.COPILOT_SPIKE_MODE ?? 'github').trim();
const BINARY_OVERRIDE = process.env.COPILOT_BINARY_PATH?.trim();

/** SessionStatus -> the event taxonomy's `status` (t98); `cancelled` has no peer there. */
const TAXONOMY_STATUS = {
  completed: 'completed',
  failed: 'failed',
  timed_out: 'timed_out',
  cancelled: 'stuck',
};

const log = (message) => console.log(`[spike] ${message}`);

function die(message) {
  console.error(`\n[spike] FAILED: ${message}\n`);
  process.exit(1);
}

if (MODE !== 'stub' && MODE !== 'github') {
  die(`COPILOT_SPIKE_MODE must be "stub" or "github", got "${MODE}"`);
}

/** Is a plain `copilot` on the PATH? */
function copilotOnPath() {
  try {
    execFileSync('copilot', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * How to run the binary: a command and the arguments that come before the
 * adapter's own. Only the COMMAND changes — every argument the builder produced,
 * and everything it produced off the argv (`stdin`), goes through whole, so the
 * proof is of the command the adapter really issues.
 */
function binaryPrefix() {
  if (BINARY_OVERRIDE) return { command: BINARY_OVERRIDE, prefix: [] };
  if (copilotOnPath()) return { command: 'copilot', prefix: [] };
  return { command: 'npx', prefix: ['-y', `@github/copilot@${MEASURED_VERSION}`] };
}

/** The adapter under proof, pointed at the real binary. */
function buildAdapter() {
  const { command, prefix } = binaryPrefix();
  log(`binary under proof: ${[command, ...prefix].join(' ')}`);

  return new CopilotAdapter({
    commandBuilder: (spec, engineRef) => {
      const built = buildCommand(spec, engineRef);
      return { ...built, command, args: [...prefix, ...built.args] };
    },
    environmentBuilder: (spec) => buildEnvironment(spec),
    probeCommandBuilder: () => ({ command, args: [...prefix, '--version'] }),
  });
}

/** A disposable git repository — the session's `workingDir`. */
function createDisposableRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-spike-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });

  git('init', '--quiet', '--initial-branch', 'main');
  git('config', 'user.email', 'spike@cartografo.local');
  git('config', 'user.name', 'Spike t676');
  writeFileSync(join(repo, 'README.md'), '# Disposable repo of the t676 manual proof\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'initial');
  return { root, repo };
}

function buildValidator() {
  // `allowUnionTypes` because the taxonomy uses a type union on purpose:
  // `entity.id` is an integer for `job`, `session`, `input_request` and `lease`,
  // and a string for `graph_version`, whose id is the snapshot hash (D15).
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  for (const name of ['envelope', 'session.opened', 'session.finished']) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), 'utf8')));
  }
  return (type, event) => {
    const valid = ajv.validate(`${type}.schema.json`, event);
    if (!valid) {
      die(`event ${type} does not validate against the schema:\n${ajv.errorsText(ajv.errors, { separator: '\n' })}`);
    }
    log(`event ${type} validates against the taxonomy schema`);
  };
}

/** The common envelope. `id` is local: in a real system the server numbers it. */
function envelope(id, type, payload) {
  return {
    id,
    type,
    project_id: 3,
    execution_id: null,
    entity: { type: 'session', id: 1 },
    actor: { type: 'system', ref: 'runner/spike-t676' },
    occurred_at: new Date().toISOString(),
    data: payload,
  };
}

/**
 * Runs one session to its end and projects it into the two events.
 *
 * @returns {{ transcript: string[], engineRef: string | null, outcome: { status: string, exitCode: number | null }, elapsed: string, events: object[] }}
 */
async function runSession(adapter, validate, spec, label, eventIdBase) {
  const transcript = [];
  let engineRef = null;
  let outcome = null;
  let resolveEnd;
  const end = new Promise((resolve) => {
    resolveEnd = resolve;
  });

  log(`--- session: ${label}`);
  const startedAt = Date.now();
  const handle = await adapter.startSession(spec, {
    onOutput(line) {
      transcript.push(line);
      process.stdout.write(`  | ${line.length > 200 ? `${line.slice(0, 200)}…` : line}\n`);
    },
    onEngineRef(ref) {
      engineRef = ref;
      log(`onEngineRef: ${ref}`);
    },
    onFinished(status, exitCode) {
      outcome = { status, exitCode };
      resolveEnd();
    },
  });
  log(`getStatus right after the start: ${await adapter.getStatus(handle)}`);

  await end;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`onFinished: ${JSON.stringify(outcome)} in ${elapsed}s`);
  log(`getStatus after the end: ${await adapter.getStatus(handle)}`);

  const opened = envelope(eventIdBase, 'session.opened', {
    engine: adapter.engineName,
    engine_session_ref: engineRef,
    working_dir: spec.workingDir,
    prompt: spec.prompt,
    timeout_seconds: TIMEOUT_SECONDS,
    job_id: null,
    node_id: null,
  });
  validate('session.opened', opened);

  const finished = envelope(eventIdBase + 1, 'session.finished', {
    status: TAXONOMY_STATUS[outcome.status],
    exit_code: outcome.exitCode,
    // The adapter does not declare `reportsUsage`: `result.usage` is request
    // counts and durations, not tokens. null is "the engine reported nothing".
    usage: null,
  });
  validate('session.finished', finished);

  return { transcript, engineRef, outcome, elapsed, events: [opened, finished] };
}

function requireCompleted(result, label) {
  if (result.outcome.status !== 'completed') die(`${label}: the session ended as "${result.outcome.status}"`);
  if (result.outcome.exitCode !== 0) die(`${label}: exit code ${result.outcome.exitCode}`);
  if (result.transcript.length === 0) die(`${label}: no line reached onOutput`);
  if (result.engineRef === null) die(`${label}: onEngineRef never fired`);
}

/** The throwaway COPILOT_HOME plus the BYOK variables that aim the CLI at the stub. */
function byokEnvironment(stubUrl, copilotHome) {
  return {
    COPILOT_PROVIDER_BASE_URL: stubUrl,
    COPILOT_PROVIDER_TYPE: 'openai',
    // Not `stub`: the CLI redacts the key's value wherever it prints it, and a key
    // that is a substring of the model name turned `stub-model` into `******-model`
    // in the frames.
    COPILOT_PROVIDER_API_KEY: 'spike-key-t676',
    COPILOT_MODEL: 'stub-model',
    COPILOT_HOME: copilotHome,
  };
}

async function main() {
  const adapter = buildAdapter();

  const probe = await adapter.verifyCli();
  log(`verifyCli: ${JSON.stringify(probe)}`);
  if (!probe.available) {
    die(
      'the `copilot` CLI did not answer --version. Install it (`npm install -g @github/copilot`), ' +
        'or point COPILOT_BINARY_PATH at a real binary.',
    );
  }
  if (MODE === 'github' && !probe.authenticated) {
    log(
      'WARNING: authenticated=false. It reads the environment only; a stored `copilot login` is ' +
        'invisible to it. Going ahead anyway.',
    );
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const instructions = manifest.instructions;
  if (typeof instructions !== 'string' || instructions.length === 0) {
    die(`the manifest ${MANIFEST} has no "instructions" field`);
  }
  log(`mode: ${MODE}; instructions: ${instructions.length} characters from the skill manifest "${manifest.id}"`);

  const validate = buildValidator();
  const { root, repo } = createDisposableRepo();
  log(`workingDir: ${repo}`);

  return MODE === 'stub'
    ? await proveWithStub({ adapter, validate, probe, instructions, root, repo })
    : await proveWithGitHub({ adapter, validate, probe, instructions, root, repo });
}

/** `stub` mode: no GitHub credential, a scripted provider, the whole runner path. */
async function proveWithStub({ adapter, validate, probe, instructions, root, repo }) {
  const copilotHome = join(root, 'copilot-home');
  mkdirSync(copilotHome);

  // Session 1: the scripted model asks a question, as a session does when it
  // cannot decide alone. The block's quotes and newlines reach `onOutput`
  // JSON-escaped inside an `assistant.message` frame.
  const askText =
    'I need a decision before I continue.\n\n```input-request\n' +
    JSON.stringify({
      question: 'Which migration number should be reserved: 0002 or 0003?',
      context: 'The migrations directory is empty and a parallel ticket may claim the same range.',
      options: ['0002', '0003'],
      recommendation: 'Reserve 0002.',
      default: '0002',
    }) +
    '\n```';

  const asking = await startStubProvider({ turns: [{ text: askText }] });
  log(`stub provider (escalation): ${asking.url}`);
  let escalation;
  try {
    escalation = await runSession(
      adapter,
      validate,
      {
        workingDir: repo,
        instructions,
        prompt: 'Ask me which migration number to reserve.',
        timeoutSeconds: TIMEOUT_SECONDS,
        envOverrides: byokEnvironment(asking.url, copilotHome),
      },
      'escalation',
      1,
    );
  } finally {
    await asking.close();
  }
  requireCompleted(escalation, 'escalation');

  const decoded = decodeCopilotSessionText(escalation.transcript);
  const rawJoined = escalation.transcript.join('\n');
  if (parseInputRequest(rawJoined) !== null) {
    die('the RAW frames already parsed as an input request — the decoder proves nothing');
  }
  const request = parseInputRequest(decoded);
  if (request === null) die(`parseInputRequest found no block in the decoded text:\n${decoded}`);
  if (!/0002/.test(request.question)) die(`the block is not the scripted question: ${request.question}`);
  if (decoded.includes('"type"') || decoded.includes('deltaContent')) {
    die(`frame JSON leaked into the decoded text:\n${decoded}`);
  }
  log(`escalation detected: ${JSON.stringify(request.question)} options=${JSON.stringify(request.options)}`);

  // Session 2: the scripted model asks the CLI to write a file, then says it is
  // done. Proves the tool loop and the `-C <workingDir>` workspace.
  const target = join(repo, REQUESTED_FILE);
  const working = await startStubProvider({
    turns: [
      { tool_calls: [{ name: 'create', arguments: { path: target, file_text: `${PHRASE}\n` } }] },
      { text: `Created ${REQUESTED_FILE}.` },
    ],
  });
  log(`stub provider (work): ${working.url}`);
  let work;
  try {
    work = await runSession(
      adapter,
      validate,
      {
        workingDir: repo,
        instructions,
        prompt: `Create a file called ${REQUESTED_FILE} containing exactly: ${PHRASE}`,
        timeoutSeconds: TIMEOUT_SECONDS,
        envOverrides: byokEnvironment(working.url, copilotHome),
      },
      'work',
      3,
    );
  } finally {
    await working.close();
  }
  requireCompleted(work, 'work');
  if (!existsSync(target)) die(`the scripted tool call did not create ${REQUESTED_FILE}`);
  if (!readFileSync(target, 'utf8').includes(PHRASE)) die(`${REQUESTED_FILE} does not carry the scripted content`);

  // The discovery half, against the real binary, in the same throwaway home:
  // nothing is registered there, so a CLI-sourced answer lists no server of the
  // user's (the builtin one is left out by design).
  const discovery = await new CopilotAdapter({
    mcpListCommandBuilder: () => {
      const { command, prefix } = binaryPrefix();
      return { command, args: [...prefix, 'mcp', 'list', '--json'] };
    },
    probeEnvironment: { ...process.env, COPILOT_HOME: copilotHome },
  }).discoverMcpServers();
  log(`discoverMcpServers: ${JSON.stringify(discovery)}`);
  if (discovery.origin !== 'cli') die(`discovery fell back to the file: ${JSON.stringify(discovery)}`);

  const events = [...escalation.events, ...work.events];
  const jsonl = join(root, 'events.jsonl');
  writeFileSync(jsonl, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  writeFileSync(join(root, 'transcript-escalation.jsonl'), `${escalation.transcript.join('\n')}\n`);
  writeFileSync(join(root, 'transcript-work.jsonl'), `${work.transcript.join('\n')}\n`);
  writeFileSync(join(root, 'decoded-escalation.txt'), `${decoded}\n`);

  console.log('\n===== evidence (stub mode, no GitHub credential) =====');
  console.log(`CLI:                ${probe.version}`);
  console.log(`engineName:         ${adapter.engineName}`);
  console.log(`escalation session: ${escalation.outcome.status} / exit ${escalation.outcome.exitCode} / ${escalation.elapsed}s / ref ${escalation.engineRef}`);
  console.log(`work session:       ${work.outcome.status} / exit ${work.outcome.exitCode} / ${work.elapsed}s / ref ${work.engineRef}`);
  console.log(`frames (escalation):${escalation.transcript.length} lines`);
  console.log(`decoded text:\n${decoded.split('\n').map((line) => `    ${line}`).join('\n')}`);
  console.log(`escalation parsed:  ${JSON.stringify(request)}`);
  console.log(`${REQUESTED_FILE}: ${JSON.stringify(readFileSync(target, 'utf8').trim())}`);
  console.log(`discovery:          origin ${discovery.origin}, ${discovery.servers.length} servers`);
  console.log(`events:             ${jsonl}`);
  console.log(`transcripts:        ${root}`);
  console.log('=====================================================\n');
  log('stub proof OK (the model was scripted: this proves the adapter and the decoder, not a model)');
}

/** `github` mode: a credentialed account, the CLI's own routing, did the model WORK? */
async function proveWithGitHub({ adapter, validate, probe, instructions, root, repo }) {
  const prompt =
    `Create a file called ${REQUESTED_FILE} in the current directory, containing ` +
    `exactly one line with the text: ${PHRASE}\n` +
    'Do nothing beyond that, and do not commit.';

  const result = await runSession(
    adapter,
    validate,
    { workingDir: repo, instructions, prompt, timeoutSeconds: TIMEOUT_SECONDS },
    'github',
    1,
  );

  const jsonl = join(root, 'events.jsonl');
  writeFileSync(jsonl, `${result.events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  writeFileSync(join(root, 'transcript.txt'), `${result.transcript.join('\n')}\n`);

  requireCompleted(result, 'github');

  const produced = join(repo, REQUESTED_FILE);
  if (!existsSync(produced)) {
    die(`the session did not create ${REQUESTED_FILE} — it exited with 0 without working`);
  }
  const content = readFileSync(produced, 'utf8');
  if (!content.includes(PHRASE)) {
    die(`${REQUESTED_FILE} exists but does not carry the phrase asked for:\n${content}`);
  }

  console.log('\n===== evidence (github mode) =====');
  console.log(`CLI:            ${probe.version}`);
  console.log(`engineName:     ${adapter.engineName}`);
  console.log(`engineRef:      ${result.engineRef}`);
  console.log(`outcome:        ${result.outcome.status} / exit ${result.outcome.exitCode} / ${result.elapsed}s`);
  console.log(`lines:          ${result.transcript.length}`);
  console.log(`${REQUESTED_FILE}: ${JSON.stringify(content.trim())}`);
  console.log(`events:         ${jsonl}`);
  console.log(`transcript:     ${join(root, 'transcript.txt')}`);
  console.log(`workdir:        ${repo}`);
  console.log('==================================\n');
  log('manual proof OK');
}

await main();
