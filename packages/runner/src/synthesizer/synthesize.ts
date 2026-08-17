/**
 * One synthesis run: declare the problem, get a graph back, stop at the draft
 * (t115, FR2–FR9).
 *
 * This is the last piece of the MVP order (D6) and the most restrained one on
 * purpose. D10 makes the synthesizer a COPILOT: it proposes, the human edits,
 * and the human's edit is the entire gate. Everything this module does not do is
 * therefore as much of the design as what it does:
 *
 * - **it registers nothing.** No `POST /v1/graphs` here and no client method for
 *   one. The draft becomes a class when a person runs `cartografo import`
 *   (t108) on the file they edited — the same command that already runs the
 *   structure and soundness gate. Writing a second validator here would give the
 *   person two verdicts to reconcile and duplicate `domain/graph.ts`;
 * - **it names no class.** D8 puts that in the user's hands; `--class` is
 *   required, and the similar classes this module computes are printed as
 *   suggestions with no power to change anything;
 * - **it never writes a partial draft.** A session that fails, times out or
 *   comes back without a usable block leaves the directory exactly as it found
 *   it. A half-written draft is worse than none: it looks like something a human
 *   could edit.
 *
 * The order of operations is a decision too. The class check (FR2) comes first,
 * before the catalogue and before the session, because a class that already has
 * a base lineage is the proposal flow (D13, t118) and finding that out after
 * burning a session is finding it out too late.
 *
 * English per D18, and since t180 that includes everything this command PRINTS.
 * What stays Portuguese is the surface a person types or a machine matches: the
 * flags (`--class`, `--out`), the error codes that echo the API's own
 * vocabulary (`class_already_registered`) and the draft file name.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { decodeClaudeCodeSessionText } from '../dispatch/session-text.ts';
import type { EngineAdapter, SessionSpec, SessionStatus } from '../engine/types.ts';
import type { ControlPlaneReader, RegisteredSkill } from './control-plane-client.ts';
import { parseGraphProposal, type GraphProposal } from './parse-graph-proposal.ts';
import { SYNTHESIS_INSTRUCTIONS, buildSynthesisPrompt, type SimilarClass } from './prompt.ts';
import { similarity } from './similarity.ts';

/** Default base URL of the control plane — the same one the runner uses. */
export const DEFAULT_URL = 'http://127.0.0.1:4317';

/** Wall-clock limit of the synthesis session, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 900;

/**
 * How many precedents ride along in the prompt.
 *
 * Three, mirroring the precedent base's own top (t113). The cut is not about
 * cost: a suggestion list long enough to include weak matches teaches the
 * session that everything resembles everything, which is the same failure the
 * 3-character token floor exists to avoid one layer down.
 */
export const SUGGESTION_LIMIT = 3;

/** Suffix of the draft file. It says out loud that this is not registered. */
export const DRAFT_SUFFIX = '.grafo.rascunho.json';

/** Exit code for a command that was typed wrong, kept apart from a run that failed. */
export const USAGE_EXIT_CODE = 2;

/** What one run needs. Everything injectable is injectable for the suite. */
export interface SynthesisOptions {
  /** The problem, in the user's own words. */
  declaration: string;
  /** The class the user named (D8). */
  className: string;
  /** The read-only door to the control plane. */
  client: ControlPlaneReader;
  /** The engine. Production passes `ClaudeCodeAdapter`; tests pass the fake. */
  adapter: EngineAdapter;
  /** Directory the session runs in. Nothing is written there by us. */
  workingDir: string;
  /** Where the draft goes; default `<class>.grafo.rascunho.json` under `cwd`. */
  outputPath?: string;
  /** Base for the default draft path. Default: the process's directory. */
  cwd?: string;
  /** Wall-clock limit of the session. Default: 15 minutes. */
  timeoutSeconds?: number;
  /** Opaque additions to the engine's environment; the seam the fake is driven by. */
  envOverrides?: Readonly<Record<string, string>>;
  /** Where normal output goes. Default: stdout. */
  write?: (text: string) => void;
  /** Where failures go. Default: stderr. */
  writeError?: (text: string) => void;
}

