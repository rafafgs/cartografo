/**
 * The intake command's command line (t144, FR5).
 *
 * Everything the manual command knows about how it is invoked: the help text,
 * how argv and the environment become a run, the two doors that run needs, and
 * the one message that tells whoever typed it what to do about a refusal.
 * `cli.mjs` is left with what genuinely needs a process — the engine, the scratch
 * directory, stdout and the exit code — for the reason
 * `src/synthesizer/synthesize.ts` records: what a test can reach without spawning
 * a process is what stays covered.
 *
 * The credential is wired in from the first commit, and that is a scar and not a
 * precaution. t146 exists because the surveyor shipped without one: t124 had
 * closed every `/v1` route behind a bearer token, and a command that reads three
 * routes and writes to a fourth had no flag and no variable to supply one. It was
 * not degraded, it was denied — every invocation, with `GET … respondeu 401` as
 * its whole explanation.
 *
 * Precedence is `--token` > `CARTOGRAFO_TOKEN` > nothing, which is the rule
 * `packages/core/src/cli/url.ts`, `packages/cost-surveyor/src/cli.ts`, the flow
 * surveyor and the synthesizer already use. A fifth rule for a fifth command
 * would be a fifth thing to remember, and the person running all of them is one
 * person.
 *
 * Nothing anywhere sends NO header, and that is deliberate: an empty
 * `Authorization` would read as a credential in the server's log instead of as
 * the absence of one (`controller/control-plane-client.ts`).
 *
 * English per D18; the flags a person types (`--class`, `--dir`) and the payload
 * keys stay as they are published.
 */

import { ControlPlaneClient } from '../controller/control-plane-client.ts';
import type { ClassReader } from './generate.ts';

/** Control plane the command talks to when the invocation names none. */
export const DEFAULT_URL = 'http://127.0.0.1:4317';

/** Environment variable that carries the credential, as everywhere else. */
export const ENV_TOKEN = 'CARTOGRAFO_TOKEN';

/** Exit code for a command that was typed wrong, kept apart from a run that failed. */
export const USAGE_EXIT_CODE = 2;

/**
 * Project this command scopes the class-exists check and the draft to, when
 * `--project` is left out.
 *
 * The same `1` every other part of the system falls back to. Redeclared here
 * rather than imported from `@cartografo/core`, the same reasoning
 * `cli/run.ts`'s own `DEFAULT_PROJECT` records: the runner imports nothing
 * from the control plane's package (D1), and the price of that boundary is a
 * constant in two places.
 */
const DEFAULT_PROJECT = 1;

/** Flags this command understands. Anything else is a typo, and is refused. */
const KNOWN_FLAGS = ['class', 'url', 'dir', 'token', 'project'];

/** The whole flow, in the shape `--help` prints it. */
export const HELP = [
  'intake — turns a request in plain language into a draft breakdown for you to',
  'confirm (t122, t144).',
  '',
  'Usage:',
  '  npm run intake --workspace @cartografo/runner -- \\',
  '    "<request>" --class <name> [options]',
  '',
  'Arguments:',
  '  <request>           required, positional: what you want, in your own words.',
  '  --class <name>      required: the registered class whose graph the tickets',
  '                      will cross. It has to exist already; this command never',
  '                      creates one.',
  '',
  'Options:',
  `  --url <url>         control plane (default ${DEFAULT_URL}).`,
  `  --project <id>      project to scope the class check and the draft to`,
  `                      (default ${String(DEFAULT_PROJECT)}).`,
  '  --dir <path>        working directory of the session (default: a temporary',
  '                      one).',
  `  --token <token>     control plane credential (env ${ENV_TOKEN}); it is`,
  '                      printed on the readiness line of the control plane the',
  '                      first time it starts. With no credential at all, every',
  '                      call here answers 401.',
  '  --help              this help.',
  '',
  'What the command does:',
  '',
  '  1. reads GET /v1/classes. If the class is not registered, it refuses and',
  '     exits 1, before opening any session;',
  '  2. opens ONE agent session, which writes the breakdown to a file;',
  '  3. posts it to POST /v1/intake and prints the id of the draft.',
  '',
  'What the command does NOT do:',
  '',
  '  - confirm the draft. It lands as `pending`, no ticket exists yet, and the',
  '    confirmation is the human gate:',
  '',
  '      POST /v1/intake/<id>/confirmations',
  '',
  '  - anything to the graph. Confirming creates travellers, never a version.',
  '',
  'Until you confirm, the draft is yours to edit (PATCH /v1/intake/<id>) or to',
  'throw away (POST /v1/intake/<id>/discards).',
].join('\n');

