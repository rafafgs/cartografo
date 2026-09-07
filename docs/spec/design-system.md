# Specification: the design system

**Package:** [`packages/screen`](../../packages/screen) · **Applies to:** every
page this product serves — the twenty-four server-rendered routes of
[`screen.md`](screen.md), the static proposal inbox, and the interview island
**Founding decision:** [D11](../../DECISIONS.md) — the screen is a client of the
public API, with no privileges · **RNF-04** — nothing requires a frontend build
chain, so this system is plain HTML and CSS *by consequence*, not by accident

This document is the visual and verbal contract of the screen. It exists
because the screen was built without one: for the whole of the 2026-08/09 wave
the only thing in this repository that described how a page should look was a
comment in `packages/screen/src/public/style.css` saying *this file is the whole
design system*, and every ticket that drew a page invented its own answer beside
it. There are two stylesheets today that share nothing —
[`style.css`](../../packages/screen/src/public/style.css) for the static half
and the `STYLE` constant in [`pages.ts`](../../packages/screen/src/pages.ts) for
the rendered half — and that is the shape of the absence, not a decision.

**Lineage.** FlowPilot and inbox-bot, which solve the same surface: an
operator's console, on a laptop, for a technical person. Three rules come from
there. Two are this product's own.

---

## 1. The foundation

Inherited:

1. **Near-monochrome, with no brand token.** There is deliberately no accent
   colour and no institutional blue.
2. **Colour is reserved for state.** Nothing is coloured for interest.
3. **Border instead of shadow.** A shadow belongs only to what floats *over* the
   page — a dropdown, a popover, a dialog. Nothing else gets one.

This product's own:

4. **Console density.** Base text is 15.5px, not 17px: a twelve-step map has to
   fit on one screen, and that is the whole difference between this lineage and
   a system designed for a phone.
5. **A first-class monospace.** This product is full of hashes, node names,
   paths and commands.

### Why there is no brand colour

If the interface has an institutional blue, the green of success and the orange
of waiting start competing with it and stop jumping out. In a tool whose only
urgent question is *is something waiting for me?*, spending colour on identity
spends the exact resource that answers it. Identity lives in the text and in the
spacing.

### Tokens

Every colour is defined at `:root`, in HSL, and referenced by token. A literal
hex in a rule is a bug — that is how the two stylesheets came to hold
`#b3261e` twice with no relationship between the copies.

| Token | Light | What it is for |
|---|---|---|
| `--background` | `hsl(0 0% 100%)` | the page |
| `--surface` | `hsl(0 0% 100%)` | a card, a panel |
| `--ink` | `hsl(240 6% 10%)` | body text, borders of emphasis, the primary button's fill |
| `--soft` | `hsl(240 4% 46%)` | supporting text, labels |
| `--muted` | `hsl(240 5% 96%)` | a tinted background |
| `--line` | `hsl(240 6% 90%)` | every ordinary border |
| `--success` | `hsl(152 72% 42%)` | running, a check that passed |
| `--success-text` | `hsl(154 75% 24%)` | that state's text grade |
| `--warning` | `hsl(30 95% 50%)` | waiting on you |
| `--warning-text` | `hsl(27 90% 30%)` | that state's text grade |
| `--error` | `hsl(0 76% 52%)` | failed |
| `--error-text` | `hsl(0 72% 38%)` | that state's text grade |
| `--radius` | `8px` | everywhere, with no second value |

**Two grades per state, and they are not interchangeable.** The solid grade is
for dots and edge bars; the `-text` grade is for text on a tinted background. A
tint changes the contrast floor, and contrast is measured against the
**composite** — the tint over the page — never against the page.

**`--line` is a token, not `currentColor`.** A border drawn with `currentColor`
is as dark as body text, which turns every card on a dense board into a heavy
box; and it makes rule 3 unenforceable, because there is no border colour to
check.

**Hierarchy is a token, not an opacity.** `opacity: .6` on text is not a
lighter grey — it composites the element and everything inside it downward, it
compounds when two of them nest, and it cannot be measured against a floor.
Supporting text is `--soft`.

### Dark mode is a token swap, not a second design

Because colour is reserved for state and everything else is a grey ramp, dark
mode redefines the same tokens. The three state colours rise in lightness to
survive a dark ground; nothing else changes.

