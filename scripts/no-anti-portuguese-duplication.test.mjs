/**
 * Gate: one wire-glossary parser, one list of frozen export names (t287, FR8).
 *
 * The premise t287 started from — that seventeen `no-portuguese-*` suites are
 * seven copies of one exception list — did not survive a full read of them. The
 * seventeen span four different dimensions, most of what looked like a shared
 * list is per-package domain vocabulary that is supposed to differ, and the
 * eight exemption shapes each answer a different question. Two things in there
 * really were one fact written down more than once, and those two are what this
 * gate keeps collapsed:
 *
 * - **The table parser of `docs/spec/glossario-wire.md`.** Five wire gates each
 *   opened that spec and matched its rows with a parser of their own, and the
 *   five had already drifted: two split a multi-spelling cell and stripped the
 *   `=` qualifier, three did neither, and two tracked `### N.N` headings while
 *   three filtered a column instead. One spec, five readers, five ways to break
 *   the day its shape changes. It belongs to `packages/test-support` now, the
 *   way the boot helper does (`scripts/no-boot-core-duplication.test.mjs`, the
 *   gate this one is modelled on) and the way the database dimension already
 *   had it in `packages/core/test/glossary-terms.ts`.
 * - **`FROZEN_IDENTIFIERS`.** The four export names of `scripts/validar-grafo.mjs`
 *   that `packages/core/test/domain-graph.test.ts` pins by name, declared
 *   verbatim in both root identifier sweeps. It lives in
 *   `scripts/frozen-portuguese-identifiers.mjs` now.
 *
 * Both rules are read off the source and run nothing, exactly like the model:
 *
 * - `glossary_read_here` — a wire gate spells the spec's own name in a string
 *   literal. That literal is a path, and a path to that spec is the one way to
 *   open it; naming it in prose or quoting it in a failure text is not.
 * - `shared_parser_not_imported` — a wire gate that reaches the rows any other
 *   way than through the owning package.
 * - `frozen_list_copied_here` — a root sweep that declares the pinned names
 *   itself instead of importing them.
 * - `frozen_list_not_imported` — ...and the same absence, from the other side.
 *
 * The last two are a pair on purpose. Deleting the declaration alone would pass
 * a rule that only hunted copies, while the names silently stopped being masked
 * and the sweep started demanding a rename that core's suite forbids.
 *
 * Same shape as the model: exported functions plus a CLI, zero dependencies, a
 * report that comes out whole instead of stopping at the first offender. It runs
 * inside the root `node --test scripts/**\/*.test.mjs` group
 * (`scripts/run-all-tests.mjs`), so no wiring was needed there.
 *
 * CLI use: `node scripts/no-anti-portuguese-duplication.test.mjs`
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

/** The workspace that owns the parser; its `src/` is the one legal home. */
export const OWNER_PACKAGE = 'test-support';

/** The specifier a consumer reaches the parser through. */
export const OWNER_SPECIFIER = '@cartografo/test-support';

/** The parser's exported name, as every consumer has to spell it. */
export const PARSER_NAME = 'glossaryTerms';

/** The spec the parser owns the reading of. */
export const GLOSSARY_FILE = 'glossario-wire.md';

/** The per-package gate that consumes the parser, one per workspace. */
export const WIRE_GATE_FILE = 'no-portuguese-wire.test.ts';

/** The module that owns the pinned export names. */
export const FROZEN_MODULE = 'frozen-portuguese-identifiers.mjs';

/** The array that module exports. */
export const FROZEN_NAME = 'FROZEN_IDENTIFIERS';

/** The two root sweeps that mask the pinned names, relative to the repository. */
export const FROZEN_CONSUMERS = Object.freeze([
  path.join('scripts', 'no-portuguese-identifiers.test.mjs'),
  path.join('tests', 'no-portuguese-identifiers.test.mjs'),
]);

/** Replaces a span with same-length blanks, so line numbers stay honest. */
function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Blanks every comment, so prose about the spec is not read as a read of it.
 *
 * Every one of the five gates names the spec in its own header, and two of them
 * quote its section numbers in the reasons they record for an exemption. That is
 * documentation, and documentation is how the next reader finds out which rows a
 * gate is about.
 */
export function maskComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank);
}

/** The name of the spec, quoted — which is to say, written as a path. */
const GLOSSARY_PATH = new RegExp(`(['"])${GLOSSARY_FILE.replace('.', '\\.')}\\1`);

