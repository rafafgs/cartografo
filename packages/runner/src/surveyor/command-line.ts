/**
 * The surveyor command's command line (t146).
 *
 * Everything the manual command knows about how it is invoked: the usage text,
 * how argv and the environment become a run, the HTTP client that run needs,
 * and the one message that tells whoever typed it what to do about a refusal.
 * `cli.mjs` is left with what genuinely needs a process — the engine, the
 * scratch directory, stdout and the exit code — for the reason
 * `src/synthesizer/synthesize.ts` records: what a test can reach without
 * spawning a process is what stays covered.
 *
 * It exists because of a hole t124 left. That ficha closed every `/v1` route
 * behind a bearer token and taught the `cartografo` CLI and the cost lens to
 * present one; this command, which reads three of those routes and writes to a
 * fourth, was built with no token and had no flag or variable to supply one. It
 * was not degraded, it was denied — every invocation, with `GET … respondeu
 * 401` as its whole explanation.
 *
 * Precedence is `--token` > `CARTOGRAFO_TOKEN` > nothing, which is the rule
 * `packages/core/src/cli/url.ts` and `packages/topografo-custo/src/cli.ts`
 * already use. A third rule for a third command would be a third thing to
 * remember, and the person running all three is the same person.
 *
 * Nothing anywhere sends NO header, and that is deliberate: the client
 * documents it (`cliente-controle.ts`), and an empty `Authorization` would read
 * as a credential in the server's log instead of as the absence of one.
 */

import { ClienteControle } from '../controller/cliente-controle.ts';

/** Control plane the command talks to when the invocation names none. */
export const DEFAULT_URL = 'http://127.0.0.1:4317';

/** Environment variable that carries the credential, as everywhere else. */
export const ENV_TOKEN = 'CARTOGRAFO_TOKEN';

/** Usage text. Printed on stderr whenever the command line is refused. */
export const USAGE = `usage: npm run surveyor --workspace @cartografo/runner -- \\
  <execucao_id> [url] [dir] [--token <token>]

  execucao_id   the run to read, an integer (required)
  url           control plane to read it from (default: ${DEFAULT_URL})
  dir           working directory of the session (default: a temporary one)
  --token       control plane credential (env ${ENV_TOKEN}); it is printed on
                the readiness line of the control plane's first startup`;

/** What a run of the command needs to know. */
export interface SurveyorRunOptions {
  /** Opaque grouper of the run to read. */
  executionId: number;
  /** Base URL of the control plane. */
  url: string;
  /** Where the session runs; absent means "make a temporary one". */
  workingDir?: string;
  /** Credential to present; absent means no header at all. */
  token?: string;
}

/** Either the command line is runnable, or it is refused with a reason. */
export type ParsedCommand =
  | { kind: 'usage'; message: string }
  | { kind: 'run'; options: SurveyorRunOptions };

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
 * Reads the argv of the surveyor command.
 *
 * Hand-rolled rather than `parseArgs` from `node:util`, like the synthesizer's,
 * because the three arguments that matter are positional and the flag has to be
 * accepted anywhere among them: whoever adds `--token` to a command they have
 * been typing for weeks adds it at the end.
 *
 * @param argv Arguments after the script name.
 * @param env Environment to read {@link ENV_TOKEN} from.
 * @returns A refusal with its message, or the run and its options.
 */
export function parseArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedCommand {
  const positional: string[] = [];
  let flagged: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--token') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) return refuse('--token needs a value');
      flagged = next;
      index += 1;
      continue;
    }
    if (current.startsWith('--token=')) {
      const inline = current.slice('--token='.length);
      if (inline === '') return refuse('--token needs a value');
      flagged = inline;
      continue;
    }
    if (current.startsWith('--')) {
      return refuse(`the surveyor does not understand ${current}`);
    }
    positional.push(current);
  }

  const [rawId, url, workingDir, ...extra] = positional;
  if (extra.length > 0) {
    return refuse(`the surveyor does not understand: ${extra.map((one) => `"${one}"`).join(', ')}`);
  }

  const executionId = Number(rawId);
  if (rawId === undefined || !Number.isInteger(executionId)) {
    return refuse(`execucao_id has to be an integer (got: ${JSON.stringify(rawId)})`);
  }

  const token = usableToken(flagged) ?? usableToken(env[ENV_TOKEN]);

  return {
    kind: 'run',
    options: {
      executionId,
      url: url ?? DEFAULT_URL,
      ...(workingDir === undefined ? {} : { workingDir }),
      ...(token === undefined ? {} : { token }),
    },
  };
}

/**
 * The HTTP client this run speaks through — the process's only door out.
 *
 * @param options What the command line resolved to.
 * @param doFetch `fetch` implementation. Default: the global one. Test seam.
 * @returns The client, already carrying the credential when there is one.
 */
export function createClient(options: SurveyorRunOptions, doFetch?: typeof fetch): ClienteControle {
  return new ClienteControle({
    urlBase: options.url,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(doFetch === undefined ? {} : { buscar: doFetch }),
  });
}

/**
 * Whether a failure is the control plane refusing the credential.
 *
 * Structural and not an `instanceof`: the check has to survive the error
 * arriving from a module instance this one did not import.
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
