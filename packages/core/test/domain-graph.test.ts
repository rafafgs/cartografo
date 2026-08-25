/**
 * Acceptance tests of the graph validator ported to TypeScript (t101, FR2).
 *
 * The control plane cannot import `scripts/validate-graph.mjs`: the script lives
 * outside the package's publishable tree (`files` in `packages/core/package.json`).
 * That is why the two functions were ported — and why this file is the only
 * place in the package that imports the reference validator: to lock parity
 * between the two, fixture by fixture, instead of trusting the copy stays
 * faithful.
 *
 * That parity is why the report keys, codes and rule labels move in LOCKSTEP:
 * this test compares the two reports with `deepEqual`, so a key renamed on one
 * side and not the other fails here on the next run. D20's fifth child (t230)
 * moved them to English out of `docs/spec/glossario-wire.md` §5.3/5.4, both
 * files in the same delivery — which is why the fixtures below are read with
 * `nodes`/`edges` and the report with `errors`/`violations`, one vocabulary
 * from the document all the way out to the 422.
 *
 * Repo convention (the same as `migrate.test.ts`): the module under test is
 * imported on demand, after an explicit `existsSync`, so that the initial red
 * says which artifact is missing instead of blowing up with a raw
 * ERR_MODULE_NOT_FOUND.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import type * as GraphModule from '../src/domain/graph.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'schema', 'examples');
const REFERENCE_VALIDATOR = path.join(REPO_ROOT, 'scripts', 'validate-graph.mjs');

/** Shape of the reference validator, which is JavaScript with no declared types. */
interface ReferenceValidator {
  validarEstrutura: (doc: unknown) => { valid: boolean; errors: unknown[] };
  validarSoundness: (doc: unknown) => { valid: boolean; violations: unknown[] };
}

let graphCache: typeof GraphModule | null = null;
let referenceCache: ReferenceValidator | null = null;

async function loadDomainGraph(): Promise<typeof GraphModule> {
  const modulePath = path.join(PACKAGE_ROOT, 'src', 'domain', 'graph.ts');
  assert.ok(existsSync(modulePath), 'artifact does not exist yet: packages/core/src/domain/graph.ts');
  graphCache ??= (await import(
    new URL('../src/domain/graph.ts', import.meta.url).href
  )) as typeof GraphModule;
  return graphCache;
}

async function loadReference(): Promise<ReferenceValidator> {
  assert.ok(existsSync(REFERENCE_VALIDATOR), 'the reference validator is gone from the repository');
  referenceCache ??= (await import(
    pathToFileURL(REFERENCE_VALIDATOR).href
  )) as ReferenceValidator;
  return referenceCache;
}

/** Every t96 fixture, in a stable order. */
function examples(): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function readExample(name: string): unknown {
  return JSON.parse(readFileSync(path.join(EXAMPLES_DIR, name), 'utf8'));
}

/** The minimal fixture, freshly parsed so every case mutates its own copy. */
function minimalGraph(): Record<string, unknown> {
  return readExample('graph-valid-minimal.json') as Record<string, unknown>;
}

/** Node list of a parsed fixture, typed loosely because the cases put junk in it. */
function nodesOf(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  return doc.nodes as Array<Record<string, unknown>>;
}

/** Edge list of a parsed fixture, same reason. */
function edgesOf(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  return doc.edges as Array<Record<string, unknown>>;
}

/**
 * An id that is PRESENT but is not a filled string, at each of the four places
 * the document names a node: the node itself, an edge endpoint, `initial_node`
 * and an entry of `final_nodes` (t153).
 *
 * `targets` are the `target`s of the expected `invalid_id` errors, in order:
 * the node's index, `{from, to}` for an edge, the field name for `initial_node`,
 * the entry's index for `final_nodes`. The `target` of an edge spells its two
 * ends the way the document does — `from`/`to`, since t230 — instead of keeping
 * a second vocabulary for the same pair inside the report.
 * `quoted` is the offending value as the message has to show it, and `absent` is
 * the code that must NOT fire in its place.
 */
