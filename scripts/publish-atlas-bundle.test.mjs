/**
 * Acceptance tests of the atlas publish step (t120, AT1-AT5).
 *
 * They cover the script as a CLI — exit code, what lands on disk, what does
 * NOT — because that is the whole contract of a publish step: it either wrote
 * a publishable copy of the bundle or it wrote nothing at all. A bundle that
 * does not validate must not reach the atlas, and the refusal has to be visible
 * as a non-zero exit, not as a warning next to a written file.
 *
 * Zero dependencies: only `node:test`, `node:assert`, `node:child_process`,
 * `node:fs`, `node:os` and `node:path` — the same constraint the reference
 * validator carries.
 *
 * The Portuguese names below are data: the bundle directories, the class names
 * they are named after and the schema keys are frozen by D18's own carve-out.
 *
 * Run with: `npm test` at the root.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'publish-atlas-bundle.mjs');

/** Factory bundle 1 (D14) and the class it publishes under. */
const BUNDLE_ONE = path.join(ROOT, 'grafos-de-fabrica', 'desenvolvimento-de-software');
const CLASS_ONE = 'desenvolvimento-de-software';

/** Factory bundle 2 (D14) — the second class, which proves the atlas is multi-map. */
const BUNDLE_TWO = path.join(ROOT, 'grafos-de-fabrica', 'bets-assimetricas');
const CLASS_TWO = 'bets-assimetricas';

/** The format doc this ticket publishes, and the three files that must point at it. */
const FORMAT_DOC = path.join(ROOT, 'docs', 'formatos', 'atlas-bundle.md');
const FORMAT_DOC_LINK = 'docs/formatos/atlas-bundle.md';
const REFERRERS = [
  path.join(ROOT, 'docs', 'spec', 'grafo.md'),
  path.join(BUNDLE_ONE, 'README.md'),
  path.join(BUNDLE_TWO, 'README.md'),
];

/** Temporary area that disappears at the end of the test. */
function temporaryArea() {
  return mkdtempSync(path.join(tmpdir(), 'cartografo-t120-'));
}

/** Runs the publish script as a child process, the way a person or CI would. */
function runPublish(bundleDir, atlasDir) {
  assert.ok(
    existsSync(SCRIPT_PATH),
    `artifact does not exist yet: ${path.relative(ROOT, SCRIPT_PATH)}`,
  );
  return spawnSync(process.execPath, [SCRIPT_PATH, bundleDir, atlasDir], { encoding: 'utf8' });
}

/** Every file of a bundle directory, as `relative path -> bytes`. */
function snapshot(directory) {
  const files = new Map();
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = path.join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) files.set(relative, readFileSync(absolute));
    }
  };
  walk(directory, '');
  return files;
}

/** The bundle's own files, minus the README that only makes sense in this repo. */
function bundleFiles(directory) {
  return new Map([...snapshot(directory)].filter(([name]) => name !== 'README.md'));
}

test('AT1 — a tampered pin is refused and nothing is written to the atlas', () => {
  const area = temporaryArea();
  const bundle = path.join(area, 'bundle-adulterado');
  cpSync(BUNDLE_ONE, bundle, { recursive: true });

  const target = path.join(bundle, 'skills', 'testar-alpha.json');
  const manifest = JSON.parse(readFileSync(target, 'utf8'));
  manifest.hash = `sha256:${'0'.repeat(64)}`;
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);

  // The atlas checkout already exists — a git working tree someone cloned —
  // which is what makes "wrote nothing" an assertion and not a tautology.
  const atlas = path.join(area, 'atlas');
  mkdirSync(atlas, { recursive: true });

  const result = runPublish(bundle, atlas);

  assert.notEqual(result.status, 0, 'a bundle that does not validate cannot exit 0');
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(output.includes('testar'), `the report has to name the diverging pin:\n${output}`);
  assert.deepEqual(
    existsSync(atlas) ? readdirSync(atlas) : [],
    [],
    'a refused bundle writes nothing at all under the atlas directory',
  );
});

test('AT2 — publishing copies the bundle byte for byte under <atlas>/<classe>/', () => {
  const area = temporaryArea();
  const atlas = path.join(area, 'atlas');

  const result = runPublish(BUNDLE_ONE, atlas);
  assert.equal(result.status, 0, `publishing a valid bundle has to exit 0:\n${result.stderr}`);

  const published = path.join(atlas, CLASS_ONE);
  assert.ok(existsSync(path.join(published, 'grafo.json')), 'the graph document is published');

  const source = bundleFiles(BUNDLE_ONE);
  const copy = snapshot(published);
  assert.deepEqual(
    [...copy.keys()].sort(),
    [...source.keys()].sort(),
    'the published class carries the graph document and every manifest, and nothing else',
  );
  for (const [name, bytes] of source) {
    assert.equal(Buffer.compare(bytes, copy.get(name)), 0, `${name} is not byte-identical`);
  }
  assert.ok(
    copy.size >= 6,
    `the bundle publishes its graph document and its five manifests, got ${copy.size} file(s)`,
  );
});

test('AT3 — publishing twice with unchanged input leaves the files unchanged', () => {
  const area = temporaryArea();
  const atlas = path.join(area, 'atlas');

  assert.equal(runPublish(BUNDLE_ONE, atlas).status, 0);
  const first = snapshot(path.join(atlas, CLASS_ONE));

  assert.equal(runPublish(BUNDLE_ONE, atlas).status, 0, 'republishing is not an error');
  const second = snapshot(path.join(atlas, CLASS_ONE));

  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort());
  for (const [name, bytes] of first) {
    assert.equal(Buffer.compare(bytes, second.get(name)), 0, `${name} changed on a republish`);
  }
});

test('AT4 — two classes share one atlas without contaminating each other', () => {
  const area = temporaryArea();
  const atlas = path.join(area, 'atlas');

  assert.equal(runPublish(BUNDLE_ONE, atlas).status, 0);
  assert.equal(runPublish(BUNDLE_TWO, atlas).status, 0);

  assert.deepEqual(
    readdirSync(atlas).sort(),
    [CLASS_TWO, CLASS_ONE].sort(),
    'the atlas has one directory per class, and only those',
  );

  for (const [source, name] of [
    [BUNDLE_ONE, CLASS_ONE],
    [BUNDLE_TWO, CLASS_TWO],
  ]) {
    const expected = bundleFiles(source);
    const copy = snapshot(path.join(atlas, name));
    assert.deepEqual(
      [...copy.keys()].sort(),
      [...expected.keys()].sort(),
      `${name} carries its own files and none of the other class's`,
    );
    for (const [file, bytes] of expected) {
      assert.equal(Buffer.compare(bytes, copy.get(file)), 0, `${name}/${file} is not byte-identical`);
    }
  }
});

test('AT5 — the format doc exists and the three forward references point at it', () => {
  assert.ok(
    existsSync(FORMAT_DOC),
    `artifact does not exist yet: ${path.relative(ROOT, FORMAT_DOC)}`,
  );

  const text = readFileSync(FORMAT_DOC, 'utf8');
  assert.ok(text.includes('D4'), 'the doc states the trust boundary this ticket does not cross');

  for (const referrer of REFERRERS) {
    const source = readFileSync(referrer, 'utf8');
    assert.ok(
      source.includes(FORMAT_DOC_LINK),
      `${path.relative(ROOT, referrer)} still does not link ${FORMAT_DOC_LINK}`,
    );
    assert.ok(
      !/\bt120\b/.test(source),
      `${path.relative(ROOT, referrer)} still points at an open ticket instead of the doc`,
    );
  }
});
