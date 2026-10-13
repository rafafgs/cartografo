/**
 * Acceptance test of t687 — git itself writes every text file with LF.
 *
 * A Windows checkout with `core.autocrlf=true` wrote the shebang files under
 * `packages/core/bin/` with CRLF, and npm's bin-links step then rewrote them,
 * leaving a fresh checkout dirty after `npm install`. The root `.gitattributes`
 * (`* text=auto eol=lf`) makes the working tree LF whatever `core.autocrlf`
 * says; this test keeps a later edit from weakening it.
 *
 * The git-backed cases skip outside a git work tree (a tarball or a Docker
 * context without `.git`).
 *
 * Run with: `node --test tests/`
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const RULE = '* text=auto eol=lf';
const BIN_DIR = 'packages/core/bin';
const README = 'packages/runner/README.md';
const REFRESH_COMMAND = 'git rm -r --cached . ; git reset --hard';

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function inGitWorkTree() {
  try {
    return git('rev-parse', '--is-inside-work-tree').trim() === 'true';
  } catch {
    return false;
  }
}

const SKIP = inGitWorkTree() ? false : 'not inside a git work tree';

/** The non-comment, non-blank lines of .gitattributes, whitespace-normalised. */
function ruleLines() {
  return readFileSync(path.join(ROOT, '.gitattributes'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** `git ls-files --eol` as { index, path } rows. */
function eolRows() {
  return git('ls-files', '--eol')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [info, file] = line.split('\t');
      return { index: info.trim().split(/\s+/)[0], path: file };
    });
}

test('AT1: the rule is declared and no later line sets eol=crlf', () => {
  const lines = ruleLines();
  const at = lines.indexOf(RULE);
  assert.notEqual(at, -1, `.gitattributes has no line equal to "${RULE}"`);
  const later = lines.slice(at + 1).filter((line) => line.includes('eol=crlf'));
  assert.deepEqual(later, [], 'a later line sets eol=crlf');
});

test('AT2: every shebang file under packages/core/bin resolves to eol=lf', { skip: SKIP }, () => {
  const shebang = readdirSync(path.join(ROOT, BIN_DIR))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => `${BIN_DIR}/${name}`)
    .filter((file) => readFileSync(path.join(ROOT, file), 'utf8').startsWith('#!'));
  assert.ok(shebang.length >= 5, `found only ${shebang.length} shebang files`);
  for (const file of shebang) {
    assert.match(git('check-attr', 'eol', '--', file).trim(), /: eol: lf$/, file);
  }
});

test('AT3: the index holds no CRLF', { skip: SKIP }, () => {
  const bad = eolRows().filter((row) => row.index === 'i/crlf' || row.index === 'i/mixed');
  assert.deepEqual(
    bad.map((row) => `${row.index} ${row.path}`),
    [],
    'tracked files with CRLF in the index',
  );
});

test('AT4: no path opts out of LF unless it is binary in the index', { skip: SKIP }, () => {
  const lines = ruleLines();
  const at = lines.indexOf(RULE);
  const optOut = lines
    .slice(at + 1)
    .filter((line) => /(^| )(-text|binary|eol=crlf)( |$)/.test(line));
  const binaryInIndex = new Set(
    eolRows()
      .filter((row) => row.index === 'i/-text')
      .map((row) => row.path),
  );
  for (const line of optOut) {
    const pattern = line.split(' ')[0];
    const matched = git('ls-files', '--', pattern).split('\n').filter(Boolean);
    const notBinary = matched.filter((file) => !binaryInIndex.has(file));
    assert.ok(
      matched.length > 0 && notBinary.length === 0,
      `"${line}" opts out of LF for text files: ${notBinary.join(', ') || '(no tracked match)'}`,
    );
  }
});

test('AT5: the runner README carries the migration line in its Windows section', () => {
  const text = readFileSync(path.join(ROOT, README), 'utf8');
  const start = text.indexOf('\n## Windows\n');
  assert.notEqual(start, -1, 'no "## Windows" heading');
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  const section = next === -1 ? rest : rest.slice(0, next);
  assert.ok(section.includes(REFRESH_COMMAND), `section lacks "${REFRESH_COMMAND}"`);
  assert.match(section, /commit or save/i, 'section does not say to commit or save local changes first');
});