const INVALID_ID_CASES: Array<{
  name: string;
  mutate: (doc: Record<string, unknown>) => void;
  targets: unknown[];
  quoted: string;
  absent?: string;
}> = [
  {
    name: 'node id = 1 (numeric)',
    mutate: (doc) => {
      nodesOf(doc)[0].id = 1;
    },
    targets: [0],
    quoted: '1',
  },
  {
    name: 'node id = true (boolean)',
    mutate: (doc) => {
      nodesOf(doc)[1].id = true;
    },
    targets: [1],
    quoted: 'true',
  },
  {
    name: 'node id = "" (empty string)',
    mutate: (doc) => {
      nodesOf(doc)[0].id = '';
    },
    targets: [0],
    quoted: '""',
  },
  {
    name: 'node id = "   " (whitespace only)',
    mutate: (doc) => {
      nodesOf(doc)[0].id = '   ';
    },
    targets: [0],
    quoted: '"   "',
  },
  {
    name: 'initial_node = 1 (numeric), every node id still a valid string',
    mutate: (doc) => {
      doc.initial_node = 1;
    },
    targets: ['initial_node'],
    quoted: '1',
    // An invalid id is not an id pointing at a missing node: only ONE of the
    // two fires.
    absent: 'unknown_initial_node',
  },
  {
    name: 'final_nodes = [null] (null inside the array)',
    mutate: (doc) => {
      doc.final_nodes = [null];
    },
    targets: [0],
    quoted: 'null',
    absent: 'unknown_final_node',
  },
  {
    name: 'final_nodes = [1] (numeric inside the array)',
    mutate: (doc) => {
      doc.final_nodes = [1];
    },
    targets: [0],
    quoted: '1',
    absent: 'unknown_final_node',
  },
  {
    name: 'edge "from" = true (boolean)',
    mutate: (doc) => {
      edgesOf(doc)[0].from = true;
    },
    targets: [{ from: true, to: 'revisar' }],
    quoted: 'true',
    absent: 'edge_unknown_node',
  },
  {
    name: 'edge "to" = 1 (numeric)',
    mutate: (doc) => {
      edgesOf(doc)[0].to = 1;
    },
    targets: [{ from: 'redigir', to: 1 }],
    quoted: '1',
    absent: 'edge_unknown_node',
  },
];

test('AT1 — the TS module agrees with scripts/validate-graph.mjs on every fixture', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  const files = examples();
  assert.ok(files.length >= 6, 'the t96 fixtures have to be in place');

  for (const file of files) {
    const doc = readExample(file);

    assert.deepEqual(
      ported.validateStructure(doc),
      reference.validarEstrutura(doc),
      `structure diverged on ${file}`,
    );
    assert.deepEqual(
      ported.validateSoundness(doc),
      reference.validarSoundness(doc),
      `soundness diverged on ${file}`,
    );
  }
});

test('AT2 — the four counterexamples fail with the expected rule, one each', async () => {
  const { validateSoundness, RULES } = await loadDomainGraph();

  const expected: Array<[string, { rule: string; target: unknown }]> = [
    ['graph-invalid-unreachable-node.json', { rule: RULES.REACHABLE, target: 'revisar_lote' }],
    ['graph-invalid-without-termination.json', { rule: RULES.TERMINATES, target: 'reprocessar_item' }],
    [
      'graph-invalid-edge-without-condition.json',
      {
        rule: RULES.EDGE_WITH_CONDITION,
        target: { from: 'coletar_fontes', to: 'resumir_fontes' },
      },
    ],
    ['graph-invalid-node-without-contract.json', { rule: RULES.NODE_WITH_CONTRACT, target: 'publicar_texto' }],
  ];

  for (const [file, violation] of expected) {
    const report = validateSoundness(readExample(file));
    assert.equal(report.valid, false, `${file} has to keep failing`);
    // Each t96 counterexample violates exactly ONE rule — that is what makes
    // each rule demonstrable in isolation (`docs/spec/graph.md` §6).
    assert.deepEqual(report.violations, [violation], `wrong rule on ${file}`);
  }
});

