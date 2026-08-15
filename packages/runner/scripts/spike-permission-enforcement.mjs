/**
 * Manual proof: the denied tools really are denied, by the real `claude` CLI.
 *
 * NOT a CI test, and it must not become one — same division of labour as
 * `spike-real-session.mjs`. The automated suite proves what the PROCESS
 * received (case C2's discipline: argv, not `SessionSpec`); only a real,
 * authenticated binary can prove what the CLI does with it, and that needs
 * network and credentials CI has neither of.
 *
 * What it demonstrates, in order:
 *
 * 1. a policy the adapter cannot express is refused before any process exists —
 *    `SessionStartError`, no pid, no output;
 * 2. a session with the network closed gets the flag in its argv AND is really
 *    stopped by the CLI when it tries to reach the network. The prompt asks for
 *    exactly one fetch and for the outcome to be written to a file, so the
 *    evidence is what the session itself reports having failed to do;
 * 3. a session with an empty write scope cannot create a file in its own
 *    workdir — the check is the filesystem, not the session's word for it.
 *
 * The residual gap is proven too, on purpose and as a WARNING rather than a
 * failure: the same closed-network session is asked to reach the network by a
 * path no denied pattern names. If it gets through, the run prints it. That is
 * the honest reading of "sandbox where the engine allows"
 * (`notas/2026-08-14-extensao-e-qualidade.md:43-44`), and a spike that hid it
 * would be selling isolation this adapter does not have.
 *
 * Usage: npm run spike:permissions --workspace @cartografo/runner
 */

import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCodeAdapter } from '../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../src/engine/command.ts';
import { SessionStartError } from '../src/engine/types.ts';

const TIMEOUT_SECONDS = 180;

/** The two policies the adapter refuses, and the field each one should name. */
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

/** Runs one session to the end and gives back everything it reported. */
async function run(adapter, spec) {
  const transcript = [];
  let outcome = null;
  let resolveEnd;
  const end = new Promise((resolve) => {
    resolveEnd = resolve;
  });

  await adapter.startSession(spec, {
    onOutput(line) {
      transcript.push(line);
      process.stdout.write(`  | ${line}\n`);
    },
    onFinished(status, exitCode) {
      outcome = { status, exitCode };
      resolveEnd();
    },
  });

  await end;
  return { transcript, outcome };
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
      'diretório atual:',
      '',
      '1. Use a ferramenta WebFetch para buscar https://example.com. Anote se conseguiu ou não.',
      '2. Rode `curl -sS -m 10 https://example.com` no shell. Anote se conseguiu ou não.',
      '3. Rode `node -e "fetch(\'https://example.com\').then(r => console.log(r.status))"`.',
      '   Anote se conseguiu ou não.',
      '',
      'Não tente contornar nenhuma recusa: o objetivo é medir o que é bloqueado.',
    ].join('\n'),
    timeoutSeconds: TIMEOUT_SECONDS,
    permissions: { filesystem: { write: ['**'] }, network: { allowed: false } },
  };

  const argv = buildCommand(networkSpec).args;
  log(`argv carries --disallowedTools: ${argv.includes('--disallowedTools')}`);
  log(`argv: ${JSON.stringify(argv.slice(0, argv.indexOf('--system-prompt')))}`);
  if (!argv.includes('--disallowedTools')) die('the closed-network policy produced no flag');

  const network = await run(adapter, networkSpec);
  log(`closed network: ${JSON.stringify(network.outcome)}`);
  const networkReport = join(networkDir, 'RESULTADO.md');
  const networkText = existsSync(networkReport) ? readFileSync(networkReport, 'utf8') : '';

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
  const wrote = existsSync(join(writeDir, 'PROVA-ESCRITA.md'));

  // --- the evidence ---------------------------------------------------------
  console.log('\n===== evidence =====');
  console.log(`CLI:              ${probe.version}`);
  console.log(`refused policies: ${REFUSED.length}/${REFUSED.length} rejected before the spawn`);
  console.log(`closed network:   ${JSON.stringify(network.outcome)}`);
  console.log(`RESULTADO.md:\n${networkText || '  <the session wrote nothing>'}`);
  console.log(`empty write:      ${JSON.stringify(write.outcome)}`);
  console.log(`file created:     ${wrote}`);
  console.log(`workdirs:         ${networkDir}\n                  ${writeDir}`);

  if (wrote) {
    die('the session with an empty write scope created a file anyway — the denied list did not hold');
  }
  console.log(
    '\nRead RESULTADO.md above: steps 1 and 2 have to be refusals. Step 3 is the residual\n' +
      'gap — if it got through, that is `Bash` reaching the network by a path no pattern\n' +
      'names, which is exactly the limit the specification writes down. Note it in the PR.',
  );
}

await main();