/** An import of one name out of one specifier, however the braces are wrapped. */
function importOf(name, specifier) {
  return new RegExp(
    `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"][^'"]*${specifier}['"]`,
  );
}

/** The parser, imported from the package that owns it. */
const PARSER_IMPORT = importOf(PARSER_NAME, OWNER_SPECIFIER);

/** The pinned names, imported from the module that owns them. */
const FROZEN_IMPORT = importOf(FROZEN_NAME, FROZEN_MODULE.replace('.', '\\.'));

/**
 * Every violation of the parser rule in one wire gate, as `{line, code, message}`.
 *
 * @param {string} source File contents.
 * @returns {Array<{line: number, code: string, message: string}>}
 */
export function wireGateHits(source) {
  const hits = [];

  maskComments(source)
    .split('\n')
    .forEach((line, index) => {
      if (GLOSSARY_PATH.test(line)) {
        hits.push({
          line: index + 1,
          code: 'glossary_read_here',
          message: `this opens ${GLOSSARY_FILE} itself; ${OWNER_SPECIFIER} owns the parsing of it`,
        });
      }
    });

  if (!PARSER_IMPORT.test(maskComments(source))) {
    hits.push({
      line: 1,
      code: 'shared_parser_not_imported',
      message: `no import of ${PARSER_NAME} from ${OWNER_SPECIFIER}; the rows have to come from there`,
    });
  }

  return hits.sort((a, b) => a.line - b.line);
}

/**
 * Every violation of the pinned-names rule in one root sweep.
 *
 * @param {string} source File contents.
 * @returns {Array<{line: number, code: string, message: string}>}
 */
export function frozenSweepHits(source) {
  const masked = maskComments(source);
  const hits = [];

  masked.split('\n').forEach((line, index) => {
    if (new RegExp(`(^|[^.\\w$])(?:const|let|var)\\s+${FROZEN_NAME}\\s*=`).test(line)) {
      hits.push({
        line: index + 1,
        code: 'frozen_list_copied_here',
        message: `${FROZEN_NAME} is declared here; import it from scripts/${FROZEN_MODULE} instead`,
      });
    }
  });

  if (!FROZEN_IMPORT.test(masked)) {
    hits.push({
      line: 1,
      code: 'frozen_list_not_imported',
      message: `no import of ${FROZEN_NAME} from scripts/${FROZEN_MODULE}; the mask would be gone`,
    });
  }

  return hits.sort((a, b) => a.line - b.line);
}

/**
 * Every per-package wire gate there is, as repository-relative paths, sorted.
 *
 * Discovered rather than listed: a sixth workspace that grows one is swept the
 * day it lands, without this gate having to be told.
 *
 * @returns {string[]}
 */
export function wireGateFiles() {
  if (!existsSync(PACKAGES_DIR)) return [];
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== OWNER_PACKAGE)
    .map((entry) => path.join('packages', entry.name, 'test', WIRE_GATE_FILE))
    .filter((relative) => existsSync(path.join(REPO_ROOT, relative)))
    .sort();
}

/**
 * Sweeps both rules over both sets.
 *
 * @returns {{valid: boolean, violations: Array<{file: string, line: number, code: string, message: string}>}}
 */
export function check() {
  const violations = [
    ...wireGateFiles().flatMap((file) =>
      wireGateHits(readFileSync(path.join(REPO_ROOT, file), 'utf8')).map((hit) => ({ file, ...hit })),
    ),
    ...FROZEN_CONSUMERS.flatMap((file) =>
      frozenSweepHits(readFileSync(path.join(REPO_ROOT, file), 'utf8')).map((hit) => ({ file, ...hit })),
    ),
  ];

  return { valid: violations.length === 0, violations };
}

test('FR8 — the wire glossary has exactly one parser, and every gate consumes it', () => {
  const gates = wireGateFiles();
  assert.ok(
    gates.length >= 5,
    `the sweep found only ${gates.length} wire gates; it is not reading the packages`,
  );

  const violations = gates.flatMap((file) =>
    wireGateHits(readFileSync(path.join(REPO_ROOT, file), 'utf8')).map(
      (hit) => `${file}:${hit.line} — ${hit.code}: ${hit.message}`,
    ),
  );

  assert.deepEqual(
    violations,
    [],
    `the wire glossary is parsed in more than one place (t287, FR8):\n${violations.join('\n')}`,
  );
});

