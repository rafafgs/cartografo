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
 * ## `input.environment`, the third value with the same problem (t360)
 *
 * The interview (`factory-graphs/map-design`) has to ask which steps reach
 * outside and through which MCP server (RF-20), and it has to be able to
 * suggest a class this installation already knows (RF-14, D8). Both are the same
 * kind of fact as the two above — true of one machine and one installation, and
 * false the moment a graph version stores them — so they arrive through this
 * same seam, under `environment`. Neither is a bench, which is why the key is
 * its own rather than a third field of `banco_de_testes`.
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
 * ## A bench that cannot be read BLOCKS when git ran and refused — and only then
 *
 * A `git` that ran and refused fails for a reason that reproduces identically
 * on every retry — the path is not a repository, the branch does not exist, the
 * checkout was moved. That is exactly the class t252 exists to stop instead of
 * loop, so this module throws {@link ExecutorEnvironmentError} rather than
 * handing back a placeholder value, and `pre-session-failure.ts` classifies it
 * into a block with a reason an operator can act on. Resolving something
 * plausible instead would open a session that verified containment against a
 * commit nobody chose.
 *
 * A `git` that could not START is a different thing (issue #4): under memory
 * pressure a Windows host answered `rev-parse` with exit 3221225794 (0xC0000142)
 * and nothing on stderr, and minutes later the very same command worked. The
 * rule, recorded in {@link classifyGitFailure}: a git that ran and refused stays
 * permanent whatever its text says; only a git that could not start (a spawn
 * `ENOMEM`/`EAGAIN`/`EMFILE`/`ENFILE`, a signal kill, an NTSTATUS death with
 * no output) is retried through the bounded pre-session retry. The CODE decides,
 * never the message text — the rule t688 set for spawn failures.
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
import type { SkillSource, SkillSourceResult } from './resolve-skill-source.ts';

/**
 * How one `git` invocation failed — the facts the retry decision is made from.
 *
 * Kept apart from the printed text on purpose: `runGit` replaces an empty stderr
 * with `error.message`, so "git printed nothing" cannot be read back from
 * `.stderr` afterwards, and it is half of what tells an NTSTATUS death at start
 * from a refusal.
 */
export interface GitFailure {
  /** The numeric exit status; `null` when the process never produced one. */
  exitCode: number | null;
  /** The string `error.code` of a spawn failure (`ENOENT`, `ENOMEM`...), or `null`. */
  errno: string | null;
  /** `error.signal` when the process was killed by one, or `null`. */
  signal: string | null;
  /** True when git printed nothing on stderr. */
  stderrEmpty: boolean;
}

/** What a failure without detail means: nothing known, so nothing transient. */
const NO_FAILURE: GitFailure = Object.freeze({
  exitCode: null,
  errno: null,
  signal: null,
  stderrEmpty: false,
});

/** The part of `execFile`'s callback error this module reads. */
export interface GitExecError {
  code?: string | number | null;
  signal?: string | null;
  killed?: boolean;
}

/**
 * Maps what `execFile`'s callback handed back to a {@link GitFailure}.
 *
 * @param error The callback's error.
 * @param stderr What the process printed on stderr, BEFORE any substitution.
 */
export function toGitFailure(error: GitExecError, stderr: string): GitFailure {
  return {
    exitCode: typeof error.code === 'number' ? error.code : null,
    errno: typeof error.code === 'string' ? error.code : null,
    signal: typeof error.signal === 'string' && error.signal !== '' ? error.signal : null,
    stderrEmpty: stderr === '',
  };
}

/** Spawn errnos that mean "the machine could not start a process right now". */
const TRANSIENT_ERRNOS: ReadonlySet<string> = new Set(['ENOMEM', 'EAGAIN', 'EMFILE', 'ENFILE']);

/** The unsigned NTSTATUS error range, `0xC0000000..0xFFFFFFFF`. */
const NTSTATUS_ERROR_FLOOR = 0xc0000000;
const NTSTATUS_ERROR_CEILING = 0xffffffff;

/**
 * Says whether a git failure is worth retrying.
 *
 * A git that ran and refused stays permanent whatever its text says; only a git
 * that could not start is transient. The code decides, never the message text.
 * Precedence: errno first, then signal, then exit code — so `ENOENT` is
 * permanent even if a signal were somehow set.
 *
 * - transient: errno in `ENOMEM`/`EAGAIN`/`EMFILE`/`ENFILE`; any signal (git
 *   does not signal itself, so the kill came from outside — an OOM killer, a
 *   shutdown — and says nothing about the configuration); or an unsigned
 *   NTSTATUS exit (`0xC0000000..0xFFFFFFFF`) with nothing on stderr (0xC0000142
 *   is the loader failing under memory pressure).
 * - permanent: everything else — `ENOENT` and any other errno, any exit with
 *   stderr, exit 0 with empty stdout, and the all-null default.
 */
export function classifyGitFailure(failure: GitFailure): 'transient' | 'permanent' {
  if (failure.errno !== null) {
    return TRANSIENT_ERRNOS.has(failure.errno) ? 'transient' : 'permanent';
  }
  if (failure.signal !== null) return 'transient';
  if (
    failure.exitCode !== null &&
    failure.exitCode >= NTSTATUS_ERROR_FLOOR &&
    failure.exitCode <= NTSTATUS_ERROR_CEILING &&
    failure.stderrEmpty
  ) {
    return 'transient';
  }
  return 'permanent';
}

/**
 * Names what happened to git, for a message or a block reason.
 *
 * @returns `exit N`, `errno X`, `signal S`, or `''` when none of the three is set.
 */
export function describeGitFailure(failure: Pick<GitFailure, 'exitCode' | 'errno' | 'signal'>): string {
  if (failure.exitCode !== null) return `exit ${String(failure.exitCode)}`;
  if (failure.errno !== null) return `errno ${failure.errno}`;
  if (failure.signal !== null) return `signal ${failure.signal}`;
  return '';
}

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
  /** The numeric exit status, or `null` when the process never produced one. */
  readonly exitCode: number | null;
  /** The spawn errno (`ENOMEM`, `ENOENT`...), or `null`. */
  readonly errno: string | null;
  /** The signal that killed the process, or `null`. */
  readonly signal: string | null;
  /** True when git printed nothing on stderr, measured before any substitution. */
  readonly stderrEmpty: boolean;

  /**
   * @param summary What the runner was trying to read.
   * @param command The command, as issued.
   * @param stderr What it printed on stderr.
   * @param failure How it failed. Omitted, the error classifies as permanent —
   *   the only thing a caller that knows nothing about the cause may claim.
   */
  constructor(summary: string, command: string, stderr: string, failure: GitFailure = NO_FAILURE) {
    const detail = stderr.trim();
    const tag = describeGitFailure(failure);
    super(
      `${summary}: \`${command}\` failed — ${detail === '' ? '(no output)' : detail}` +
        (tag === '' ? '' : ` (${tag})`),
    );
    this.name = 'ExecutorEnvironmentError';
    this.command = command;
    this.stderr = detail;
    this.exitCode = failure.exitCode;
    this.errno = failure.errno;
    this.signal = failure.signal;
    this.stderrEmpty = failure.stderrEmpty;
  }
}

