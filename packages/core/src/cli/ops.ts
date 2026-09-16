/**
 * The write subcommands of `cartografo`, plus `examples` and `runners` — the
 * two remaining reads the screen still had and the CLI did not (t544, D26).
 *
 * Every one of these is an HTTP client like every other subcommand (D1, D11):
 * no database, only `/v1/*`. The routes themselves are unchanged by this
 * ticket — see the ticket's own Context for the exact route each subcommand
 * drives.
 *
 * `runRunners`'s decision logic (`engineProfile`, `engineLine`, `credentialLine`,
 * `mcpLine`, `workspaceLine`, `waitingLines`, `pairingCommand`) is ported from
 * `packages/screen/src/pages.ts`'s `checkPage`, not imported: `packages/core`
 * has never depended on `packages/screen` (D11). Same conditions, same
 * headline wording and the same two engine profiles, with the fix text
 * rendered as plain lines instead of `<p>`/`<pre><code>`.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';

import { isObject } from '../util/is-object.ts';
import { UsageError, requestJson, type HttpResponse } from './url.ts';

/** One `label  value` line of a human success report. */
function line(label: string, value: string): string {
  return `  ${label.padEnd(18)}${value}\n`;
}

/** A plain-text table: a header row and one row per entry, columns aligned. */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join('  ')
      .trimEnd();
  const body = rows.length === 0 ? ['(none)'] : rows.map(renderRow);
  return [renderRow(headers), ...body].join('\n');
}

/**
 * The general-convention refusal (FR1): whatever status this ticket did not
 * name explicitly, printed as `<error> — <message>`, or a bare HTTP status
 * when the body carries neither.
 */
function genericRefusal(response: HttpResponse): number {
  const body = isObject(response.body) ? response.body : {};
  const error = typeof body.error === 'string' ? body.error : undefined;
  const message = typeof body.message === 'string' ? body.message : undefined;
  if (error === undefined && message === undefined) {
    process.stderr.write(`cartografo: the control plane refused (HTTP ${response.status})\n`);
    return 1;
  }
  process.stderr.write(
    `cartografo: ${error ?? ''}${error !== undefined && message !== undefined ? ' — ' : ''}${message ?? ''}\n`,
  );
  return 1;
}

/**
 * Who is doing this write (FR4): `--by`, trimmed, or the OS user, or the
 * literal `'operator'` when neither is available. Never blank — D26 records
 * writes made from the terminal as `user`, and a blank ref would be a `system`
 * actor in disguise.
 */
export function resolveOperatorName(explicit?: string): string {
  const trimmed = explicit?.trim();
  if (trimmed !== undefined && trimmed !== '') return trimmed;
  try {
    const name = os.userInfo().username;
    return name === '' ? 'operator' : name;
  } catch {
    return 'operator';
  }
}

/* -------------------------------------------------------------------- answer */

/** Options of `answer`. */
export interface AnswerOptions {
  url: string;
  id: number;
  /** The positional `<text>` argument, if one was given. */
  text?: string;
  /** `--file <path>`, if one was given. */
  file?: string;
  by?: string;
  json: boolean;
}

/**
 * Resolves the text to send: exactly one of a positional argument or a file,
 * trimmed, and never blank (FR5).
 *
 * @throws {UsageError} When neither or both were given, or the result is blank.
 */
function resolveAnswerText(text: string | undefined, file: string | undefined): string {
  if ((text === undefined) === (file === undefined)) {
    throw new UsageError('answer needs the text to send, as an argument or with --file');
  }

  let raw: string;
  if (file !== undefined) {
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      throw new UsageError(`could not read "${file}"`);
    }
  } else {
    raw = text as string;
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new UsageError('answer needs the text to send, as an argument or with --file');
  }
  return trimmed;
}

