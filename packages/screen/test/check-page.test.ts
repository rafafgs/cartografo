/**
 * Acceptance tests of the check page — the screen's new root (t402).
 *
 * RNF-01 says nothing is asked that the system can discover, and this page is
 * that rule applied to the first thing a person opens: `/` stops being the
 * proposal inbox and becomes a check that runs itself, out of two reads the API
 * already publishes (`GET /v1/runners` with t401's embedded probe, and
 * `GET /v1/settings` from t403). The screen gains no privilege and the control
 * plane gains no route (D11) — everything below is a rendering or a routing
 * decision, and therefore observable in a response.
 *
 * Two levels, the same split `runners.test.ts` already uses and for the same
 * reason:
 *
 * - the MARKUP is pinned against a fake `fetch`, because a runner whose CLI is
 *   missing, whose adapter cannot answer about MCP at all, or that has never
 *   reported is impossible to seed through a real control plane without a real
 *   runner process on a deliberately broken machine;
 * - the two WRITE routes are exercised end to end against a real control plane
 *   and a real screen, because "the form reached the API" is a claim about the
 *   wiring, and it is proven by reading the control plane back independently of
 *   the screen — the discipline `docs/spec/screen.md` §3 already demands of the
 *   answer form.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiClient } from '../src/client.ts';
import type * as PagesModule from '../src/pages.ts';
import {
  T107_ARTIFACTS,
  api,
  blocks,
  openPage,
  requireArtifacts,
  startControlPlane,
  startScreen,
  submitForm,
} from './support.ts';

const BASE_URL = 'http://127.0.0.1:4317';

/** The support address the page carries, once, whatever it is showing (FR7). */
const SUPPORT = 'mailto:hello@agentsmaestro.dev';

/**
 * The probe as `GET /v1/runners` embeds it (t401), declared here rather than
 * imported: this file is a consumer of the WIRE, and a local declaration is
 * what makes a field the control plane stops sending fail in this test instead
 * of silently type-checking against the screen's own copy.
 */
interface Probe {
  runner_id: string;
  reported_at: string;
  cli: { available: boolean; version: string | null; authenticated: boolean };
  mcp:
    | { supported: false }
    | {
        supported: true;
        servers: { name: string }[];
        origin: 'cli' | 'file';
        resolved_at: string | null;
      };
  workspace: {
    working_dir: string;
    working_dir_resolved: string;
    is_git_repo: boolean;
    worktrees_root: string;
    worktrees_root_resolved: string;
    worktrees_root_exists: boolean;
    worktrees_root_writable: boolean;
  };
}

/** A runner's health, as `GET /v1/runners` returns it since t401. */
interface RunnerHealth {
  id: string;
  name: string | null;
  registered_at: string;
  active_leases: number;
  last_heartbeat: string | null;
  last_expiration: null;
  probe: Probe | null;
}

/** A probe where every one of the four checks passes; overridden per test. */
function healthyProbe(overrides: Partial<Probe> = {}): Probe {
  return {
    runner_id: 'runner-a',
    reported_at: '2026-09-06T10:00:00.000Z',
    cli: { available: true, version: '2.1.263', authenticated: true },
    mcp: {
      supported: true,
      servers: [{ name: 'cartografo' }],
      origin: 'cli',
      resolved_at: '2026-09-06T10:00:00.000Z',
    },
    workspace: {
      working_dir: '~/proj',
      working_dir_resolved: '/home/rafael/proj',
      is_git_repo: true,
      worktrees_root: '~/proj-worktrees',
      worktrees_root_resolved: '/home/rafael/proj-worktrees',
      worktrees_root_exists: true,
      worktrees_root_writable: true,
    },
    ...overrides,
  };
}

/** A paired runner, by id, carrying the probe it reported (or none). */
function paired(id: string, probe: Probe | null): RunnerHealth {
  return {
    id,
    name: null,
    registered_at: '2026-09-06T09:00:00.000Z',
    active_leases: 0,
    last_heartbeat: null,
    last_expiration: null,
    probe,
  };
}

