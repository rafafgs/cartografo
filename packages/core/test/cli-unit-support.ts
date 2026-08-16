/**
 * Support for the in-process CLI tests (t212).
 *
 * Not a test file (`test/*.test.ts` is the runner glob): it is what the
 * `cli-*-unit.test.ts` files share in order to call a subcommand as a FUNCTION,
 * against a control plane that is a handful of lines instead of a database.
 *
 * It does not replace `cli-support.ts`, and the two answer different questions.
 * That one spawns the real binary, because the CLI's contract IS the process —
 * exit code, stdout, stderr, a server that comes up — and nothing else proves
 * that end to end. What it cannot do is drive the error branches: making the
 * real control plane answer `500`, or hand back a version with no snapshot, or
 * refuse the fourth manifest of a bundle, means breaking a real server on
 * purpose, and those branches stayed uncovered exactly because of it (33–45 %
 * of branches on `export.ts`, `import.ts` and `skill-import.ts`).
 *
 * So the spawn tests stay as the end-to-end guard and these run beside them: one
 * fake HTTP server per test, scripted per request, and the subcommand called
 * directly. The two things a direct call loses — stdout and stderr — are the
 * point of {@link capture}, which is also what keeps the output of the suite
 * readable while a dozen subcommands print their failures into it.
 *
 * The fake speaks HTTP for real, over the loopback: `cli/url.ts` is the one
 * place that knows how to reach the control plane (D1, D11), and stubbing
 * `fetch` would test the subcommands against a mock of the module that carries
 * every one of their requests.
 */

import { createServer } from 'node:http';

import { type TestHook } from './cli-support.ts';

/** One request the fake control plane received. */
export interface RecordedRequest {
  method: string;
  /** Path and query, as it came on the wire. */
  path: string;
  /** Parsed when the body is JSON, the raw text otherwise, `undefined` when empty. */
  body: unknown;
  /** The credential the subcommand presented, if it presented one (t124). */
  authorization: string | undefined;
}

/** What the fake control plane answers to one request. */
export interface FakeAnswer {
  status: number;
  /** Answer body as JSON. Ignored when `text` is given. */
  body?: unknown;
  /** Answer body verbatim — for what is not JSON at all. */
  text?: string;
}

/** A control plane that exists only for one test. */
export interface FakeControlPlane {
  /** Base URL, with no trailing slash, as `--url` would carry it. */
  url: string;
  /** Everything asked of it, in order. */
  requests: RecordedRequest[];
}

/**
 * Starts a control plane that answers whatever the test says.
 *
 * @param t Test context, so the server is closed at the end.
 * @param respond Answer for each request; it is called once per request.
 * @returns The base URL and the log of what was asked.
 */
export async function startFakeControlPlane(
  t: TestHook,
  respond: (request: RecordedRequest) => FakeAnswer,
): Promise<FakeControlPlane> {
  const requests: RecordedRequest[] = [];

  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      if (text !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }

      const recorded: RecordedRequest = {
        method: incoming.method ?? '',
        path: incoming.url ?? '',
        body,
        authorization: incoming.headers.authorization,
      };
      requests.push(recorded);

      const answer = respond(recorded);
      const payload = answer.text ?? (answer.body === undefined ? '' : JSON.stringify(answer.body));
      outgoing.writeHead(answer.status, { 'content-type': 'application/json' });
      outgoing.end(payload);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the fake control plane did not bind a port'));
        return;
      }
      resolve(address.port);
    });
  });

  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return { url: `http://127.0.0.1:${port}`, requests };
}

/** What a subcommand did: its exit code and everything it printed. */
export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a subcommand and reads back everything it printed.
 *
 * What it must NOT do is hold every chunk, and that is not a detail: `node
 * --test` runs each file as a child process and reports what happened over that
 * child's own stdout. The first version of this helper kept everything to
 * itself and ate the report along with the output — a file of eight tests
 * reported as `tests 1`, with the other seven passing silently and invisibly.
 *
 * What tells the two apart is that the runner's traffic is a serialized event
 * frame and a subcommand's is plain text. So a chunk carrying control bytes is
 * the runner's and goes straight through, untouched; anything else is the
 * subcommand's and is held, which is also what keeps the suite readable while a
 * dozen subcommands print their failures into it.
 *
 * The streams are restored in a `finally`, so a subcommand that throws — every
 * `UsageError` does — gives them back before the assertion runs.
 *
 * @param run Call to the subcommand.
 * @returns Exit code, stdout and stderr.
 */
export async function capture(run: () => Promise<number>): Promise<Captured> {
  let stdout = '';
  let stderr = '';

  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const hold = (
    original: typeof process.stdout.write,
    into: (text: string) => void,
  ): typeof process.stdout.write =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      // eslint-disable-next-line no-control-regex -- spotting them is the point.
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }
      into(text);
      return true;
    }) as typeof process.stdout.write;

  process.stdout.write = hold(originalStdout, (text) => {
    stdout += text;
  });
  process.stderr.write = hold(originalStderr, (text) => {
    stderr += text;
  });

  try {
    const code = await run();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}