/** Runs `cartografo answer`. */
export async function runAnswer(options: AnswerOptions): Promise<number> {
  const text = resolveAnswerText(options.text, options.file);
  const answeredBy = resolveOperatorName(options.by);

  const response = await requestJson(`${options.url}/v1/input-requests/${options.id}/answer`, {
    method: 'PATCH',
    body: { answer: text, answered_by: answeredBy },
  });

  if (response.status === 404) {
    process.stderr.write(`cartografo: no input request #${options.id}\n`);
    return 1;
  }
  if (response.status === 409) {
    const body = isObject(response.body) ? response.body : {};
    const details = Array.isArray(body.details) ? body.details : [];
    process.stderr.write(`cartografo: ${details[0] ?? 'the input request is already answered'}\n`);
    return 1;
  }
  if (response.status !== 200) return genericRefusal(response);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  const body = isObject(response.body) ? response.body : {};
  process.stdout.write('input request answered\n');
  process.stdout.write(line('id', String(body.id)));
  process.stdout.write(line('status', String(body.status)));
  process.stdout.write(line('answered_by', String(body.answered_by)));
  return 0;
}

/* --------------------------------------------------------------- block/unblock */

/** Options of `block`. */
export interface BlockOptions {
  url: string;
  id: number;
  reason?: string;
  by?: string;
  json: boolean;
}

/** Runs `cartografo block`. */
export async function runBlock(options: BlockOptions): Promise<number> {
  const reason = options.reason?.trim();
  if (reason === undefined || reason === '') {
    throw new UsageError('block needs --reason');
  }

  const response = await requestJson(`${options.url}/v1/jobs/${options.id}/blocks`, {
    method: 'POST',
    body: { reason, actor: { type: 'user', ref: resolveOperatorName(options.by) } },
  });

  if (response.status === 404) {
    process.stderr.write(`cartografo: no job #${options.id}\n`);
    return 1;
  }
  if (response.status !== 200) return genericRefusal(response);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  const body = isObject(response.body) ? response.body : {};
  process.stdout.write('job blocked\n');
  process.stdout.write(line('id', String(body.id)));
  process.stdout.write(line('block_reason', String(body.block_reason)));
  return 0;
}

/** Options of `unblock`. */
export interface UnblockOptions {
  url: string;
  id: number;
  note?: string;
  by?: string;
  json: boolean;
}

/** Runs `cartografo unblock`. */
export async function runUnblock(options: UnblockOptions): Promise<number> {
  const note = options.note?.trim();
  const body: Record<string, unknown> = { actor: { type: 'user', ref: resolveOperatorName(options.by) } };
  if (note !== undefined && note !== '') body.reason = note;

  const response = await requestJson(`${options.url}/v1/jobs/${options.id}/unblocks`, {
    method: 'POST',
    body,
  });

  if (response.status === 404) {
    process.stderr.write(`cartografo: no job #${options.id}\n`);
    return 1;
  }
  if (response.status !== 200) return genericRefusal(response);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  const responseBody = isObject(response.body) ? response.body : {};
  process.stdout.write('job unblocked\n');
  process.stdout.write(line('id', String(responseBody.id)));
  process.stdout.write(line('blocked', String(responseBody.blocked)));
  return 0;
}

/* -------------------------------------------------------------------- job create */

/** Options of `job create`. */
export interface CreateJobOptions {
  url: string;
  graphVersionId: string;
  inputPath: string;
  executionId?: number;
  projectId: number;
  json: boolean;
}

/** Reads and parses `--input`; refuses anything that is not a JSON object (FR12). */
function readJobInput(filePath: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    throw new UsageError(`could not read "${filePath}"`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`"${filePath}" is not valid JSON — ${(error as Error).message}`);
  }
  if (!isObject(parsed)) {
    throw new UsageError(`"${filePath}" has to hold a JSON object`);
  }
  return parsed;
}

/** Runs `cartografo job create`. */
export async function runCreateJob(options: CreateJobOptions): Promise<number> {
  const input = readJobInput(options.inputPath);

  const response = await requestJson(`${options.url}/v1/jobs`, {
    method: 'POST',
    body: {
      ...input,
      graph_version_id: options.graphVersionId,
      ...(options.executionId === undefined ? {} : { execution_id: options.executionId }),
      project_id: options.projectId,
    },
  });

  if (response.status !== 201) return genericRefusal(response);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  const body = isObject(response.body) ? response.body : {};
  process.stdout.write('job created\n');
  process.stdout.write(line('id', String(body.id)));
  process.stdout.write(line('entry_node_id', String(body.entry_node_id)));
  process.stdout.write(line('graph_version_id', String(body.graph_version_id)));
  process.stdout.write(
    line('execution_id', body.execution_id === null || body.execution_id === undefined ? '-' : String(body.execution_id)),
  );
  return 0;
}

