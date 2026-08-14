/**
 * `cartografo import <path>` — the graph becomes data (t108, FR2).
 *
 * Two input shapes, on purpose:
 *
 * - **a file** — the graph document directly, with no ceremony. It is what
 *   `export` produces, and it is what closes the round trip.
 * - **a bundle directory** — reads `<dir>/grafo.json` and, if there is a sibling
 *   `skills/`, checks the bundle BEFORE touching the network. A bundle with a
 *   broken pin never becomes a request: a pinned skill is an injection vector
 *   (D4), and a graph whose `skill_ref` does not match the manifest next to it
 *   is exactly the case the pin exists to catch.
 *
 * A bundle's `skills/` ARE registered, and the boundary is the one D4 draws
 * (t135, FR2). D4's gate — `cartografo scan-skill`/`propose-skill`/`register-skill`,
 * with a human signature on it — exists against *skill de repo externo*: content
 * nobody in this repository wrote, whose instructions are an injection vector. A
 * factory bundle is in-repo, code-reviewed content, and asking a human to
 * re-approve five manifests they already merged buys no safety at all; what it
 * buys is an empty registry, and a graph whose nodes pin capabilities the
 * synthesizer cannot find. So the manifests go up first, then the graph.
 *
 * "Registered" here still means *offered*: the registry re-verifies everything
 * on its own (`repositories/skill.ts`), and a manifest it refuses stops the
 * import before the graph is sent. The local check that runs first is about the
 * pin, computed by the very same `manifestHash` the registry re-verifies with —
 * that is what `domain/manifest.ts` is for.
 *
 * **Declared limit of the manifest check.** The three checks are those of
 * `scripts/validar-bundle-fabrica.mjs` — a sound graph, a checked manifest, a
 * matching pin — but the second one covers here the subset of schema rules the
 * pin depends on (required fields, shape of `id`/`versao`/`hash`, `papel` in the
 * enum, and the recalculated hash matching the declared one), not the whole
 * schema. The reason is the same one that made `domain/graph.ts` port the graph
 * rules instead of loading `schema/grafo.schema.json`: `especificacoes/` is
 * outside the package's publishable tree (`files` in `package.json`), and the
 * core cannot depend at runtime on a file `npm pack` does not carry along. Full
 * conformance against
 * `especificacoes/formatos/manifesto-skill.schema.json` remains the job of the
 * reference validator, which is what guards the bundle in the repository.
 *
 * The manifest field names are the skill-manifest format's, which the D18 rename
 * does not touch (t127, FR8).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { validateGraph } from '../domain/graph.ts';
import {
  HASH_PATTERN,
  ID_PATTERN,
  MANIFEST_FIELDS,
  MANIFEST_ROLES,
  VERSION_PATTERN,
  manifestHash,
} from '../domain/manifest.ts';
import { UsageError, requestJson } from './url.ts';

/** A problem found in the local check, already carrying the scope that produced it. */
export interface BundleProblem {
  scope: 'bundle' | 'graph' | 'manifest' | 'pin';
  message: string;
}

/** Options of `import`. */
export interface ImportOptions {
  /** Graph file or bundle directory. */
  path: string;
  /** Base URL of the control plane. */
  url: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    throw new UsageError(`could not read "${filePath}"`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`"${filePath}" is not valid JSON — ${(error as Error).message}`);
  }
}

/** Checks one manifest in isolation; returns the messages of whatever is wrong. */
function checkManifest(manifest: unknown, file: string): string[] {
  const problems: string[] = [];
  if (!isObject(manifest)) return [`${file}: the manifest has to be a JSON object`];

  for (const field of MANIFEST_FIELDS) {
    if (manifest[field] === undefined) problems.push(`${file}: required field missing: "${field}"`);
  }

  const id = manifest.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    problems.push(`${file}: "id" has to be kebab-case (${ID_PATTERN.source})`);
  } else if (id !== path.basename(file, '.json')) {
    problems.push(`${file}: the id "${id}" has to be the file name without the extension`);
  }
  if (typeof manifest.versao !== 'string' || !VERSION_PATTERN.test(manifest.versao)) {
    problems.push(`${file}: "versao" has to be semver (x.y.z)`);
  }
  if (typeof manifest.papel !== 'string' || !MANIFEST_ROLES.includes(manifest.papel)) {
    problems.push(`${file}: "papel" has to be ${MANIFEST_ROLES.join(' or ')}`);
  }

  const declared = manifest.hash;
  if (typeof declared !== 'string' || !HASH_PATTERN.test(declared)) {
    problems.push(`${file}: "hash" has to have the shape sha256:<64 hex>`);
    return problems;
  }
  const recalculated = manifestHash(manifest);
  if (recalculated !== declared) {
    problems.push(
      `${file}: the manifest declares hash ${declared}, but its content is ${recalculated} — a tampered manifest does not run (D4)`,
    );
  }
  return problems;
}

