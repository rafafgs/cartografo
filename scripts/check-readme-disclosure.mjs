/**
 * Static gate: the two disclosures reach a reader BEFORE the first command
 * (t329, FR6).
 *
 * Two properties are inherent to what this product is — a local orchestrator
 * that hands a model the power to execute — and neither is a defect this gate
 * asks anybody to fix:
 *
 * - the agent inherits the operator's whole shell environment
 *   (`buildEnvironment`, `packages/runner/src/engine/command.ts`);
 * - session transcripts are stored unredacted (the `transcript` column,
 *   `packages/core/src/repositories/session.ts`).
 *
 * What this gate defends is POSITION, not presence. A README that states both
 * facts three screens below the `npm install` a reader already pasted has
 * disclosed nothing: the decision the disclosure exists for was taken before
 * the sentence was reached. So both citations must appear before the first
 * ` ```bash ` fence under `## How to run it`, and `docs/getting-started.md` —
 * which a search hit or a shared link opens directly, bypassing the README's
 * fast path entirely — must carry a pointer to that section above its own first
 * fence.
 *
 * The citations are checked as PATHS, not as prose. What the block says is a
 * human's call at review (the ticket's own AC3: does it read as a boundary or
 * as a warning label); what a machine can hold is that the reader was told
 * where the behaviour lives, and told it in time.
 *
 * First occurrence is what counts. A later, legitimate mention of either file
 * further down the README is not a violation — the question is whether the
 * reader MET the citation before the command, and the first occurrence settles
 * it.
 *
 * Same shape as `scripts/check-single-writer.mjs` and
 * `scripts/check-bin-dependencies.mjs`: exported functions plus a thin CLI, zero
 * dependencies, an unreadable file reported rather than thrown — the report
 * comes out whole, not at the first problem.
 *
 * CLI use: `node scripts/check-readme-disclosure.mjs [root...]`
 * (with no argument, it checks the repository root).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Where `buildEnvironment` merges the operator's environment into the session. */
export const ENVIRONMENT_CITATION = 'packages/runner/src/engine/command.ts';

/** Where the unredacted transcript is written down. */
export const TRANSCRIPT_CITATION = 'packages/core/src/repositories/session.ts';

/** Both, in the order the disclosure introduces them. */
export const README_CITATIONS = Object.freeze([ENVIRONMENT_CITATION, TRANSCRIPT_CITATION]);

/** The link `docs/getting-started.md` owes the README section. */
export const GETTING_STARTED_POINTER = '../README.md#how-to-run-it';

/** The heading the fast path lives under. */
export const HOW_TO_RUN_HEADING = '## How to run it';

/** The fence that opens the first command a reader would paste. */
export const BASH_FENCE = '```bash';

/** Documents this gate reads, relative to the repository root. */
export const README_FILE = 'README.md';
export const GETTING_STARTED_FILE = 'docs/getting-started.md';

/** This gate's diagnostic vocabulary. */
export const CITATION_MISSING = 'disclosure_citation_missing';
export const CITATION_AFTER_FIRST_COMMAND = 'disclosure_citation_after_first_command';
export const SECTION_MISSING = 'disclosure_section_missing';
export const POINTER_MISSING = 'getting_started_pointer_missing';
export const POINTER_AFTER_FIRST_COMMAND = 'getting_started_pointer_after_first_command';
export const FILE_UNREADABLE = 'document_unreadable';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Index of the first command fence at or after `from`.
 *
 * `-1` means there is no command below that point — nothing for a reader to run
 * past, so the position rule has nothing to say. That is a deliberate pass: a
 * document with no command in it cannot put a reader in front of one.
 */
function firstFenceIndex(content, from = 0) {
  return content.indexOf(BASH_FENCE, from);
}

/**
 * Does the README disclose both facts, and does it do it in time?
 *
 * @param {string} content Contents of `README.md`.
 * @returns {{valid: boolean, violations: Array<{code: string, message: string, target: string}>}}
 */