/* ------------------------------------------------------------------- examples */

/** Options of `example run`. */
export interface ExampleRunOptions {
  url: string;
  className: string;
  projectId: number;
  json: boolean;
}

/** Runs `cartografo example run <class>`. */
export async function runExampleRun(options: ExampleRunOptions): Promise<number> {
  const response = await requestJson(
    `${options.url}/v1/examples/${encodeURIComponent(options.className)}/run?project_id=${options.projectId}`,
    { method: 'POST' },
  );

  if (response.status !== 201) return genericRefusal(response);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  const body = isObject(response.body) ? response.body : {};
  const job = isObject(body.job) ? body.job : {};
  process.stdout.write('example running\n');
  process.stdout.write(line('execution_id', String(body.execution_id)));
  process.stdout.write(line('job.id', String(job.id)));
  process.stdout.write(line('registered', String(body.registered)));
  return 0;
}

/** Options of `examples`. */
export interface ExamplesOptions {
  url: string;
  projectId: number;
  json: boolean;
}

/** One entry of `GET /v1/examples`, in the fields the human table shows. */
interface ExampleRead {
  class: string;
  bundle: string;
  demo_title: string;
  registered: boolean;
}

/** Runs `cartografo examples`. */
export async function runExamples(options: ExamplesOptions): Promise<number> {
  const response = await requestJson(`${options.url}/v1/examples?project_id=${options.projectId}`);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  const body = isObject(response.body) ? response.body : {};
  const examples = Array.isArray(body.examples) ? (body.examples as ExampleRead[]) : [];
  process.stdout.write(
    `${table(
      ['class', 'bundle', 'demo_title', 'registered'],
      examples.map((example) => [example.class, example.bundle, example.demo_title, String(example.registered)]),
    )}\n`,
  );
  return 0;
}

/* -------------------------------------------------------------------- runners */

/** The MCP server the check looks for — `checkPage`'s own constant. */
const MCP_SERVER_NAME = 'cartografo';

/** The command an MCP client is registered with — `checkPage`'s own placeholder. */
const MCP_ENTRYPOINT = 'node /absolute/path/to/cartografo/packages/mcp/bin/mcp.mjs';

/** Control plane the fix actions quote — `checkPage`'s own default. */
const CONTROL_PLANE_HINT = 'http://127.0.0.1:4317';

/** What to put where the credential goes. */
const TOKEN_HINT = '<the token printed when the control plane started>';

/** Stand-ins for the two roots when no setting records them yet. */
const WORKING_DIR_PLACEHOLDER = '<the repository the sessions work in>';
const WORKTREES_ROOT_PLACEHOLDER = '<a sibling directory, never inside it>';

/** The engine the runner takes when nothing recorded one (`settings.engine`). */
const DEFAULT_ENGINE = 'claude-code';

/** Everything the fix actions need to know about one engine — `checkPage`'s own shape. */
interface EngineProfile {
  binary: string;
  installCommand: string | null;
  credentialVariables: readonly string[];
  credentialsFile: string | null;
  mcpAddCommand: string | null;
}

/** The two adapters this product ships, and the honest answer for anything else. */
function engineProfile(engine: string): EngineProfile {
  if (engine === 'claude-code') {
    return {
      binary: 'claude',
      installCommand: null,
      credentialVariables: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
      credentialsFile: '~/.claude.json',
      mcpAddCommand: `claude mcp add ${MCP_SERVER_NAME} \\\n  -e CARTOGRAFO_URL=${CONTROL_PLANE_HINT} \\\n  -e CARTOGRAFO_MCP_TOKEN=${TOKEN_HINT} \\\n  -- ${MCP_ENTRYPOINT}`,
    };
  }

  if (engine === 'codex') {
    return {
      binary: 'codex',
      installCommand: 'npx --yes @openai/codex@latest',
      credentialVariables: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
      credentialsFile: '$CODEX_HOME/auth.json (~/.codex/auth.json by default)',
      mcpAddCommand: `export CARTOGRAFO_URL=${CONTROL_PLANE_HINT}\nexport CARTOGRAFO_MCP_TOKEN=${TOKEN_HINT}\ncodex mcp add ${MCP_SERVER_NAME} -- ${MCP_ENTRYPOINT}`,
    };
  }

  return { binary: engine, installCommand: null, credentialVariables: [], credentialsFile: null, mcpAddCommand: null };
}

