/**
 * The watcher's command: `cartografo-surveyor` (t247, FR1).
 *
 * One subcommand, `watch`. It opens the finished-round stream and runs both
 * surveyor lenses over every round that ends, unattended, until somebody stops
 * it:
 *
 * ```
 * cartografo-surveyor watch --url http://127.0.0.1:4317 --token <token>
 * ```
 *
 * What it deliberately does NOT do, and none of it is an oversight:
 *
 * - **it applies nothing.** Neither lens has an apply call and neither does
 *   this: a proposal reaches `pending` and waits for a person (README,
 *   principle 5). D21 turned the PROPOSING unattended and nothing else.
 * - **it starts itself nowhere.** No startup script, no service file, no CI
 *   job — running this is a decision of its own, and it is the founder's
 *   (D21). What this command is, is the thing that decision would start.
 * - **it remembers nothing between runs.** Killed and started again, it picks
 *   the stream up at the present (`docs/spec/events-stream.md` §5) and misses
 *   whatever fired while it was down. What it does NOT do is duplicate: two
 *   runs over the same round meet t246's deduplication at the control plane.
 *
 * Exit codes, in the same convention as `cost-surveyor` and the `cartografo`
 * CLI (`packages/core/src/cli/index.ts`):
 *
 * - `0` — it ran and was stopped;
 * - `1` — it could not run: the stream refused the credential or the filter,
 *   which is configuration and does not improve with a retry;
 * - `2` — the command line is wrong.
 */

import { runWatch, LENS_SELECTIONS, type LensSelection } from './watch.ts';
import { StreamDeniedError } from './stream.ts';

/**
 * Usage text. The same on `--help` (stdout) and on a usage error (stderr).
 *
 * English from the first line, and with nothing to migrate: `watch`, `--lens`
 * and `--dry-run` were never spelled any other way, so `docs/spec/glossary-wire.md`
 * gains no row for this command (D20).
 */
export const USAGE = `usage: cartografo-surveyor watch --url <url> --token <token> [options]

subcommands:
  watch                  subscribes to the finished-execution stream and runs
                         the two surveyor lenses over every execution that
                         ends. It never applies a proposal.

options:
  --url <url>            control plane to watch (required)
  --token <token>        control plane credential (required); it is printed the
                         first time the control plane starts
  --lens <flow|cost|all> which lens to run per execution (default: all)
  --dry-run              report what each lens would run, and run neither
  -h, --help             this text

The flow lens spends one real agent session per execution; the cost lens spends
none. Neither applies anything: a proposal is born pending and stays there until
somebody approves it.`;

/** The command line is wrong. Exits 2, as in `cost-surveyor`. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** What can be injected into a run of the command. All of it for tests only. */
export interface CliContext {
  doFetch?: typeof fetch;
  write?: (text: string) => void;
  log?: (text: string) => void;
  signal?: AbortSignal;
}

/** What `watch` was asked to do. */
export interface WatchArguments {
  url: string;
  token: string;
  lens: LensSelection;
  dryRun: boolean;
}

/** What is left of the command line after taking one option out. */
interface Extraction {
  value?: string;
  rest: string[];
}

/**
 * Takes an option with a value (`--name value` or `--name=value`) out of the list.
 *
 * The same reader `cost-surveyor` uses, and for the same reason: a command
 * that refuses what it did not consume needs to know what is left.
 *
 * @param args Arguments of the subcommand.
 * @param name Long name of the option, with the two dashes.
 * @returns The value, when present, and the list without it.
 */
function extractValue(args: string[], name: string): Extraction {
  const rest: string[] = [];
  let value: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === name) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`${name} needs a value`);
      }
      value = next;
      index += 1;
      continue;
    }
    if (current.startsWith(`${name}=`)) {
      value = current.slice(name.length + 1);
      if (value === '') throw new UsageError(`${name} needs a value`);
      continue;
    }
    rest.push(current);
  }

  return { value, rest };
}

