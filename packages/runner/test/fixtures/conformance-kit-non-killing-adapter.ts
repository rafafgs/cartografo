/**
 * A deliberately non-conformant adapter, and the harness that drives C4 at it
 * (t468, AT3–AT4).
 *
 * This file is a fixture and a program at once: importing it REGISTERS the
 * conformance kit, so it is never imported by a test — it is spawned as its own
 * process by `test/engine/conformance-kit-reaping-regression.test.ts`. That
 * isolation is the whole design. C4 is meant to fail here, and a failing case
 * inside this repository's own suite would be a permanently red file nobody can
 * tell from a real regression.
 *
 * What it breaks, it breaks in exactly one place. The adapter under test is the
 * real, already-certified `ShellAdapter`, wrapped by a decorator that delegates
 * every member untouched except `cancel()`, which does nothing at all. So the
 * drive measures real detached-process-group semantics against a real engine,
 * and the only thing missing is the kill — which is the precise failure the
 * reaper has to survive.
 *
 * The side channel exists because of an ordering the kit cannot change: C4's
 * `finally` calls `scenario.cleanup()`, which deletes the fake engine's sidecar
 * along with the temp root, so the parent test has no way to learn the two pids
 * after this process is gone. The decorator therefore copies them out of the
 * sidecar into a file the PARENT owns, the moment they are readable.
 *
 * English per the project's language convention.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runConformanceKit } from '../../src/engine/conformance-kit.ts';
import { ShellAdapter } from '../../src/engine/shell-adapter.ts';
import type {
  CliProbe,
  EngineAdapter,
  EngineCapabilities,
  SessionListener,
  SessionSpec,
  SessionStatus,
} from '../../src/engine/types.ts';

/**
 * Where the two pids are copied to, named by the parent process.
 *
 * Deliberately duplicated as a literal in the regression test rather than
 * imported from here: importing this module would register the kit's cases in
 * the parent's own process, which is the one thing this file must never do.
 */
const SIDE_CHANNEL_ENV = 'CARTOGRAFO_T468_SIDE_CHANNEL';

const FAKE_ENGINE = fileURLToPath(new URL('fake-engine.mjs', import.meta.url));

/** Deadline for the kit's waits. Well under C4's own 60s wall clock. */
const KIT_DEADLINE_MS = 3_000;

/** How long the sidecar is waited for before giving up on the side channel. */
const SIDECAR_DEADLINE_MS = 10_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * An adapter that opens sessions correctly and then refuses to end them.
 *
 * Every member is a straight delegation except `cancel`, and that asymmetry is
 * the fixture: a real adapter with this bug passes C1, C2 and C5's first half
 * and leaves C4's engine and grandchild running forever.
 */
class NonKillingAdapter implements EngineAdapter {
  readonly #inner: EngineAdapter;

  constructor(inner: EngineAdapter) {
    this.#inner = inner;
  }

  get engineName(): string {
    return this.#inner.engineName;
  }

  async startSession(spec: SessionSpec, listener: SessionListener): Promise<string> {
    const id = await this.#inner.startSession(spec, listener);
    await this.#publishPids(spec);
    return id;
  }

  async getStatus(sessionId: string): Promise<SessionStatus> {
    return await this.#inner.getStatus(sessionId);
  }

  /**
   * The bug, on purpose: a stop that stops nothing.
   *
   * Not a rejection and not a throw — an adapter that refused would fail C4 at
   * the `cancel` call and never reach the process-death assertions. This one
   * resolves like a healthy adapter and leaves the process group alive, which is
   * what makes the case fail where it is supposed to fail.
   */
  async cancel(): Promise<void> {
    /* deliberately never touches the process group */
  }

  capabilities(): EngineCapabilities {
    return this.#inner.capabilities();
  }

  async verifyCli(): Promise<CliProbe> {
    return await this.#inner.verifyCli();
  }

  /**
   * Copies the fake engine's pids somewhere `scenario.cleanup()` cannot reach.
   *
   * Awaited inside `startSession` rather than left running in the background, so
   * that by the time the kit reads the sidecar itself the side channel is
   * already on disk — no race between this file and the case it serves.
   */
  async #publishPids(spec: SessionSpec): Promise<void> {
    const recordPath = spec.envOverrides?.FAKE_ENGINE_RECORD;
    const sideChannel = process.env[SIDE_CHANNEL_ENV];
    if (recordPath === undefined || sideChannel === undefined) return;

    const limit = Date.now() + SIDECAR_DEADLINE_MS;
    while (Date.now() < limit) {
      try {
        const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
          pid: number;
          grandchildPid: number | null;
        };
        writeFileSync(
          sideChannel,
          JSON.stringify({ pid: record.pid, grandchildPid: record.grandchildPid }),
        );
        return;
      } catch {
        // Not written yet, or written half — the engine's own `writeFileSync` is
        // one call, but the wait for the file to EXIST is the honest one.
        await sleep(25);
      }
    }
  }
}

/**
 * Only C4 is driven; the other ten are exempted WITH their reason, which is the
 * kit's own contract for an absent case (`KitOptions.skip`).
 */
const ONLY_C4_IS_DRIVEN =
  'this harness exists to drive C4 against an adapter that never kills the process group (t468); ' +
  'every other case would be measuring the certified ShellAdapter twice';

runConformanceKit(
  (fakeEnginePath) =>
    new NonKillingAdapter(
      new ShellAdapter({
        commandBuilder: () => ({ command: process.execPath, args: [fakeEnginePath] }),
        graceMs: 300,
      }),
    ),
  FAKE_ENGINE,
  {
    deadlineMs: KIT_DEADLINE_MS,
    skip: {
      C1: ONLY_C4_IS_DRIVEN,
      C2: ONLY_C4_IS_DRIVEN,
      C3: ONLY_C4_IS_DRIVEN,
      C5: ONLY_C4_IS_DRIVEN,
      C6: ONLY_C4_IS_DRIVEN,
      C7: ONLY_C4_IS_DRIVEN,
      C8: ONLY_C4_IS_DRIVEN,
      C9: ONLY_C4_IS_DRIVEN,
      C10: ONLY_C4_IS_DRIVEN,
      C11: ONLY_C4_IS_DRIVEN,
    },
  },
);
