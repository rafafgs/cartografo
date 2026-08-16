/**
 * Manual proof: what the real `claude` CLI does with `--resume`.
 *
 * NOT a CI test, and it must not become one — same division of labour as
 * `spike-real-session.mjs` and `spike-permission-enforcement.mjs`. The
 * automated suite (C10) proves that the ref REACHES the process, which is all
 * a fake engine can ever prove; only a real, authenticated binary can prove
 * that the ref carries CONTEXT, and that needs network and credentials CI has
 * neither of.
 *
 * Two questions, and the second one is the reason this script exists at all:
 *
 * 1. **Does resume actually carry context?** Session A is told a marker that
 *    appears nowhere else. Session B asks for it back, with `resumeFrom` set to
 *    A's `engineRef` and the marker deliberately absent from its own prompt.
 *    Recall is measured on B's final `result` frame — a marker that only shows
 *    up in some replayed transcript line is echo, not memory.
 * 2. **Does it require the same `workingDir`?** The refinement of t173 read
 *    `dispatch/session-worktree.ts:16-26` and found that every dispatch mints a
 *    FRESH worktree per `acquire()`, so if the CLI keys its transcript by cwd,
 *    resume in production would silently find nothing. Session B therefore runs
 *    TWICE: once in A's directory, once in a directory A never saw.
 *
 * The second question has no expected answer, and this script deliberately does
 * not fail on either one. It reports. If resume turns out to ignore `cwd`, that
 * contradicts what the ficha assumed and belongs in the Refinement Log — not in
 * a silent change of code.
 *
 * Usage: npm run spike:resume --workspace @cartografo/runner
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCodeAdapter } from '../src/engine/claude-code-adapter.ts';
import { resolveCapabilities } from '../src/engine/types.ts';

const TIMEOUT_SECONDS = 180;

/**
 * The marker, minted per run.
 *
 * Random on purpose: a fixed string could be recalled from a transcript of a
 * previous run of this very script sitting in the same `~/.claude` history, and
 * the proof would be measuring the wrong memory.
 */
const MARKER = `MARCADOR-${randomUUID().slice(0, 8).toUpperCase()}`;

/** What the session answers when it does not have the earlier turn. */
const NO_CONTEXT = 'SEM-CONTEXTO';

const INSTRUCTIONS =
  'Você é um nó de teste do cartografo. Responda de forma curta e literal, ' +
  'sem explicações e sem usar ferramenta nenhuma.';

const log = (message) => console.log(`[spike] ${message}`);

function die(message) {
  console.error(`\n[spike] FAILED: ${message}\n`);
  process.exit(1);
}

/** A disposable directory — one session's `workingDir`. */
function createWorkdir(name) {
  const root = mkdtempSync(join(tmpdir(), `cartografo-t173-${name}-`));
  const workdir = join(root, 'workdir');
  mkdirSync(workdir);
  writeFileSync(join(workdir, 'LEIA.md'), '# Diretório descartável da prova manual da t173\n');
  return workdir;
}

/**
 * The text of the CLI's final `result` frame — what the session ANSWERED.
 *
 * Separated from the raw transcript on purpose: `--resume` may well replay
 * earlier messages into the stream, and a marker found in a replayed line
 * proves the CLI can read its own log, not that the session remembers.
 */
function resultText(transcript) {
  for (const line of transcript) {
    if (!line.trim().startsWith('{')) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame?.type === 'result' && typeof frame.result === 'string') return frame.result;
  }
  return null;
}

/** Runs one session to its end and collects everything the listener reported. */
async function runSession(adapter, label, spec) {
  const transcript = [];
  let engineRef = null;
  let outcome = null;
  let resolveEnd;
  const end = new Promise((resolve) => {
    resolveEnd = resolve;
  });

  log(`${label}: starting in ${spec.workingDir}${spec.resumeFrom ? ` (resumeFrom ${spec.resumeFrom})` : ''}`);
  const startedAt = Date.now();
  await adapter.startSession(spec, {
    onOutput(line) {
      transcript.push(line);
    },
    onEngineRef(ref) {
      engineRef = ref;
    },
    onFinished(status, exitCode) {
      outcome = { status, exitCode };
      resolveEnd();
    },
  });

  await end;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(
    `${label}: ${outcome.status} / exit ${outcome.exitCode} / ${elapsed}s / ` +
      `ref ${engineRef ?? '(none)'} / ${transcript.length} line(s)`,
  );
  return { transcript, engineRef, outcome, elapsed, answer: resultText(transcript) };
}