/** What `parseArguments` understood. */
export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'usage'; message: string }
  | {
      kind: 'run';
      options: {
        declaration: string;
        className: string;
        url: string;
        outputPath?: string;
        timeoutSeconds: number;
        /** Credential to present; absent means no header at all (t148). */
        token?: string;
      };
    };

/** Environment variable that carries the credential, as everywhere else. */
export const ENV_TOKEN = 'CARTOGRAFO_TOKEN';

/**
 * Where the draft lands.
 *
 * `--out` wins whole, resolved against the working directory so a relative
 * path means what the person typing it meant. Without it, the class names the
 * file: a directory with three drafts in it should say which is which.
 *
 * @param className The class the user named.
 * @param outputPath What `--out` carried, if anything.
 * @param cwd Base for both branches. Default: the process's directory.
 * @returns An absolute path.
 */
export function resolveOutputPath(
  className: string,
  outputPath?: string,
  cwd: string = process.cwd(),
): string {
  if (outputPath !== undefined) return path.resolve(cwd, outputPath);
  return path.join(cwd, `${className}${DRAFT_SUFFIX}`);
}

/** The whole flow, in the shape `--help` prints it. */
export const HELP = [
  'synthesize — proposes a graph for a new class, for you to edit (D10).',
  '',
  'Usage:',
  '  npm run synthesize --workspace @cartografo/runner -- \\',
  '    "<problem declaration>" --class <name> [options]',
  '',
  'Arguments:',
  '  <declaration>       required, positional: the problem in natural language.',
  '  --class <name>      required: the name of the class. Naming it is yours to',
  '                      do (D8) — this command never invents a name.',
  '',
  'Options:',
  `  --url <url>         control plane (default ${DEFAULT_URL}).`,
  '  --out <path>        where to write the draft (default',
  `                      <class>${DRAFT_SUFFIX} in the current directory).`,
  `  --timeout <sec>     limit of the session (default ${DEFAULT_TIMEOUT_SECONDS}).`,
  `  --token <token>     control plane credential (env ${ENV_TOKEN}); it is`,
  '                      printed on the readiness line of the control plane the',
  '                      first time it starts. With no credential at all, every',
  '                      read here answers 401.',
  '  --help              this help.',
  '',
  'What the command does:',
  '',
  '  1. reads GET /v1/classes. If the class already has a base graph, it refuses',
  '     and exits 1: extending an existing lineage is the proposal flow, not',
  '     synthesis.',
  '  2. scores the declaration against the registered classes and prints the',
  `     ${SUGGESTION_LIMIT} closest ones — a suggestion, never a decision.`,
  '  3. reads GET /v1/skills and assembles the catalogue of capabilities.',
  '  4. opens ONE agent session, which gives back a graph document.',
  '  5. writes that document as a DRAFT and stops there.',
  '',
  'What the command does NOT do, and you have to do by hand afterwards:',
  '',
  '  - edit the draft. Your edit is the whole gate (D10);',
  '  - register the graph:',
  '',
  '      cartografo import <file>',
  '',
  '    that is what runs the structure and soundness gate and creates the base',
  '    lineage. Until you run it, none of this exists for the control plane.',
].join('\n');

/**
 * Reads the argv of `synthesize`.
 *
 * Hand-rolled rather than `parseArgs` from `node:util` for one reason: the
 * declaration is positional and free text, and a parser that treats an unknown
 * leading token as an error would refuse the only argument that matters.
 *
 * Precedence of the credential is `--token` > {@link ENV_TOKEN} > nothing,
 * which is the rule `packages/core/src/cli/url.ts`, `topografo-custo` and the
 * flow surveyor already use. A fourth rule for a fourth command would be a
 * fourth thing to remember, and the person running all of them is one person.
 *
 * @param argv Arguments after the script name.
 * @param env Environment to read {@link ENV_TOKEN} from. Injectable so a test
 *   never depends on whoever ran it having exported a credential.
 * @returns What to do: help, a usage refusal with its message, or a run.
 */