/** What a run of the command needs to know. */
export interface IntakeRunOptions {
  /** The request in natural language, exactly as it was typed. */
  request: string;
  /** The registered class the batch will run over. */
  className: string;
  /** Project to scope the class-exists check and the draft to. Always resolved. */
  projectId: number;
  /** Base URL of the control plane. */
  url: string;
  /** Where the session runs; absent means "make a temporary one". */
  workingDir?: string;
  /** Credential to present; absent means no header at all. */
  token?: string;
}

/** What `parseArguments` understood. */
export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'usage'; message: string }
  | { kind: 'run'; options: IntakeRunOptions };

/** A refusal, in the shape the entry point prints. */
function refuse(message: string): ParsedCommand {
  return { kind: 'usage', message };
}

/** Trims a candidate token and turns the blank ones into "none presented". */
function usableToken(candidate: string | undefined): string | undefined {
  const trimmed = candidate?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Reads the argv of the intake command.
 *
 * Hand-rolled rather than `parseArgs` from `node:util`, like the synthesizer's,
 * for one reason: the request is positional and free text, and a parser that
 * treats an unknown leading token as an error would refuse the only argument
 * that matters.
 *
 * @param argv Arguments after the script name.
 * @param env Environment to read {@link ENV_TOKEN} from. Injectable so a test
 *   never depends on whoever ran it having exported a credential.
 * @returns What to do: help, a refusal with its message, or a run.
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
    if (!KNOWN_FLAGS.includes(name)) return refuse(`the intake command does not understand --${name}`);

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return refuse(`option --${name} needs a value`);
    flags.set(name, value);
    index += 1;
  }

  const request = positional[0];
  if (request === undefined || request.trim() === '') {
    return refuse('the request is missing (first argument)');
  }
  if (positional.length > 1) {
    return refuse(`the request is ONE argument; got ${positional.length} (quotes around it?)`);
  }

  const className = flags.get('class');
  if (className === undefined || className.trim() === '') {
    return refuse('--class is required: intake breaks work down over a class already registered');
  }

  const projectRaw = flags.get('project');
  let projectId = DEFAULT_PROJECT;
  if (projectRaw !== undefined) {
    const parsed = Number(projectRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return refuse(`--project has to be a positive integer (got: "${projectRaw}")`);
    }
    projectId = parsed;
  }

  const workingDir = flags.get('dir');
  const token = usableToken(flags.get('token')) ?? usableToken(env[ENV_TOKEN]);

  return {
    kind: 'run',
    options: {
      request,
      className: className.trim(),
      projectId,
      url: flags.get('url') ?? DEFAULT_URL,
      ...(workingDir === undefined ? {} : { workingDir }),
      ...(token === undefined ? {} : { token }),
    },
  };
}

/**
 * The read-only door of this run: which classes are registered, for the
 * resolved project.
 *
 * Its own `ControlPlaneClient.getClasses` (t421), not the synthesizer's
 * reader (`../synthesizer/control-plane-client.ts`): that one calls
 * `GET /v1/classes` with no query at all, which the server silently resolves
 * against project 1 regardless of `--project`. `createClient` already builds
 * the client this run's write door needs; handing it the read too is simpler
 * than keeping two clients open on the same credential.
 *
 * @param options What the command line resolved to.
 * @param doFetch `fetch` implementation. Default: the global one. Test seam.
 * @returns A reader, scoped to `options.projectId` and already carrying the
 *   credential when there is one.
 */
export function createReader(options: IntakeRunOptions, doFetch?: typeof fetch): ClassReader {
  const client = createClient(options, doFetch);
  return {
    fetchClasses: async () => await client.getClasses(options.projectId),
  };
}

/**
 * The write door: the one `POST /v1/intake` this command makes.
 *
 * @param options What the command line resolved to.
 * @param doFetch `fetch` implementation. Default: the global one. Test seam.
 * @returns The client, already carrying the credential when there is one.
 */
export function createClient(options: IntakeRunOptions, doFetch?: typeof fetch): ControlPlaneClient {
  return new ControlPlaneClient({
    urlBase: options.url,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(doFetch === undefined ? {} : { fetchImpl: doFetch }),
  });
}

/**
 * Whether a failure is the control plane refusing the credential.
 *
 * Structural and not an `instanceof`: this command talks through two different
 * doors, which raise two different error classes, and the check has to survive
 * both — as well as one arriving from a module instance this one did not import.
 *
 * @param error Anything thrown while talking to the control plane.
 * @returns `true` when it is a 401.
 */
export function isDenied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 401
  );
}

/**
 * The credential-refused message, in the voice `cartografo` already uses.
 *
 * It says what to DO, because `GET /v1/… respondeu 401` describes the server's
 * state to somebody asking about their own — and this command has exactly one
 * remedy to offer.
 *
 * @param url Address that refused.
 * @returns A single line for stderr.
 */
export function deniedMessage(url: string): string {
  return (
    `the control plane at ${url} refused the credential (401) — set ${ENV_TOKEN} or pass ` +
    '--token with the token printed when the control plane started'
  );
}
