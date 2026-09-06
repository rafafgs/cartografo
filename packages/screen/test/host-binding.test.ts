/**
 * The screen's listening address is configurable, and still loopback by default
 * (t250; D23).
 *
 * Until this ticket the address was a constant. That was right for every way the
 * screen had ever been started — `npx cartografo` and `npx cartografo-screen`,
 * both on the operator's own machine — and it is unworkable for the one D23 adds:
 * inside a container, `127.0.0.1` is the container's own loopback, so a published
 * `4318:4318` maps the host's port onto an interface nothing listens on. The
 * screen comes up, reports itself ready, and refuses every connection from the
 * browser it exists for.
 *
 * So the constant became a default, and nothing else moved: with no
 * `CARTOGRAFO_SCREEN_HOST` in the environment the screen binds exactly where it
 * always did. The reason that default matters is the one `server.ts` already
 * writes down — the screen holds a service credential and asks the browser for
 * none, so its port is what keeps a passer-by away from the only writer in the
 * system. Opening it is a decision, and this is the knob that lets `compose.yml`
 * take it in a place an operator can read.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startScreenRouter } from '../src/router.ts';
import {
  DEFAULT_SCREEN_HOST,
  SCREEN_HOST_ENV,
  resolveScreenHost,
  startScreen,
} from '../src/server.ts';

test('t250 AT — with nothing configured, the screen still binds loopback', () => {
  assert.equal(DEFAULT_SCREEN_HOST, '127.0.0.1');
  assert.equal(resolveScreenHost({}), DEFAULT_SCREEN_HOST);
});

test('t250 AT — a blank value is not a configuration', () => {
  assert.equal(resolveScreenHost({ [SCREEN_HOST_ENV]: '' }), DEFAULT_SCREEN_HOST);
  assert.equal(resolveScreenHost({ [SCREEN_HOST_ENV]: '   ' }), DEFAULT_SCREEN_HOST);
});

test('t250 AT — CARTOGRAFO_SCREEN_HOST moves the address', () => {
  assert.equal(resolveScreenHost({ [SCREEN_HOST_ENV]: '0.0.0.0' }), '0.0.0.0');
  assert.equal(resolveScreenHost({ [SCREEN_HOST_ENV]: ' 0.0.0.0 ' }), '0.0.0.0');
});

test('t250 AT — the address the COMMAND binds is the resolved one too', async () => {
  // The case that matters most, and the one the first pass of this file missed:
  // `packages/screen/bin/screen.mjs` runs `runScreenCli` out of `router.ts`,
  // which had a listening address of its own. A knob honoured only by
  // `server.ts` moves nothing at all inside the container — the screen comes up
  // on the container's own loopback, announces itself ready, and refuses the
  // browser.
  const before = process.env[SCREEN_HOST_ENV];
  process.env[SCREEN_HOST_ENV] = '0.0.0.0';

  const screen = await startScreenRouter({
    controlPlaneUrl: 'http://127.0.0.1:4317',
    port: 0,
  }).finally(() => {
    if (before === undefined) delete process.env[SCREEN_HOST_ENV];
    else process.env[SCREEN_HOST_ENV] = before;
  });

  try {
    assert.match(
      screen.url,
      /^http:\/\/0\.0\.0\.0:\d+$/,
      'the screen the command starts is on another address than the one asked for',
    );
  } finally {
    await screen.close();
  }
});

test('t250 AT — the resolved address is the one the socket actually binds', async () => {
  // Port 0, and closed on the next line: what is under test is which interface
  // `listen` was handed, not that anything can be reached on it.
  const screen = await startScreen({
    [SCREEN_HOST_ENV]: '0.0.0.0',
    CARTOGRAFO_SCREEN_PORT: '0',
  });

  try {
    const address = screen.server.address();
    assert.notEqual(address, null);
    assert.equal(
      typeof address === 'string' ? address : address?.address,
      '0.0.0.0',
      'the constant is still being passed to `listen` somewhere below `resolveScreenHost`',
    );
    assert.match(
      screen.url,
      /^http:\/\/0\.0\.0\.0:\d+$/,
      'the readiness line has to name the address the screen is really on',
    );
  } finally {
    await screen.close();
  }
});
