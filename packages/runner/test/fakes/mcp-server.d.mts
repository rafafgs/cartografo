/**
 * Types of the fake MCP server (t370).
 *
 * Hand-written beside the fixture rather than inferred, because the fixture is
 * a `.mjs` on purpose: it is SPAWNED as a child process by the stdio transport
 * tests, so it has to be a file `node` runs with nothing in front of it — and
 * `tsc` will not read an untyped JavaScript module from a `.ts` test (this
 * package compiles with `allowJs` off). Declaring the surface here is what lets
 * one fixture be both the spawned server and the module the in-process HTTP
 * double borrows `handle` from.
 */

/** The suffix every `read_file` answer carries, whatever it was asked for. */
export declare const FIXED_TEXT: string;

/** The bytes `read_blob` hands back, base64 inside a `resource` entry. */
export declare const FIXED_BLOB: Buffer;

/** What `read_file` answers for a given `path` argument. */
export declare function readFileText(path: unknown): string;

/** The tools this server publishes, in the order `tools/list` gives them. */
export declare const TOOLS: readonly { readonly name: string }[];

/** The tool a node's declared OUTPUT is delivered through (t371). */
export declare const DELIVER_TOOL: string;

/** One recorded attempt at {@link DELIVER_TOOL}. */
export interface DeliveryAttempt {
  /** `ok` when the server accepted it, `error` when it refused, `hang` when it never answered. */
  readonly fate: 'ok' | 'error' | 'hang';
  /** The arguments it was handed, verbatim. */
  readonly args: Record<string, unknown>;
}

/**
 * Every attempt at {@link DELIVER_TOOL}, in order, or `[]`.
 *
 * Read from the file `CARTOGRAFO_FAKE_MCP_CALL_LOG` names, and not from memory:
 * the count has to survive the client pool closing between two dispatches,
 * which is exactly the window a duplicate write would slip through.
 */
export declare function deliveryLog(logPath: string | undefined): DeliveryAttempt[];

/** The revision this fake speaks. */
export declare const PROTOCOL_VERSION: string;

/** The sentinel {@link handle} answers with when the mode is to say nothing. */
export declare const HANGS: symbol;

/**
 * Answers one message: the response, `null` for a notification, or
 * {@link HANGS} for the modes whose whole point is that nothing comes back.
 */
export declare function handle(
  message: unknown,
  mode?: string,
  logPath?: string,
): object | null | symbol;