test('t153 — an id that is present but is not a filled string is a structure error', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  for (const scenario of INVALID_ID_CASES) {
    const document = minimalGraph();
    scenario.mutate(document);

    const report = ported.validateStructure(document);

    // Parity first: a rule that only one of the two validators applies is a
    // rule the reference validator no longer documents (AT1's contract).
    assert.deepEqual(
      report,
      reference.validarEstrutura(document),
      `structure diverged on: ${scenario.name}`,
    );
    assert.equal(report.valid, false, `has to be refused: ${scenario.name}`);

    const flagged = report.errors.filter((item) => item.code === 'invalid_id');
    assert.deepEqual(
      flagged.map((item) => item.target),
      scenario.targets,
      `wrong invalid_id targets on: ${scenario.name}`,
    );
    for (const item of flagged) {
      assert.ok(
        item.message.includes(scenario.quoted),
        `the message has to quote the offending value on: ${scenario.name}`,
      );
    }

    if (scenario.absent !== undefined) {
      assert.ok(
        !report.errors.some((item) => item.code === scenario.absent),
        `${scenario.absent} must not fire in place of invalid_id on: ${scenario.name}`,
      );
    }
  }
});

test('t153 — a node whose id is invalid never enters the known ids', async () => {
  const { validateStructure } = await loadDomainGraph();

  const document = minimalGraph();
  nodesOf(document)[0].id = 1;
  const codes = validateStructure(document).errors.map((item) => item.code);

  assert.ok(codes.includes('invalid_id'), 'the invalid id has to be reported');
  // And it is not registered either: every reference to "redigir" now dangles,
  // which is exactly what used to be swallowed in silence.
  assert.ok(codes.includes('edge_unknown_node'), 'the edge referencing it has to dangle');
  assert.ok(codes.includes('unknown_initial_node'), 'initial_node referencing it has to dangle');
});

test('AT2 — the two valid graphs keep passing both validations', async () => {
  const { validateGraph } = await loadDomainGraph();

  for (const file of ['graph-valid-minimal.json', 'graph-valid-flowpilot.json']) {
    const report = validateGraph(readExample(file));
    assert.equal(report.valid, true, `${file} has to stay valid`);
    assert.deepEqual(report.structure.errors, []);
    assert.deepEqual(report.soundness.violations, []);
  }
});

/**
 * t169 — a hook is graph DATA, so a hook that points nowhere is a shape defect.
 *
 * It lands in the structural pass and not among the four soundness rules on
 * purpose: soundness is a property of the workflow net (reachable, terminates,
 * labelled edges, contracted nodes), and a dangling `node_id` in a reaction says
 * nothing about the net. The two assertions below are that decision, written
 * down: the structure report names the problem, and `violations` stays empty.
 */
test('t169 — a hook pointing at a node that does not exist is a structure error', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  const document = readExample('graph-invalid-hook-unknown-node.json');
  const report = ported.validateStructure(document);

  assert.deepEqual(
    report,
    reference.validarEstrutura(document),
    'structure diverged on the dangling-hook fixture',
  );
  assert.equal(report.valid, false, 'a hook that points nowhere refuses the document');

  const dangling = report.errors.filter((item) => item.code === 'hook_unknown_node');
  assert.equal(dangling.length, 1, 'exactly one hook of the fixture dangles');
  assert.ok(
    dangling[0].message.includes('no_que_nao_existe'),
    `the message has to name the missing node: ${dangling[0].message}`,
  );

  assert.deepEqual(
    ported.validateSoundness(document).violations,
    [],
    'the net itself is sound: a dangling hook is shape, never a workflow-net rule',
  );
});

