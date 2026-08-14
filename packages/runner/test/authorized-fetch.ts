/**
 * Lets the suites that boot a real control plane keep speaking HTTP (t124).
 *
 * Not a test file (the runner glob is `test/**\/*.test.ts`): it is the device
 * two of them share since `/v1/*` started demanding a credential. It presents a
 * REAL token — the one the control plane announced on its own readiness line —
 * on every request aimed at that control plane, so the suites keep asserting
 * about dispatch and telemetry instead of about headers.
 *
 * It repeats `packages/core/test/authorized-fetch.ts` on purpose: the runner
 * imports nothing from the core (D1, and `test/no-privileged-access.test.ts` is
 * the gate), so a shared helper across the two packages would be the very
 * boundary these suites exist to exercise.
 *
 * Two rules keep it honest: the patch is undone in `t.after`, and it never
 * overwrites an `Authorization` already on the request.
 */

/** The slice of `node:test`'s context this module uses. */
export interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

/**
 * Makes every `fetch` of this test present a credential to one control plane.
 *
 * @param t Test context, so the global is restored at the end.
 * @param options Base URL of the control plane and a token valid on it.
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
