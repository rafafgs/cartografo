/**
 * One intake generation run: a request in natural language becomes a pending
 * draft (t144, FR3).
 *
 * This is the piece `docs/spec/intake.md` §8 named and left for later —
 * `gerar o rascunho a partir do pedido em linguagem natural` — and the whole
 * design decision is which of the two existing precedents it copies:
 *
 * - the **synthesizer** (t115, D10) stops at a local FILE and waits for a person
 *   to run `cartografo import`. It has to: registering a graph has no API-level
 *   undo, so the import IS the gate;
 * - the **surveyor** (t110) posts straight to `POST /v1/proposals`, because a
 *   proposal always lands `pendente` and nothing in that flow applies it — the
 *   safety ladder is enforced by the ABSENCE of an `aplicar` method, not by a
 *   manual file step.
 *
 * Intake follows the surveyor, and the reason is intake's own two-phase design:
 * a `rascunho` is `pendente`, freely `PATCH`-able and discardable, emits no
 * event, and only becomes real work at `POST /v1/intake/:id/confirmations`
 * (`docs/spec/intake.md` §1). The human gate is already there. Stopping at a file
 * so somebody can submit it by hand would not add a second gate — it would
 * duplicate the first one.
 *
 * Two absences are as much of the design as what is here:
 *
 * - **nothing re-validates `itens`.** Unlike the surveyor's mirror of
 *   `validateOperation` — which exists because a bad `POST /v1/proposals` is
 *   costly to have made — a bad `POST /v1/intake` is cheap and reversible, and
 *   the server answers the whole `itens_invalidos` report at once. A second copy
 *   of that judgement here is a copy that can drift;
 * - **nothing confirms, amends or discards.** Those are t122's human gate, and
 *   the client this module writes through does not have the methods.
 *
 * The order of operations is a decision too. The class check comes first, before
 * any session, mirroring the synthesizer's own FR2 ordering: a typo in `--class`
 * that costs a whole session is a typo found too late.
 *
 * English per D18, and since t180 that includes everything this module PRINTS.
 * What stays Portuguese is the surface a machine matches: the payload keys and
 * the error code that echoes the API's own vocabulary (`grafo_desconhecido`).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { EntradaDeIntake, Rascunho } from '../controller/cliente-controle.ts';
import type { EngineAdapter, SessionSpec, SessionStatus } from '../engine/types.ts';
import { INTAKE_INSTRUCTIONS, OUTPUT_FILE, buildIntakePrompt } from './prompt.ts';

/** Wall-clock limit of the intake session, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 900;

/**
 * The one read this run needs: which classes are registered.
 *
 * Declared as the narrowest interface that answers the question, rather than
 * demanding the synthesizer's whole `ControlPlaneReader`: production passes that
 * reader (it already carries the credential, t148) and the suite passes a
 * two-line object.
 */
export interface ClassReader {
  fetchClasses(): Promise<readonly { class: string }[]>;
}

/**
 * The one write this run makes.
 *
 * Narrow for the same reason, and narrow ON PURPOSE in a second sense: this is
 * the entire power the module has over the control plane. There is no confirm,
 * no amend and no discard here because a caller that does not have the method
 * cannot take the decision by accident (`controller/cliente-controle.ts`).
 */
export interface IntakeWriter {
  criarIntake(input: EntradaDeIntake): Promise<Rascunho>;
}

/** Configuration of one intake generation run. */
export interface IntakeGenerationOptions {
  /** The read-only door: which classes exist. */
  reader: ClassReader;
  /** The write door: the one `POST /v1/intake` of this ficha. */
  client: IntakeWriter;
  /** The engine. Production passes `ClaudeCodeAdapter`; tests pass the fake. */
  adapter: EngineAdapter;
  /** The request in natural language, in the user's own words. */
  request: string;
  /** The registered class the batch will run over. */
  className: string;
  /** Scratch directory the session runs in, and writes its answer to. */
  workingDir: string;
  /** Wall-clock limit of the session. Default: 15 minutes. */
  timeoutSeconds?: number;
  /**
   * Opaque additions to the engine's environment.
   *
   * Never the control plane: the session gets no URL, no credential and no write
   * access to anything but its own directory. In production nothing is passed
   * here; it is the seam the fake engine of the suite is driven by.
   */
  envOverrides?: Readonly<Record<string, string>>;
  /** Where progress goes. Default: nowhere — this is a library, not a CLI. */
  log?: (message: string) => void;
}