test('t169 — a duplicate hook id is a structure error, and the valid fixture has none', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  const document = readExample('graph-valid-with-hooks.json') as Record<string, unknown>;
  assert.deepEqual(
    ported.validateGraph(document),
    { valid: true, structure: { valid: true, errors: [] }, soundness: { valid: true, violations: [] } },
    'the fixture that declares hooks has to pass both validations whole',
  );

  const hooks = document.hooks as Array<Record<string, unknown>>;
  assert.ok(hooks.length >= 1, 'the fixture has to declare at least one hook');

  const repeated = structuredClone(document);
  const repeatedHooks = repeated.hooks as Array<Record<string, unknown>>;
  repeatedHooks.push(structuredClone(repeatedHooks[0]));

  const report = ported.validateStructure(repeated);
  assert.deepEqual(
    report,
    reference.validarEstrutura(repeated),
    'structure diverged on the duplicate-hook-id case',
  );
  assert.equal(report.valid, false);

  const duplicated = report.errors.filter((item) => item.code === 'duplicate_hook_id');
  assert.equal(duplicated.length, 1, 'a repeated id is reported once, not once per repetition');
  assert.equal(duplicated[0].target, hooks[0].id);
  assert.ok(
    duplicated[0].message.includes(hooks[0].id as string),
    'the message has to name the duplicated id',
  );
});

/**
 * t256 — the hook's own vocabulary, enforced where the schema cannot reach it.
 *
 * `POST /v1/graphs` declares no ajv schema against `schema/grafo.schema.json`
 * (`routes/graphs.ts`: the schema is draft 2020-12 and the ajv Fastify ships is
 * draft-07), so this pair of validators is the ONLY gate a document really
 * passes. Until this ticket the loop below checked that `trigger` and
 * `destination` were PRESENT and never looked at what was inside them — which
 * made two documents the schema forbids answer `201`: a trigger outside the
 * closed enum, and a destination carrying the RAW HMAC key instead of the name
 * of one. The second is the reason the three codes are distinct: a raw secret in
 * a content-addressed snapshot is a credential leak, not a shape mistake, and
 * the document is served whole, exported to disk and published to the atlas.
 *
 * Each case runs through BOTH validators, like every other rule here: the port
 * and `scripts/validate-graph.mjs` say the same thing or AT1 says so on the next
 * run.
 */
const HOOK_CASES: Array<{
  name: string;
  mutate: (hook: Record<string, unknown>) => void;
  code: string;
  quoted: string;
  /** What the message must NOT carry: reporting a leak by repeating it is not a fix. */
  forbidden?: string;
}> = [
  {
    name: 'trigger outside the closed enum',
    mutate: (hook) => {
      hook.trigger = 'node_entred';
    },
    code: 'invalid_hook_trigger',
    quoted: 'node_entred',
  },
  {
    name: 'destination carrying the raw key instead of its name',
    mutate: (hook) => {
      const destination = hook.destination as Record<string, unknown>;
      delete destination.secret_ref;
      destination.secret = 'RAW-HMAC-KEY';
    },
    code: 'hook_raw_secret',
    quoted: 'secret',
    forbidden: 'RAW-HMAC-KEY',
  },
  {
    name: 'destination with neither secret_ref nor a raw secret',
    mutate: (hook) => {
      delete (hook.destination as Record<string, unknown>).secret_ref;
    },
    code: 'invalid_hook_destination',
    quoted: 'secret_ref',
  },
];