| Token | Dark |
|---|---|
| `--ink` | `hsl(0 0% 96%)` |
| `--soft` | `hsl(240 5% 58%)` |
| `--success` | `hsl(152 62% 52%)` |
| `--warning` | `hsl(30 92% 60%)` |

**Open:** `--background`, `--surface`, `--muted`, `--line` and `--error` have no
dark grade recorded yet. Whoever implements dark mode measures them and adds
them here in the same delivery — inventing them silently is how a palette ends
up with two sources of truth.

**A colour that exists only inside the dark block is the classic error.** Define
every token at the root and redefine only what changes, so the system default,
an explicit light choice and an explicit dark choice all render correctly.

---

## 2. The six states of a job — derived, never stored

There is no state column on a job. There is `current_node_id`, a `blocked` flag
with its `block_reason`, and the event log. What the interface shows is a
projection, and this is the derivation, **in priority order**:

| State | Derivation |
|---|---|
| **awaiting you** | an `input_request` with `status` pending |
| **blocked, unasked** | `blocked = 1` and no pending question |
| **running** | a session with `status` open and an active lease |
| **unowned** | a session open whose lease deadline has passed — there is no sweep, so the row still says "active" |
| **completed** | a final node, and that node's session finished and accepted — *arriving is not finishing* |
| **queued** | none of the above |

**"Blocked, unasked" is the state that matters most to show, and it was the one
missing.** A job can be stopped with nobody called — an environment fault, an
exhausted retry ladder. That one waits forever, unlike the one waiting on you,
which leaves with one click. Two different facts behind one flag, and separating
them is a **set difference**, never a subtraction of counts.

**"Failed" is a session's state, not a job's.** A session that ends badly does
not finish the job; it can be tried again. A session's terminal vocabulary lives
in the event taxonomy and has six values, not one: finished, failed, stalled,
timed out, paused by quota, resume failed. One colour for "failed" distinguishes
none of them — and *paused by quota* and *stalled* are precisely the two an
operator most needs to tell apart. The labels are read from the glossary and are
never invented at the render site.

---

## 3. Interaction states

**Focus.** In a keyboard-driven tool a visible focus ring is not decoration: it
is how you know where you are without a mouse. It is an **ink outline with
offset** — `outline: 2px solid var(--ink); outline-offset: 2px` — never a
coloured shadow, because colour is reserved for state.

**Loading.** A skeleton in the shape of what is coming, never a spinner. What is
loading is *known* — a step always has three fields — so the space is reserved
and the page does not jump.

**Field error.** The error carries the same left-edge bar as every other state
that asks for attention, and it says **what to do**, not only what is wrong:

> *How is this step verified?*
> A step with no verification cannot advance on its own. Describe what has to be
> true, or mark the step as needing a person.

---

## 4. Typography — two families, and the second is not decoration

| Role | Spec |
|---|---|
| Screen title | `1.6rem` / 600 / `letter-spacing: -.015em` |
| Section title | `1.05rem` / 600 |
| Body | `.95rem` / 400 |
| Support | `.82rem`, `--soft` |
| Label | mono `.68rem`, uppercase, `letter-spacing: .08em`, `--soft` |
| Identifier | mono |

The monospace carries **everything that is copied, compared or typed** — hashes,
node ids, paths, commands — and nothing else. It is not a visual effect: it is
what lets two similar identifiers be told apart at a glance.

**Weights stop at 600.** In a dense tool, 800 shouts.

---

## 5. Space, corners and targets — console density

Spacing is **multiples of four**: 4, 8, 12, 16, 24, 32. The radius is **8px on
everything**, with no second value. There is **no shadow** anywhere that does
not float over the page.

| Target | Size |
|---|---|
| A list row | 44px |
| A button | 36px |
| Base text | 15.5px |

---

## 6. Buttons and fields

**The primary is solid ink, not a colour.** One per screen, and it is always the
path most people take.

**The destructive is an outline, not a fill.** A filled red button in a dense
console reads as a permanent alarm.

A field carries a visible `<label>` tied by `for`/`id`, and its help text sits
below it: *"Describe the result, not how you get there."*

---

## 7. The product's own components

Seven. Each appears on more than one screen and none of them can be bought
ready-made.

### 7.1 The map step