/** A run that could not produce a draft. Never a partial one. */
export class IntakeError extends Error {
  readonly code: string;
  readonly details: readonly string[];

  constructor(code: string, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
    this.details = details;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the session reported when it ended. */
interface Outcome {
  status: SessionStatus;
  exitCode: number | null;
}

/**
 * Opens exactly one session and returns the items it wrote.
 *
 * Everything that can go wrong here ends in an {@link IntakeError} and no
 * `POST`: a session that dies, one that writes nothing, one that writes
 * something that is not a JSON document with a non-empty `itens` in it. What is
 * NOT checked is whether those items are well formed — that is the server's
 * `validateItems`, and duplicating it here would be a second verdict on the same
 * batch.
 */
async function decompose(
  options: IntakeGenerationOptions,
  log: (message: string) => void,
): Promise<unknown[]> {
  const spec: SessionSpec = {
    workingDir: options.workingDir,
    instructions: INTAKE_INSTRUCTIONS,
    prompt: buildIntakePrompt(options.request, options.className),
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    ...(options.envOverrides === undefined ? {} : { envOverrides: options.envOverrides }),
  };

  const lines: string[] = [];
  let announceEnd: (outcome: Outcome) => void = () => undefined;
  const end = new Promise<Outcome>((resolve) => {
    announceEnd = resolve;
  });

  await options.adapter.startSession(spec, {
    onOutput(line) {
      lines.push(line);
    },
    onFinished(status, exitCode) {
      announceEnd({ status, exitCode });
    },
  });

  const outcome = await end;
  log(`session ended as "${outcome.status}" (exit ${String(outcome.exitCode)})`);

  if (outcome.status !== 'completed') {
    throw new IntakeError(
      'session_failed',
      `the intake session ended as "${outcome.status}" (exit ${String(outcome.exitCode)}); no draft was proposed`,
      lines.slice(-10),
    );
  }

  const outputPath = path.join(options.workingDir, OUTPUT_FILE);
  let raw: string;
  try {
    raw = readFileSync(outputPath, 'utf8');
  } catch {
    throw new IntakeError(
      'missing_output',
      `the session ended without writing ${OUTPUT_FILE} in ${options.workingDir}: with no "itens", there is no draft`,
      lines.slice(-10),
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new IntakeError(
      'invalid_output',
      `${OUTPUT_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const items = isObject(document) ? document.itens : undefined;
  if (!Array.isArray(items) || items.length === 0) {
    throw new IntakeError(
      'missing_items',
      `${OUTPUT_FILE} has to carry "itens" as a non-empty list — a breakdown with no ticket in it is not a breakdown`,
    );
  }

  return items;
}

/**
 * Turns one request in natural language into one pending intake draft.
 *
 * @param options Control plane doors, engine, the request, the class and a
 *   scratch directory.
 * @returns The draft as the control plane recorded it, always `pendente`.
 * @throws {IntakeError} When the class is not registered, the session failed, or
 *   what it wrote is unusable. Nothing is posted in any of those cases.
 * @throws {ErroDoControlPlane} When the API refuses the write.
 */
export async function generateIntakeDraft(options: IntakeGenerationOptions): Promise<Rascunho> {
  const log = options.log ?? ((): void => undefined);

  // FR3a — the refusal comes BEFORE the session, not after it has been paid for.
  // The code is the control plane's own, so that the two refusals are obviously
  // the same refusal (`routes/intake.ts`).
  const classes = await options.reader.fetchClasses();
  if (!classes.some((entry) => entry.class === options.className)) {
    throw new IntakeError(
      'grafo_desconhecido',
      `grafo_desconhecido — class "${options.className}" has no base graph registered; ` +
        'intake breaks work down over a class that is already registered',
      classes.map((entry) => entry.class),
    );
  }

  log(`class ${options.className} is registered; opening the intake session`);
  const items = await decompose(options, log);
  log(`the session proposed ${items.length} item(s)`);

  const draft = await options.client.criarIntake({
    class: options.className,
    request: options.request,
    items: items,
  });
  log(`draft ${draft.id} written as "${draft.status}"`);

  return draft;
}
