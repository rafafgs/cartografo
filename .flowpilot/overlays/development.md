### If your ticket draws or edits a page, the design system is binding

Anything under `packages/screen` is a page this product serves: a
server-rendered route, the `STYLE` constant in `pages.ts`, `public/style.css`,
the interview island, or `map-document.ts`. Before you write a line of markup
or CSS, **open [`docs/spec/design-system.md`](../../docs/spec/design-system.md)
and read it whole.** It is short, and it is the contract — not background
reading, and not one of the canonical docs you open only if your surface
touches it.

This instruction exists because for a whole wave of tickets it did not:
the design system lived only in a private document nobody working in this
repository could open, `style.css` carried a comment claiming to *be* the
design system, and every ticket that drew a page invented its own answer. Two
stylesheets that share no token is what that cost.

The five rules that are violated most easily, restated here so that no session
can claim it did not have them:

1. **No literal colour in a rule.** Every colour is a token defined at `:root`.
   A `#b3261e` in a stylesheet is a bug, whatever it renders as.
2. **`--line` for borders, never `currentColor`.** A border as dark as body
   text turns a dense board into a wall of boxes.
3. **Hierarchy is `--soft`, never `opacity`.** Opacity composites everything
   inside the element, compounds when nested, and cannot be measured against a
   contrast floor.
4. **Colour is reserved for state**, and there is no brand colour. The primary
   button is solid ink; the destructive one is an outline.
5. **8px radius, spacing in multiples of four, no shadow** on anything that
   does not float over the page. 44px list rows, 36px buttons, 15.5px base.

If your change genuinely needs something the design system does not have, that
is an `input-request`, not a decision you take inside the diff — and the answer
belongs in `docs/spec/design-system.md` in the same delivery. §10 of that
document lists what is already known to be unsettled; adding to that list is a
legitimate outcome, inventing a sixth colour is not.

### The vocabulary rule is part of it

On the interview's pages, every string a person reads says *interview*, *map*,
*step*, *question*, *answer* — never *job*, *runner* or *input request*
(`docs/spec/screen-interview.md` §2, swept by a test). Route paths, `data-*`
markers and class names are identifiers and are outside the rule.
