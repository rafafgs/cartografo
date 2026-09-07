### A ticket that draws a page must say so, and must cite the design system

If the work you are refining touches anything under `packages/screen` — a
server-rendered route, the `STYLE` constant in `pages.ts`, `public/style.css`,
the interview island, `map-document.ts` — the spec you write carries a
**Design** section, and that section:

1. names [`docs/spec/design-system.md`](../../docs/spec/design-system.md) as
   binding, with the sections that apply (§1 tokens, §2 the six derived states,
   §3 focus/loading/error, §5 density, §6 buttons, §7 the component this ticket
   draws, §8 the left-edge bar, §9 voice);
2. says which of the two stylesheets the change lands in — they share no token
   (§10), so "add a rule" is ambiguous until this is decided;
3. turns the applicable rules into **acceptance criteria a test can fail on**,
   not prose. "No literal hex in the rules this ticket adds", "borders use
   `--line`", "the focus ring is an ink outline", "44px rows" are all
   assertable; "follows the design system" is not.

Do not write a ticket that invents a colour, a radius or a spacing value. If
the design system genuinely lacks what the work needs, that is a question for
the founder and a change to §10 of that document — never a value chosen inside
a ticket body.

**Why this is in your instructions:** a whole wave of screen tickets was
refined and built without one of them mentioning a design system, because the
one that existed lived in a private document nobody in this repository could
open. The document exists here now. A spec that does not cite it is how it
goes back to being invisible.
