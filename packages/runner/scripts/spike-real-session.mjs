/**
 * Manual proof: a real session, with the real `claude` CLI.
 *
 * NOT a CI test, and it must not become one. The suite runs against the fake
 * engine precisely so it does not depend on an installed binary, credentials or
 * network (`docs/formatos/engine-adapter.md:363-366`); this proof is the manual
 * gate on the other side — the half the kit cannot prove because it has no real
 * CLI. Same division the flowpilot's `make spike` set up: evidence attached to
 * the ticket, not an automatic gate.
 *
 * What it demonstrates, end to end:
 *
 * 1. `verifyCli()` finds the real CLI and reports the version.
 * 2. A session runs in a disposable git repository, with `instructions` coming
 *    from the existing "fazer" skill manifest
 *    (`especificacoes/formatos/exemplos/manifesto-skill.develop.json`). It is
 *    the closest stand-in for "skill coming from the database" available today:
 *    the database is t101/t102 and does not exist yet.
 * 3. The session actually WORKED — the file the prompt asked for is in the
 *    workdir. Without that, "it exited with 0" proves nothing.
 * 4. The listener's callbacks are projected into `sessao.aberta` and
 *    `sessao.finalizada` conforming to the taxonomy (t98) and validated with
 *    ajv against the real schemas.
 *
 * The JSONL is a local evidence artifact, not a table: the adapter does not
 * write to a database (D1 — the listener is the only output, and whoever called
 * decides what to persist).
 *
 * Usage: npm run spike --workspace @cartografo/runner
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import AjvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';

import { ClaudeCodeAdapter } from '../src/engine/claude-code-adapter.ts';

const Ajv2020 = AjvModule.default ?? AjvModule;
const addFormats = formatsModule.default ?? formatsModule;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCHEMAS_DIR = join(REPO_ROOT, 'especificacoes/eventos/schemas');
const MANIFEST = join(REPO_ROOT, 'especificacoes/formatos/exemplos/manifesto-skill.develop.json');

const REQUESTED_FILE = 'PROVA-T104.md';
const PHRASE = 'sessao real do EngineAdapter do Claude Code';
const TIMEOUT_SECONDS = 300;

/**
 * `SessionStatus` (the interface's vocabulary) -> the event taxonomy's `status`
 * (t98). Two vocabularies on purpose: the interface's is the minimum every
 * headless CLI expresses, the taxonomy's describes the outcome of the WORK.
 *
 * `cancelled` lands on `travada` for want of anything better — the taxonomy has
 * no "cancelled". The description of `travada` is "a stop of ours", which does
 * the job, but the match is not exact and is worth recording before the runner
 * (t103) has to decide it alone.
 */
const TAXONOMY_STATUS = {
  completed: 'concluida',
  failed: 'falhou',
  timed_out: 'tempo_esgotado',
  cancelled: 'travada',
};

const log = (message) => console.log(`[spike] ${message}`);

function die(message) {
  console.error(`\n[spike] FAILED: ${message}\n`);
  process.exit(1);
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
  git('config', 'user.name', 'Spike t104');
  writeFileSync(join(repo, 'README.md'), '# Repo descartável da prova manual da t104\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'inicial');
  return { root, repo };
}

function buildValidator() {
  // `allowUnionTypes` because the taxonomy uses a type union on purpose:
  // `entidade.id` is an integer for `trabalho`, `sessao`, `pergunta` and
  // `lease`, and a string for `grafo_versao`, whose id is the snapshot hash
  // (D15). It is t98's
  // decision, not schema sloppiness — and changing another ticket's schema is
  // out of scope.
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  for (const name of ['envelope', 'sessao.aberta', 'sessao.finalizada']) {
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
    tipo: type,
    projeto_id: 3,
    execucao_id: null,
    entidade: { tipo: 'sessao', id: 1 },
    ator: { tipo: 'sistema', ref: 'runner/spike-t104' },
    ocorrido_em: new Date().toISOString(),
    dados: payload,
  };
}

async function main() {
  const adapter = new ClaudeCodeAdapter();

  const probe = await adapter.verifyCli();
  log(`verifyCli: ${JSON.stringify(probe)}`);
  if (!probe.available) die('the `claude` CLI did not answer --version — install it before running the proof');
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

  // `sessao.aberta` goes out with the ref the session has already revealed: the
  // init frame is the first of the stream, so in practice it is known well
  // before the end.
  const opened = envelope(1, 'sessao.aberta', {
    engine: adapter.engineName,
    engine_session_ref: engineRef,
    working_dir: repo,
    prompt,
    timeout_seconds: TIMEOUT_SECONDS,
    trabalho_id: null,
    no_id: null,
  });
  validate('sessao.aberta', opened);

  const finished = envelope(2, 'sessao.finalizada', {
    status: TAXONOMY_STATUS[outcome.status],
    exit_code: outcome.exitCode,
    // The v0 interface reports no token usage (out of scope), and null here is
    // "the engine reported nothing" — never collapse it into zero.
    uso: null,
  });
  validate('sessao.finalizada', finished);

  const jsonl = join(root, 'eventos.jsonl');
  writeFileSync(jsonl, `${JSON.stringify(opened)}\n${JSON.stringify(finished)}\n`);
  writeFileSync(join(root, 'transcript.txt'), `${transcript.join('\n')}\n`);

  // The hard proofs, in the order that matters.
  if (outcome.status !== 'completed') die(`the session ended as "${outcome.status}"`);
  if (outcome.exitCode !== 0) die(`exit code ${outcome.exitCode}`);
  if (transcript.length === 0) die('no line reached onOutput');
  if (engineRef === null) die('onEngineRef never fired — no session_id was recognized in the stream');

  const produced = join(repo, REQUESTED_FILE);
  if (!existsSync(produced)) die(`the session did not create ${REQUESTED_FILE} — it exited with 0 without working`);
  const content = readFileSync(produced, 'utf8');
  if (!content.includes(PHRASE)) die(`${REQUESTED_FILE} exists but does not carry the phrase asked for:\n${content}`);

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
