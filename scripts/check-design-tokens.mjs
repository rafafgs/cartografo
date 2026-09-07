/**
 * Design-token conformance gate — `docs/spec/design-system.md` §1/§3/§5 (t458).
 *
 * Until this ticket nothing in `npm run lint` failed on a literal hex, a
 * shadow, a second radius or an `opacity` used as a text grade — §10 named
 * that gap explicitly. This gate closes it, reading `.css` text and reporting
 * every violation rather than throwing at the first one, over the six rules
 * the design system's own §1/§3/§5 write down:
 *
 * 1. No colour literal (hex, or `rgb()`/`rgba()`/`hsl()`/`hsla()` written out
 *    instead of `var(...)`) anywhere outside the `:root { }` block.
 * 2. No `currentColor` anywhere — the token is `--line`.
 * 3. Every `border-radius` is exactly `var(--radius)`.
 * 4. No `opacity` declaration anywhere — the token is `--soft`.
 * 5. No `box-shadow` outside a rule whose selector names a floating element
 *    (`dropdown`, `popover`, `dialog`).
 * 6. At least one `:focus-visible` rule exists, using
 *    `outline: 2px solid var(--ink); outline-offset: 2px` — not `box-shadow`,
 *    not a colour outline.
 *
 * Same shape as `scripts/check-single-writer.mjs`: exported functions plus a
 * thin CLI, zero dependencies.
 *
 * CLI use: `node scripts/check-design-tokens.mjs [root...]`
 * (with no argument, it sweeps `packages/screen/src/public/*.css`; a root
 * argument is itself swept for `.css` files, non-recursively — the shape a
 * fixture directory or the real public directory both already have).
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** This gate's diagnostic vocabulary. */
export const COLOR_LITERAL_OUTSIDE_ROOT = 'color_literal_outside_root';
export const CURRENT_COLOR_USED = 'current_color_used';
export const NON_TOKEN_RADIUS = 'non_token_radius';
export const OPACITY_DECLARED = 'opacity_declared';
export const BOX_SHADOW_OUTSIDE_FLOATING = 'box_shadow_outside_floating';
export const FOCUS_VISIBLE_MISSING = 'focus_visible_missing';

/** Selector fragments a `box-shadow` may sit behind (Design rule 5). */
export const FLOATING_SELECTOR_NAMES = Object.freeze(['dropdown', 'popover', 'dialog']);

/** The one focus rule the system allows (§3), matched loosely on whitespace. */
const FOCUS_OUTLINE_RE = /outline\s*:\s*2px\s+solid\s+var\(\s*--ink\s*\)/;
const FOCUS_OFFSET_RE = /outline-offset\s*:\s*2px/;

