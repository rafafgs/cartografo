/**
 * The ceiling of one command line, as data (t689, FR8–FR9).
 *
 * A shell skill's `command.argv` is spawned with `shell: false`, so the
 * operating system is the only thing that can refuse it — and it refuses with
 * `ENAMETOOLONG`, after a worktree was cut and a session row was written. The
 * factory's shell skills put whole JSON documents in an argv through
 * `{{input.<path>}}`, and a 53 KB source already produced a 31,132-character
 * element, so the refusal has to come BEFORE any of that, from the one place
 * that knows both the final argv and the templates it was built from.
 *
 * Two rules, because the two families of platform fail differently:
 *
 * - **`win32`** limits ONE command line to 32,767 UTF-16 units, the program name
 *   and a separator per element included. The guard measures
 *   `sum(element.length) + argv.length` — `String.length` is UTF-16 units, which
 *   is exactly the unit — against {@link WIN32_COMMAND_LINE_LIMIT}, which keeps
 *   767 units of margin for the quoting `CreateProcess` adds.
 * - **Everywhere else** limits ONE argument: Linux's `MAX_ARG_STRLEN` is 128 KiB.
 *   macOS has no per-argument cap, but one manifest has to stay portable, so it
 *   follows the same rule; a 140 KB element that happened to work there is
 *   refused there too, and that is deliberate.
 *
 * Pure: the platform is a parameter, not a read of `process.platform`, which is
 * what lets one machine test both rules.
 *
 * English per D18.
 */

import { inputPlaceholderPaths } from './interpolate-input.ts';

/** The most a `win32` command line may measure, in UTF-16 units (the hard limit is 32,767). */
export const WIN32_COMMAND_LINE_LIMIT = 32000;

/** The most one argument may measure elsewhere, in UTF-8 bytes (Linux's `MAX_ARG_STRLEN`). */
export const ARGUMENT_LIMIT_BYTES = 131072;

/** What measured the violation, and in which unit. */
export type CommandLineUnit = 'characters' | 'bytes';

/** Everything the refusal knows about the command line it refused. */
export interface CommandLineViolation {
  readonly platform: NodeJS.Platform;
  /** The measured size: the whole line on `win32`, the longest element elsewhere. */
  readonly measured: number;
  readonly limit: number;
  readonly unit: CommandLineUnit;
  /** Zero-based index into `command.argv` of the longest element. */
  readonly position: number;
  /**
   * The `{{input.<path>}}` paths of that element's DECLARED template, in order,
   * deduplicated. Empty when the element is literal, or built from file
   * placeholders only.
   */
  readonly placeholders: readonly string[];
}

/** A command line the platform cannot spawn, refused before anything is cut. */
export class CommandLineTooLongError extends Error implements CommandLineViolation {
  readonly nodeId: string;
  readonly skillId: string;
  readonly platform: NodeJS.Platform;
  readonly measured: number;
  readonly limit: number;
  readonly unit: CommandLineUnit;
  readonly position: number;
  readonly placeholders: readonly string[];

  constructor(details: CommandLineViolation & { nodeId: string; skillId: string }) {
    super(
      `node "${details.nodeId}" pins skill "${details.skillId}", whose command line measures ` +
        `${String(details.measured)} ${details.unit} on ${details.platform} (limit ${String(details.limit)}): ` +
        `argv element ${String(details.position)} is the longest — a command line the platform ` +
        'cannot spawn aborts the dispatch before anything is cut or started',
    );
    this.name = 'CommandLineTooLongError';
    this.nodeId = details.nodeId;
    this.skillId = details.skillId;
    this.platform = details.platform;
    this.measured = details.measured;
    this.limit = details.limit;
    this.unit = details.unit;
    this.position = details.position;
    this.placeholders = details.placeholders;
  }
}

/** Index of the first longest element, by the given size. */
function longest(argv: readonly string[], size: (element: string) => number): number {
  let position = 0;
  let best = -1;
  argv.forEach((element, index) => {
    const measured = size(element);
    if (measured > best) {
      best = measured;
      position = index;
    }
  });
  return position;
}

/**
 * Measures a final argv against the ceiling of a platform.
 *
 * @param argv The argv as it will be spawned, file paths already substituted.
 * @param templates The same elements as the manifest declared them, index for
 *   index, which is what names the placeholders of the culprit.
 * @param platform The platform the command will be spawned on.
 * @returns The violation, or `null` when the line fits. Exactly at the limit fits.
 */
export function checkCommandLine(
  argv: readonly string[],
  templates: readonly string[],
  platform: NodeJS.Platform,
): CommandLineViolation | null {
  const placeholdersOf = (position: number): string[] =>
    inputPlaceholderPaths(templates[position] ?? '');

  if (platform === 'win32') {
    const measured = argv.reduce((sum, element) => sum + element.length, 0) + argv.length;
    if (measured <= WIN32_COMMAND_LINE_LIMIT) return null;

    const position = longest(argv, (element) => element.length);
    return {
      platform,
      measured,
      limit: WIN32_COMMAND_LINE_LIMIT,
      unit: 'characters',
      position,
      placeholders: placeholdersOf(position),
    };
  }

  const bytes = (element: string): number => Buffer.byteLength(element, 'utf8');
  const position = longest(argv, bytes);
  const measured = bytes(argv[position] ?? '');
  if (measured <= ARGUMENT_LIMIT_BYTES) return null;

  return {
    platform,
    measured,
    limit: ARGUMENT_LIMIT_BYTES,
    unit: 'bytes',
    position,
    placeholders: placeholdersOf(position),
  };
}