/** How the reference is read, in the vocabulary `implantar-release` declares. */
export type ReferenceMode = 'instalacao_em_uso' | 'ponta_do_principal';

/**
 * What this engine's MCP discovery answered, for the whole process (t360, FR4).
 *
 * A discriminated union and not `string[] | null`, for the reason
 * `engine/types.ts` gives the capability itself: an adapter that never
 * implemented discovery is NOT an engine with zero MCP servers, and a shape
 * that could only say "none" would make the two indistinguishable at the point
 * where they are handed to a session. The union survives all the way to
 * `environment.mcp_servers`, where `supported: false` becomes `null` and a
 * supported discovery becomes the list — the empty one included, which is a
 * real answer.
 */
export type McpDiscoveryResult =
  | { supported: false }
  | { supported: true; servers: readonly string[] };

/**
 * A registered class whose current version reads like this job (t360, FR4).
 *
 * Structurally the synthesizer's own `SimilarClass` (`synthesizer/prompt.ts`)
 * with English keys, and it is a separate declaration rather than an import for
 * one reason: those keys are the SYNTHESIS PROMPT's frozen vocabulary and are
 * Portuguese, while these are read by a manifest written after D24. The scoring
 * is not duplicated — `synthesizer/similarity.ts` is what computes it, from
 * `cli/run.ts`, and this is only the shape it arrives in.
 */
