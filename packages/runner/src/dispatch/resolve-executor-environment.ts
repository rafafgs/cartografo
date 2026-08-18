/**
 * What only the machine running the session knows (t270 Half B).
 *
 * The software factory bundle asks its last two nodes for four values, and
 * until this ficha not one of them had a source. Two turned out to be STATIC —
 * `arquivos_de_registro` (fixed by t259) and `aplicacao` — and static
 * configuration of a class belongs in the graph's own `project`, versioned with
 * the document like everything else about the class. The other two are not
 * configuration at all:
 *
 * - **`banco_de_testes.caminho`** is a filesystem path. It names a directory on
 *   ONE machine, and the machine that has it is the one running the session.
 * - **`referencia.commit`** is a live commit. It moves under the reader.
 *
 * Neither can live in the control plane's database (D1). A path written into a
 * graph version would be versioned graph data pretending to be a machine fact,
 * and would be wrong for every runner but one; a commit stored anywhere at all
 * would be stale by the time somebody read it. So they come from HERE, from the
 * process that is about to open the session, and are merged into the resolved
 * input right before the manifest renders (`dispatch.ts`).
 *
 * ## The two modes, and why one is memoized and the other is not
 *
 * `implantar-release`'s own manifest already writes the distinction down, and
 * this module is only obeying it:
 *
 * - **`instalacao_em_uso`** — "the commit the running process was started from,
 *   read once at startup and never again, because it is an assertion about THIS
 *   process, and re-reading it later would assert something about a process that
 *   no longer exists." So it is read on the first call and memoized in the
 *   closure, for the life of the returned function — the life of the runner.
 * - **`ponta_do_principal`** — "the live tip of the main line, read at every
 *   verification, because it is a fact about the repository and it advances with
 *   every integration." So it is read on every call, with nothing cached.
 *
 * ## A bench that cannot be read BLOCKS, it does not resolve
 *
 * A `git` that fails here fails for a reason that reproduces identically on
 * every retry — the path is not a repository, the branch does not exist, the
 * checkout was moved. That is exactly the class t252 exists to stop instead of
 * loop, so this module throws {@link ExecutorEnvironmentError} rather than
 * handing back a placeholder value, and `pre-session-failure.ts` classifies it
 * into a block with a reason an operator can act on. Resolving something
 * plausible instead would open a session that verified containment against a
 * commit nobody chose.
 *
 * **Read-only, always.** Nothing here writes to the bench, advances a branch or
 * prepares a checkout: `git rev-parse` and nothing else. Keeping the bench true
 * — advancing `main` into it, provisioning it at all — is t273's, and this
 * module only reads a path and a commit it assumes already exist.
 *
 * English per D18; the keys it produces are the skill manifest format's, which
 * is why `banco_de_testes` and `referencia` are Portuguese.
 */

import { execFile } from 'node:child_process';

import type { Job } from './options.ts';
import type { ResolvedNode } from './resolve-node.ts';

/**
 * The reference could not be read off the bench.
 *
 * Same shape as `session-worktree.ts`'s `WorktreeError`, deliberately: both are
 * a `git` invocation that did not do what the runner needed, and whoever reads
 * either one wants the command as it was issued plus what it printed. The
 * message is English, like every other `Error.message` in this package; the
 * text a PERSON reads is the block reason `pre-session-failure.ts` writes.
 */
export class ExecutorEnvironmentError extends Error {
  /** The command that failed, as it was issued. */
  readonly command: string;
  /** What it printed on stderr, trimmed. */
  readonly stderr: string;

  constructor(summary: string, command: string, stderr: string) {
    const detail = stderr.trim();
    super(`${summary}: \`${command}\` failed — ${detail === '' ? '(no output)' : detail}`);
    this.name = 'ExecutorEnvironmentError';
    this.command = command;
    this.stderr = detail;
  }
}

/** How the reference is read, in the vocabulary `implantar-release` declares. */
export type ReferenceMode = 'instalacao_em_uso' | 'ponta_do_principal';

/**
 * What a dispatch with no bench configured contributes: nothing.
 *
 * The honest default, and it lives here rather than inside `dispatch.ts` so the
 * orchestrator states the merge and this module states what an absent one
 * means. `{}` is not a degraded answer — a bets runner has no test bench, and
 * neither does any deployment that has not set one up, and both behave exactly
 * as they did before this seam existed.
 */
export const NO_EXECUTOR_ENVIRONMENT = (): Promise<Record<string, unknown>> =>
  Promise.resolve({});