/** One check of one runner — `checkPage`'s own `CheckLine`, fix as plain lines. */
interface CheckLine {
  field: 'engine' | 'credential' | 'mcp' | 'workspace';
  met: boolean;
  headline: string;
  /** What to do about it, one line per paragraph/command; empty when nothing to do. */
  fix: string[];
}

/** What a runner reported about its own machine — the slice these checks read. */
interface RunnerProbeRead {
  cli: { available: boolean; version: string | null; authenticated: boolean };
  mcp: { supported: boolean; servers?: { name: string }[] };
  workspace: {
    working_dir: string;
    working_dir_resolved: string;
    is_git_repo: boolean;
    worktrees_root: string;
    worktrees_root_resolved: string;
    worktrees_root_writable: boolean;
  };
}

/** A paired runner and its liveness, in the fields these checks read. */
interface RunnerHealthRead {
  id: string;
  probe: RunnerProbeRead | null;
}

/** The three keys `GET`/`PATCH /v1/settings` hold per project. */
interface SettingsRead {
  workspace_root?: string;
  worktrees_root?: string;
  engine?: string;
  allow_git_clone?: string;
}

/** The four lines of one runner that has never said anything about itself. */
function waitingLines(): CheckLine[] {
  const fields: CheckLine['field'][] = ['engine', 'credential', 'mcp', 'workspace'];
  return fields.map((field) => ({ field, met: false, headline: "waiting for this runner's first report", fix: [] }));
}

/** The engine line: is the CLI this runner dispatches through even there? */
function engineLine(probe: RunnerProbeRead, profile: EngineProfile): CheckLine {
  if (probe.cli.available) {
    return {
      field: 'engine',
      met: true,
      headline: `engine found — ${profile.binary} ${probe.cli.version ?? '(version unknown)'}`,
      fix: [],
    };
  }

  const fix =
    profile.installCommand === null
      ? [
          `Install the \`${profile.binary}\` CLI on this machine — its own installation documentation is the source of truth, and this repository records no package name for it.`,
        ]
      : [
          `Install the \`${profile.binary}\` CLI on this machine, or run it with no install at all:`,
          profile.installCommand,
        ];

  return {
    field: 'engine',
    met: false,
    headline: `engine not found — the runner could not run \`${profile.binary}\``,
    fix,
  };
}

/** The credential line: would a session this runner opens be able to authenticate? */
function credentialLine(probe: RunnerProbeRead, profile: EngineProfile): CheckLine {
  if (probe.cli.authenticated) {
    return { field: 'credential', met: true, headline: 'model credential found', fix: [] };
  }

  if (profile.credentialVariables.length === 0) {
    return {
      field: 'credential',
      met: false,
      headline: 'no model credential — the CLI reported none',
      fix: [
        `This runner is configured with the engine \`${profile.binary}\`, which is neither of the two adapters this product ships, so nothing here knows which variables it reads. Authenticate its CLI the way its own documentation says.`,
      ],
    };
  }

  const exports = profile.credentialVariables.map((variable) => `export ${variable}=…`).join('\n');

  return {
    field: 'credential',
    met: false,
    headline: 'no model credential — the CLI reported none',
    fix: [
      "Export any one of these in the shell the runner starts from — they are the variables this engine's own adapter checks:",
      `# any one of the three\n${exports}`,
      profile.credentialsFile === null
        ? `Or log in with the \`${profile.binary}\` CLI itself.`
        : `Or log in with the \`${profile.binary}\` CLI itself, which writes the credential file the runner also reads: ${profile.credentialsFile}.`,
    ],
  };
}