export interface SimilarClass {
  /** The class id, which is also the lineage id (D8). */
  class: string;
  /** `metadata.name` of its current version. */
  name: string;
  /** `metadata.description` of its current version; empty when it declares none. */
  description: string;
  /** Jaccard score in `[0, 1]`. */
  score: number;
}

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
  /**
   * Which MCP servers this runner's engine sees — `input.environment.mcp_servers`
   * (t360, FR4; RF-20).
   *
   * A plain VALUE and not a function, unlike {@link classPrecedents} below, and
   * the asymmetry is the whole point: MCP discovery costs one CLI spawn and its
   * answer cannot change inside a process, so `cli/run.ts` computes it once —
   * for the probe report t401 already sends — and hands the same answer here.
   * A resolver that discovered per dispatch would spend a spawn per session and
   * let the operator page and the interview describe the same machine
   * differently.
   *
   * Absent means the same as `{supported: false}`: a deployment that wired
   * nothing knows nothing, and saying so is the honest answer.
   */
  mcpDiscovery?: McpDiscoveryResult;
  /**
   * Registered classes that read like THIS job — `input.environment.similar_classes`
   * (t360, FR4; RF-14, D8).
   *
   * A FUNCTION, because the score is computed against the job's own title and
   * body: two jobs of the same runner get two different lists, and there is
   * nothing here to memoize. `cli/run.ts` builds it out of `GET /v1/classes`
   * and `synthesizer/similarity.ts`.
   *
   * Absent means an empty list, which is a real answer — "this installation has
   * no precedent to suggest" — and not a missing capability. The distinction
   * `mcp_servers` needs `null` for does not arise here: a control plane always
   * has a class listing, even an empty one.
   */
  classPrecedents?: (job: Job) => Promise<SimilarClass[]>;
  /**
   * What the person's own folder or repository of skills derived to —
   * `input.environment.skill_drafts` (t440, FR5; the RF-14 extension).
   *
   * A function of the SOURCE and not of the job, which is the third shape this
   * configuration carries and the only one that reads something a turn
   * REPORTED: the path or the URL lives in the projection's own
   * `input.interview.skill_source`, put there by an earlier session, which is
   * why the resolver below takes the projection as a third argument. What it
   * does with it is `resolve-skill-source.ts`'s subject — read a folder, or
   * clone a repository shallow and throw it away — and this module only decides
   * WHEN to ask and what an absent answer means.
   *
   * Absent means an empty list and a `null` error, the same real answer
   * {@link classPrecedents} has: a person who pointed at nothing is shown
   * nothing. It is never called for a job whose interview named no source, so a
   * runner wired with it reads and clones nothing until somebody asks for it.
   */
  resolveSkillSource?: (source: SkillSource) => Promise<SkillSourceResult>;
}

/** What `git rev-parse` answered. */
interface GitResult extends GitFailure {
  stdout: string;
  /** What it printed, or `error.message` when it printed nothing and failed. */
  stderr: string;
}

/**
 * Runs git in a repository and reports what happened, never throwing.
 *
 * The same shape `session-worktree.ts` uses, and for the same reason: a
 * non-zero exit is data, and deciding what it MEANS belongs to the caller that
 * knows which question it asked.
 *
 * @param repoRoot Repository the command runs against.
 * @param args The command, minus `git -C <repoRoot>`.
 * @returns Both streams and the {@link GitFailure} fields.
 */
function runGit(repoRoot: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, errno: null, signal: null, stderrEmpty: stderr === '', stdout, stderr });
        return;
      }
      // What happened to the process is kept as data (`toGitFailure`) BEFORE the
      // empty stderr is replaced by the error's message: afterwards, "git
      // printed nothing" can no longer be told from "git printed its message".
      resolve({
        ...toGitFailure(error, stderr),
        stdout,
        stderr: stderr === '' ? error.message : stderr,
      });
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

  if (answered.exitCode !== 0 || commit === '') {
    throw new ExecutorEnvironmentError(
      `the reference \`${revision}\` of the test bench could not be read`,
      describe(repoRoot, args),
      answered.stderr,
      {
        exitCode: answered.exitCode,
        errno: answered.errno,
        signal: answered.signal,
        stderrEmpty: answered.stderrEmpty,
      },
    );
  }

  return commit;
}

/**
 * Builds the dispatch's `executorEnvironment` out of one runner's configuration.
 *
 * The returned function takes the work, the resolved node and — since t440 —
 * the control plane's own projection of this node's input, which the merge
 * (`resolve-input.ts`) has just fetched. That third argument is what lets
 * `environment.skill_drafts` exist at all: the folder or URL it derives from is
 * a fact only a previous TURN knows, reported into `input.interview.skill_source`
 * and nowhere on the `Job` row. Fetching the same context route a second time
 * from in here would read one fact twice, and the two reads could disagree.
 *
 * Since t360 it also READS the job: `environment.similar_classes` is scored against this
 * job's own words, so it cannot be a fact about the process the way the bench
 * and the reference are. `environment.mcp_servers` still is one — it is
 * discovered once per runner and handed in as a value, not a resolver — and the
 * asymmetry between the two is stated field by field on
 * {@link ExecutorEnvironmentConfig}. The resolved node is still unread, and the
 * parameter stays for the reason it always did: the seam beside this one
 * (`resolveInput`) has it, and a second signature would be one more thing for
 * whoever wires a dispatch to get right.
 *
 * @param config The bench, the mode, the two optional overrides, and what this
 *   machine knows about MCP and about precedent classes.
 * @returns The function, with `instalacao_em_uso`'s single read memoized in it.
 */
