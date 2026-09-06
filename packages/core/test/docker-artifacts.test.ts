/**
 * Acceptance tests for the container artifacts (t250, FR1-FR10; D23).
 *
 * D23 promises "an official Docker image" for the control plane and the screen.
 * These cases pin the SHAPE of what that promise ships — the `Dockerfile`, the
 * `.dockerignore` and the `compose.yml` at the repository root — plus the two
 * prose claims a reader depends on. Everything here is a file read: no Docker
 * daemon, no build, no network. The real build and the real restart live next
 * door in `docker-image.e2e.test.ts`, which skips itself where Docker is not
 * installed; this file has to run everywhere, because these are the properties
 * that go wrong silently.
 *
 * The three that matter most, and why each is a test rather than a comment:
 *
 * - **No `ENV CARTOGRAFO_HOST` in the image.** `packages/core/src/index.ts:31-39`
 *   says loopback is the default precisely so that starting the product does not
 *   decide for its operator that the port is open. An image that baked
 *   `0.0.0.0` in would take that decision back, for every container anyone ever
 *   runs from it. Opening the port belongs to `compose.yml`, where an operator
 *   reads it.
 * - **The database lives at `/data`, on a named volume.** Otherwise it lives on
 *   the container's writable layer and a `docker rm` is a data loss nobody was
 *   warned about.
 * - **The screen's baked healthcheck is disabled for its own service.** The
 *   image's `HEALTHCHECK` probes the control plane's port, which the screen
 *   never listens on; left enabled, that service reports unhealthy forever for
 *   a reason that means nothing.
 *
 * `compose.yml` is read with a small indentation reader rather than a YAML
 * parser. Nothing in this repository depends on one — the only `yaml` on disk is
 * a transitive dependency of `@fastify/swagger-ui`, and a test that reached for
 * it would be pinning somebody else's dependency tree. The subset needed here is
 * "the block nested under this key", which is a dozen lines.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

const DOCKERFILE = path.join(REPO_ROOT, 'Dockerfile');
const DOCKERIGNORE = path.join(REPO_ROOT, '.dockerignore');
const COMPOSE = path.join(REPO_ROOT, 'compose.yml');
const README = path.join(REPO_ROOT, 'README.md');
const PLAIN_EXPLANATION = path.join(REPO_ROOT, 'docs', 'what-cartografo-is.md');

/** The heading FR9 puts the container instructions under. */
const CONTAINER_HEADING = '## Running in a container';

/** The paragraph FR10 appends its one sentence to (D19). */
const INSTALL_PARAGRAPH = '**Install it and bring it up in one command.**';

/**
 * Reads a file the suite requires, complaining about the missing artifact
 * rather than about `ENOENT`.
 *
 * @param file Absolute path.
 * @param what What the file is, for the complaint.
 * @returns Its contents.
 */
function required(file: string, what: string): string {
  assert.ok(existsSync(file), `${what} does not exist at ${path.relative(REPO_ROOT, file)}`);
  return readFileSync(file, 'utf8');
}