const HEX_COLOR_RE = /#(?:[0-9a-fA-F]{3,4}){1,2}\b/g;
const FUNCTIONAL_COLOR_RE = /\b(?:rgba?|hsla?)\(/gi;
const CURRENT_COLOR_RE = /currentColor/gi;
const RADIUS_DECLARATION_RE = /border-radius\s*:\s*([^;]+);/g;
const OPACITY_DECLARATION_RE = /(?<![\w-])opacity\s*:/g;
const BOX_SHADOW_DECLARATION_RE = /box-shadow\s*:/g;

/** Directory this gate sweeps by default. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
export const DEFAULT_PUBLIC_DIR = path.join(REPO_ROOT, 'packages/screen/src/public');

/**
 * Replaces every `/* ... *‍/` comment with spaces of the same length, newlines
 * kept — so a colour literal or a `currentColor` written in a comment cannot
 * trip the gate, and every offset computed afterwards still points at the
 * same line and column in the ORIGINAL file.
 *
 * @param content Raw CSS text.
 * @returns The same text, comments blanked out.
 */
export function stripComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** 1-indexed line a character offset falls on. */
function lineOf(content, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Splits CSS text into its rule blocks — `{selector, bodyStart, bodyEnd}`,
 * offsets into `content` — recursing into an at-rule's body (`@media { ... }`)
 * so a nested selector is reported the same way a top-level one is.
 *
 * A textual scan, not a parser: it tracks brace depth to find each block's
 * matching close, which is all six rules below need to know which selector a
 * declaration sits under.
 *
 * @param content CSS text, comments already blanked by {@link stripComments}.
 * @param from Start offset (recursion only; callers pass the whole file).
 * @param to End offset (recursion only).
 * @returns Every rule block found, in document order.
 */
export function collectRules(content, from = 0, to = content.length) {
  const rules = [];
  let i = from;

  while (i < to) {
    const brace = content.indexOf('{', i);
    if (brace === -1 || brace >= to) break;

    const selector = content.slice(i, brace).trim();
    let depth = 1;
    let j = brace + 1;
    while (j < to && depth > 0) {
      if (content[j] === '{') depth++;
      else if (content[j] === '}') depth--;
      j++;
    }
    const bodyStart = brace + 1;
    const bodyEnd = j - 1;

    if (selector.startsWith('@')) {
      rules.push(...collectRules(content, bodyStart, bodyEnd));
    } else if (selector !== '') {
      rules.push({ selector, bodyStart, bodyEnd });
    }

    i = j;
  }

  return rules;
}

/** Rule 1 — no colour literal outside `:root { }`. */
export function checkColorLiterals(content) {
  const stripped = stripComments(content);
  const root = collectRules(stripped).find((rule) => rule.selector === ':root');
  const violations = [];

  for (const pattern of [HEX_COLOR_RE, FUNCTIONAL_COLOR_RE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(stripped)) !== null) {
      const index = match.index;
      if (root && index >= root.bodyStart && index < root.bodyEnd) continue;
      violations.push({
        code: COLOR_LITERAL_OUTSIDE_ROOT,
        line: lineOf(stripped, index),
        message: `colour literal "${match[0]}" outside :root; use a var(...) token`,
        target: match[0],
      });
    }
  }

  return violations;
}

/** Rule 2 — no `currentColor` anywhere. */
export function checkCurrentColor(content) {
  const stripped = stripComments(content);
  const violations = [];
  CURRENT_COLOR_RE.lastIndex = 0;
  let match;
  while ((match = CURRENT_COLOR_RE.exec(stripped)) !== null) {
    violations.push({
      code: CURRENT_COLOR_USED,
      line: lineOf(stripped, match.index),
      message: 'currentColor used as a border colour; the token is var(--line)',
      target: match[0],
    });
  }
  return violations;
}

/** Rule 3 — every `border-radius` is `var(--radius)`. */
export function checkRadius(content) {
  const stripped = stripComments(content);
  const violations = [];
  RADIUS_DECLARATION_RE.lastIndex = 0;
  let match;
  while ((match = RADIUS_DECLARATION_RE.exec(stripped)) !== null) {
    const value = match[1].trim();
    if (value !== 'var(--radius)') {
      violations.push({
        code: NON_TOKEN_RADIUS,
        line: lineOf(stripped, match.index),
        message: `border-radius: ${value} is not var(--radius)`,
        target: value,
      });
    }
  }
  return violations;
}

/** Rule 4 — no `opacity` declaration anywhere. */
export function checkOpacity(content) {
  const stripped = stripComments(content);
  const violations = [];
  OPACITY_DECLARATION_RE.lastIndex = 0;
  let match;
  while ((match = OPACITY_DECLARATION_RE.exec(stripped)) !== null) {
    violations.push({
      code: OPACITY_DECLARED,
      line: lineOf(stripped, match.index),
      message: 'opacity declaration used as a text or hierarchy grade; the token is var(--soft)',
      target: match[0],
    });
  }
  return violations;
}

/** Rule 5 — `box-shadow` only behind a selector naming a floating element. */
export function checkBoxShadow(content) {
  const stripped = stripComments(content);
  const violations = [];

  for (const rule of collectRules(stripped)) {
    const body = stripped.slice(rule.bodyStart, rule.bodyEnd);
    BOX_SHADOW_DECLARATION_RE.lastIndex = 0;
    let match;
    while ((match = BOX_SHADOW_DECLARATION_RE.exec(body)) !== null) {
      const selectorLower = rule.selector.toLowerCase();
      const onFloatingElement = FLOATING_SELECTOR_NAMES.some((name) => selectorLower.includes(name));
      if (onFloatingElement) continue;
      violations.push({
        code: BOX_SHADOW_OUTSIDE_FLOATING,
        line: lineOf(stripped, rule.bodyStart + match.index),
        message: `box-shadow on "${rule.selector}", which names none of ${FLOATING_SELECTOR_NAMES.join(', ')}`,
        target: rule.selector,
      });
    }
  }

  return violations;
}

/** Rule 6 — at least one conforming `:focus-visible` rule exists. */
export function checkFocusVisible(content) {
  const stripped = stripComments(content);
  const focusRules = collectRules(stripped).filter((rule) => rule.selector.includes(':focus-visible'));

  if (focusRules.length === 0) {
    return [
      {
        code: FOCUS_VISIBLE_MISSING,
        line: 1,
        message: 'no :focus-visible rule found; §3 requires one ink outline, once',
        target: ':focus-visible',
      },
    ];
  }

  const conforms = focusRules.some((rule) => {
    const body = stripped.slice(rule.bodyStart, rule.bodyEnd);
    return FOCUS_OUTLINE_RE.test(body) && FOCUS_OFFSET_RE.test(body) && !/box-shadow\s*:/.test(body);
  });

  if (conforms) return [];

  return [
    {
      code: FOCUS_VISIBLE_MISSING,
      line: lineOf(stripped, focusRules[0].bodyStart),
      message:
        ':focus-visible does not use outline: 2px solid var(--ink); outline-offset: 2px (§3) with no box-shadow',
      target: ':focus-visible',
    },
  ];
}

/**
 * Runs all six rules over one file's content.
 *
 * @param content CSS text.
 * @returns Violations, each `{code, line, message, target}` — no `file`; the
 *   caller ({@link check}) knows which file it read.
 */
export function checkContent(content) {
  return [
    ...checkColorLiterals(content),
    ...checkCurrentColor(content),
    ...checkRadius(content),
    ...checkOpacity(content),
    ...checkBoxShadow(content),
    ...checkFocusVisible(content),
  ];
}

/** The `.css` files directly inside `dir` — never recursive, a `*.css` glob. */
function listCssFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/**
 * Sweeps one directory of `.css` files against the six rules.
 *
 * @param root Directory to sweep. Default: `packages/screen/src/public`.
 * @returns `{valid, violations}`; each violation carries `code`, `file`
 *   (relative to `root`), `line`, `message` and `target`.
 */
export function check(root = DEFAULT_PUBLIC_DIR) {
  const absoluteRoot = path.resolve(root);
  const violations = [];

  for (const file of listCssFiles(absoluteRoot)) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const relative = path.relative(absoluteRoot, file).split(path.sep).join('/');
    for (const violation of checkContent(content)) {
      violations.push({ ...violation, file: relative });
    }
  }

  return { valid: violations.length === 0, violations };
}

function main(roots) {
  const targets = roots.length > 0 ? roots : [DEFAULT_PUBLIC_DIR];
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
      console.error(`  ${violation.file}:${violation.line} ${violation.code}: ${violation.message}`);
    }
  }

  return failed ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