/**
 * Checks the whole bundle: graph, manifests and pins.
 *
 * Never throws on a malformed bundle — it returns the whole list of what is
 * wrong, like the reference validator: whoever is fixing a bundle needs every
 * problem, not the first one.
 *
 * @param directory Bundle directory (with `grafo.json` and `skills/`).
 * @param document Graph document already read from `<directory>/grafo.json`.
 * @returns Problems found; empty when the bundle checks out.
 */
export function verifyBundle(directory: string, document: unknown): BundleProblem[] {
  const problems: BundleProblem[] = [];

  // 1. the graph is valid and sound.
  const report = validateGraph(document);
  for (const error of report.estrutura.erros) {
    problems.push({ scope: 'graph', message: `estrutura ${error.codigo}: ${error.mensagem}` });
  }
  for (const violation of report.soundness.violacoes) {
    problems.push({
      scope: 'graph',
      message: `soundness ${violation.regra}: ${JSON.stringify(violation.alvo)}`,
    });
  }

  // 2. each manifest stands on its own.
  const skillsDir = path.join(directory, 'skills');
  let files: string[];
  try {
    files = readdirSync(skillsDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    problems.push({ scope: 'bundle', message: `could not list ${skillsDir}` });
    return problems;
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const file of files) {
    let manifest: unknown;
    try {
      manifest = readJson(path.join(skillsDir, file));
    } catch (error) {
      problems.push({ scope: 'manifest', message: (error as Error).message });
      continue;
    }
    for (const message of checkManifest(manifest, file)) {
      problems.push({ scope: 'manifest', message });
    }
    if (isObject(manifest) && typeof manifest.id === 'string') {
      if (byId.has(manifest.id)) {
        problems.push({ scope: 'manifest', message: `${file}: repeated id in the bundle: "${manifest.id}"` });
      } else {
        byId.set(manifest.id, manifest);
      }
    }
  }

  // 3. each pin checks out: the node's id, version and hash match the manifest next to it.
  const nodes = isObject(document) && Array.isArray(document.nos) ? document.nos : [];
  for (const node of nodes) {
    if (!isObject(node)) continue;
    const ref = isObject(node.skill_ref) ? node.skill_ref : {};
    const label = `node "${String(node.id)}" → skill "${String(ref.id)}"`;
    const manifest = typeof ref.id === 'string' ? byId.get(ref.id) : undefined;
    if (manifest === undefined) {
      problems.push({ scope: 'pin', message: `${label}: no manifest in skills/ with that id` });
      continue;
    }
    if (manifest.versao !== ref.versao) {
      problems.push({
        scope: 'pin',
        message: `${label}: pinned version ${String(ref.versao)}, manifest ${String(manifest.versao)}`,
      });
    }
    const recalculated = manifestHash(manifest);
    if (recalculated !== ref.hash) {
      problems.push({
        scope: 'pin',
        message: `${label}: pinned hash ${String(ref.hash)}, manifest content ${recalculated}`,
      });
    }
  }

  return problems;
}

/** How the registry answered for the bundle as a whole. */
interface RegistryOutcome {
  /** Manifests the registry had never seen (201). */
  created: number;
  /** Manifests already registered (409) — a reimport, not a failure. */
  known: number;
}

/**
 * Reads `<directory>/skills/*.json`, in file-name order.
 *
 * Only ever called after `verifyBundle` came back empty, which is what makes
 * reading the same files twice safe rather than sloppy: by then every one of
 * them parsed, declared the required fields and matched its pin.
 *
 * @param directory Bundle directory.
 * @returns File name and parsed manifest, sorted by file name.
 */
function readBundleSkills(directory: string): { file: string; manifest: unknown }[] {
  const skillsDir = path.join(directory, 'skills');
  return readdirSync(skillsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => ({ file, manifest: readJson(path.join(skillsDir, file)) }));
}

/**
 * Offers every manifest of the bundle to the registry, over HTTP (D1), before
 * the graph (FR2/FR3).
 *
 * 201 and 409 are both success. Registration is create-only (t117), so the
 * second `cartografo import` of a bundle finds its manifests already there —
 * treating that as a failure would make the command non-idempotent in exchange
 * for nothing, since the pin the CLI just checked is the same content the
 * registry already holds.
 *
 * Anything else stops the import where it stands, and the graph is never sent:
 * a class whose nodes pin a capability the registry refused is a class nobody
 * can dispatch, and registering it would leave a lineage in the database
 * pointing at a skill that does not exist. Manifests already accepted before the
 * refusal stay registered — they passed the same gate on their own, and this
 * command owns no transaction across the API.
 *
 * @param directory Bundle directory, already checked.
 * @param url Base URL of the control plane.
 * @returns What the registry did, or `null` when it refused a manifest.
 */
async function registerBundleSkills(
  directory: string,
  url: string,
): Promise<RegistryOutcome | null> {
  const outcome: RegistryOutcome = { created: 0, known: 0 };

  for (const { file, manifest } of readBundleSkills(directory)) {
    const response = await requestJson(`${url}/v1/skills`, { method: 'POST', body: manifest });
    if (response.status === 201) {
      outcome.created += 1;
      continue;
    }
    if (response.status === 409) {
      outcome.known += 1;
      continue;
    }

    const id = isObject(manifest) && typeof manifest.id === 'string' ? manifest.id : file;
    const body = isObject(response.body) ? response.body : {};
    process.stderr.write(
      `cartografo: the registry refused a skill (HTTP ${response.status}) — ${id}\n`,
    );
    if (typeof body.error === 'string') {
      process.stderr.write(`  ${'registry'.padEnd(10)} ${body.error}\n`);
    }
    for (const detail of Array.isArray(body.details) ? body.details : []) {
      process.stderr.write(`  ${'registry'.padEnd(10)} ${String(detail)}\n`);
    }
    process.stderr.write('cartografo: the graph was not sent to the control plane\n');
    return null;
  }

  return outcome;
}

/** One `label  value` line of the success output. */
function line(label: string, value: string): string {
  return `  ${label.padEnd(18)}${value}\n`;
}

/**
 * Runs `cartografo import`.
 *
 * @param options Input path and base URL of the control plane.
 * @returns Process exit code.
 */
export async function runImport(options: ImportOptions): Promise<number> {
  const target = path.resolve(options.path);

  let isDirectory: boolean;
  try {
    isDirectory = statSync(target).isDirectory();
  } catch {
    throw new UsageError(`path not found: "${options.path}"`);
  }

  const graphPath = isDirectory ? path.join(target, 'grafo.json') : target;
  const document = readJson(graphPath);

  let hasSkills = false;
  if (isDirectory) {
    try {
      hasSkills = statSync(path.join(target, 'skills')).isDirectory();
    } catch {
      hasSkills = false;
    }
  }

  let registry: RegistryOutcome | null = null;
  if (hasSkills) {
    const problems = verifyBundle(target, document);
    if (problems.length > 0) {
      process.stderr.write(`cartografo: invalid bundle — ${target}\n`);
      for (const problem of problems) {
        process.stderr.write(`  ${problem.scope.padEnd(10)} ${problem.message}\n`);
      }
      process.stderr.write('cartografo: nothing was sent to the control plane\n');
      return 1;
    }

    registry = await registerBundleSkills(target, options.url);
    if (registry === null) return 1;
  }

  const response = await requestJson(`${options.url}/v1/graphs`, { method: 'POST', body: document });
  const body = isObject(response.body) ? response.body : {};

  if (response.status === 201) {
    const graph = isObject(body.grafo) ? body.grafo : {};
    const version = isObject(body.grafo_versao) ? body.grafo_versao : {};
    process.stdout.write('graph imported\n');
    process.stdout.write(line('classe', String(graph.classe)));
    process.stdout.write(line('grafo.id', String(graph.id)));
    process.stdout.write(line('grafo_versao.id', String(version.id)));
    if (registry !== null) {
      process.stdout.write(
        line('skills', `${registry.created} registered, ${registry.known} already in the registry`),
      );
    }
    return 0;
  }

  if (response.status === 409) {
    process.stderr.write(`cartografo: classe_ja_registrada — ${String(body.mensagem)}\n`);
    return 1;
  }

  if (response.status === 422) {
    process.stderr.write(`cartografo: grafo_invalido — ${graphPath}\n`);
    const structure = isObject(body.estrutura) ? body.estrutura : {};
    const soundness = isObject(body.soundness) ? body.soundness : {};
    for (const error of Array.isArray(structure.erros) ? structure.erros : []) {
      const item = isObject(error) ? error : {};
      process.stderr.write(`  estrutura  ${String(item.codigo)}: ${String(item.mensagem)}\n`);
    }
    for (const violation of Array.isArray(soundness.violacoes) ? soundness.violacoes : []) {
      const item = isObject(violation) ? violation : {};
      process.stderr.write(`  soundness  ${String(item.regra)}: ${JSON.stringify(item.alvo)}\n`);
    }
    return 1;
  }

  process.stderr.write(
    `cartografo: the control plane refused the graph (HTTP ${response.status})${
      typeof body.erro === 'string' ? ` — ${body.erro}` : ''
    }${typeof body.mensagem === 'string' ? `: ${body.mensagem}` : ''}\n`,
  );
  return 1;
}
