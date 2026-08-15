/**
 * Unit tests of the lease ceiling configuration (t157, FR1).
 *
 * The ceiling the server enforces is a decision of the CONTROL PLANE (D1), and
 * a decision has to come from somewhere the request cannot reach: these two
 * functions are that somewhere. They mirror `serverPort`/`CARTOGRAFO_PORT`
 * (`src/index.ts`) down to the shape of the failure — unset or blank keeps the
 * default, a valid value overrides it, and anything that is not a positive
 * integer dies at startup with a message that names the variable instead of
 * silently degrading into a cap nobody chose.
 *
 * The environment is passed in as an argument, never read off `process.env`
 * here: a config test that mutates the real environment leaks into every other
 * test in the process.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type * as IndexModule from '../src/index.ts';
import type * as LeaseRoutesModule from '../src/routes/leases.ts';

let indexCache: typeof IndexModule | null = null;
let leaseRoutesCache: typeof LeaseRoutesModule | null = null;

async function loadIndex(): Promise<typeof IndexModule> {
  indexCache ??= (await import(
    new URL('../src/index.ts', import.meta.url).href
  )) as typeof IndexModule;
  return indexCache;
}

async function loadLeaseRoutes(): Promise<typeof LeaseRoutesModule> {
  leaseRoutesCache ??= (await import(
    new URL('../src/routes/leases.ts', import.meta.url).href
  )) as typeof LeaseRoutesModule;
  return leaseRoutesCache;
}

/** The two resolvers, side by side with the variable and the default each one owns. */
async function resolvers(): Promise<
  Array<{
    name: string;
    variable: string;
    fallback: number;
    resolve: (env: NodeJS.ProcessEnv) => number;
  }>
> {
  const { ENV_LEASE_CAP_RUNNER, ENV_LEASE_CAP_PROJECT, leaseCapRunner, leaseCapProject } =
    await loadIndex();
  const { DEFAULT_LEASE_CAP_RUNNER, DEFAULT_LEASE_CAP_PROJECT } = await loadLeaseRoutes();

  for (const [name, value] of [
    ['leaseCapRunner', leaseCapRunner],
    ['leaseCapProject', leaseCapProject],
  ] as const) {
    assert.equal(typeof value, 'function', `artifact does not exist yet: ${name} in src/index.ts`);
  }

  return [
    {
      name: 'leaseCapRunner',
      variable: ENV_LEASE_CAP_RUNNER,
      fallback: DEFAULT_LEASE_CAP_RUNNER,
      resolve: leaseCapRunner,
    },
    {
      name: 'leaseCapProject',
      variable: ENV_LEASE_CAP_PROJECT,
      fallback: DEFAULT_LEASE_CAP_PROJECT,
      resolve: leaseCapProject,
    },
  ];
}

test('t157 FR1 — an unset or blank variable keeps the package default', async () => {
  for (const { name, variable, fallback, resolve } of await resolvers()) {
    assert.equal(typeof variable, 'string', `${name} has no environment variable name`);
    assert.ok(variable.startsWith('CARTOGRAFO_'), `${variable} is outside the CARTOGRAFO_ prefix`);
    assert.ok(Number.isInteger(fallback) && fallback > 0, `${name}'s default is not a positive integer`);

    assert.equal(resolve({}), fallback, `${name} without the variable is the default`);
    assert.equal(resolve({ [variable]: '' }), fallback, `${name} with an empty value is the default`);
    assert.equal(resolve({ [variable]: '   ' }), fallback, `${name} with a blank value is the default`);
  }
});

test('t157 FR1 — a valid value overrides the default', async () => {
  for (const { name, variable, resolve } of await resolvers()) {
    assert.equal(resolve({ [variable]: '3' }), 3, `${name} honors the configured ceiling`);
    assert.equal(resolve({ [variable]: ' 12 ' }), 12, `${name} tolerates surrounding blanks`);
    assert.equal(resolve({ [variable]: '1' }), 1, `${name} accepts the smallest usable ceiling`);
  }
});

test('t157 FR1 — a value that is not a positive integer dies naming the variable', async () => {
  for (const { name, variable, resolve } of await resolvers()) {
    for (const invalid of ['abc', '0', '-1', '2.5', 'NaN']) {
      assert.throws(
        () => resolve({ [variable]: invalid }),
        (error: unknown) => {
          assert.ok(error instanceof Error, `${name} has to throw an Error for ${invalid}`);
          assert.ok(
            error.message.includes(variable),
            `the message has to name the variable: ${error.message}`,
          );
          return true;
        },
        `${name} accepted ${JSON.stringify(invalid)}, which is not a positive integer`,
      );
    }
  }
});