/** The MCP line: is the model driving this session on the same map as its reader? */
function mcpLine(probe: RunnerProbeRead, profile: EngineProfile): CheckLine {
  if (!probe.mcp.supported) {
    return {
      field: 'mcp',
      met: false,
      headline: `MCP servers — this engine's adapter can't be checked automatically`,
      fix: [
        `The \`${profile.binary}\` adapter implements no MCP discovery, so nothing here can say whether the ${MCP_SERVER_NAME} server is registered. Ask the engine itself; there is nothing to react to here.`,
      ],
    };
  }

  if ((probe.mcp.servers ?? []).some((server) => server.name === MCP_SERVER_NAME)) {
    return { field: 'mcp', met: true, headline: `MCP servers — ${MCP_SERVER_NAME} is registered`, fix: [] };
  }

  return {
    field: 'mcp',
    met: false,
    headline: `MCP servers — ${MCP_SERVER_NAME} is not registered with this engine`,
    fix:
      profile.mcpAddCommand === null
        ? [
            `Register the ${MCP_SERVER_NAME} server with \`${profile.binary}\` the way its own documentation says: it runs ${MCP_ENTRYPOINT}, with CARTOGRAFO_URL and CARTOGRAFO_MCP_TOKEN in its environment.`,
          ]
        : [`Register it with the engine's own command:`, profile.mcpAddCommand],
  };
}

/** The workspace line: can a session actually be cut on this machine? */
function workspaceLine(probe: RunnerProbeRead, settings: SettingsRead): CheckLine {
  const { workspace } = probe;
  if (workspace.is_git_repo && workspace.worktrees_root_writable) {
    return { field: 'workspace', met: true, headline: `workspace usable — ${workspace.working_dir_resolved}`, fix: [] };
  }

  const problems = [
    workspace.is_git_repo ? null : `${workspace.working_dir_resolved} is not a git repository`,
    workspace.worktrees_root_writable ? null : `${workspace.worktrees_root_resolved} cannot be created by this runner`,
  ].filter((problem): problem is string => problem !== null);

  return {
    field: 'workspace',
    met: false,
    headline: `workspace unusable — ${problems.join('; ')}`,
    fix: [
      'Point this project at directories that work; the runner picks these up when it is started without --working-dir/--worktrees-root.',
      `cartografo settings set workspace_root ${workspace.working_dir || settings.workspace_root || ''}`,
      `cartografo settings set worktrees_root ${workspace.worktrees_root || settings.worktrees_root || ''}`,
    ],
  };
}

/** The four checks of one runner, decided against what it reported. */
function runnerLines(runner: RunnerHealthRead, settings: SettingsRead): CheckLine[] {
  const probe = runner.probe;
  if (probe === null) return waitingLines();

  const profile = engineProfile(settings.engine ?? DEFAULT_ENGINE);
  return [engineLine(probe, profile), credentialLine(probe, profile), mcpLine(probe, profile), workspaceLine(probe, settings)];
}

/** The command that pairs the first runner, built from whatever is recorded (AC2). */
function pairingCommand(projectId: number, settings: SettingsRead): string {
  return [
    'npx cartografo-runner',
    `--project ${projectId}`,
    `--working-dir ${settings.workspace_root ?? WORKING_DIR_PLACEHOLDER}`,
    `--worktrees-root ${settings.worktrees_root ?? WORKTREES_ROOT_PLACEHOLDER}`,
    `--engine ${settings.engine ?? DEFAULT_ENGINE}`,
  ].join(' ');
}

/** Options of `runners`. */
export interface RunnersOptions {
  url: string;
  projectId: number;
  json: boolean;
}

