/**
 * The suite `npm test` runs. It passes exactly as committed.
 *
 * That matters more than what it covers: the demo's whole claim is that the
 * graph crosses against a project whose gates are green to begin with, so that
 * a red one during the demo means the work broke something.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { slugify } from '../lib/text.js';

test('slugify joins the words of a phrase with single hyphens', () => {
  assert.equal(slugify('The Cartografo Demo Repo'), 'the-cartografo-demo-repo');
});

test('slugify drops the punctuation and the padding at both ends', () => {
  assert.equal(slugify('  Hello, world!  '), 'hello-world');
});
