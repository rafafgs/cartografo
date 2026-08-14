/**
 * Specification parity: `types.ts` may not drift away from the document.
 *
 * The EngineAdapter specification is declaredly **not frozen**
 * (`docs/formatos/engine-adapter.md:1-9`) — the two-consumers rule demands two
 * implemented adapters before the format is locked. While it moves, the real
 * risk is not the code contradicting the document loudly: it is the code
 * drifting in silence and only showing up on the day of the second CLI (t119).
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