/** Everything one runner process needs to know about its own bench. */
export interface ExecutorEnvironmentConfig {
  /**
   * The checkout the sessions observe — `input.banco_de_testes.caminho`.
   *
   * A point of observation and not a work area: the manifest tells the session
   * it has no write permission there, and nothing in this module writes either.
   */
  testBenchPath: string;
  /** Which of the two questions `referencia.commit` answers. */
  referenceMode: ReferenceMode;
  /**
   * The repository the reference is read from. Default: {@link testBenchPath}.
   *
   * Separable because they can honestly differ — a bench checked out from a
   * mirror, a reference read from the repository the installation was built
   * from — and defaulted because in the ordinary deployment they are the same
   * directory, and a second required path is a second thing to get wrong.
   */
  referenceRepo?: string;
  /** The branch `ponta_do_principal` reads. Default: `main`. */
  mainBranch?: string;
}

/** What `git rev-parse` answered. */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Exit code reported when `git` itself could not be executed. */
const SPAWN_FAILURE = -1;

/**
 * Runs git in a repository and reports what happened, never throwing.
 *
 * The same shape `session-worktree.ts` uses, and for the same reason: a
 * non-zero exit is data, and deciding what it MEANS belongs to the caller that
 * knows which question it asked.
 *
 * @param repoRoot Repository the command runs against.
 * @param args The command, minus `git -C <repoRoot>`.
 * @returns Exit code and both streams.
 */
function runGit(repoRoot: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      // A process that exited non-zero reports a numeric `code`; a `git` that
      // could not be spawned at all reports a string one (`ENOENT`) and says
      // what happened only in its message.
      const code = typeof error.code === 'number' ? error.code : SPAWN_FAILURE;
      resolve({ code, stdout, stderr: stderr === '' ? error.message : stderr });
    });
  });
}

/** The command, as a human would have typed it, for the error message. */
function describe(repoRoot: string, args: readonly string[]): string {
  return ['git', '-C', repoRoot, ...args].join(' ');
}

/**
 * Reads one commit off the repository, or refuses.
 *
 * @param repoRoot Repository to ask.
 * @param revision What to resolve — `HEAD`, or the main branch's name.
 * @returns The full sha.
 * @throws {ExecutorEnvironmentError} git refused, or could not be run at all.
 */
async function readCommit(repoRoot: string, revision: string): Promise<string> {
  const args = ['rev-parse', revision];
  const answered = await runGit(repoRoot, args);
  const commit = answered.stdout.trim();

  if (answered.code !== 0 || commit === '') {
    throw new ExecutorEnvironmentError(
      `the reference \`${revision}\` of the test bench could not be read`,
      describe(repoRoot, args),
      answered.stderr,
    );
  }

  return commit;
}

/**
 * Builds the dispatch's `executorEnvironment` out of one runner's configuration.
 *
 * The returned function takes the work and the resolved node and reads neither,
 * today: the environment is a fact about the PROCESS, identical for every job
 * this runner takes. The two parameters are there because the seam beside it
 * (`resolveInput`) has them and a second signature would be one more thing for
 * whoever wires a dispatch to get right — and because a bench chosen per class
 * is a plausible next ficha that would need exactly them.
 *
 * @param config The bench, the mode, and the two optional overrides.
 * @returns The function, with `instalacao_em_uso`'s single read memoized in it.
 */
export function createExecutorEnvironmentResolver(
  config: ExecutorEnvironmentConfig,
): (job: Job, resolved: ResolvedNode) => Promise<Record<string, unknown>> {
  const referenceRepo = config.referenceRepo ?? config.testBenchPath;
  const mainBranch = config.mainBranch ?? 'main';

  /**
   * The commit this PROCESS was started from, and WHEN that was read.
   *
   * The whole of `instalacao_em_uso`'s memoization, and it lives in the closure
   * rather than in a module-level cache on purpose: two of these functions are
   * two configurations, and a cache shared between them would answer one
   * runner's question with another runner's bench.
   *
   * `lido_em` is memoized with the commit and not stamped fresh per call. The
   * field says when the reference was READ, and for this mode that moment is
   * the startup — restamping it would claim a freshness the value does not
   * have, which is the one thing the mode exists to be honest about.
   */
  let installed: { commit: string; lido_em: string } | null = null;

  /** One reading of the reference, with the instant it happened. */
  const read = async (revision: string): Promise<{ commit: string; lido_em: string }> => ({
    commit: await readCommit(referenceRepo, revision),
    lido_em: new Date().toISOString(),
  });

  return async (): Promise<Record<string, unknown>> => {
    const reference =
      config.referenceMode === 'instalacao_em_uso'
        ? (installed ??= await read('HEAD'))
        : await read(mainBranch);

    return {
      banco_de_testes: {
        caminho: config.testBenchPath,
        // Declared, and empty, because `testar-alpha`'s body interpolates it:
        // an absent key fails the dispatch closed, and a list nobody filled is
        // the honest answer for a deployment that has no data-preparation
        // commands. What would fill it is bench provisioning, which is t273's —
        // and a configuration knob nobody can set yet is dead capability.
        comandos_de_dados: [] as string[],
      },
      referencia: { ...reference, modo: config.referenceMode },
    };
  };
}
