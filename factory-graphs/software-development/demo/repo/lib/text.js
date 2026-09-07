/**
 * The one module this fixture project has.
 *
 * Deliberately tiny and dependency-free: what the demo needs from it is a real
 * file a session can open, edit and commit, plus a sibling test that already
 * passes — not a library worth having.
 */

/**
 * Turns a phrase into a slug that is safe in a URL or a branch name.
 *
 * @param {string} text Phrase to convert.
 * @returns {string} Lowercased words joined by single hyphens, with no hyphen
 *   left at either end.
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
