/**
 * Acceptance test for the error line of `cartografo job <id>` (t1313, FR8).
 *
 * A session the runner closed after a post-engine failure carries the error in
 * its `session.finished` event (`data.error`). The `sessions:` section prints
 * it as one indented line under that session's row, and prints nothing new for
 * a session closed without one.
 *
 * Against a real control plane through the real binary, seeded through the
 * public API, the posture `cli-reads.test.ts` takes.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { runCli, startControlPlane, temporaryArea, type RunningControlPlane } from './cli-support.ts';

interface Created {
  id: number;
}

async function send<T>(
  plane: RunningControlPlane,
  method: string,
  route: string,
  body: unknown,
  expected: number,
): Promise<T> {
  const response = await fetch(`${plane.url}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${String(response.status)}: ${text}`);
  return JSON.parse(text) as T;
}

async function sessionOn(plane: RunningControlPlane, jobId: number): Promise<number> {
  const session = await send<Created>(
    plane,
    'POST',
    '/v1/sessions',
    {
      job_id: jobId,
      node_id: 'implement',
      engine: 'shell',
      working_dir: '/tmp/cartografo',
      prompt: 'do the step',
    },
    201,
  );
  return session.id;
}

/** The lines of the `sessions:` section, up to the end of the output. */
function sessionsSection(stdout: string): string[] {
  const lines = stdout.replace(/\n$/, '').split('\n');
  const start = lines.indexOf('sessions:');
  assert.ok(start >= 0, `no sessions: section in:\n${stdout}`);
  return lines.slice(start + 1);
}

test(
  't1313 AT12 — job <id> prints a closed session’s error under its row, and nothing for the rest',
  { timeout: 180_000 },
  async (t) => {
    const area = temporaryArea(t, 'cartografo-t1313-cli-');
    const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

    const job = await send<Created>(
      plane,
      'POST',
      '/v1/jobs',
      { title: 'a job with a dead tick', entry_node_id: 'implement' },
      201,
    );
    const failed = await sessionOn(plane, job.id);
    const longError = `UploadError: the artifact store\nis unreachable ${'x'.repeat(300)}`;
    await send(plane, 'PATCH', `/v1/sessions/${String(failed)}/finish`, { status: 'failed', error: longError }, 200);
    const clean = await sessionOn(plane, job.id);
    await send(plane, 'PATCH', `/v1/sessions/${String(clean)}/finish`, { status: 'completed', exit_code: 0 }, 200);

    const human = await runCli(['job', String(job.id), '--url', plane.url], { token: plane.token });
    assert.equal(human.code, 0, `stderr:\n${human.stderr}`);
    const section = sessionsSection(human.stdout);

    const failedRow = section.findIndex((line) => new RegExp(`^${String(failed)}\\s`).test(line));
    const cleanRow = section.findIndex((line) => new RegExp(`^${String(clean)}\\s`).test(line));
    assert.ok(failedRow > 0 && cleanRow > 0, `both rows are listed:\n${section.join('\n')}`);

    const collapsed = longError.replace(/\s+/g, ' ');
    const expected = `${collapsed.slice(0, 199)}…`;
    assert.equal(
      section[failedRow + 1],
      `  error: ${expected}`,
      'the error, on one line, cut to 200 characters, directly below its row',
    );
    assert.equal(expected.length, 200);
    const afterClean = section[cleanRow + 1];
    assert.ok(
      afterClean === undefined || !afterClean.startsWith('  error:'),
      'a session closed without an error prints no error line',
    );
    assert.equal(section.filter((line) => line.startsWith('  error:')).length, 1);

    // Without the feature's line, the section is exactly the table: a header
    // and one row per session, and nothing else.
    const withoutErrorLines = section.filter((line) => !line.startsWith('  error:'));
    assert.equal(withoutErrorLines.length, 3, 'header + two rows');
    assert.match(withoutErrorLines[0], /^id\s+job_id\s+execution_id/);

    // A job with no error at all prints the section exactly as before.
    const quiet = await send<Created>(
      plane,
      'POST',
      '/v1/jobs',
      { title: 'a job whose sessions all closed cleanly', entry_node_id: 'implement' },
      201,
    );
    const ok = await sessionOn(plane, quiet.id);
    await send(plane, 'PATCH', `/v1/sessions/${String(ok)}/finish`, { status: 'failed', exit_code: 1 }, 200);
    const quietOut = await runCli(['job', String(quiet.id), '--url', plane.url], { token: plane.token });
    assert.equal(quietOut.code, 0, `stderr:\n${quietOut.stderr}`);
    assert.doesNotMatch(quietOut.stdout, /error:/, 'no error line anywhere');
    const quietSection = sessionsSection(quietOut.stdout);
    assert.equal(quietSection.length, 2, 'header + one row, byte for byte the table alone');
    assert.match(quietSection[1], new RegExp(`^${String(ok)}\\s.*\\sfailed\\s+1\\s`));

    // --json is the API's own answer: `events` already carries the field.
    const json = await runCli(['job', String(job.id), '--json', '--url', plane.url], { token: plane.token });
    assert.equal(json.code, 0, `stderr:\n${json.stderr}`);
    const parsed = JSON.parse(json.stdout) as {
      events: { events: Array<{ type: string; entity: { id: number }; data: Record<string, unknown> }> };
    };
    const finished = parsed.events.events.find(
      (event) => event.type === 'session.finished' && event.entity.id === failed,
    );
    assert.equal(finished?.data.error, longError);
  },
);