export function parseArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedCommand {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };

  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { kind: 'usage', message: `option --${name} needs a value` };
    }
    flags.set(name, value);
    index += 1;
  }

  const declaration = positional[0];
  if (declaration === undefined || declaration.trim() === '') {
    return { kind: 'usage', message: 'the problem declaration is missing (first argument)' };
  }
  if (positional.length > 1) {
    return {
      kind: 'usage',
      message: `the declaration is ONE argument; got ${positional.length} (quotes around it?)`,
    };
  }

  const className = flags.get('class');
  if (className === undefined || className.trim() === '') {
    return {
      kind: 'usage',
      message: '--class is required: you name the class, not the synthesizer (D8)',
    };
  }

  const rawTimeout = flags.get('timeout');
  const timeoutSeconds = rawTimeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(rawTimeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return { kind: 'usage', message: `--timeout has to be a number of seconds: ${rawTimeout}` };
  }

  const outputPath = flags.get('out');
  // A blank token is "none presented", not a credential: the whole point of
  // sending no header is that the 401 says what it means.
  const token = [flags.get('token'), env[ENV_TOKEN]]
    .map((candidate) => candidate?.trim())
    .find((candidate) => candidate !== undefined && candidate !== '');

  return {
    kind: 'run',
    options: {
      declaration,
      className: className.trim(),
      url: flags.get('url') ?? DEFAULT_URL,
      ...(outputPath === undefined ? {} : { outputPath }),
      timeoutSeconds,
      ...(token === undefined ? {} : { token }),
    },
  };
}

/**
 * The precedents: registered classes whose current version reads like the
 * declaration (FR3).
 *
 * The signal is `metadata.name` + `metadata.description` of the current version,
 * never the class id on its own — an id like `nota-curta` is two tokens, and two
 * tokens against a sentence produce a score that says nothing. A class with no
 * current version, or whose version cannot be read, is skipped in silence: this
 * is a non-blocking suggestion, and failing the whole command over a precedent
 * would let context break the thing it was meant to help.
 *
 * @param declaration The problem, in the user's own words.
 * @param client The read-only door.
 * @returns Up to {@link SUGGESTION_LIMIT} classes scoring above zero, best first.
 */