test('t256 — a hook with a bad trigger or a raw secret refuses the document', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  for (const scenario of HOOK_CASES) {
    const document = readExample('graph-valid-with-hooks.json') as Record<string, unknown>;
    const hooks = document.hooks as Array<Record<string, unknown>>;
    assert.ok(hooks.length >= 1, 'the fixture has to declare at least one hook');
    const hookId = hooks[0].id;
    scenario.mutate(hooks[0]);

    const report = ported.validateStructure(document);

    // Parity first, exactly as t153 does: a rule only one of the two validators
    // applies is a rule the reference validator no longer documents.
    assert.deepEqual(
      report,
      reference.validarEstrutura(document),
      `structure diverged on: ${scenario.name}`,
    );
    assert.equal(report.valid, false, `has to be refused: ${scenario.name}`);

    // The fixture is valid but for the mutation, so the whole report is the one
    // error — no companion code fires in its place.
    assert.deepEqual(
      report.errors.map((item) => item.code),
      [scenario.code],
      `wrong codes on: ${scenario.name}`,
    );
    assert.equal(report.errors[0].target, hookId, `the hook has to be named on: ${scenario.name}`);
    assert.ok(
      report.errors[0].message.includes(scenario.quoted),
      `the message has to quote "${scenario.quoted}" on: ${scenario.name} — ${report.errors[0].message}`,
    );
    if (scenario.forbidden !== undefined) {
      assert.ok(
        !report.errors[0].message.includes(scenario.forbidden),
        `the message repeats the very key it refuses: ${report.errors[0].message}`,
      );
    }
  }
});

test('t256 — a destination that is not an object is the same refusal', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  const document = readExample('graph-valid-with-hooks.json') as Record<string, unknown>;
  const hooks = document.hooks as Array<Record<string, unknown>>;
  hooks[0].destination = 'https://exemplo.invalid/ganchos/revisao';

  const report = ported.validateStructure(document);
  assert.deepEqual(report, reference.validarEstrutura(document), 'the two validators still agree');
  assert.deepEqual(report.errors.map((item) => item.code), ['invalid_hook_destination']);
});

/**
 * t168 — `custom_fields` is a required key, and both validators say so.
 *
 * The point of running it through the pair is the parity of AT1: a rule added
 * to the port and not to the reference validator (or the other way round) is a
 * rule the fixtures would never expose, because a fixture that carries the key
 * satisfies both.
 */
test('t168 — a document with no custom_fields is a structure error in both validators', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  const document = minimalGraph();
  delete document.custom_fields;
  const report = ported.validateStructure(document);

  assert.deepEqual(report, reference.validarEstrutura(document), 'the two validators still agree');
  assert.equal(report.valid, false, 'the key is required, not optional-with-a-default');
  const missing = report.errors.find((item) => item.target === 'custom_fields');
  assert.ok(missing !== undefined, 'the missing key has to be reported by name');
  assert.equal(missing.code, 'missing_required_field');

  const notAList = minimalGraph();
  notAList.custom_fields = 'nem lista nem nada';
  const listReport = ported.validateStructure(notAList);

  assert.deepEqual(listReport, reference.validarEstrutura(notAList), 'and they agree here too');
  const invalid = listReport.errors.find((item) => item.target === 'custom_fields');
  assert.ok(invalid !== undefined, 'a custom_fields that is not a list has to be reported');
  assert.equal(invalid.code, 'invalid_field');
  assert.equal(invalid.message, '"custom_fields" has to be a list');
});

/**
 * t180/t230 — the report's prose, keys, codes and rule names are all English.
 *
 * The prose moved with t180; the vocabulary around it with t230, the fifth
 * child of D20. The parity of AT1 is what makes this a two-file claim: the same
 * sentence and the same code have to come out of `scripts/validate-graph.mjs`,
 * or `deepEqual` says so above.
 */
test('t230 — a structure message and the vocabulary around it are English', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  const document = minimalGraph();
  document.nodes = 'nem lista nem nada';
  const report = ported.validateStructure(document);

  assert.deepEqual(report, reference.validarEstrutura(document), 'the two validators still agree');

  const listProblem = report.errors.find((item) => item.target === 'nodes');
  assert.ok(listProblem !== undefined, 'a "nodes" that is not a list has to be reported');
  assert.equal(listProblem.code, 'invalid_field', 'the machine-readable code comes from the glossary (§5.4)');
  assert.equal(listProblem.message, '"nodes" has to be a list');

  // The rule labels are data two validators compare on, not prose (§5.4).
  assert.equal(ported.RULES.REACHABLE, 'reachable');
});
