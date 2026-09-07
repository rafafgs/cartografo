/**
 * Registering a finished map: closing its pins, then offering it to the API
 * (t432, RF-24).
 *
 * The interview (t360) ends with a draft — a graph plus one skill manifest per
 * node, written for that node and carrying everything the format requires
 * EXCEPT `hash`. What is missing is precisely the thing nobody but the content
 * itself can supply: the pin (D4). This module computes it, writes it into
 * every node's `skill_ref`, and then walks the same pipeline `cartografo
 * import` walks — manifests first, one at a time, and the graph only after
 * every one of them was accepted.
 *
 * ## Why the hash recipe is copied here
 *
 * D11 is the reason, and it is not negotiable at this layer: the screen imports
 * nothing from `packages/core` (`docs/spec/screen.md` §0), so
 * `domain/manifest.ts`'s `manifestHash` cannot be imported and has to be
 * ported. This is the THIRD copy of that recipe in the repository —
 * `scripts/validate-factory-bundle.mjs` already carries the second, for exactly
 * the same reason (it cannot depend on the TypeScript scaffold either). A copy
 * nobody measures is a pin waiting to drift, so the copy is not trusted: the
 * acceptance test recomputes every manifest of factory bundle 1 with THIS
 * function and demands the hash the bundle already declares. The transcription
 * is checked against real content, not read twice and hoped over.
 *
 * ## The two disciplines this module inherits from `import.ts`
 *
 * - **A draft with a broken pin never becomes a request.** A node naming a
 *   skill no manifest declares, or pinning a version its manifest disagrees
 *   with, stops everything locally — before a byte goes anywhere. And every
 *   node is checked, not just the first: whoever is fixing a map needs the whole
 *   list.
 * - **There is no transaction across the API.** When the registry refuses the
 *   fourth manifest, the three before it stay registered. They passed the same
 *   gate on their own, and inventing a compensating call here would be this
 *   module claiming an atomicity the API does not offer.
 *
 * Nothing here opens a socket: the client is injected, and it is declared as a
 * narrow local interface rather than imported from `client.ts`. Wiring the real
 * one up (t433) means adding two methods of exactly this shape to `ApiClient`
 * — the throwing convention below is the one every method of that class already
 * follows.
 */

import { createHash } from 'node:crypto';

/** Algorithm prefix, explicit in the value — the pin's own shape (D4). */
const HASH_PREFIX = 'sha256:';

/**
 * A manifest as `session.output.draft.skills[]` carries it: every field
 * `specs/formats/skill-manifest.schema.json` requires except `hash`.
 *
 * Typed as an open record on purpose. This module reads two fields of it and
 * hashes the rest verbatim; declaring the whole format here would be the screen
 * owning a schema that lives next door.
 */
export type MapDraftManifest = Record<string, unknown> & { id: string; version: string };

/**
 * A node of the drafted graph.
 *
 * `skill_ref` arrives pinned by `{id, version}` — the interview writes it when
 * it writes that step's manifest — and with `hash` missing, which is this
 * module's whole job.
 */
export type MapDraftNode = Record<string, unknown> & {
  id: string;
  skill_ref?: { id?: string; version?: string };
};

/** What the interview leaves behind: a graph and the manifests its nodes name. */
export interface MapDraft {
  graph: { problem_class?: string; nodes?: MapDraftNode[] } & Record<string, unknown>;
  skills: MapDraftManifest[];
}

/**
 * A problem found before anything left this machine.
 *
 * `{code, message}` is `scripts/validate-factory-bundle.mjs`'s own `annotate`
 * shape, picked over `import.ts`'s local `{scope, message}` because it is the
 * one the two validators this logic mirrors already share — a third convention
 * would buy nothing.
 */
export interface PinProblem {
  code: string;
  message: string;
}

/** A manifest with its pin computed. */
export type PinnedManifest = MapDraftManifest & { hash: string };

/** What {@link fillSkillRefs} produces: a closed draft, or every reason it did not close. */
export type FillResult =
  | { ok: true; graph: Record<string, unknown>; manifests: PinnedManifest[] }
  | { ok: false; problems: PinProblem[] };

/**
 * The client this module speaks to, declared as the narrow thing it needs.
 *
 * Both methods follow the convention every existing `ApiClient` method already
 * follows (`client.ts`): return the parsed 2xx body, and throw an
 * `ApiError`-shaped value — an object exposing `status` and `body` — when the
 * control plane refuses. That is what makes the real client structurally
 * compatible with this interface without learning a second calling convention,
 * and it is why nothing here is imported from `client.ts`: the module is tested
 * whole against a hand-written fake.
 */
export interface RegisterMapClient {
  registerSkill(manifest: Record<string, unknown>, filter?: { project_id?: number }): Promise<unknown>;
  registerGraph(
    document: Record<string, unknown>,
    filter?: { project_id?: number },
  ): Promise<{ graph: unknown; graph_version: unknown }>;
}

/** How a registration ended — one shape per place it can stop. */
export type RegisterMapResult =
  | { ok: true; graph: unknown; graphVersion: unknown }
  | { ok: false; stage: 'pin'; problems: PinProblem[] }
  | { ok: false; stage: 'skill'; skillId: string; status: number; body: unknown }
  | { ok: false; stage: 'graph'; status: number; body: unknown };