export function createExecutorEnvironmentResolver(
  config: ExecutorEnvironmentConfig,
): (
  job: Job,
  resolved: ResolvedNode,
  projection: Record<string, unknown>,
) => Promise<Record<string, unknown>> {
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

  /**
   * What each job's named source derived to, resolved ONCE per source.
   *
   * `instalacao_em_uso`'s reasoning, applied to a different kind of fact: an
   * interview is twenty questions and twenty dispatches, and re-walking the
   * same folder — or re-cloning the same repository — on every one of them is
   * twenty reads of an answer that did not change. The promise is what is
   * cached, not its value, so two dispatches of the same job racing each other
   * still clone once.
   *
   * Keyed by job AND by the source itself: a person who corrects their answer
   * halfway through the interview names a different location, and a cache keyed
   * by job alone would keep showing them the folder they already said was the
   * wrong one. In the ordinary case — a source reported once and never changed —
   * this is exactly "memoized per job".
   *
   * In the closure and never module-level, for {@link installed}'s reason: two
   * of these functions are two runners, and a shared cache would answer one
   * runner's question with another runner's disk.
   */
  const derived = new Map<string, Promise<SkillSourceResult>>();

  /**
   * `skill_drafts` / `skill_drafts_error`, for whatever this turn's input says.
   *
   * The source is read out of the PROJECTION and not out of the job, because
   * that is the only place it exists: the interview reported it as a sibling of
   * its `done`/`draft`, and `contract.produces` merged it into the
   * `input.interview` bucket. A turn that named nothing — or a runner with no
   * hook wired — is an empty list and a `null` error, which is a real answer and
   * not a degraded one.
   */
  const skillDraftsOf = async (
    job: Job,
    projection: Record<string, unknown>,
  ): Promise<{ skill_drafts: Record<string, unknown>[]; skill_drafts_error: string | null }> => {
    const empty = { skill_drafts: [], skill_drafts_error: null };
    if (config.resolveSkillSource === undefined) return empty;

    const interview = projection.interview;
    if (typeof interview !== 'object' || interview === null) return empty;
    const reported = (interview as Record<string, unknown>).skill_source;
    if (typeof reported !== 'object' || reported === null) return empty;

    const { kind, location } = reported as Partial<SkillSource>;
    if ((kind !== 'path' && kind !== 'git') || typeof location !== 'string' || location === '') {
      // A report that named a source this module cannot read is the person's
      // own answer coming back to them, not a silent nothing: `additionalProperties`
      // let it through, so somebody has to say what is wrong with it.
      return {
        skill_drafts: [],
        skill_drafts_error: `the reported skill source is not a {kind, location}: ${JSON.stringify(reported)}`,
      };
    }

    const key = `${String(job.id)}:${kind}:${location}`;
    let answer = derived.get(key);
    if (answer === undefined) {
      answer = config.resolveSkillSource({ kind, location });
      derived.set(key, answer);
    }

    const { drafts, error } = await answer;
    return { skill_drafts: drafts, skill_drafts_error: error };
  };

  /**
   * The two machine facts the interview reads, in the shape it declares.
   *
   * `null` for `mcp_servers` is load-bearing and is argued at
   * {@link McpDiscoveryResult}: it means "this engine implements no discovery",
   * which a session has to be able to tell apart from "it found none".
   */
  const environmentOf = async (
    job: Job,
    projection: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => ({
    ...(await skillDraftsOf(job, projection)),
    mcp_servers:
      config.mcpDiscovery?.supported === true ? [...config.mcpDiscovery.servers] : null,
    // Sorted HERE and not only in whoever computed it: "best first" is what the
    // interview's instructions promise the session, so it is a property of this
    // key rather than a habit of one caller. Descending, and a tie keeps the
    // order it arrived in — `sort` is stable, and two classes that score the
    // same have nothing to break the tie with that would not be arbitrary.
    similar_classes:
      config.classPrecedents === undefined
        ? []
        : [...(await config.classPrecedents(job))].sort((a, b) => b.score - a.score),
  });

  return async (
    job: Job,
    _resolved: ResolvedNode,
    projection: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const reference =
      config.referenceMode === 'instalacao_em_uso'
        ? (installed ??= await read('HEAD'))
        : await read(mainBranch);

    return {
      // The one key of this seam that is not the bench's, and the one that is
      // English: `banco_de_testes`/`referencia` are the software bundle's frozen
      // manifest vocabulary, while `environment` is born after D24 (t360).
      environment: await environmentOf(job, projection),
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
