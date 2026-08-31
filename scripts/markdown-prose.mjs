/**
 * Reading a Markdown document as prose.
 *
 * A gate that asserts something about what a document SAYS has to separate the
 * sentences from the markup around them: a code fence, a backtick span and an
 * inline identifier are not prose, and a check pointed at them reports on the
 * wrong thing.
 *
 * Everything here blanks rather than drops, so the index of a line in the
 * result is still its number in the file and a failure can name it.
 *
 * Nothing here runs on its own; it is imported by the gates that do.
 */

/**
 * The same text, same length, every character but a newline turned to a space.
 *
 * @param {string} text The span to blank out.
 * @returns {string} The same length, spaces except for the newlines.
 */
export function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

/** An opening or closing code fence, and the run of backticks that makes it. */
export const FENCE = /^\s*(`{3,})/;

/**
 * A backtick span, of any backtick run length, within one line.
 *
 * Within one line ON PURPOSE. Widening `.` to `[\s\S]` so that a wrapped span
 * stays one span was tried and reverted: a single unbalanced backtick anywhere
 * above then pairs across the line break and INVERTS every pairing after it,
 * blanking the gaps between spans instead of the spans. Per line, an odd
 * backtick spoils its own line and nothing else.
 */
export const SPAN = /(`+)(.+?)\1/g;

/**
 * One line with every backtick span blanked out; the backticks stay.
 *
 * @param {string} line One line of a file.
 * @returns {string} The same length, every quoted span blanked.
 */
export function withoutSpans(line) {
  let kept = line;

  for (const match of line.matchAll(SPAN)) {
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    kept = kept.slice(0, start) + blank(match[2]) + kept.slice(end);
  }

  return kept;
}

/**
 * A document reduced to its prose: no code span and no fenced block.
 *
 * @param {string} markdown Contents of one document.
 * @returns {string[]} One entry per line of the input, prose intact, rest blank.
 */
export function proseOf(markdown) {
  const prose = [];
  let fence = null;

  for (const line of markdown.split('\n')) {
    const opener = FENCE.exec(line);
    if (fence !== null) {
      prose.push('');
      if (opener !== null && opener[1].startsWith(fence)) fence = null;
      continue;
    }
    if (opener !== null) {
      fence = opener[1];
      prose.push('');
      continue;
    }

    prose.push(withoutSpans(line));
  }

  return prose;
}
