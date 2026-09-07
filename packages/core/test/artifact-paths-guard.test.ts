/**
 * Structural gate: only the local store knows where an artifact's bytes live
 * (t422, FR12/AT18).
 *
 * RF-38's whole point is that a stored file leaves a session's worktree through
 * an INTERFACE, and that the database keeps a reference and not a path. The way
 * that erodes is never a redesign — it is one route, one repository or one CLI
 * command that "just needs the file", writes
 * `path.join(root, 'artifacts', ref)` of its own, and from then on the layout
 * is load-bearing in two places. The day a second `ArtifactStore` exists, that
 * second place is a bug nobody can find by reading `store.ts`.
 *
 * So this reads the source and runs nothing, the same technique as
 * `scripts/check-single-writer.mjs`: a string literal containing `artifacts/`
 * in a path-building position is a violation anywhere under
 * `packages/core/src` except in `src/artifacts/local-store.ts`, which is the one
 * module the layout belongs to.
 *
 * **What it deliberately does NOT flag** is the same word in an HTTP route
 * (`/artifacts/:id`) or in prose: those are addresses and sentences, not
 * filesystem paths, and a gate that refused them would be asking the API to
 * rename its own surface. The distinction is the path-building CALL around the
 * literal, which is why {@link pathBuildingLiterals} looks at the expression and
 * not only at the string — and why the second case below feeds it a snippet that
 * really does build a path, so the gate cannot pass by finding nothing anywhere.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PACKAGE_ROOT } from './support.ts';

/** The one module allowed to know the layout, relative to `packages/core`. */
const LAYOUT_OWNER = path.join('src', 'artifacts', 'local-store.ts');

/** Where the sweep starts. */
const SOURCE_ROOT = path.join(PACKAGE_ROOT, 'src');

/**
 * Calls that turn a string into a filesystem path.
 *
 * `path.*` builds one and the `node:fs` verbs consume one; either is enough to
 * make the literal beside it a path rather than a word. The list is deliberately
 * short and literal — the same posture the single-writer gate takes with its own
 * import patterns — because a regex that tried to understand expressions would
 * fail silently in both directions.
 */
const PATH_BUILDERS = Object.freeze([
  'path.join',
  'path.resolve',
  'path.normalize',
  'join(',
  'resolve(',
  'readFile',
  'writeFile',
  'appendFile',
  'createReadStream',
  'createWriteStream',
  'existsSync',
  'statSync',
  'mkdir',
  'rename',
  'unlink',
  'openSync',
]);

/** How far back from the literal the enclosing expression is looked for. */
const WINDOW = 160;

/**
 * The path-building literals of a source file that mention `artifacts/`.
 *
 * @param source Contents of a `.ts` file.
 * @returns One entry per offending literal, with the expression around it.
 */
export function pathBuildingLiterals(source: string): string[] {
  const found: string[] = [];
  const literal = /(['"`])([^'"`\n]*artifacts\/[^'"`\n]*)\1/g;

  let match;
  while ((match = literal.exec(source)) !== null) {
    const start = Math.max(0, match.index - WINDOW);
    const context = source.slice(start, match.index + match[0].length);
    if (PATH_BUILDERS.some((builder) => context.includes(builder))) {
      found.push(context.split('\n').slice(-3).join('\n').trim());
    }
  }

  return found;
}

/** Every `.ts` file under a directory, recursively, as absolute paths. */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(filePath));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(filePath);
  }
  return found.sort();
}

test('t422 AT18 — nothing outside local-store.ts builds a path out of "artifacts/"', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles(SOURCE_ROOT)) {
    const relative = path.relative(PACKAGE_ROOT, file);
    if (relative === LAYOUT_OWNER) continue;

    for (const occurrence of pathBuildingLiterals(readFileSync(file, 'utf8'))) {
      offenders.push(`${relative}\n    ${occurrence.replace(/\n/g, '\n    ')}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these build an artifact path outside `src/artifacts/local-store.ts`; go through ' +
      '`ArtifactStore` instead — the layout is that module\'s alone (RF-38, FR12)',
  );
});

test('t422 AT18 — the guard really does recognize a path built by hand', () => {
  // The positive control, and the reason the case above cannot pass by looking
  // at nothing: this is exactly the line the gate exists to stop, and a change
  // to `pathBuildingLiterals` that stopped seeing it would leave the sweep green
  // and empty.
  const offending = "const file = path.join(root, 'artifacts/ab', ref);";
  assert.equal(pathBuildingLiterals(offending).length, 1);

  // ...and the two shapes it must NOT call violations: an HTTP address and a
  // sentence. Neither reaches a filesystem.
  assert.deepEqual(pathBuildingLiterals("app.get('/artifacts/:id', handler);"), []);
  assert.deepEqual(pathBuildingLiterals('// the bytes live under artifacts/<sha>'), []);
});
