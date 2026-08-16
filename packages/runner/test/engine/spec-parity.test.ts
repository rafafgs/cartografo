/**
 * Specification parity: `types.ts` may not drift away from the document.
 *
 * The EngineAdapter specification is **frozen at v1** since t119
 * (`docs/formatos/engine-adapter.md:1-9`) — the two-consumers rule demanded two
 * implemented adapters before the format could be locked, and both exist. The
 * risk this test guards against did not end with the freeze, it changed sides:
 * while the document moved, the danger was the code drifting in silence; now
 * that it is still, the danger is a convenient edit to a published format
 * passing as an implementation detail.
 *
 * This test is the gate against that. It reads the ```typescript``` blocks of
 * the "Interface TypeScript" section of the document, extracts every exported
 * symbol and demands the SAME set from the module — neither less (the document
 * rules) nor more (the module invents no contract).
 *
 * Only names and kinds are compared, never the prose around them: the document
 * is a repo document and stays in Portuguese, while the module's comments are
 * English from D18 onward.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOC = fileURLToPath(new URL('../../../../docs/formatos/engine-adapter.md', import.meta.url));
const TYPES = fileURLToPath(new URL('../../src/engine/types.ts', import.meta.url));

const SECTION = '## Interface TypeScript';

/** Symbols that only exist at compile time — there is no checking them at runtime. */
const ERASED_KINDS = new Set(['type', 'interface']);

const EXPORT_PATTERN =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(type|interface|class|const|let|var|function|enum)\s+([A-Za-z_$][\w$]*)/gm;

/** Body of a `## <title>` section up to the next heading of the same level. */
function sectionBody(markdown: string, title: string): string {
  const lines = markdown.split('\n');
  const start = lines.indexOf(title);
  assert.notEqual(start, -1, `section "${title}" not found in ${DOC}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Concatenates the content of every fenced ```typescript``` block of an excerpt. */
function typescriptBlocks(excerpt: string): string {
  const blocks: string[] = [];
  const pattern = /^```typescript\n([\s\S]*?)^```$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(excerpt)) !== null) blocks.push(match[1] ?? '');
  return blocks.join('\n');
}

/** `name -> kind` of every exported symbol in a TypeScript source. */
function exportsOf(source: string): Map<string, string> {
  const found = new Map<string, string>();
  EXPORT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPORT_PATTERN.exec(source)) !== null) {
    const [, kind, name] = match;
    if (kind && name) found.set(name, kind);
  }
  return found;
}

const fromDocument = exportsOf(typescriptBlocks(sectionBody(readFileSync(DOC, 'utf8'), SECTION)));

test('the extraction from the document found the interface (guard against a broken regex)', () => {
  assert.ok(
    fromDocument.size >= 10,
    `only ${fromDocument.size} symbol(s) extracted from "${SECTION}" — the extraction broke`,
  );
  for (const anchor of ['SessionSpec', 'SessionListener', 'EngineAdapter', 'UnknownSessionError']) {
    assert.ok(fromDocument.has(anchor), `anchor "${anchor}" did not come from the document`);
  }
});

test('types.ts exports exactly the symbols of the document — neither less, nor more', () => {
  const fromModule = exportsOf(readFileSync(TYPES, 'utf8'));

  const expected = [...fromDocument.keys()].sort();
  const declared = [...fromModule.keys()].sort();

  const missing = expected.filter((name) => !fromModule.has(name));
  const extra = declared.filter((name) => !fromDocument.has(name));

  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    'types.ts drifted away from docs/formatos/engine-adapter.md § Interface TypeScript',
  );
  assert.deepEqual(declared, expected);

  for (const [name, kind] of fromDocument) {
    assert.equal(fromModule.get(name), kind, `"${name}" changed kind relative to the document`);
  }
});

test('the value symbols of the document really exist at runtime', async () => {
  const module: Record<string, unknown> = await import('../../src/engine/types.ts');

  for (const [name, kind] of fromDocument) {
    if (ERASED_KINDS.has(kind)) continue;
    assert.ok(
      Object.hasOwn(module, name),
      `"${name}" is declared but is not exported at runtime by types.ts`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* t166 — model discovery grew the frozen-but-additive interface.             */
/*                                                                            */
/* The two tests above already demand SYMBOL parity, so `EngineModel` and     */
/* `ModelCatalog` are covered the moment they exist on either side. What they */
/* do NOT cover is a MEMBER: `listModels` is a method of `EngineAdapter`, and */
/* an interface member is invisible to an export scan. Growth of a published  */
/* format that nothing checks is exactly the drift this file exists to catch. */
/* -------------------------------------------------------------------------- */

const MODULE_SOURCE = readFileSync(TYPES, 'utf8');
const DOCUMENT_TYPESCRIPT = typescriptBlocks(sectionBody(readFileSync(DOC, 'utf8'), SECTION));

/** The body of an `export interface <name> { … }`, brace-matched. */
function interfaceBody(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name}`);
  assert.notEqual(start, -1, `interface "${name}" not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`interface "${name}" is not closed`);
}

test('t166 — the document and types.ts both declare EngineModel and ModelCatalog', () => {
  for (const name of ['EngineModel', 'ModelCatalog']) {
    assert.equal(
      fromDocument.get(name),
      'interface',
      `"${name}" did not come from the document as an interface`,
    );
  }
});

test('t166 — listModels is an OPTIONAL member of EngineAdapter, on both sides', () => {
  for (const [side, source] of [
    ['docs/formatos/engine-adapter.md', DOCUMENT_TYPESCRIPT],
    ['src/engine/types.ts', MODULE_SOURCE],
  ] as const) {
    const body = interfaceBody(source, 'EngineAdapter');
    assert.match(
      body,
      /\blistModels\?\s*\(\s*\)\s*:\s*Promise<ModelCatalog>/,
      `${side}: EngineAdapter has to declare \`listModels?(): Promise<ModelCatalog>\` — ` +
        'the QUESTION MARK is the compatibility claim, and without it every third-party ' +
        'adapter stops compiling',
    );
  }
});

test('t166 — EngineModel keeps id and origin required, and label optional', () => {
  for (const [side, source] of [
    ['docs/formatos/engine-adapter.md', DOCUMENT_TYPESCRIPT],
    ['src/engine/types.ts', MODULE_SOURCE],
  ] as const) {
    const body = interfaceBody(source, 'EngineModel');
    assert.match(body, /\bid\s*:\s*string/, `${side}: EngineModel.id has to be a required string`);
    assert.match(body, /\blabel\?\s*:\s*string/, `${side}: EngineModel.label has to be optional`);
    assert.match(
      body,
      /\borigin\s*:\s*("cli"|'cli')\s*\|\s*("catalog"|'catalog')/,
      `${side}: EngineModel.origin has to be the closed pair 'cli' | 'catalog'`,
    );

    const catalog = interfaceBody(source, 'ModelCatalog');
    assert.match(catalog, /\bmodels\s*:\s*readonly EngineModel\[\]/, `${side}: ModelCatalog.models`);
    assert.match(catalog, /\bresolvedAt\s*:\s*string/, `${side}: ModelCatalog.resolvedAt`);
  }
});
