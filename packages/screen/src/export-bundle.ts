/**
 * Exporting a finished map as a bundle the rest of the world already reads
 * (t432, RF-25).
 *
 * `cartografo import` takes a DIRECTORY — a `graph.json` beside a `skills/` of
 * manifests — and that is what a bundle is everywhere else in this repository.
 * A browser download is not a directory: it is a sequence of bytes with a file
 * name on it. So this module assembles the directory as an archive, and the
 * claim it makes is exact: unpack these bytes anywhere and
 * `scripts/validate-factory-bundle.mjs` accepts the result unchanged, pins and
 * all.
 *
 * Three decisions are worth stating, because each one removes a class of
 * failure rather than adding a feature:
 *
 * - **Stored, never Deflate** (compression method 0). RF-25 asks for a bundle
 *   the validator accepts, not a small file, and JSON of this size gains
 *   approximately nothing from compression. What Stored buys is the absence of
 *   an encode/decode step where a hand-rolled writer and whatever reads it back
 *   could silently disagree.
 * - **The ZIP format's own epoch floor** (1980-01-01 00:00:00) as every entry's
 *   timestamp, never `Date.now()`. This function reads no clock and no random
 *   source, so the same draft always produces byte-identical output — which is
 *   what a wall-clock stamp would have broken one hour past midnight, and
 *   nowhere else.
 * - **`node:zlib`'s `crc32()`** for the checksum every entry header carries
 *   regardless of compression. `packages/screen/package.json` declares no
 *   runtime dependency at all and this module does not become the first one:
 *   `node:zlib` is a built-in, and `crc32` has been there since Node 22.2, well
 *   inside the package's declared `engines`.
 *
 * The pin filling itself is not duplicated here: it is `register-map.ts`'s
 * {@link fillSkillRefs}, imported. Same package, same ticket — the D11 boundary
 * this screen guards is `packages/core`, and reaching next door is what
 * `map-document.ts` already does with `pages.ts`'s own helpers.
 */

import { crc32 } from 'node:zlib';

import { fillSkillRefs, type MapDraft, type PinProblem } from './register-map.ts';

/** Version needed to extract: 2.0, which is what a Stored entry asks for. */
const VERSION = 20;

/** 1980-01-01 in the DOS date encoding: year 0 since 1980, month 1, day 1. */
const DOS_DATE = 0x0021;

/** 00:00:00 in the DOS time encoding. */
const DOS_TIME = 0x0000;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/** What {@link buildBundleZip} produces: an archive with a name, or why there is none. */
export type BundleResult =
  | { ok: true; filename: string; bytes: Uint8Array }
  | { ok: false; problems: PinProblem[] };

/** One file of the archive, already serialized. */
interface Entry {
  /** Path inside the bundle, ASCII (kebab-case ids, `graph.json`, `skills/`). */
  name: string;
  data: Buffer;
  crc: number;
}

function entryOf(name: string, document: unknown): Entry {
  const data = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return { name, data, crc: crc32(data) };
}

/** The header that precedes an entry's bytes. */
function localHeader(entry: Entry): Buffer {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(0, 6); // general purpose flags: none, and no UTF-8 bit (every name is ASCII)
  header.writeUInt16LE(0, 8); // compression method: Stored
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.data.length, 18); // compressed size — Stored, so the same as below
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28); // extra field: none
  name.copy(header, 30);
  return header;
}

/** The catalogue record, which is where a reader starts. */
function centralRecord(entry: Entry, offset: number): Buffer {
  const name = Buffer.from(entry.name, 'utf8');
  const record = Buffer.alloc(46 + name.length);
  record.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  record.writeUInt16LE(VERSION, 4); // version made by
  record.writeUInt16LE(VERSION, 6); // version needed to extract
  record.writeUInt16LE(0, 8);
  record.writeUInt16LE(0, 10);
  record.writeUInt16LE(DOS_TIME, 12);
  record.writeUInt16LE(DOS_DATE, 14);
  record.writeUInt32LE(entry.crc, 16);
  record.writeUInt32LE(entry.data.length, 20);
  record.writeUInt32LE(entry.data.length, 24);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt16LE(0, 30); // extra field: none
  record.writeUInt16LE(0, 32); // comment: none
  record.writeUInt16LE(0, 34); // disk the entry starts on
  record.writeUInt16LE(0, 36); // internal attributes
  record.writeUInt32LE(0, 38); // external attributes
  record.writeUInt32LE(offset, 42);
  name.copy(record, 46);
  return record;
}

/** The one record that says where the catalogue is. */
function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(EOCD_SIGNATURE, 0);
  record.writeUInt16LE(0, 4); // this disk
  record.writeUInt16LE(0, 6); // disk the central directory starts on
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(size, 12);
  record.writeUInt32LE(offset, 16);
  record.writeUInt16LE(0, 20); // archive comment: none
  return record;
}

/** Packs the entries, in the order given: local headers, then the catalogue, then the end record. */
function pack(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const header = localHeader(entry);
    central.push(centralRecord(entry, offset));
    parts.push(header, entry.data);
    offset += header.length + entry.data.length;
  }

  const directorySize = central.reduce((total, record) => total + record.length, 0);
  return Buffer.concat([
    ...parts,
    ...central,
    endOfCentralDirectory(entries.length, directorySize, offset),
  ]);
}

/**
 * Packs the drafted map into a bundle a person can download (RF-25).
 *
 * Pure: no clock, no randomness, no I/O. The pins are closed first — a draft
 * whose `skill_ref` names a manifest that is not there is refused for THAT
 * reason, before the file even needs a name — and the problem shape is
 * `fillSkillRefs`'s own, so a caller renders one list either way.
 *
 * @param draft The interview's output.
 * @returns The archive and the name to download it under, or every problem that
 *   stopped it.
 */
export function buildBundleZip(draft: MapDraft): BundleResult {
  const filled = fillSkillRefs(draft);
  if (!filled.ok) return { ok: false, problems: filled.problems };

  const problemClass = filled.graph.problem_class;
  if (typeof problemClass !== 'string' || problemClass.trim() === '') {
    return {
      ok: false,
      problems: [
        {
          code: 'missing_problem_class',
          message:
            'the drafted graph declares no "problem_class", and it is what names both the bundle and the class the map registers as',
        },
      ],
    };
  }

  const entries = [
    entryOf('graph.json', filled.graph),
    ...filled.manifests.map((manifest) => entryOf(`skills/${manifest.id}.json`, manifest)),
  ];

  return { ok: true, filename: `${problemClass}.bundle.zip`, bytes: pack(entries) };
}
