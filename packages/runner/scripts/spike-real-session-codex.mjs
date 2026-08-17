#!/usr/bin/env node
/**
 * Manual proof: a real session, with the real `codex` CLI.
 *
 * NOT a CI test, and it must not become one — same division `spike-real-session.mjs`
 * set up for the first adapter. The suite runs against the fake engine precisely
 * so it does not depend on an installed binary, credentials or network
 * (`docs/formatos/engine-adapter.md:363-366`); this proof is the manual gate on
 * the other side, the half the kit cannot prove because it has no real CLI.
 *
 * What it demonstrates, end to end:
 *
 * 1. `verifyCli()` finds the real CLI and reports the version.
 * 2. A session runs in a disposable git repository, with `instructions` coming
 *    from the same "fazer" skill manifest the first adapter's proof used
 *    (`especificacoes/formatos/exemplos/manifesto-skill.develop.json`) — the
 *    closest stand-in for "skill coming from the database" available today.
 * 3. The session actually WORKED — the file the prompt asked for is in the
 *    workdir. Without that, "it exited with 0" proves nothing.
 * 4. The listener's callbacks are projected into `session.opened` and
 *    `session.finished` conforming to the taxonomy (t98) and validated with
 *    ajv against the real schemas.
 *
 * The JSONL is a local evidence artifact, not a table: the adapter does not
 * write to a database (D1 — the listener is the only output, and whoever called
 * decides what to persist).
 *
 * Two things this proof needs that the first one did not:
 *
 * - **`CODEX_BINARY_PATH`.** The CLI is very often not installed globally — the
 *   feasibility review of t99 itself ran it through
 *   `npx --yes @openai/codex@latest`. Pointing the adapter's seam at an already
 *   downloaded binary keeps the proof honest (it is the real CLI) without
 *   demanding a global install. Unset, the plain `codex` of the PATH is used.
 * - **A credential.** `codex login`, or one of `OPENAI_API_KEY`,
 *   `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`. With none of them the CLI still
 *   opens the session and only fails in the middle of the stream, with a 401 —
 *   which is exactly the measurement that demoted `authenticated` to best
 *   effort (`engine-adapter.md:452-461`), and is why this script keeps going
 *   past a false `authenticated` instead of refusing to start.
 *
 * **State of this proof as of t119:** run against `codex-cli 0.147.0` WITHOUT a
 * credential, by the founder's decision not to hold the wave for one. It got as
 * far as the 401 and, on the way, proved everything that does not need a model:
 * `verifyCli` finding the real CLI, the `thread.started` frame becoming the
 * `engineRef`, plain-text runtime errors reaching `onOutput` interleaved with
 * the JSON frames, a failed turn leaving with exit code 1 and being classified
 * `failed`, and both events validating against the taxonomy schemas. What is
 * still pending is the half below the `onFinished` line — that the session
 * actually WORKED. Whoever has an `OPENAI_API_KEY` closes it by running this
 * script once, unchanged.
 *
 * **CLOSED in t141 (2026-08-15).** Run unchanged against `codex-cli 0.147.0`
 * WITH a credential: `completed`, exit 0, 11.8s, `engineRef`
 * `01a00665-7730-7591-9c7e-5a090ece0a2a`, and `PROVA-T119.md` in the workdir
 * carrying exactly the phrase asked for. The session worked. Two things that
 * run measured, both about the operator's setup and neither about this script:
 *
 * - Of the three credential variables `CODEX_CREDENTIAL_VARIABLES` names, only
 *   `CODEX_API_KEY` actually authenticates. The same key exported as
 *   `OPENAI_API_KEY` — the obvious guess — dies on
 *   `401 ... wss://api.openai.com/v1/responses` every turn, which matches the
 *   `auth mode none` t119 recorded for it. So: `export CODEX_API_KEY="$…"`, and
 *   no `codex login` and no `auth.json` are needed at all.
 * - `codex exec` sandboxes to read-only by default, so the session politely
 *   reports it cannot write, exits 0 and produces nothing — which this script
 *   catches only because it checks the FILE and not the exit code. Writing needs
 *   `sandbox_mode = "workspace-write"` in `$CODEX_HOME/config.toml`.
 *
 * Usage: npm run spike:codex --workspace @cartografo/runner
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import AjvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';

import { CodexAdapter } from '../src/engine/codex-adapter.ts';
import { buildCommand, buildEnvironment } from '../src/engine/codex-command.ts';

const Ajv2020 = AjvModule.default ?? AjvModule;
const addFormats = formatsModule.default ?? formatsModule;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCHEMAS_DIR = join(REPO_ROOT, 'especificacoes/eventos/schemas');
const MANIFEST = join(REPO_ROOT, 'especificacoes/formatos/exemplos/manifesto-skill.develop.json');

const REQUESTED_FILE = 'PROVA-T119.md';
const PHRASE = 'sessao real do EngineAdapter do Codex';
const TIMEOUT_SECONDS = 300;

/** The real binary, when it is not on the PATH under the plain name. */
const BINARY_OVERRIDE = process.env.CODEX_BINARY_PATH?.trim();

