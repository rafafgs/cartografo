/**
 * Atlas publish step (t120).
 *
 * Takes a validated bundle and lays it down inside an atlas checkout, one
 * directory per class:
 *
 * ```
 * node scripts/publish-atlas-bundle.mjs <bundle-dir> <atlas-dir>
 * ```
 *
 * Three properties make this a publish step rather than `cp -r`:
 *
 * 1. **It validates first, and refuses whole.** The check is the reference
 *    validator's own `validateBundle` — imported, never reimplemented — so a
 *    sound graph, a schema-valid manifest and a pin that closes are the same
 *    three things here as in `npm test`. A bundle that fails writes NOTHING:
 *    the atlas is content other people import, and a half-published map with a
 *    broken pin is worse than no map at all (D4).
 * 2. **The class names the directory.** `<atlas-dir>/<classe>/` is read from the
 *    graph document's own `problem_class` field, which is why an atlas checkout
 *    and this repository's `factory-graphs/<classe>/` are interchangeable inputs
 *    to `cartografo import`: same shape, same file names, same hashes.
 * 3. **It never runs `git`.** Committing and pushing the populated checkout is
 *    the caller's job — CI or a person. Git stays at the edges and never
 *    becomes a dependency of anything in this project (D15); what this script
 *    owns is a directory, with no network and no repository in it.
 *
 * Publishing is idempotent and additive: republishing an unchanged bundle
 * rewrites the same bytes, and two different maps share one atlas without
 * touching each other. Inside the class it publishes, the manifest directory is a
 * MIRROR — a `skills/*.json` the bundle no longer carries is removed, and named
 * on stdout, so that a renamed skill cannot leave a stale manifest behind for
 * `cartografo import` to register. Nothing outside `<atlas-dir>/<classe>/` is
 * ever touched.
 *
 * Zero dependencies: only Node built-ins and the reference validator, the same
 * constraint `validate-factory-bundle.mjs` carries.
 *
 * The names this file reads (`problem_class`, `grafo.json`, `skills/`) belong to
 * the graph-bundle and skill-manifest formats: this module publishes that
 * format, it does not own it. The KEY moved to English with t178; the file and
 * directory names did not, and are the downstream slice's to rename.
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { validateBundle } from './validate-factory-bundle.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The graph document of a bundle. */
const GRAPH_FILE = 'grafo.json';

/** The manifest directory of a bundle. */
const SKILLS_DIR = 'skills';

/**
 * A class that is safe as a single directory name.
 *
 * The format only requires `problem_class` to be a non-empty string
 * (`schema/grafo.schema.json`), and this script turns that string into a path.
 * Anything with a separator, a drive letter or a `..` in it would publish
 * outside the atlas, so it is refused here instead of being sanitized: a class
 * whose name is not a directory name is a bundle problem, not a copy problem.
 */
const SAFE_CLASS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Every file under a directory, as paths relative to it, sorted. */
function filesUnder(directory) {
  const found = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  try {
    walk(directory, '');
  } catch {
    return [];
  }
  return found.sort();
}