export function checkReadmeDisclosure(content) {
  const violations = [];
  const headingIndex = content.indexOf(HOW_TO_RUN_HEADING);

  if (headingIndex === -1) {
    violations.push({
      code: SECTION_MISSING,
      message: `no "${HOW_TO_RUN_HEADING}" heading; the disclosure has no section to sit in`,
      target: HOW_TO_RUN_HEADING,
    });
  }

  // The fence that decides position is the fast path's own, not one belonging
  // to an earlier section: a snippet higher up the page is not the command this
  // disclosure has to precede.
  const fenceIndex = headingIndex === -1 ? -1 : firstFenceIndex(content, headingIndex);

  for (const citation of README_CITATIONS) {
    const citationIndex = content.indexOf(citation);

    if (citationIndex === -1) {
      violations.push({
        code: CITATION_MISSING,
        message: `"${citation}" is cited nowhere; a reader is never told where the behaviour lives`,
        target: citation,
      });
      continue;
    }

    if (fenceIndex !== -1 && citationIndex >= fenceIndex) {
      violations.push({
        code: CITATION_AFTER_FIRST_COMMAND,
        message: `"${citation}" is cited only at or after the first command under "${HOW_TO_RUN_HEADING}"; a reader runs past it`,
        target: citation,
      });
    }
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Does `docs/getting-started.md` send its own reader to that section first?
 *
 * @param {string} content Contents of `docs/getting-started.md`.
 * @returns {{valid: boolean, violations: Array<{code: string, message: string, target: string}>}}
 */
export function checkGettingStartedPointer(content) {
  const pointerIndex = content.indexOf(GETTING_STARTED_POINTER);

  if (pointerIndex === -1) {
    return {
      valid: false,
      violations: [
        {
          code: POINTER_MISSING,
          message: `no link to "${GETTING_STARTED_POINTER}"; a reader who lands here never passes through the disclosure`,
          target: GETTING_STARTED_POINTER,
        },
      ],
    };
  }

  const fenceIndex = firstFenceIndex(content);
  if (fenceIndex !== -1 && pointerIndex >= fenceIndex) {
    return {
      valid: false,
      violations: [
        {
          code: POINTER_AFTER_FIRST_COMMAND,
          message: `the link to "${GETTING_STARTED_POINTER}" comes at or after this page's first command; a reader runs past it`,
          target: GETTING_STARTED_POINTER,
        },
      ],
    };
  }

  return { valid: true, violations: [] };
}

/** Reads a document; `null` when it is unreadable. */
function readDocument(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Runs both checks over a repository tree.
 *
 * @param root Directory to check. Default: the repository root.
 * @returns `{valid, violations}`; each violation carries `code`, `file`
 *   (relative to the checked root), `message` and `target`.
 */
export function check(root = REPO_ROOT) {
  const absoluteRoot = path.resolve(root);
  const violations = [];

  const documents = [
    { file: README_FILE, run: checkReadmeDisclosure },
    { file: GETTING_STARTED_FILE, run: checkGettingStartedPointer },
  ];

  for (const { file, run } of documents) {
    const content = readDocument(path.join(absoluteRoot, file));

    if (content === null) {
      violations.push({
        code: FILE_UNREADABLE,
        file,
        message: 'could not be read; the disclosure cannot be verified',
        target: file,
      });
      continue;
    }

    for (const violation of run(content).violations) {
      violations.push({ ...violation, file });
    }
  }

  return { valid: violations.length === 0, violations };
}

function main(roots) {
  const targets = roots.length > 0 ? roots : [REPO_ROOT];
  let failed = false;

  for (const root of targets) {
    const report = check(root);
    if (report.valid) {
      console.log(`✔ ${root}`);
      continue;
    }
    failed = true;
    console.error(`✖ ${root}`);
    for (const violation of report.violations) {
      console.error(`  ${violation.code}: "${violation.file}" ${violation.message}`);
    }
  }

  return failed ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
