/**
 * `cartografo export <class>` — the data becomes a file again (t108, FR3/FR4).
 *
 * Writes the `snapshot` of the CURRENT version of the class, with no envelope:
 * what comes out is exactly the format `import` accepts back. That is not
 * formatting convenience — it is what makes the round trip meaningful. Since
 * `graph_version.id` is the canonical hash of the whole document
 * (`docs/spec/entidades-versionamento.md` §2), reimporting the exported file
 * into another control plane has to produce the SAME id; any field this command
 * added, removed or rewrote would show up as a different hash on the other side.
 *
 * Only the current version comes out. Navigating history (`--versao`) is the
 * same cut `docs/spec/entidades-versionamento.md` §7 already declares out of
 * scope.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isObject } from '../util/is-object.ts';
import { UsageError, requestJson } from './url.ts';

/** Options of `export`. */
export interface ExportOptions {
  /** Class of the lineage to export. */
  className: string;
  /** Base URL of the control plane. */
  url: string;
  /** Output file; defaults to `./<class>.grafo.json`. */
  output?: string;
}

/** One `label  value` line of the success output. */
function line(label: string, value: string): string {
  return `  ${label.padEnd(18)}${value}\n`;
}

/**
 * Runs `cartografo export`.
 *
 * @param options Class, base URL and output file.
 * @returns Process exit code.
 */
export async function runExport(options: ExportOptions): Promise<number> {
  if (options.className.trim() === '') throw new UsageError('export needs a class');

  const fromLineage = await requestJson(
    `${options.url}/v1/graphs/${encodeURIComponent(options.className)}`,
  );
  if (fromLineage.status === 404) {
    process.stderr.write(
      `cartografo: unknown_graph — no class "${options.className}" registered at ${options.url}\n`,
    );
    return 1;
  }
  if (fromLineage.status !== 200) {
    process.stderr.write(
      `cartografo: the control plane answered HTTP ${fromLineage.status} while looking up class "${options.className}"\n`,
    );
    return 1;
  }

  const lineageBody = isObject(fromLineage.body) ? fromLineage.body : {};
  const graph = isObject(lineageBody.graph) ? lineageBody.graph : {};
  const versionId = graph.current_version_id;
  if (typeof versionId !== 'string' || versionId === '') {
    process.stderr.write(
      `cartografo: class "${options.className}" has no current version to export\n`,
    );
    return 1;
  }

  const fromVersion = await requestJson(
    `${options.url}/v1/graph-versions/${encodeURIComponent(versionId)}`,
  );
  if (fromVersion.status !== 200) {
    process.stderr.write(
      `cartografo: unknown_graph_version — the control plane answered HTTP ${fromVersion.status} for ${versionId}\n`,
    );
    return 1;
  }

  const versionBody = isObject(fromVersion.body) ? fromVersion.body : {};
  const version = isObject(versionBody.graph_version) ? versionBody.graph_version : {};
  const snapshot = version.snapshot;
  if (snapshot === undefined) {
    process.stderr.write(`cartografo: version ${versionId} came back without a snapshot\n`);
    return 1;
  }

  const destination = path.resolve(options.output ?? `${options.className}.grafo.json`);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  process.stdout.write('graph exported\n');
  process.stdout.write(line('class', options.className));
  process.stdout.write(line('graph_version.id', versionId));
  process.stdout.write(line('file', destination));
  return 0;
}
