/**
 * Acceptance tests of the atlas round trip (t120, AT6-AT8).
 *
 * The proof this ticket owes is not "the script copies files" — `node --test
 * scripts/publish-atlas-bundle.test.mjs` already covers that. It is that the
 * copy survives the border: published into an atlas, committed, cloned FRESH
 * somewhere else and reimported by the unmodified `cartografo import`, both
 * factory bundles have to register with the very same `grafo_versao.id` and the
 * very same per-skill content hash they register with when imported straight
 * from this repository.
 *
 * That is what makes the atlas an atlas rather than a folder of copies: the id
 * is the canonical hash of the whole document
 * (`docs/spec/entities-versioning.md` §2), so a byte the publish step added,
 * dropped or reordered on the way out shows up here as a different hash, and a
 * skill whose content drifted shows up as a different pin (D4).
 *
 * The external repository is a LOCAL git repository. D7 keeps this project
 * private and there is no public atlas yet; what the test needs from "external"
 * is that the import reads a checkout it did not produce, and a fresh clone is
 * exactly that. `git` runs with no user configuration at all (`GIT_CONFIG_*`
 * pointed at `/dev/null`), so the round trip does not depend on how the machine
 * running the suite happens to be set up.
 *
 * The class names and the bundle directories below are still Portuguese: they
 * are data, and renaming a directory belongs to the downstream slice. The
 * schema KEYS are English since t178, when the 2026-08-15 D18 amendment lifted
 * the carve-out that used to keep the two data formats out of the rename.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  BETS_BUNDLE,
  FACTORY_BUNDLE,
  REPO_ROOT,
  firstHash,
  runCli,
  startControlPlane,
  temporaryArea,
} from './cli-support.ts';

/** The publish step under test — a standalone script, with no control plane in it. */
const PUBLISH_SCRIPT = path.join(REPO_ROOT, 'scripts', 'publish-atlas-bundle.mjs');

/** The two factory bundles, each with the class it publishes under. */
const MAPS = [
  { bundle: FACTORY_BUNDLE, name: 'software-development' },
  { bundle: BETS_BUNDLE, name: 'asymmetric-bets' },
];

/** A registered skill, in the part these tests read. */
interface RegisteredSkill {
  id: string;
  hash: string;
}

/** Sorts keys recursively — same canonicalization the format's hash is defined over. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonical(source[key]);
    return sorted;
  }
  return value;
}

/**
 * The pin, recomputed here straight from the specification
 * (`specs/formats/skill-manifest.md`) instead of imported: a test
 * that reused the implementation it checks would agree with it even when both
 * are wrong.
 */
function contentHash(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(subset)), 'utf8').digest('hex')}`;
}

/** Runs `git` with no user, global or system configuration in the way. */
function git(args: string[], cwd: string): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'atlas',
      GIT_AUTHOR_EMAIL: 'atlas@example.test',
      GIT_COMMITTER_NAME: 'atlas',
      GIT_COMMITTER_EMAIL: 'atlas@example.test',
    },
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
}

/** Publishes one bundle into the atlas working tree. */
function publish(bundle: string, atlas: string): void {
  const result = spawnSync(process.execPath, [PUBLISH_SCRIPT, bundle, atlas], { encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `publishing ${bundle} failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
}

/** Every skill the registry holds. */
async function registeredSkills(url: string): Promise<RegisteredSkill[]> {
  const response = await fetch(`${url}/v1/skills`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { skills: RegisteredSkill[] };
  return body.skills;
}

test('AT6-AT8 — both factory bundles round-trip through a git-backed atlas', { timeout: 600_000 }, async (t) => {
  const base = temporaryArea(t, 'cartografo-t120-');

  // 1. publish both maps into one atlas working tree, then commit and clone it.
  const tree = path.join(base, 'atlas');
  mkdirSync(tree, { recursive: true });
  for (const map of MAPS) publish(map.bundle, tree);

  git(['-c', 'init.defaultBranch=main', 'init', '--quiet'], tree);
  git(['add', '--all'], tree);
  git(['commit', '--quiet', '--message', 'atlas'], tree);

  const clone = path.join(base, 'clone');
  git(['clone', '--quiet', tree, clone], base);

  // 2. two control planes: one imports from the clone, the other from this repo.
  const mirrored = await startControlPlane(t, {
    databasePath: path.join(base, 'mirror', 'cartografo.db'),
  });
  const local = await startControlPlane(t, {
    databasePath: path.join(base, 'local', 'cartografo.db'),
  });

  await t.test('AT6 — software-development imports from the clone with the same id', async () => {
    const [map] = MAPS;
    const fromClone = await runCli(['import', path.join(clone, map.name), '--url', mirrored.url], { token: mirrored.token });
    assert.equal(fromClone.code, 0, `stdout:\n${fromClone.stdout}\nstderr:\n${fromClone.stderr}`);

    const fromRepo = await runCli(['import', map.bundle, '--url', local.url], { token: local.token });
    assert.equal(fromRepo.code, 0, `stdout:\n${fromRepo.stdout}\nstderr:\n${fromRepo.stderr}`);

    assert.equal(
      firstHash(fromClone.stdout),
      firstHash(fromRepo.stdout),
      'the version id is the canonical hash of the snapshot: publishing cannot change it',
    );
  });

  await t.test('AT7 — asymmetric-bets imports from the clone with the same id', async () => {
    const map = MAPS[1];
    const fromClone = await runCli(['import', path.join(clone, map.name), '--url', mirrored.url], { token: mirrored.token });
    assert.equal(fromClone.code, 0, `stdout:\n${fromClone.stdout}\nstderr:\n${fromClone.stderr}`);

    const fromRepo = await runCli(['import', map.bundle, '--url', local.url], { token: local.token });
    assert.equal(fromRepo.code, 0, `stdout:\n${fromRepo.stdout}\nstderr:\n${fromRepo.stderr}`);

    assert.equal(
      firstHash(fromClone.stdout),
      firstHash(fromRepo.stdout),
      'the second map crosses the border with its identity intact too',
    );
  });

  await t.test('AT8 — the skills registered from the clone carry the source pin', async () => {
    const skills = await registeredSkills(mirrored.url);
    const byId = new Map(skills.map((skill) => [skill.id, skill]));

    const expected = new Map<string, string>();
    for (const map of MAPS) {
      const skillsDir = path.join(map.bundle, 'skills');
      for (const file of readdirSync(skillsDir).filter((name) => name.endsWith('.json'))) {
        const manifest = JSON.parse(readFileSync(path.join(skillsDir, file), 'utf8')) as Record<
          string,
          unknown
        >;
        expected.set(String(manifest.id), contentHash(manifest));
      }
    }

    assert.ok(expected.size >= 12, `the two bundles pin ${expected.size} skills, expected 12`);
    for (const [id, hash] of expected) {
      const registered = byId.get(id);
      assert.ok(registered !== undefined, `the clone import did not register "${id}"`);
      assert.equal(
        registered.hash,
        hash,
        `"${id}" reached the atlas with a different content hash (D4)`,
      );
    }
  });
});
