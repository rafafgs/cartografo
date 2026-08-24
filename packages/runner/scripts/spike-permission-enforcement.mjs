/**
 * Manual proof: what the real `claude` CLI does with the denied list.
 *
 * NOT a CI test, and it must not become one — same division of labour as
 * `spike-real-session.mjs`. The automated suite proves what the PROCESS
 * received (case C2's discipline: argv, not `SessionSpec`); only a real,
 * authenticated binary can prove what the CLI does with it, and that needs
 * network and credentials CI has neither of.
 *
 * What it proves hard, and fails on:
 *
 * 1. a policy the adapter cannot express is refused before any process exists —
 *    `SessionStartError`, no pid, no output;
 * 2. **no denied tool is ever invoked.** A tool in `--disallowedTools` is not
 *    offered to the model at all, so it never shows up in a `tool_use` frame.
 *    That is the check, and it is measured on the frames — not on the session
 *    saying it could not.
 * 3. a denied `Bash` pattern really is refused by the CLI, and
 *    `PermissionDenialTracker` recognizes the refusal ON THE REAL FRAMES. The
 *    unit tests feed the tracker a fixture; this feeds it the engine.
 *
 * And what it reports as a WARNING, because it is the documented limit and not
 * a defect: `Bash` reaching the network or the disk by a path no denied pattern
 * names. Gating by tool name is best-effort in what the engine offers ("sandbox
 * where the engine allows", `notas/2026-08-14-extension-and-quality.md:43-44`),
 * never process isolation — a spike that failed here would be demanding a
 * guarantee the specification explicitly does not make, and one that hid it
 * would be selling that guarantee.
 *
 * Usage: npm run spike:permissions --workspace @cartografo/runner
 */

import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PermissionDenialTracker } from '../src/dispatch/parse-permission-denial.ts';
import { ClaudeCodeAdapter } from '../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../src/engine/command.ts';
import { resolvePermissions } from '../src/engine/permission-policy.ts';
import { SessionStartError } from '../src/engine/types.ts';

const TIMEOUT_SECONDS = 180;

/** The two policies the adapter refuses. */
const REFUSED = [
  {
    label: 'network scoped by domain',
    permissions: {
      filesystem: { write: ['**'] },
      network: { allowed: true, domains: ['api.anthropic.com'] },
    },
  },
  {
    label: 'write scope narrower than the workspace',
    permissions: { filesystem: { write: ['src/**'] }, network: { allowed: false } },
  },
];

const log = (message) => console.log(`[spike] ${message}`);
const warn = (message) => console.log(`[spike] WARNING: ${message}`);

function die(message) {
  console.error(`\n[spike] FAILED: ${message}\n`);
  process.exit(1);
}

/** A disposable directory — the session's `workingDir`. */
function createWorkdir(name) {
  const root = mkdtempSync(join(tmpdir(), `cartografo-t125-${name}-`));
  const workdir = join(root, 'workdir');
  mkdirSync(workdir);
  writeFileSync(join(workdir, 'LEIA.md'), '# Diretório descartável da prova manual da t125\n');
  return workdir;
}

/** Every tool the session actually invoked, as the frames report it. */
function toolsInvoked(transcript) {
  const names = new Set();
  for (const line of transcript) {
    if (!line.trim().startsWith('{')) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    const content = frame?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') names.add(block.name);
    }
  }
  return names;
}

/** Runs one session to the end and gives back everything it reported. */
async function run(adapter, spec) {
  const tracker = new PermissionDenialTracker(resolvePermissions(spec.permissions).deniedTools);
  const transcript = [];
  const denials = [];
  let outcome = null;
  let resolveEnd;
  const end = new Promise((resolve) => {
    resolveEnd = resolve;
  });

  await adapter.startSession(spec, {
    onOutput(line) {
      transcript.push(line);
      denials.push(...tracker.observe(line));
      process.stdout.write(`  | ${line.slice(0, 240)}\n`);
    },
    onFinished(status, exitCode) {
      outcome = { status, exitCode };
      resolveEnd();
    },
  });

  await end;
  return { transcript, denials, outcome, invoked: toolsInvoked(transcript) };
}

/** The denied entries that are bare tool names — the ones never to be invoked. */
function bareNames(permissions) {
  return resolvePermissions(permissions).deniedTools.filter((entry) => !entry.includes('('));
}