async function rankPrecedents(
  declaration: string,
  client: ControlPlaneReader,
  classes: readonly { class: string; current_version_id: string | null }[],
): Promise<SimilarClass[]> {
  const scored: SimilarClass[] = [];

  for (const entry of classes) {
    if (entry.current_version_id === null) continue;

    let metadata;
    try {
      const version = await client.fetchClassVersion(entry.current_version_id);
      metadata = version.snapshot.metadata ?? {};
    } catch {
      continue;
    }

    // `nome`/`descricao` stay spelled in Portuguese as KEYS — they are the
    // frozen wire format of `metadata` — while the locals they land in are
    // English like the rest of the code written from D18 onward.
    const name = typeof metadata.name === 'string' ? metadata.name : '';
    const description = typeof metadata.description === 'string' ? metadata.description : '';
    const score = similarity(declaration, `${name} ${description}`);
    if (score > 0) scored.push({ classe: entry.class, nome: name, descricao: description, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, SUGGESTION_LIMIT);
}

/** What the session reported when it ended. */
interface Outcome {
  status: SessionStatus;
  exitCode: number | null;
  output: string;
}

/**
 * Opens exactly one session and returns everything it printed.
 *
 * Only the raw output comes back, deliberately. Deciding what the output means
 * is {@link parseGraphProposal}'s job, and keeping the two apart is what lets
 * the failure path (FR7) print the stream a person needs in order to see why
 * the session came back empty.
 */
async function runSession(
  options: SynthesisOptions,
  skills: readonly RegisteredSkill[],
  precedents: readonly SimilarClass[],
): Promise<Outcome> {
  const spec: SessionSpec = {
    workingDir: options.workingDir,
    instructions: SYNTHESIS_INSTRUCTIONS,
    prompt: buildSynthesisPrompt(options.declaration, options.className, precedents, skills),
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    ...(options.envOverrides === undefined ? {} : { envOverrides: options.envOverrides }),
  };

  const lines: string[] = [];
  let finish: (outcome: { status: SessionStatus; exitCode: number | null }) => void = () => undefined;
  const finished = new Promise<{ status: SessionStatus; exitCode: number | null }>((resolve) => {
    finish = resolve;
  });

  await options.adapter.startSession(spec, {
    onOutput(line) {
      lines.push(line);
    },
    onFinished(status, exitCode) {
      finish({ status, exitCode });
    },
  });

  const { status, exitCode } = await finished;
  // Decoded, never joined raw (t148). `onOutput` hands over exactly what the
  // engine printed, and a real Claude Code session prints one `stream-json`
  // frame per line — so the block's own quotes arrive as `\"` and its newlines
  // as `\n`, and the fence scanner downstream matches neither. It cost every
  // real run of this command an exit 1 while every fake-engine test, which
  // prints prose, stayed green.
  //
  // The decoder is the ONE t141 published per engine (`dispatch/session-text.ts`),
  // not a copy: this command opens a Claude Code session itself, so it picks the
  // Claude Code decoder directly instead of routing on a node's declared engine
  // the way the dispatcher does. The day the synthesizer accepts a second engine,
  // it routes the same way the dispatcher already does.
  return { status, exitCode, output: decodeClaudeCodeSessionText(lines) };
}

/**
 * Runs one synthesis, from the declaration to the draft on disk.
 *
 * @param options Declaration, class, control plane, engine and where to write.
 * @returns The process exit code: `0` when a draft was written, `1` otherwise.
 *   Nothing is ever written on a non-zero return.
 */
export async function runSynthesis(options: SynthesisOptions): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const writeError = options.writeError ?? ((text: string) => process.stderr.write(text));

  // FR2 — the refusal comes BEFORE the catalogue and before any session.
  const classes = await options.client.fetchClasses();
  if (classes.some((entry) => entry.class === options.className)) {
    writeError(
      `synthesize: class_already_registered — class "${options.className}" already has a base graph.\n` +
        '  A new version over an existing lineage is the proposal flow (D13), not synthesis.\n',
    );
    return 1;
  }

  const precedents = await rankPrecedents(options.declaration, options.client, classes);
  for (const item of precedents) {
    write(`synthesize: similar class — ${item.classe} (${item.score.toFixed(2)}) ${item.nome}\n`);
  }

  const skills = await options.client.fetchSkills();
  write(`synthesize: ${skills.length} skill(s) in the registry; opening the synthesis session\n`);

  const outcome = await runSession(options, skills, precedents);
  const document: GraphProposal | null =
    outcome.status === 'completed' ? parseGraphProposal(outcome.output) : null;

  // FR7 — one exit for both failures, because the person's next move is the
  // same either way: read what the session actually said.
  if (document === null) {
    writeError(
      `synthesize: the session ended as "${outcome.status}" (exit ${String(outcome.exitCode)}) ` +
        `with no valid \`grafo-proposto\` block; nothing was written.\n`,
    );
    writeError('----- raw session output -----\n');
    writeError(outcome.output === '' ? '(the session printed nothing)\n' : `${outcome.output}\n`);
    writeError('---------------------------------\n');
    return 1;
  }

  const target = resolveOutputPath(options.className, options.outputPath, options.cwd);
  // Two spaces, because the next thing that happens to this file is a person
  // opening it in an editor (D10).
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const nodes = Array.isArray(document.nodes) ? document.nodes.length : 0;
  const edges = Array.isArray(document.edges) ? document.edges.length : 0;
  const suggestion =
    precedents.length === 0
      ? 'no similar class'
      : `similar: ${precedents.map((item) => item.classe).join(', ')}`;

  write(`${target}\n`);
  write(`synthesize: ${nodes} node(s), ${edges} edge(s), ${suggestion}\n`);
  write(`synthesize: edit the draft and register it with \`cartografo import ${target}\`\n`);
  return 0;
}