test('FR8 — the pinned export names are declared once, and both sweeps import them', () => {
  const owner = path.join(REPO_ROOT, 'scripts', FROZEN_MODULE);
  assert.ok(existsSync(owner), `scripts/${FROZEN_MODULE} is where the pinned names live`);

  const violations = FROZEN_CONSUMERS.flatMap((file) =>
    frozenSweepHits(readFileSync(path.join(REPO_ROOT, file), 'utf8')).map(
      (hit) => `${file}:${hit.line} — ${hit.code}: ${hit.message}`,
    ),
  );

  assert.deepEqual(
    violations,
    [],
    `the pinned export names are declared twice (t287, FR8):\n${violations.join('\n')}`,
  );
});

test('FR8 — the sweep bites on a re-introduced copy', () => {
  const readsTheSpec = [
    `const GLOSSARY = path.join(REPO_ROOT, 'docs', 'spec', '${GLOSSARY_FILE}');`,
    `readFileSync(path.join(root, "${GLOSSARY_FILE}"), 'utf8');`,
  ];
  for (const source of readsTheSpec) {
    assert.ok(
      wireGateHits(source).some((hit) => hit.code === 'glossary_read_here'),
      `the sweep missed a second reader of the spec: ${source}`,
    );
  }

  assert.ok(
    wireGateHits(`import { termsFor } from './local.ts';`).some(
      (hit) => hit.code === 'shared_parser_not_imported',
    ),
    'the sweep missed a gate that never imports the shared parser',
  );

  const declaresTheNames = [
    `const ${FROZEN_NAME} = Object.freeze(['validarEstrutura']);`,
    `export const ${FROZEN_NAME} = ['validarGrafo'];`,
  ];
  for (const source of declaresTheNames) {
    assert.ok(
      frozenSweepHits(source).some((hit) => hit.code === 'frozen_list_copied_here'),
      `the sweep missed a second declaration of the pinned names: ${source}`,
    );
  }

  assert.ok(
    frozenSweepHits('import test from "node:test";').some(
      (hit) => hit.code === 'frozen_list_not_imported',
    ),
    'the sweep missed a root sweep that no longer masks the pinned names',
  );
});

test('FR8 — the sweep does NOT bite on importing, or on naming the spec in prose', () => {
  const legalGate = [
    `import { type GlossaryTerm, ${PARSER_NAME} } from '${OWNER_SPECIFIER}';`,
    `import {\n  type GlossaryTerm,\n  ${PARSER_NAME},\n} from '${OWNER_SPECIFIER}';`,
  ].map((header) => `${header}\nconst terms = ${PARSER_NAME}({ surface: SURFACE }, 25);`);

  // Prose about the spec, and a failure text quoting it, are how a gate says
  // which rows it is about. Neither is a second reader.
  legalGate.push(
    `import { ${PARSER_NAME} } from '${OWNER_SPECIFIER}';\n` +
      `/** Reads the rows of \`docs/spec/${GLOSSARY_FILE}\` that belong here. */\n` +
      `// see '${GLOSSARY_FILE}' for the table this walks\n` +
      'assert.deepEqual(hits, [], `Portuguese still on the wire (D20, ' +
      GLOSSARY_FILE +
      ' §1)`);',
  );

  for (const source of legalGate) {
    assert.deepEqual(wireGateHits(source), [], `the sweep flagged a legal wire gate: ${source}`);
  }

  const legalSweep = [
    `import { ${FROZEN_NAME} } from './${FROZEN_MODULE}';`,
    `import { ${FROZEN_NAME} } from '../scripts/${FROZEN_MODULE}';`,
  ].map((header) => `${header}\nfor (const name of ${FROZEN_NAME}) mask(name);`);

  legalSweep.push(
    `import { ${FROZEN_NAME} } from './${FROZEN_MODULE}';\n` +
      `/** ${FROZEN_NAME} used to be declared here: const ${FROZEN_NAME} = []; */`,
  );

  for (const source of legalSweep) {
    assert.deepEqual(frozenSweepHits(source), [], `the sweep flagged a legal root sweep: ${source}`);
  }
});

function main() {
  const { valid, violations } = check();

  if (valid) {
    console.log(`✔ one glossary parser in packages/${OWNER_PACKAGE}/src, one scripts/${FROZEN_MODULE}`);
    return 0;
  }

  console.error('✖ the anti-Portuguese support is duplicated (t287, FR8)');
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} ${violation.code}: ${violation.message}`);
  }
  return 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main();
}