async function main() {
  const adapter = new ClaudeCodeAdapter();

  const probe = await adapter.verifyCli();
  log(`verifyCli: ${JSON.stringify(probe)}`);
  if (!probe.available) {
    die('the `claude` CLI did not answer --version — install it before running the proof');
  }
  if (!probe.authenticated) {
    log('WARNING: authenticated=false. It is best effort, not a guarantee; going ahead anyway.');
  }

  const capabilities = resolveCapabilities(adapter.capabilities());
  log(`capabilities: ${JSON.stringify(capabilities)}`);
  if (!capabilities.hasResume) die('the adapter does not declare hasResume — nothing to prove');

  const original = createWorkdir('a');
  const elsewhere = createWorkdir('b');

  // Session A: the only place the marker is ever spoken.
  const first = await runSession(adapter, 'session A', {
    workingDir: original,
    instructions: INSTRUCTIONS,
    prompt:
      `Guarde este marcador para o próximo turno: ${MARKER}. ` +
      'Responda apenas com a palavra: guardado.',
    timeoutSeconds: TIMEOUT_SECONDS,
  });

  if (first.outcome.status !== 'completed') die(`session A ended as "${first.outcome.status}"`);
  if (first.engineRef === null) die('onEngineRef never fired for session A — there is no ref to resume from');

  // The question, asked without ever naming the answer.
  const question =
    'Qual foi o marcador que eu pedi para você guardar no turno anterior? ' +
    `Responda apenas com o marcador, sem mais nada. Se você não tem esse turno ` +
    `no seu contexto, responda exatamente: ${NO_CONTEXT}`;

  if (question.includes(MARKER)) die('the question leaks the marker — the proof would be measuring itself');

  const sameDir = await runSession(adapter, 'session B (same workingDir)', {
    workingDir: original,
    instructions: INSTRUCTIONS,
    prompt: question,
    timeoutSeconds: TIMEOUT_SECONDS,
    resumeFrom: first.engineRef,
  });

  const otherDir = await runSession(adapter, 'session B (different workingDir)', {
    workingDir: elsewhere,
    instructions: INSTRUCTIONS,
    prompt: question,
    timeoutSeconds: TIMEOUT_SECONDS,
    resumeFrom: first.engineRef,
  });

  const verdict = (run) => ({
    status: run.outcome.status,
    exitCode: run.outcome.exitCode,
    engineRef: run.engineRef,
    sameRefAsA: run.engineRef === first.engineRef,
    answer: run.answer,
    recalledInAnswer: typeof run.answer === 'string' && run.answer.includes(MARKER),
    markerAnywhereInTranscript: run.transcript.some((line) => line.includes(MARKER)),
  });

  const inOriginal = verdict(sameDir);
  const inElsewhere = verdict(otherDir);

  console.log('\n===== evidence =====');
  console.log(`CLI:                 ${probe.version}`);
  console.log(`marker:              ${MARKER}`);
  console.log(`session A ref:       ${first.engineRef}`);
  console.log(`same workingDir:     ${JSON.stringify(inOriginal, null, 2)}`);
  console.log(`different workingDir:${JSON.stringify(inElsewhere, null, 2)}`);
  console.log(`workdir A:           ${original}`);
  console.log(`workdir B:           ${elsewhere}`);

  console.log('\n===== finding =====');
  console.log(
    inOriginal.recalledInAnswer
      ? 'resume CARRIES context: session B answered with a marker it was never told.'
      : 'resume did NOT carry context in the same workingDir — the ficha assumed it would.',
  );
  console.log(
    inElsewhere.recalledInAnswer
      ? 'resume does NOT require the same workingDir: the ref alone was enough.'
      : 'resume REQUIRES the same workingDir: the same ref, elsewhere, recalled nothing.',
  );

  // The one hard failure. The `workingDir` half is a question, not a claim, and
  // failing on it would be demanding an answer this ficha never had.
  if (!inOriginal.recalledInAnswer) {
    die('session B, in the same workingDir, did not recall the marker — resume carried no context');
  }
}

await main();
