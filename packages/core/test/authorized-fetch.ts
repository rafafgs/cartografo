/**
 * Lets a suite that predates the credential keep speaking HTTP (t124).
 *
 * Not a test file (the runner glob is `test/*.test.ts`), and not a shortcut
 * around the gate either: it presents a REAL credential, issued against the very
 * database the suite is running on, on every request that does not already carry
 * one. What it buys is that the suites written before `/v1/*` needed a token —
 * `graph-routes`, `leases`, `proposal-routes`, `runners` and the `cli-*` ones —
 * keep asserting about routes instead of about headers, in the ~60 places where
 * they call `fetch` directly.
 *
 * Patching the global is the point: those call sites use the global `fetch`, and
 * threading a header through every one of them is a diff about nothing.
 *
 * Three rules keep the patch honest:
 *
 * - it is undone in `t.after`, so it lasts exactly as long as the test;
 * - it only touches requests aimed at ITS control plane, which is what lets a
 *   test hold two of them at once — each with a credential of its own — without
 *   presenting one server's token to the other;
 * - it never overwrites an `Authorization` already on the request, so a test can
 *   still send a wrong credential on purpose.
 *
 * The suite that exercises the gate itself (`test/auth.test.ts`) does not use
 * this: a gate proven through a harness that always authenticates proves nothing.
 */

/** The slice of `node:test`'s context this module uses. */
export interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

/**
 * Makes every `fetch` of this test present a credential to one control plane.
 *
 * @param t Test context, so the global is restored at the end.
 * @param options Base URL of the control plane and a raw token valid on it.
 */
export function authorizeGlobalFetch(
  t: TestHook,
  options: { baseUrl: string; token: string },
): void {
  const original = globalThis.fetch;
  const prefix = options.baseUrl.replace(/\/+$/, '');

  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // `fetch` takes a string, a URL or a Request; only the last one hides the
    // address behind a property.
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!target.startsWith(prefix)) return await original(input, init);

    const headers = new Headers(init?.headers);
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${options.token}`);
    return await original(input, { ...init, headers });
  };

  t.after(() => {
    globalThis.fetch = original;
  });
}