/**
 * `SessionStatus` (the interface's vocabulary) -> the event taxonomy's `status`
 * (t98). Two vocabularies on purpose: the interface's is the minimum every
 * headless CLI expresses, the taxonomy's describes the outcome of the WORK.
 *
 * `cancelled` lands on `stuck` for want of anything better — the taxonomy has
 * no "cancelled". Recorded as-is from the first adapter's proof: the mismatch is
 * the runner's to decide, not this script's to paper over.
 */
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

/**
 * The adapter under proof, pointed at the real binary.
 *
 * When `CODEX_BINARY_PATH` is set, only the COMMAND changes — every argument
 * `buildCommand` produced goes through whole, and since t203 so does everything
 * it produced OFF the argv (`stdin`). It is the same discipline the conformance
 * test applies to the fake engine, and for the same reason: an override that
 * rewrote the command would be proving a different one from the one the adapter
 * actually issues — and dropping `stdin` here would prove a session whose large
 * prompt went nowhere at all.
 */
function buildAdapter() {
  if (!BINARY_OVERRIDE) return new CodexAdapter();
  return new CodexAdapter({
    commandBuilder: (spec) => ({ ...buildCommand(spec), command: BINARY_OVERRIDE }),
    environmentBuilder: (spec) => buildEnvironment(spec),
    probeCommandBuilder: () => ({ command: BINARY_OVERRIDE, args: ['--version'] }),
  });
}

/** A disposable git repository — the session's `workingDir`. */
function createDisposableRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-spike-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });

  git('init', '--quiet');
  git('config', 'user.email', 'spike@cartografo.local');
  git('config', 'user.name', 'Spike t119');
  writeFileSync(join(repo, 'README.md'), '# Repo descartável da prova manual da t119\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'inicial');
  return { root, repo };
}

function buildValidator() {
  // `allowUnionTypes` because the taxonomy uses a type union on purpose:
  // `entity.id` is an integer for `job`, `session`, `input_request` and
  // `lease`, and a string for `grafo_versao`, whose id is the snapshot hash
  // (D15). It is t98's decision, not schema sloppiness.
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  for (const name of ['envelope', 'session.opened', 'session.finished']) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), 'utf8')));
  }
  return (type, event) => {
    const valid = ajv.validate(`${type}.schema.json`, event);
    if (!valid) {
      die(
        `event ${type} does not validate against the schema:\n${ajv.errorsText(ajv.errors, { separator: '\n' })}`,
      );
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
    actor: { type: 'system', ref: 'runner/spike-t119' },
    occurred_at: new Date().toISOString(),
    data: payload,
  };
}