The signature component. It always shows the three contract fields — **needs**,
**produces**, **verified by** — *even when unfilled*, because the gap is what
the person needs to see (RF-23). Rendered by
[`map-document.ts`](../../packages/screen/src/map-document.ts).

```
03  Check the numbers                             completed
    Needs         The proposal drafted at step 02, and finance/prices.xlsx
    Produces      The proposal with the values checked, and a list of divergences
    Verified by   No value differs from the table by more than one per cent

04  Contract review                              awaiting you
    Needs         The checked proposal
    Produces      The proposal with the clauses revised
    Verified by   to be defined — the interview has not asked yet
```

### 7.2 The interview turn

A value that is accepted in one click (RF-15, RF-16). The suggested answer is
the button's own label.

### 7.3 The check line

The first screen (RF-10, RF-11). **What is missing carries the attention bar and
an action, never only an error message.**

```
Agent engine        found · compatible version
MCP servers         3 found · files, calendar, repository
Model credential    not found in ~/.claude.json          [ How to fix ]
```

### 7.4 The job card

The board (RF-30): where it is, for how long, and whether it waits on somebody.

### 7.5 The operator question

**The recommendation comes first, because it is the text of the button that
accepts it.** The situation comes after, and is **never truncated**.

### 7.6 A session's log

The densest surface in the product, and the reason it exists. Monospace, wraps
inside its own container, scrolls without dragging the page. The line the
verification failed on is marked with **the same red bar** as the other states,
never with a background colour that is lost when printed. **The cut is declared,
never hidden** — that is what RF-40 is for.

### 7.7 The list of many jobs

A card serves two or three. Past a dozen, what you want is to sweep a column
with your eyes: **table rows, not cards.** The left-edge bar is what makes the
rows that need you jump out without reading each label.

Rows are sorted by the **state derivation of §2**, not by date. In a console,
sorting by time is sorting by nothing.

---

## 8. The left-edge bar

`border-left: 4px solid var(--warning)` on the row, card or panel that is
**waiting on you** — the one state this product exists to make noticeable.

It is a bar and not a colour fill because a bar survives monochrome, printing
and colour blindness. Nothing else in the product may claim it.

---

## 9. The product's voice

The audience is technical and the domain vocabulary stays: nodes, edges,
crossings. What changes is the tone — **say what happened and what to do next**,
without apologising and without hiding.

| Instead of | Write |
|---|---|
| An unexpected error occurred. | Step 03's verification did not pass: two values differ from the table. Nothing was written outside. |
| Operation not permitted. | This step writes outside the system, so it does not repeat on its own. Say what to do. |
| Incomplete configuration. | The model credential is missing. The engine looks for it in `~/.claude.json`. |
| Sorry, your request could not be processed. | The runner stopped responding 3 minutes ago. The job goes back to the queue as soon as it returns. |
| Do you really want to continue? | This version of the map applies to the jobs that follow. The ones already running stay on the old version. |

**On the interview's pages the vocabulary is narrower still**
([`screen-interview.md`](screen-interview.md) §2): every string a person reads
says *interview*, *map*, *step*, *question*, *answer* — never *job*, *runner* or
*input request*.

---

## 10. What is not settled yet

Named here rather than left to be rediscovered:

- **The two stylesheets are one.** `pages.ts`'s `STYLE` constant is gone
  (t458): `layout()` links `public/style.css` instead of inlining it, every
  selector `STYLE` declared was merged into that file, and both halves of the
  screen now read the same `:root` token set.
- **Dark mode's five remaining tokens** (§1).
- **A conformance check exists.** `scripts/check-design-tokens.mjs` (t458),
  wired into `npm run lint`, fails on a literal colour, `currentColor`, a
  non-`var(--radius)` radius, an `opacity` declaration, a `box-shadow` outside
  a floating element, or a missing `:focus-visible` rule — with zero
  exclusions.

---

## 11. Provenance

Ported from Part 2 of the private requirements document
(`~/cartografo-strategy/cartografo-requisitos.html`, revision 2.8 of
2026-09-05), which is where these decisions were taken and where their history
is recorded. That document is private and English-only does not reach it; **this
one is the version the repository and its agents read**, and the reason the port
exists at all is that a design system nobody working in the repository can open
is a design system nothing follows.

Where the two disagree, the private document is the record of the *decision* and
this one is the record of the *contract*. A change to either belongs in both, in
the same delivery.