/** Runs `cartografo runners` — `checkPage`'s own reads and decision logic. */
export async function runRunners(options: RunnersOptions): Promise<number> {
  const [runnersResponse, settingsResponse] = await Promise.all([
    requestJson(`${options.url}/v1/runners`),
    requestJson(`${options.url}/v1/settings?project_id=${options.projectId}`),
  ]);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ runners: runnersResponse.body, settings: settingsResponse.body })}\n`);
    return 0;
  }

  const runners =
    isObject(runnersResponse.body) && Array.isArray(runnersResponse.body.runners)
      ? (runnersResponse.body.runners as RunnerHealthRead[])
      : [];
  const settings = (isObject(settingsResponse.body) ? settingsResponse.body : {}) as SettingsRead;

  if (runners.length === 0) {
    process.stdout.write('no runner paired — nothing on this machine is going to pick work up\n');
    process.stdout.write(`${pairingCommand(options.projectId, settings)}\n`);
    return 0;
  }

  const groups = runners.map((runner) => ({ runner, lines: runnerLines(runner, settings) }));

  if (groups.every((group) => group.lines.every((checkLine) => checkLine.met))) {
    process.stdout.write('everything this machine needs is ready\n');
    return 0;
  }

  for (const group of groups) {
    process.stdout.write(`${group.runner.id}\n`);
    for (const checkLine of group.lines) {
      process.stdout.write(`  ${checkLine.met ? '✓' : '✗'} ${checkLine.headline}\n`);
      for (const fixLine of checkLine.fix) {
        process.stdout.write(`${fixLine.split('\n').map((piece) => `      ${piece}`).join('\n')}\n`);
      }
    }
  }
  return 0;
}

/** Options of `runners recheck`. */
export interface RunnersRecheckOptions {
  url: string;
  runnerId: string;
  json: boolean;
}

/** Runs `cartografo runners recheck <runner-id>`. */
export async function runRunnersRecheck(options: RunnersRecheckOptions): Promise<number> {
  const response = await requestJson(`${options.url}/v1/runners/${encodeURIComponent(options.runnerId)}/rechecks`, {
    method: 'POST',
  });

  if (response.status === 404) {
    process.stderr.write(`cartografo: no runner "${options.runnerId}"\n`);
    return 1;
  }
  if (response.status !== 200 && response.status !== 201) return genericRefusal(response);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  process.stdout.write(`recheck requested for runner_id ${options.runnerId}\n`);
  return 0;
}

/* ------------------------------------------------------------------- settings */

/**
 * A CLI-local mirror of `KNOWN_SETTING_KEYS` (`repositories/settings.ts`).
 *
 * `packages/core`'s CLI half imports nothing from `src/db/**` or the
 * repositories (D1, D11), the same reason `reads.ts`'s `JOB_STATES` mirrors
 * RF-30's six words instead of importing them.
 */
export const SETTING_KEYS = ['workspace_root', 'worktrees_root', 'engine', 'allow_git_clone'] as const;

/** Options of `settings` / `settings get`. */
export interface SettingsGetOptions {
  url: string;
  projectId: number;
  json: boolean;
}

/** Runs `cartografo settings` / `cartografo settings get`. */
export async function runSettingsGet(options: SettingsGetOptions): Promise<number> {
  const response = await requestJson(`${options.url}/v1/settings?project_id=${options.projectId}`);
  if (response.status !== 200) return genericRefusal(response);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  const body = isObject(response.body) ? response.body : {};
  for (const key of SETTING_KEYS) {
    if (body[key] !== undefined) process.stdout.write(`${key}: ${String(body[key])}\n`);
  }
  return 0;
}

/** Options of `settings set`. */
export interface SettingsSetOptions {
  url: string;
  key: string;
  value: string;
  projectId: number;
  json: boolean;
}

/**
 * Runs `cartografo settings set <key> <value>`.
 *
 * @throws {UsageError} When `key` is not one of {@link SETTING_KEYS} — refused
 *   before any request is made (FR22), so the refusal costs no round trip.
 */
export async function runSettingsSet(options: SettingsSetOptions): Promise<number> {
  if (!(SETTING_KEYS as readonly string[]).includes(options.key)) {
    throw new UsageError(`settings set: unknown key "${options.key}" (expected one of ${SETTING_KEYS.join(', ')})`);
  }

  const response = await requestJson(`${options.url}/v1/settings`, {
    method: 'PATCH',
    body: { [options.key]: options.value, project_id: options.projectId },
  });
  if (response.status !== 200) return genericRefusal(response);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  const body = isObject(response.body) ? response.body : {};
  for (const key of SETTING_KEYS) {
    if (body[key] !== undefined) process.stdout.write(`${key}: ${String(body[key])}\n`);
  }
  return 0;
}