/**
 * Loads `pages.ts` and fails naming the missing export, instead of letting the
 * link of a static import blow up with no diagnosis.
 */
async function loadPages(): Promise<typeof PagesModule> {
  requireArtifacts(T107_ARTIFACTS.pages);
  const pages = (await import(
    new URL('../src/pages.ts', import.meta.url).href
  )) as typeof PagesModule;
  assert.equal(
    typeof pages.checkPage,
    'function',
    'artifact does not exist yet: checkPage in packages/screen/src/pages.ts',
  );
  return pages;
}

/** What the fake control plane was asked, so a test can pin the scope of it. */
interface Asked {
  paths: string[];
}

/**
 * A client whose control plane answers exactly the two reads this page makes.
 *
 * Anything else is a failure and not an empty answer: the page's whole claim is
 * that it discovers rather than asks, and a third read nobody declared would be
 * a claim about a route this ticket never opened.
 */
function clientAnswering(
  fleet: RunnerHealth[],
  settings: Record<string, string> = {},
  asked: Asked = { paths: [] },
): ApiClient {
  return new ApiClient({
    baseUrl: BASE_URL,
    doFetch: async (input) => {
      const url = new URL(String(input));
      asked.paths.push(`${url.pathname}${url.search}`);

      const body =
        url.pathname === '/v1/runners'
          ? { runners: fleet }
          : url.pathname === '/v1/settings'
            ? { project_id: Number(url.searchParams.get('project_id') ?? '1'), ...settings }
            : null;

      assert.ok(body !== null, `the check page read ${url.pathname}, which it has no business reading`);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

/* ------------------------------------------------------------------ AT1 */

test('t402 AT1 — with nobody paired the page is one line: the pairing command, built from the settings', async () => {
  const { checkPage } = await loadPages();
  const asked: Asked = { paths: [] };

  const page = await checkPage(
    clientAnswering([], { workspace_root: '/srv/proj', worktrees_root: '/srv/proj-worktrees', engine: 'codex' }, asked),
    { projectId: 1, projects: [] },
  );

  assert.equal(page.status, 200);
  assert.deepEqual(
    blocks(page.html, 'campo').map((line) => line.value),
    ['runner'],
    'exactly one line is drawn, and none of the four probe-derived ones',
  );
  assert.ok(page.html.includes('no runner paired'), `the line does not name what is missing:\n${page.html}`);
  assert.match(page.html, /<pre><code>/, 'the fix action is a copyable command block');
  assert.ok(
    page.html.includes(
      'npx cartografo-runner --project 1 --working-dir /srv/proj --worktrees-root /srv/proj-worktrees --engine codex',
    ),
    `the pairing command is not built from the settings:\n${page.html}`,
  );

  // The settings read is project-scoped; the fleet read deliberately is not
  // (`listRunners` — pairing is identity alone).
  assert.ok(
    asked.paths.includes('/v1/settings?project_id=1'),
    `the settings read is not scoped to the cookie's project: ${asked.paths.join(', ')}`,
  );
  assert.ok(asked.paths.includes('/v1/runners'), `the fleet was not read: ${asked.paths.join(', ')}`);

  assert.equal(
    page.html.split(SUPPORT).length - 1,
    1,
    'the support link appears exactly once, whatever the page is showing',
  );
});

test('t402 AT1 — with no settings recorded the pairing command falls back to placeholders', async () => {
  const { checkPage } = await loadPages();

  const page = await checkPage(clientAnswering([], {}), { projectId: 3, projects: [] });

  assert.match(
    page.html,
    /npx cartografo-runner --project 3 --working-dir &lt;[^&]+&gt; --worktrees-root &lt;[^&]+&gt; --engine claude-code/,
    `the placeholder form of the pairing command is missing:\n${page.html}`,
  );
});

/* ------------------------------------------------------------------ AT2 */

test('t402 AT2 — a runner that has never reported gets four waiting lines and only the check-again form', async () => {
  const { checkPage } = await loadPages();

  const page = await checkPage(clientAnswering([paired('runner-a', null)]), {
    projectId: 1,
    projects: [],
  });

  const lines = blocks(page.html, 'campo');
  assert.deepEqual(
    lines.map((line) => line.value),
    ['engine', 'credential', 'mcp', 'workspace'],
    'the four lines are drawn even with nothing known yet',
  );

  for (const line of lines) {
    assert.ok(
      line.excerpt.includes('waiting for this runner&#39;s first report'),
      `${line.value} diagnoses something the probe never said:\n${line.excerpt}`,
    );
    assert.ok(
      line.excerpt.includes('action="/runners/runner-a/rechecks"'),
      `${line.value} has no check-again form:\n${line.excerpt}`,
    );
    assert.ok(
      !line.excerpt.includes('action="/settings"'),
      `${line.value} offers to fix a workspace nobody has described yet`,
    );
    assert.ok(!/mcp add/.test(line.excerpt), `${line.value} suggests an MCP command with nothing to react to`);
    assert.ok(!/ANTHROPIC_API_KEY/.test(line.excerpt), `${line.value} names a credential with nothing to react to`);
  }
});

/* ------------------------------------------------------------------ AT3 */

test('t402 AT3 — a CLI that is not there is an unmet engine line, with the fix its own engine takes', async () => {
  const { checkPage } = await loadPages();
  const missing = healthyProbe({ cli: { available: false, version: null, authenticated: false } });

  const forClaude = await checkPage(clientAnswering([paired('runner-a', missing)], { engine: 'claude-code' }), {
    projectId: 1,
    projects: [],
  });
  const claudeLine = blocks(forClaude.html, 'campo').find((line) => line.value === 'engine');
  assert.ok(claudeLine !== undefined, 'no engine line was drawn');
  assert.ok(claudeLine.excerpt.includes('claude'), `the engine line does not name the binary:\n${claudeLine.excerpt}`);
  assert.ok(
    !claudeLine.excerpt.includes('npm install'),
    'no npm package name for the claude CLI is evidenced in this repository, and none is invented here',
  );

  const forCodex = await checkPage(clientAnswering([paired('runner-a', missing)], { engine: 'codex' }), {
    projectId: 1,
    projects: [],
  });
  const codexLine = blocks(forCodex.html, 'campo').find((line) => line.value === 'engine');
  assert.ok(codexLine !== undefined, 'no engine line was drawn');
  assert.ok(
    codexLine.excerpt.includes('npx --yes @openai/codex@latest'),
    `the codex fix action does not cite the evidenced no-install way to run it:\n${codexLine.excerpt}`,
  );
});

test('t402 AT3 — a CLI that is there with no version is still met, and says so', async () => {
  const { checkPage } = await loadPages();

  // One line has to be unmet for any line to be drawn at all (FR4): a page
  // where everything passes is the ready panel and nothing else. The workspace
  // is the one broken here, so the engine line is observable.
  const healthy = healthyProbe();
  const page = await checkPage(
    clientAnswering([
      paired('runner-a', {
        ...healthy,
        cli: { available: true, version: null, authenticated: true },
        workspace: { ...healthy.workspace, is_git_repo: false },
      }),
    ]),
    { projectId: 1, projects: [] },
  );

  const line = blocks(page.html, 'campo').find((entry) => entry.value === 'engine');
  assert.ok(line !== undefined, 'no engine line was drawn');
  assert.ok(line.excerpt.includes('version unknown'), `a null version is not read as met:\n${line.excerpt}`);
  assert.match(line.excerpt, /data-estado="met"/, 'an available CLI with no version is met');
});

/* ------------------------------------------------------------------ AT4 */

test('t402 AT4 — an unauthenticated CLI names the variables its own adapter checks, and the file its login writes', async () => {
  const { checkPage } = await loadPages();
  const unauthenticated = healthyProbe({ cli: { available: true, version: '2.1.263', authenticated: false } });

  const forClaude = await checkPage(
    clientAnswering([paired('runner-a', unauthenticated)], { engine: 'claude-code' }),
    { projectId: 1, projects: [] },
  );
  const claudeLine = blocks(forClaude.html, 'campo').find((line) => line.value === 'credential');
  assert.ok(claudeLine !== undefined, 'no credential line was drawn');
  assert.match(claudeLine.excerpt, /data-estado="unmet"/);
  for (const variable of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    assert.ok(
      claudeLine.excerpt.includes(variable),
      `the fix action does not name ${variable}, which claude-code's own adapter checks:\n${claudeLine.excerpt}`,
    );
  }
  assert.ok(
    claudeLine.excerpt.includes('~/.claude.json'),
    `the fix action does not name the credential file the CLI's own login writes:\n${claudeLine.excerpt}`,
  );

  const forCodex = await checkPage(clientAnswering([paired('runner-a', unauthenticated)], { engine: 'codex' }), {
    projectId: 1,
    projects: [],
  });
  const codexLine = blocks(forCodex.html, 'campo').find((line) => line.value === 'credential');
  assert.ok(codexLine !== undefined, 'no credential line was drawn');
  for (const variable of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) {
    assert.ok(
      codexLine.excerpt.includes(variable),
      `the fix action does not name ${variable}, which the codex adapter checks:\n${codexLine.excerpt}`,
    );
  }
  assert.ok(
    codexLine.excerpt.includes('~/.codex/auth.json'),
    `the fix action does not name codex's own credential file:\n${codexLine.excerpt}`,
  );
  assert.ok(
    !codexLine.excerpt.includes('ANTHROPIC_API_KEY'),
    'the credential fix action is the engine that is configured, not both of them',
  );
});

/* ------------------------------------------------------------------ AT5 */

test('t402 AT5 — the MCP line is about the cartografo server, and an adapter that cannot answer is not a failure', async () => {
  const { checkPage } = await loadPages();
  const scope = { projectId: 1, projects: [] };

  const withNone = await checkPage(
    clientAnswering([paired('runner-a', healthyProbe({ mcp: { supported: true, servers: [], origin: 'cli', resolved_at: null } }))], {
      engine: 'claude-code',
    }),
    scope,
  );
  const none = blocks(withNone.html, 'campo').find((line) => line.value === 'mcp');
  assert.ok(none !== undefined, 'no mcp line was drawn');
  assert.match(none.excerpt, /data-estado="unmet"/);
  assert.ok(
    none.excerpt.includes('claude mcp add cartografo'),
    `the fix action is not the engine's own mcp-add command:\n${none.excerpt}`,
  );
  assert.ok(
    none.excerpt.includes('packages/mcp/bin/mcp.mjs'),
    `the mcp-add command does not point at the server it is registering:\n${none.excerpt}`,
  );
  for (const variable of ['CARTOGRAFO_URL', 'CARTOGRAFO_MCP_TOKEN']) {
    assert.ok(none.excerpt.includes(variable), `the mcp-add fix action does not carry ${variable}`);
  }

  const withCodex = await checkPage(
    clientAnswering([paired('runner-a', healthyProbe({ mcp: { supported: true, servers: [], origin: 'cli', resolved_at: null } }))], {
      engine: 'codex',
    }),
    scope,
  );
  const codex = blocks(withCodex.html, 'campo').find((line) => line.value === 'mcp');
  assert.ok(codex !== undefined, 'no mcp line was drawn');
  assert.ok(
    codex.excerpt.includes('codex mcp add cartografo --'),
    `the codex fix action is not the shape the engine's own docs give:\n${codex.excerpt}`,
  );

  // Again with one unmet line, so the met MCP line is drawn rather than
  // collapsed into the ready panel.
  const healthy = healthyProbe();
  const withServer = await checkPage(
    clientAnswering([
      paired('runner-a', {
        ...healthy,
        mcp: { supported: true, servers: [{ name: 'flowpilot' }, { name: 'cartografo' }], origin: 'cli', resolved_at: null },
        workspace: { ...healthy.workspace, is_git_repo: false },
      }),
    ]),
    scope,
  );
  const registered = blocks(withServer.html, 'campo').find((line) => line.value === 'mcp');
  assert.ok(registered !== undefined, 'no mcp line was drawn');
  assert.match(registered.excerpt, /data-estado="met"/, 'the cartografo server is registered, so the line is met');

  const unsupported = await checkPage(
    clientAnswering([paired('runner-a', healthyProbe({ mcp: { supported: false } }))]),
    scope,
  );
  const cannot = blocks(unsupported.html, 'campo').find((line) => line.value === 'mcp');
  assert.ok(cannot !== undefined, 'no mcp line was drawn');
  assert.match(cannot.excerpt, /data-estado="unmet"/);
  assert.ok(
    cannot.excerpt.includes('can&#39;t be checked automatically'),
    `an adapter with no discovery is reported as a false failure:\n${cannot.excerpt}`,
  );
  assert.ok(
    !cannot.excerpt.includes('mcp add'),
    'there is nothing to react to: the adapter cannot say whether the server is there',
  );
});

/* ------------------------------------------------------------------ AT6 */

test('t402 AT6 — an unusable workspace is unmet, with a form prefilled from the probe itself', async () => {
  const { checkPage } = await loadPages();
  const scope = { projectId: 1, projects: [] };

  for (const broken of [{ is_git_repo: false }, { worktrees_root_writable: false }]) {
    const probe = healthyProbe();
    const page = await checkPage(
      clientAnswering(
        [paired('runner-a', { ...probe, workspace: { ...probe.workspace, ...broken } })],
        { workspace_root: '/settings/proj', worktrees_root: '/settings/worktrees' },
      ),
      scope,
    );

    const line = blocks(page.html, 'campo').find((entry) => entry.value === 'workspace');
    assert.ok(line !== undefined, 'no workspace line was drawn');
    assert.match(line.excerpt, /data-estado="unmet"/, `${JSON.stringify(broken)} left the workspace line met`);
    assert.ok(line.excerpt.includes('action="/settings"'), `the fix action is not the settings form:\n${line.excerpt}`);
    assert.ok(
      line.excerpt.includes('name="workspace_root" value="~/proj"'),
      `the form is not prefilled from the probe's own working_dir:\n${line.excerpt}`,
    );
    assert.ok(
      line.excerpt.includes('name="worktrees_root" value="~/proj-worktrees"'),
      `the form is not prefilled from the probe's own worktrees_root:\n${line.excerpt}`,
    );
  }
});

/* ------------------------------------------------------------------ AT7 */

test('t402 AT7 — with every line met the page is the ready panel and a way into the board', async () => {
  const { checkPage } = await loadPages();

  const page = await checkPage(clientAnswering([paired('runner-a', healthyProbe())]), {
    projectId: 1,
    projects: [],
  });

  assert.equal(page.status, 200);
  assert.equal(blocks(page.html, 'pronto').length, 1, 'the ready panel is drawn exactly once');
  assert.deepEqual(blocks(page.html, 'campo'), [], 'no per-line group survives the ready state');
  assert.deepEqual(blocks(page.html, 'runner'), [], 'no per-runner group survives the ready state');
  assert.ok(page.html.includes('href="/board"'), 'the ready panel does not lead into the board');
  assert.equal(page.html.split(SUPPORT).length - 1, 1, 'the support link is there in the ready state too');
});

/* ------------------------------------------------------------------ AT8 */

test('t402 AT8 — a broken runner beside a working one hides neither, and the page is not ready', async () => {
  const { checkPage } = await loadPages();

  const page = await checkPage(
    clientAnswering(
      [
        paired('runner-ok', healthyProbe({ runner_id: 'runner-ok' })),
        paired(
          'runner-broken',
          healthyProbe({ runner_id: 'runner-broken', cli: { available: false, version: null, authenticated: false } }),
        ),
      ],
      { engine: 'claude-code' },
    ),
    { projectId: 1, projects: [] },
  );

  const groups = blocks(page.html, 'runner');
  assert.deepEqual(
    groups.map((group) => group.value),
    ['runner-ok', 'runner-broken'],
    'both runners get a group of their own, in the order the API sent them',
  );
  assert.deepEqual(blocks(page.html, 'pronto'), [], 'one broken runner is enough for the page not to be ready');

  const [ok, broken] = groups;
  assert.match(ok.excerpt, /data-campo="engine"[^>]*data-estado="met"/, 'the working runner reads as working');
  assert.match(broken.excerpt, /data-campo="engine"[^>]*data-estado="unmet"/, 'the broken runner reads as broken');
});

/* ------------------------------------------------- AT9: POST /runners/:id/rechecks */

/** A pending re-check, as `GET /v1/runners/:id/rechecks` answers it. */
interface Recheck {
  id: number;
  runner_id: string;
  requested_at: string;
  served_at: string | null;
}

test('t402 AT9 — the check-again form asks the control plane for a re-check, and comes back to /', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  await api(cp, 'POST', '/v1/runners', { id: 'runner-a' });

  const screen = await startScreen(t, cp);
  const result = await submitForm(screen, '/runners/runner-a/rechecks', {});

  assert.equal(result.status, 303, 'after a POST the way back is a GET');
  assert.equal(result.location, '/');

  // The proof is not the redirect: it is the state, read back through the
  // public API without going through the screen at all.
  const after = await api<{ recheck: Recheck | null }>(cp, 'GET', '/v1/runners/runner-a/rechecks');
  assert.equal(after.status, 200);
  assert.ok(after.body.recheck !== null, 'no re-check is pending: the screen never asked for one');
  assert.equal(after.body.recheck.runner_id, 'runner-a');
  assert.equal(after.body.recheck.served_at, null, 'nothing has answered it yet — the runner reports on its next tick');
});

test('t402 AT9 — a cross-origin check-again is refused, and nothing is asked of the control plane', async (t) => {
  const cp = await startControlPlane(t);
  await api(cp, 'POST', '/v1/runners', { id: 'runner-a' });

  const screen = await startScreen(t, cp);
  const submission = await fetch(`${screen.url}/runners/runner-a/rechecks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'cross-site',
    },
    body: '',
    redirect: 'manual',
  });

  assert.equal(submission.status, 403);
  assert.ok((await submission.text()).includes('<h2>untrusted origin</h2>'));

  const after = await api<{ recheck: Recheck | null }>(cp, 'GET', '/v1/runners/runner-a/rechecks');
  assert.equal(after.body.recheck, null, 'a form from somewhere else ordered a machine to re-probe');
});

/* ------------------------------------------------------------- AT10: POST /settings */

/** The settings, as `GET /v1/settings` answers them. */
interface Settings {
  project_id: number;
  workspace_root?: string;
  worktrees_root?: string;
  engine?: string;
}

test('t402 AT10 — the settings form writes both roots, drops a blank field, and comes back to /', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  const before = await api<Settings>(cp, 'GET', '/v1/settings?project_id=1');
  assert.equal(before.status, 200);

  const screen = await startScreen(t, cp);
  const both = await submitForm(screen, '/settings', {
    workspace_root: '/srv/proj',
    worktrees_root: '/srv/proj-worktrees',
  });
  assert.equal(both.status, 303);
  assert.equal(both.location, '/');

  const written = await api<Settings>(cp, 'GET', '/v1/settings?project_id=1');
  assert.equal(written.body.workspace_root, '/srv/proj');
  assert.equal(written.body.worktrees_root, '/srv/proj-worktrees');
  assert.equal(written.body.engine, before.body.engine, 'the form writes two keys and touches no third one');

  // A blank field is dropped rather than forwarded: the API refuses an empty
  // string with `invalid_setting_value`, and a screen that sent it would turn a
  // half-filled form into a 502.
  const partial = await submitForm(screen, '/settings', {
    workspace_root: '/srv/other',
    worktrees_root: '',
  });
  assert.equal(partial.status, 303, 'a blank field became a refusal the screen should never have asked for');
  assert.equal(partial.location, '/');

  const kept = await api<Settings>(cp, 'GET', '/v1/settings?project_id=1');
  assert.equal(kept.body.workspace_root, '/srv/other');
  assert.equal(kept.body.worktrees_root, '/srv/proj-worktrees', 'the blank field left the old value alone');
});

test('t402 AT10 — the settings form is scoped to the project of the cookie', async (t) => {
  const cp = await startControlPlane(t);
  const created = await api<{ id: number }>(cp, 'POST', '/v1/projects', { name: 'second' });
  assert.equal(created.status, 201, `POST /v1/projects returned ${created.status}`);
  const other = created.body.id;

  const screen = await startScreen(t, cp);
  const response = await fetch(`${screen.url}/settings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `cartografo_project=${other}`,
    },
    body: new URLSearchParams({ workspace_root: '/srv/second' }).toString(),
    redirect: 'manual',
  });
  assert.equal(response.status, 303);

  const scoped = await api<Settings>(cp, 'GET', `/v1/settings?project_id=${other}`);
  assert.equal(scoped.body.workspace_root, '/srv/second');

  const untouched = await api<Settings>(cp, 'GET', '/v1/settings?project_id=1');
  assert.notEqual(untouched.body.workspace_root, '/srv/second', 'the write leaked into another project');
});

test('t402 AT10 — a cross-origin settings submit is refused, and nothing is written', async (t) => {
  const cp = await startControlPlane(t);
  const before = await api<Settings>(cp, 'GET', '/v1/settings?project_id=1');

  const screen = await startScreen(t, cp);
  const submission = await fetch(`${screen.url}/settings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'cross-site',
    },
    body: new URLSearchParams({ workspace_root: '/srv/evil' }).toString(),
    redirect: 'manual',
  });

  assert.equal(submission.status, 403);
  assert.ok((await submission.text()).includes('<h2>untrusted origin</h2>'));

  const after = await api<Settings>(cp, 'GET', '/v1/settings?project_id=1');
  assert.equal(after.body.workspace_root, before.body.workspace_root, 'a form from somewhere else moved a root');
});

/* -------------------------------------------------- the root, end to end (FR1, FR10) */

test('t402 — GET / is the check page against a real control plane, with the same scope every view gets', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const empty = await openPage(screen, '/');
  assert.equal(empty.status, 200);
  assert.match(empty.contentType ?? '', /^text\/html/);
  assert.ok(empty.html.includes('no runner paired'), `GET / is not the check page:\n${empty.html}`);
  assert.ok(empty.html.includes(SUPPORT), 'the support link is missing from the served page');

  await api(cp, 'POST', '/v1/runners', { id: 'runner-a' });
  const paired = await openPage(screen, '/');
  assert.equal(paired.status, 200);
  assert.deepEqual(
    blocks(paired.html, 'campo').map((line) => line.value),
    ['engine', 'credential', 'mcp', 'workspace'],
    'a paired runner that has never reported still gets its four lines',
  );
});

/* ------------------------------------------------------------------ AT13 */

test('t402 AT13 — every nav leads to the check at / and to the proposals at /inbox', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  for (const route of ['/', '/board', '/examples', '/executions', '/input-requests', '/runners', '/inbox', '/graph-editor.html']) {
    const page = await openPage(screen, route);
    assert.equal(page.status, 200, `${route} returned ${page.status}`);
    assert.ok(page.html.includes('href="/">check</a>'), `${route} does not link the check page`);
    assert.ok(page.html.includes('href="/inbox">proposals</a>'), `${route} does not link the proposals inbox`);
    assert.ok(
      !/href="\/">\s*proposals/.test(page.html),
      `${route} still points "proposals" at the bare root:\n${page.html}`,
    );
  }
});