/** Columns of leading whitespace on a line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Whether a line carries no content of its own (blank, or a comment). */
function isFiller(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/**
 * The block nested under `key:` at the given indentation.
 *
 * Stops at the first line of content indented at or below the key itself, which
 * is the whole of YAML's block structure that this file needs. Blank lines and
 * comments never close a block.
 *
 * @param source Text to read.
 * @param key Mapping key, without its colon.
 * @param indent Columns the key itself is indented by.
 * @returns The nested lines, joined; empty when the key is absent.
 */
function blockUnder(source: string, key: string, indent: number): string {
  const lines = source.split('\n');
  const head = lines.findIndex(
    (line) => indentOf(line) === indent && line.trimStart().startsWith(`${key}:`),
  );
  if (head === -1) return '';

  const body: string[] = [];
  for (const line of lines.slice(head + 1)) {
    if (isFiller(line)) {
      body.push(line);
      continue;
    }
    if (indentOf(line) <= indent) break;
    body.push(line);
  }
  return body.join('\n');
}

/** The mapping keys declared at the given indentation, in order. */
function keysAt(source: string, indent: number): string[] {
  return source
    .split('\n')
    .filter((line) => !isFiller(line) && indentOf(line) === indent)
    .map((line) => /^([^:]+):/.exec(line.trim())?.[1] ?? '')
    .filter((key) => key !== '');
}

/**
 * The `KEY: value` pairs of an `environment:` block, with any quoting removed.
 *
 * @param service Raw service block.
 * @returns Environment as a plain record.
 */
function environmentOf(service: string): Record<string, string> {
  const block = blockUnder(service, 'environment', 4);
  const pairs: Record<string, string> = {};
  for (const line of block.split('\n')) {
    if (isFiller(line)) continue;
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    pairs[match[1] as string] = (match[2] as string).trim().replace(/^["']|["']$/g, '');
  }
  return pairs;
}

/** The section of a markdown document opened by `heading`, up to the next `## `. */
function sectionUnder(document: string, heading: string): string {
  const start = document.indexOf(heading);
  if (start === -1) return '';
  const rest = document.slice(start + heading.length);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

/** The paragraph a marker opens, up to the first blank line. */
function paragraphFrom(document: string, marker: string): string {
  const start = document.indexOf(marker);
  if (start === -1) return '';
  const rest = document.slice(start);
  const end = rest.indexOf('\n\n');
  return end === -1 ? rest : rest.slice(0, end);
}

test('t250 AT — the Dockerfile takes no decision the operator has to take', () => {
  const dockerfile = required(DOCKERFILE, 'the Dockerfile');

  assert.equal(
    dockerfile.split('\n').filter((line) => /^\s*ENV\s+CARTOGRAFO_HOST\b/.test(line)).length,
    0,
    'the image must not bake `CARTOGRAFO_HOST`: opening the port is the operator\'s\n' +
      'decision, taken in `compose.yml` where it can be read, and the image inherits\n' +
      'the loopback default of `packages/core/src/index.ts:31-39` instead.',
  );

  assert.match(
    dockerfile,
    /^\s*EXPOSE\s+4317\s+4318\s*$/m,
    'both ports are exposed: either binary may be the one a container from this image runs',
  );

  const healthcheck = dockerfile
    .split('\n')
    .find((line) => /^\s*HEALTHCHECK\b/.test(line));
  assert.notEqual(healthcheck, undefined, 'the image declares no HEALTHCHECK');
  assert.match(
    healthcheck as string,
    /\/health/,
    'the HEALTHCHECK has to probe `GET /health` (`packages/core/src/routes/health.ts:47-57`)',
  );
});

test('t250 AT — .dockerignore keeps the checkout out of the build context', () => {
  const ignored = required(DOCKERIGNORE, '.dockerignore')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  for (const entry of ['.git', 'node_modules', '.cartografo']) {
    assert.ok(
      ignored.some((line) => line === entry || line.replace(/^\*\*\//, '').replace(/\/$/, '') === entry),
      `.dockerignore does not exclude "${entry}" — it mirrors .gitignore:2-8,20\n` +
        `what it does exclude: ${ignored.join(', ')}`,
    );
  }
});

test('t250 AT — compose.yml wires two services, one image and one volume', () => {
  const compose = required(COMPOSE, 'compose.yml');

  assert.doesNotMatch(
    compose,
    /^version:/m,
    'the Compose Specification dropped the top-level `version:` key; it is obsolete',
  );

  const services = blockUnder(compose, 'services', 0);
  assert.deepEqual(
    keysAt(services, 2).sort(),
    ['control-plane', 'screen'],
    'compose.yml declares exactly the two services the image serves',
  );

  const controlPlane = blockUnder(services, 'control-plane', 2);
  const controlPlaneEnv = environmentOf(controlPlane);
  assert.equal(
    controlPlaneEnv.CARTOGRAFO_HOST,
    '0.0.0.0',
    'the one place the port is opened is the compose service, not the image',
  );
  assert.equal(
    controlPlaneEnv.CARTOGRAFO_DB_PATH,
    '/data/cartografo.db',
    'the database file sits inside the mount point, not beside it',
  );
  assert.match(
    blockUnder(controlPlane, 'volumes', 4),
    /:\/data\b/,
    'the control plane mounts a volume at /data, or its database dies with the container',
  );

  const screen = blockUnder(services, 'screen', 2);
  const command = screen
    .split('\n')
    .find((line) => indentOf(line) === 4 && line.trimStart().startsWith('command:'));
  assert.notEqual(command, undefined, 'the screen service declares no `command:` of its own');
  assert.match(
    command as string,
    /cartografo-screen/,
    "the screen service replaces the image's default command with `cartografo-screen`",
  );

  const screenEnv = environmentOf(screen);
  assert.equal(
    screenEnv.CARTOGRAFO_URL,
    'http://control-plane:4317',
    'the screen reaches the control plane by its compose service name',
  );

  assert.match(
    blockUnder(screen, 'healthcheck', 4),
    /disable:\s*true/,
    'the image\'s baked healthcheck probes port 4317, which the screen never listens on:\n' +
      'left enabled it reports unhealthy forever, for a reason that means nothing',
  );

  assert.notEqual(
    blockUnder(compose, 'volumes', 0).trim(),
    '',
    'the named volume the control plane mounts has to be declared at the top level',
  );
});

test('t250 AT — the README tells an operator the runner stays out of the container', () => {
  const readme = required(README, 'README.md');

  assert.ok(readme.includes(CONTAINER_HEADING), `README.md has no "${CONTAINER_HEADING}" heading`);

  const section = sectionUnder(readme, CONTAINER_HEADING);
  const sentences = section.split(/(?<=[.!?])\s+/);
  const claim = sentences.find(
    (sentence) =>
      /runner/i.test(sentence) &&
      /container|image/i.test(sentence) &&
      /\bnot\b|outside|on the host/i.test(sentence),
  );
  assert.notEqual(
    claim,
    undefined,
    'the container section has to say plainly that the runner is not part of the image (D23):\n' +
      'it needs the authenticated engine CLI and the target repository on the machine it runs on.\n' +
      `section read:\n${section}`,
  );
});

test('t250 AT — the plain explanation mentions the container image (D19)', () => {
  const explanation = required(PLAIN_EXPLANATION, 'docs/what-cartografo-is.md');
  const paragraph = paragraphFrom(explanation, INSTALL_PARAGRAPH);

  assert.notEqual(paragraph, '', `docs/what-cartografo-is.md has no "${INSTALL_PARAGRAPH}" paragraph`);
  assert.match(
    paragraph,
    /container/i,
    'D19 asks the living document to move with the product: the paragraph about bringing\n' +
      'cartografo up says nothing about the container image this delivery ships',
  );
});
