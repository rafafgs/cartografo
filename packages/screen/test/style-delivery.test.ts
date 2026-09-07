/**
 * Acceptance test of the stylesheet collapse (t458, Functional Requirement 6).
 *
 * The `STYLE` constant that used to be inlined into every rendered page by
 * `layout()` is gone; `layout()` links `/style.css` instead, the same file
 * `static.ts` already serves to `/inbox` and `/graph-editor.html`
 * (`static.test.ts` proves that half — the byte-for-byte, real-HTTP one). This
 * file proves the other half: a rendered page's own HTML no longer carries an
 * inline `<style>` block and does carry the link, through the real router.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { openPage, startControlPlane, startScreen } from './support.ts';

test('t458 — a rendered page links /style.css and carries no inline <style>', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const page = await openPage(screen, '/');
  assert.equal(page.status, 200);
  assert.ok(
    page.html.includes('<link rel="stylesheet" href="/style.css">'),
    `the check page does not link /style.css:\n${page.html}`,
  );
  assert.ok(
    !page.html.includes('<style>'),
    `the check page still carries an inline <style> block:\n${page.html}`,
  );
});