/** Copies one file, creating the directories it needs. */
function copyInto(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

/**
 * Validates a bundle and publishes it into the atlas.
 *
 * Never throws on a bundle it refuses — it returns the report, the way the
 * reference validator does: whoever is fixing a bundle needs every problem, not
 * the first one.
 *
 * @param {string} bundleDir Directory with `grafo.json` and `skills/`.
 * @param {string} atlasDir Atlas checkout; created when it does not exist.
 * @returns {{published: boolean, bundle: string, atlas: string, target: string|null,
 *            name: string|null, written: string[], removed: string[],
 *            problems: Array<{code: string, message: string}>, report: object}}
 */
export function publishBundle(bundleDir, atlasDir) {
  const bundle = path.resolve(bundleDir);
  const atlas = path.resolve(atlasDir);
  const outcome = {
    published: false,
    bundle,
    atlas,
    target: null,
    name: null,
    written: [],
    removed: [],
    problems: [],
    report: validateBundle(bundle),
  };
  const refuse = (code, message) => {
    outcome.problems.push({ code, message });
    return outcome;
  };

  // 1. nothing gets published before the whole bundle checks out.
  if (!outcome.report.valid) {
    return refuse('bundle_invalido', 'the bundle does not validate; nothing was published');
  }

  // 2. the class names the directory, and it has to BE a directory name.
  const document = JSON.parse(readFileSync(path.join(bundle, GRAPH_FILE), 'utf8'));
  const name = document.problem_class;
  if (typeof name !== 'string' || !SAFE_CLASS.test(name)) {
    return refuse(
      'classe_insegura',
      `"problem_class" has to be usable as a directory name (${SAFE_CLASS.source}), got ${JSON.stringify(name)}`,
    );
  }
  outcome.name = name;

  const target = path.join(atlas, name);
  outcome.target = target;
  if (target === bundle) {
    return refuse('destino_igual_a_origem', 'the bundle is already its own published copy');
  }

  // 3. the copy: the graph document, then every file under skills/.
  const sources = [
    GRAPH_FILE,
    ...filesUnder(path.join(bundle, SKILLS_DIR)).map((file) => `${SKILLS_DIR}/${file}`),
  ];
  mkdirSync(target, { recursive: true });
  for (const file of sources) {
    copyInto(path.join(bundle, file), path.join(target, ...file.split('/')));
    outcome.written.push(file);
  }

  // 4. the published class mirrors the bundle: a manifest the bundle dropped
  //    does not survive in the atlas, where the next import would register it.
  const kept = new Set(sources);
  for (const file of filesUnder(path.join(target, SKILLS_DIR)).map((f) => `${SKILLS_DIR}/${f}`)) {
    if (kept.has(file)) continue;
    rmSync(path.join(target, ...file.split('/')), { force: true });
    outcome.removed.push(file);
  }

  // 5. the published copy has to validate from its new location, or what left
  //    this script is not a bundle anyone can import.
  const republished = validateBundle(target);
  if (!republished.valid) {
    outcome.report = republished;
    return refuse('copia_invalida', `the published copy does not validate: ${target}`);
  }

  outcome.published = true;
  return outcome;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

/**
 * Shortest honest way to name a path: relative when it is inside `from`,
 * absolute when it is not — an atlas usually lives outside this repository, and
 * `../../../tmp/...` names it worse than the full path does.
 */
function shortPath(target, from) {
  const relative = path.relative(from, target);
  return relative === '' || relative.startsWith('..') ? target : relative;
}

/** Prints the refusal, in the shape the reference validator's CLI already uses. */
function printRefusal(outcome) {
  const { report } = outcome;
  console.error(`✖ ${shortPath(outcome.bundle, ROOT)}`);
  for (const problem of outcome.problems) {
    console.error(`  publish    ${problem.code}: ${problem.message}`);
  }
  for (const problem of report.errors) {
    console.error(`  bundle     ${problem.code}: ${problem.message}`);
  }
  for (const problem of report.graph?.structure.errors ?? []) {
    console.error(`  graph      structure ${problem.code}: ${problem.message}`);
  }
  for (const violation of report.graph?.soundness.violations ?? []) {
    console.error(`  graph      soundness ${violation.rule}: ${JSON.stringify(violation.target)}`);
  }
  for (const manifest of report.manifests) {
    for (const problem of manifest.errors) {
      console.error(`  manifest   ${manifest.file} ${problem.pointer}: ${problem.message}`);
    }
  }
  for (const pin of report.pins) {
    for (const problem of pin.problems) {
      console.error(`  pin        node "${pin.node}" → skill "${pin.skill}": ${problem}`);
    }
  }
}

function main(args) {
  if (args.length !== 2) {
    console.error('usage: node scripts/publish-atlas-bundle.mjs <bundle-dir> <atlas-dir>');
    return 2;
  }

  const [bundleDir, atlasDir] = args;
  const existing = statSync(atlasDir, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isDirectory()) {
    console.error(`✖ ${atlasDir} exists and is not a directory`);
    return 1;
  }

  const outcome = publishBundle(bundleDir, atlasDir);
  if (!outcome.published) {
    printRefusal(outcome);
    return 1;
  }

  const target = shortPath(outcome.target, process.cwd());
  const manifests = outcome.written.filter((file) => file.startsWith(`${SKILLS_DIR}/`)).length;
  console.log(`✔ ${outcome.name} → ${target} — graph document and ${manifests} manifest(s) published`);
  for (const file of outcome.removed) {
    console.log(`  removed    ${file}: the bundle no longer carries it`);
  }
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