async function main() {
  const adapter = buildAdapter();
  if (BINARY_OVERRIDE) log(`binary under proof: ${BINARY_OVERRIDE}`);

  const probe = await adapter.verifyCli();
  log(`verifyCli: ${JSON.stringify(probe)}`);
  if (!probe.available) {
    die(
      'the `codex` CLI did not answer --version. Install it, or point ' +
        'CODEX_BINARY_PATH at a real binary (the t99 review used ' +
        '`npx --yes @openai/codex@latest`).',
    );
  }
  if (!probe.authenticated) {
    log('WARNING: authenticated=false. It is best effort, not a guarantee; going ahead anyway.');
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const instructions = manifest.instructions;
  if (typeof instructions !== 'string' || instructions.length === 0) {
    die(`the manifest ${MANIFEST} has no "instructions" field`);
  }
  log(`instructions: ${instructions.length} characters from the skill manifest "${manifest.id}"`);

  const { root, repo } = createDisposableRepo();
  log(`workingDir: ${repo}`);

  const prompt =
    `Crie no diretório atual um arquivo chamado ${REQUESTED_FILE} contendo exatamente ` +
    `uma linha com o texto: ${PHRASE}\n` +
    'Não faça mais nada além disso, e não commite.';

  const spec = {
    workingDir: repo,
    instructions,
    prompt,
    timeoutSeconds: TIMEOUT_SECONDS,
  };

  const transcript = [];
  let engineRef = null;
  let outcome = null;
  let resolveEnd;
  const end = new Promise((resolve) => {
    resolveEnd = resolve;
  });

  const startedAt = Date.now();
  const handle = await adapter.startSession(spec, {
    onOutput(line) {
      transcript.push(line);
      process.stdout.write(`  | ${line}\n`);
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
  log(`local handle of the adapter: ${handle}`);
  log(`getStatus right after the start: ${await adapter.getStatus(handle)}`);

  await end;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`onFinished: ${JSON.stringify(outcome)} in ${elapsed}s`);
  log(`getStatus after the end: ${await adapter.getStatus(handle)}`);

  const validate = buildValidator();

  // `session.opened` goes out with the ref the session has already revealed: the
  // `thread.started` frame is the first of the stream, so in practice it is
  // known well before the end.
  const opened = envelope(1, 'session.opened', {
    engine: adapter.engineName,
    engine_session_ref: engineRef,
    working_dir: repo,
    prompt,
    timeout_seconds: TIMEOUT_SECONDS,
    job_id: null,
    node_id: null,
  });
  validate('session.opened', opened);

  const finished = envelope(2, 'session.finished', {
    status: TAXONOMY_STATUS[outcome.status],
    exit_code: outcome.exitCode,
    // The v0 interface reports no token usage (out of scope), and null here is
    // "the engine reported nothing" — never collapse it into zero.
    usage: null,
  });
  validate('session.finished', finished);

  const jsonl = join(root, 'eventos.jsonl');
  writeFileSync(jsonl, `${JSON.stringify(opened)}\n${JSON.stringify(finished)}\n`);
  writeFileSync(join(root, 'transcript.txt'), `${transcript.join('\n')}\n`);

  // The hard proofs, in the order that matters.
  if (outcome.status !== 'completed') die(`the session ended as "${outcome.status}"`);
  if (outcome.exitCode !== 0) die(`exit code ${outcome.exitCode}`);
  if (transcript.length === 0) die('no line reached onOutput');
  if (engineRef === null) die('onEngineRef never fired — no thread_id was recognized in the stream');

  const produced = join(repo, REQUESTED_FILE);
  if (!existsSync(produced)) {
    die(`the session did not create ${REQUESTED_FILE} — it exited with 0 without working`);
  }
  const content = readFileSync(produced, 'utf8');
  if (!content.includes(PHRASE)) {
    die(`${REQUESTED_FILE} exists but does not carry the phrase asked for:\n${content}`);
  }

  console.log('\n===== evidence =====');
  console.log(`CLI:            ${probe.version}`);
  console.log(`engineName:     ${adapter.engineName}`);
  console.log(`engineRef:      ${engineRef}`);
  console.log(`outcome:        ${outcome.status} / exit ${outcome.exitCode} / ${elapsed}s`);
  console.log(`lines:          ${transcript.length}`);
  console.log(`${REQUESTED_FILE}: ${JSON.stringify(content.trim())}`);
  console.log(`events:         ${jsonl}`);
  console.log(`transcript:     ${join(root, 'transcript.txt')}`);
  console.log(`workdir:        ${repo}`);
  console.log('=====================\n');
  log('manual proof OK');
}

await main();