/**
 * Sorts keys recursively — the part of RFC 8785 these formats use.
 *
 * Ported from `packages/core/src/domain/hash.ts` and kept private: what this
 * module exports is the recipe, not its plumbing.
 *
 * @param value Already parsed JSON value.
 * @returns The same value with every object rewritten in key order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const original = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(original).sort()) {
      sorted[key] = canonicalize(original[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Content hash of a skill manifest, by the procedure of
 * `specs/formats/skill-manifest.md`: sha256 of the canonical JSON of
 * `{instructions, input, output, checks, permissions, budgets, command}`.
 *
 * The subset is the point. Catalogue metadata (`id`, `version`, `description`,
 * `origin`) is outside it, so renaming a skill never invalidates its own pin;
 * and `hash` itself is outside it, which is what lets a draft manifest — which
 * has none yet — hash exactly like the same manifest once it carries one. A key
 * the manifest does not declare serializes to nothing, because `JSON.stringify`
 * drops a key whose value is `undefined`, which is the core's own behaviour and
 * the reason growing the subset costs already-registered manifests nothing.
 *
 * @param manifest Already parsed manifest; its `hash`, when present, is never read.
 * @returns `sha256:` followed by 64 hex characters.
 */
export function manifestHash(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
    budgets: manifest.budgets,
    command: manifest.command,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(subset)), 'utf8')
    .digest('hex');
  return `${HASH_PREFIX}${digest}`;
}

/**
 * Closes every pin of the draft: one hash per manifest, written into the node
 * that names it.
 *
 * Never throws, and never writes into the draft — `graph` and every node are
 * copied before a field is set, so the caller's object is exactly what it was
 * (the page still holds it, and an export followed by a registration must see
 * the same draft twice).
 *
 * Every node is checked before anything is decided: a broken pin does not stop
 * the sweep, exactly as `verifyBundle`'s own pin loop reports every pin rather
 * than the first. And when anything is broken, nothing at all comes back — no
 * partially filled graph a caller could mistake for a registrable one.
 *
 * @param draft The interview's output.
 * @returns The filled graph and manifests, or every problem that stopped them.
 */
export function fillSkillRefs(draft: MapDraft): FillResult {
  const problems: PinProblem[] = [];
  const manifests: PinnedManifest[] = [];
  const byId = new Map<string, PinnedManifest>();

  for (const manifest of draft.skills ?? []) {
    const pinned: PinnedManifest = { ...manifest, hash: manifestHash(manifest) };
    manifests.push(pinned);
    if (byId.has(pinned.id)) {
      problems.push({
        code: 'duplicate_manifest_id',
        message: `two manifests of the draft declare the id "${pinned.id}"`,
      });
      continue;
    }
    byId.set(pinned.id, pinned);
  }

  const nodes: Record<string, unknown>[] = [];
  for (const node of draft.graph.nodes ?? []) {
    const reference = node.skill_ref;
    const label = `node "${String(node.id)}" → skill "${String(reference?.id)}"`;
    const manifest = typeof reference?.id === 'string' ? byId.get(reference.id) : undefined;

    if (manifest === undefined) {
      problems.push({
        code: 'unmatched_skill_ref',
        message: `${label}: no manifest of the draft declares that id`,
      });
      continue;
    }
    if (reference?.version !== undefined && reference.version !== manifest.version) {
      problems.push({
        code: 'version_mismatch',
        message: `${label}: pinned version ${reference.version}, manifest ${manifest.version}`,
      });
      continue;
    }

    nodes.push({
      ...node,
      skill_ref: { id: manifest.id, version: manifest.version, hash: manifest.hash },
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, graph: { ...draft.graph, nodes }, manifests };
}

/**
 * A refusal, when the thrown value is one.
 *
 * The distinction `client.ts` draws between `ApiError` and `NetworkError`, read
 * structurally rather than by class: an answer carrying a status is something
 * this module has an opinion about, and anything else — a socket that never
 * opened — is not, and goes on up untouched.
 *
 * @param error Whatever the client threw.
 * @returns The status and body, or `undefined` when this is not a refusal.
 */
function asRefusal(error: unknown): { status: number; body: unknown } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { status?: unknown; body?: unknown };
  if (typeof candidate.status !== 'number') return undefined;
  return { status: candidate.status, body: candidate.body };
}

/**
 * Registers the drafted map: its manifests, then its graph (RF-24).
 *
 * The order is the whole of it, and it is `cartografo import`'s: a class whose
 * nodes pin a capability the registry refused is a class nobody can dispatch,
 * so the graph is sent last and only after every manifest was accepted. The
 * loop is sequential — `await` inside a `for`, never `Promise.all` — because
 * stopping partway has to mean something: everything before the refusal went
 * up, everything after it did not.
 *
 * What it does NOT do is roll back. The manifests already accepted stay
 * registered, which is `registerBundleSkills`'s own documented stance: they
 * passed the registry's gate on their own, and this module owns no transaction
 * across the API.
 *
 * @param client The API client, injected.
 * @param draft The interview's output.
 * @param filter Scope of the write, when there is one.
 * @returns Where it got to, and why it stopped when it did.
 * @throws Whatever the client threw, when that is not a refusal (a transport failure).
 */
export async function registerMap(
  client: RegisterMapClient,
  draft: MapDraft,
  filter?: { project_id?: number },
): Promise<RegisterMapResult> {
  const filled = fillSkillRefs(draft);
  if (!filled.ok) return { ok: false, stage: 'pin', problems: filled.problems };

  for (const manifest of filled.manifests) {
    try {
      await client.registerSkill(manifest, filter);
    } catch (error) {
      const refusal = asRefusal(error);
      if (refusal === undefined) throw error;
      return {
        ok: false,
        stage: 'skill',
        skillId: manifest.id,
        status: refusal.status,
        body: refusal.body,
      };
    }
  }

  try {
    const registered = await client.registerGraph(filled.graph, filter);
    return { ok: true, graph: registered.graph, graphVersion: registered.graph_version };
  } catch (error) {
    const refusal = asRefusal(error);
    if (refusal === undefined) throw error;
    return { ok: false, stage: 'graph', status: refusal.status, body: refusal.body };
  }
}