/** Takes a valueless flag out of the list. */
function extractFlag(args: string[], name: string): { present: boolean; rest: string[] } {
  const rest = args.filter((argument) => argument !== name);
  return { present: rest.length !== args.length, rest };
}

/**
 * Reads the options of `watch`, refusing what it does not understand.
 *
 * The credential is required on the command line and has no environment
 * fallback, unlike `cost-surveyor`'s. That is deliberate: this process runs
 * for days, and "which token is it presenting" has to be answerable from the
 * command that started it rather than from the shell that happened to export
 * something when it did.
 *
 * @param args Arguments after the subcommand.
 * @returns Everything one run needs.
 * @throws {UsageError} On a missing, empty or unrecognized argument.
 */
export function parseArguments(args: string[]): WatchArguments {
  const fromDryRun = extractFlag(args, '--dry-run');
  const fromUrl = extractValue(fromDryRun.rest, '--url');
  const fromToken = extractValue(fromUrl.rest, '--token');
  const fromLens = extractValue(fromToken.rest, '--lens');

  if (fromLens.rest.length > 0) {
    throw new UsageError(
      `watch does not understand: ${fromLens.rest.map((extra) => `"${extra}"`).join(', ')}`,
    );
  }

  if (fromUrl.value === undefined) throw new UsageError('watch needs --url');
  if (fromToken.value === undefined || fromToken.value.trim() === '') {
    throw new UsageError('watch needs --token: every route of the v1 demands a credential');
  }

  const lens = (fromLens.value ?? 'all') as LensSelection;
  if (!LENS_SELECTIONS.includes(lens)) {
    throw new UsageError(
      `--lens has to be one of ${LENS_SELECTIONS.join(', ')}, got "${fromLens.value ?? ''}"`,
    );
  }

  return {
    url: fromUrl.value,
    token: fromToken.value.trim(),
    lens,
    dryRun: fromDryRun.present,
  };
}

/**
 * Entry point of the command: decides the subcommand and returns the exit code.
 *
 * It does not call `process.exit`: whoever invokes decides that — the same
 * choice as `runCli` in the core package and in the cost lens.
 *
 * @param args `process.argv.slice(2)`.
 * @param context Test injections (`fetch`, output writers and the stop signal).
 * @returns Exit code.
 */
export async function runCli(args: string[], context: CliContext = {}): Promise<number> {
  const write = context.write ?? ((text: string) => void process.stdout.write(text));
  const log = context.log ?? ((text: string) => void process.stderr.write(`${text}\n`));

  if (args.some((argument) => argument === '--help' || argument === '-h')) {
    write(`${USAGE}\n`);
    return 0;
  }

  const subcommand = args[0];
  if (subcommand !== 'watch') {
    process.stderr.write(
      `cartografo-surveyor: unknown subcommand: "${subcommand ?? ''}"\n${USAGE}\n`,
    );
    return 2;
  }

  let parsed: WatchArguments;
  try {
    parsed = parseArguments(args.slice(1));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`cartografo-surveyor: ${error.message}\n`);
    process.stderr.write('cartografo-surveyor: run `cartografo-surveyor --help` for the usage\n');
    return 2;
  }

  try {
    await runWatch({
      url: parsed.url,
      token: parsed.token,
      lens: parsed.lens,
      dryRun: parsed.dryRun,
      write: (line) => write(`${line}\n`),
      log: (message) => log(`cartografo-surveyor: ${message}`),
      ...(context.doFetch === undefined ? {} : { doFetch: context.doFetch }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    return 0;
  } catch (error) {
    // A refused stream is denied, not degraded: the same posture the flow lens's
    // own command line already takes with a 401. Everything that a retry could
    // fix was already retried, inside the consumer, forever.
    if (error instanceof StreamDeniedError) {
      process.stderr.write(`cartografo-surveyor: ${error.message}\n${error.body}\n`);
      return 1;
    }
    // `fetch` throws a TypeError when nobody is listening on the port — but the
    // consumer treats that as a drop and retries it, so anything reaching here
    // is genuinely unexpected and belongs in a stack trace, not in one line.
    throw error;
  }
}