async function main() {
  const adapter = new ClaudeCodeAdapter();

  const probe = await adapter.verifyCli();
  log(`verifyCli: ${JSON.stringify(probe)}`);
  if (!probe.available) {
    die('the `claude` CLI did not answer --version — install it before running the proof');
  }
  if (!probe.authenticated) {
    warn('authenticated=false. It is best effort, not a guarantee; going ahead anyway.');
  }

  // --- 1. what the adapter refuses ------------------------------------------
  for (const refused of REFUSED) {
    const workdir = createWorkdir('refused');
    let raised = null;
    try {
      await adapter.startSession(
        {
          workingDir: workdir,
          instructions: 'Você é a prova manual da t125.',
          prompt: 'Não faça nada.',
          timeoutSeconds: TIMEOUT_SECONDS,
          permissions: refused.permissions,
        },
        { onOutput() {}, onFinished() {} },
      );
    } catch (error) {
      raised = error;
    }

    if (raised === null) die(`${refused.label}: the session came up and should not have`);
    if (!(raised instanceof SessionStartError)) {
      die(`${refused.label}: raised ${raised?.constructor?.name}, expected SessionStartError`);
    }
    log(`refused (${refused.label}): ${raised.message}`);
  }

  // --- 2. closed network ----------------------------------------------------
  const networkDir = createWorkdir('network');
  const networkSpec = {
    workingDir: networkDir,
    instructions:
      'Você é a prova manual da t125 do cartografo. Faça exatamente o que o prompt pede e ' +
      'relate o que aconteceu, inclusive falhas — relatar a falha É o trabalho.',
    prompt: [
      'Faça, nesta ordem, e escreva o resultado de cada passo no arquivo RESULTADO.md do',
      'diretório em que você está (o diretório atual, não invente outro caminho):',
      '',
      '1. Tente usar a ferramenta WebFetch para buscar https://example.com. Anote o que houve.',
      '2. Rode `curl -sS -m 10 https://example.com` no shell. Anote o que houve.',
      '3. Rode `node -e "fetch(\'https://example.com\').then(r => console.log(r.status))"`.',
      '   Anote o que houve.',
      '',
      'Não tente contornar nenhuma recusa: o objetivo é medir o que é bloqueado.',
    ].join('\n'),
    timeoutSeconds: TIMEOUT_SECONDS,
    permissions: { filesystem: { write: ['**'] }, network: { allowed: false } },
  };

  const argv = buildCommand(networkSpec).args;
  if (!argv.includes('--disallowedTools')) die('the closed-network policy produced no flag');
  if (argv.includes('--add-dir')) die('invariant 7: the argv carries --add-dir');
  log(`argv: ${JSON.stringify(argv.slice(0, argv.indexOf('--system-prompt')))}`);

  const network = await run(adapter, networkSpec);
  log(`closed network: ${JSON.stringify(network.outcome)}`);

  // --- 3. empty write scope -------------------------------------------------
  const writeDir = createWorkdir('write');
  const writeSpec = {
    workingDir: writeDir,
    instructions: 'Você é a prova manual da t125 do cartografo.',
    prompt:
      'Crie no diretório atual um arquivo chamado PROVA-ESCRITA.md com uma linha qualquer. ' +
      'Se não conseguir, diga por quê e pare — não tente outro caminho.',
    timeoutSeconds: TIMEOUT_SECONDS,
    permissions: { filesystem: { write: [] }, network: { allowed: true } },
  };

  const write = await run(adapter, writeSpec);
  log(`empty write scope: ${JSON.stringify(write.outcome)}`);

  // --- the evidence ---------------------------------------------------------
  const networkReport = join(networkDir, 'RESULTADO.md');
  const networkText = existsSync(networkReport) ? readFileSync(networkReport, 'utf8') : '';
  const wroteFile = existsSync(join(writeDir, 'PROVA-ESCRITA.md'));

  console.log('\n===== evidence =====');
  console.log(`CLI:              ${probe.version}`);
  console.log(`refused policies: ${REFUSED.length}/${REFUSED.length} rejected before the spawn`);
  console.log(`closed network:   ${JSON.stringify(network.outcome)}`);
  console.log(`  tools invoked:  ${[...network.invoked].join(', ') || '<none>'}`);
  console.log(`  denials seen:   ${JSON.stringify(network.denials)}`);
  console.log(`empty write:      ${JSON.stringify(write.outcome)}`);
  console.log(`  tools invoked:  ${[...write.invoked].join(', ') || '<none>'}`);
  console.log(`  denials seen:   ${JSON.stringify(write.denials)}`);
  console.log(`  file created:   ${wroteFile}`);
  console.log(`RESULTADO.md:\n${networkText || '  <the session wrote nothing>'}`);

  // --- the hard checks ------------------------------------------------------
  for (const [label, session, permissions] of [
    ['closed network', network, networkSpec.permissions],
    ['empty write', write, writeSpec.permissions],
  ]) {
    for (const name of bareNames(permissions)) {
      if (session.invoked.has(name)) {
        die(`${label}: the session invoked ${name}, which --disallowedTools should have removed`);
      }
    }
  }

  if (network.denials.length === 0) {
    die(
      'the closed-network session produced no denial the tracker could see — either the CLI ' +
        'stopped refusing `Bash(curl *)` by name, or the frame shape changed (t125, FR6)',
    );
  }

  // --- and the documented limit, as a warning -------------------------------
  if (wroteFile) {
    warn(
      'the session with an empty write scope created the file anyway, through `Bash`. This is ' +
        'the residual gap the specification writes down, not a regression — `Edit`/`Write` were ' +
        'gone (checked above), and closing this needs an OS sandbox, which is another ticket.',
    );
  }
  console.log(
    '\nRead RESULTADO.md above: step 1 (WebFetch) has to be "the tool does not exist" and step 2\n' +
      '(curl) a refusal. Step 3 is the residual gap — if `node -e "fetch(...)"` got through, that\n' +
      'is `Bash` reaching the network by a path no pattern names. Note both in the PR.',
  );
}

await main();
