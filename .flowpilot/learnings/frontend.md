# Screen and design gotchas

Recorded after the 2026-08/09 wave shipped every page without ever reading a
design system. Everything here is measured against this repository, not
inherited from another product.

| # | Gotcha |
|---|---|
| 1 | **There are two stylesheets and they share nothing.** `packages/screen/src/public/style.css` serves the static half (`/inbox`); the `STYLE` template literal in `packages/screen/src/pages.ts` serves the twenty-four rendered routes. A token added to one is absent from the other. Check which half your page is on before you edit a rule — and never add a third. |
| 2 | **`style.css`'s header comment is not the design system.** It used to claim it was. The design system is `docs/spec/design-system.md`; the stylesheet is one of its two incomplete implementations (§10). |
| 3 | **`border: 1px solid currentColor` is everywhere in `pages.ts`'s `STYLE`, and it is wrong.** It draws every card border at body-text darkness. The token is `--line`. Fixing it is a deliberate change, not a drive-by: it moves the look of every rendered route at once. |
| 4 | **`opacity: .6` is used as a text grade throughout `STYLE`.** It is not a lighter grey — it composites the element and its children, it compounds when nested, and no contrast floor can be measured through it. `--soft` is the token. |
| 5 | **There is no focus style anywhere in either stylesheet.** In a keyboard-driven console that is not a polish item; it is how you know where you are. The spec's rule is an ink outline with offset, never a coloured shadow. |
| 6 | **Radius is 4px in some places and 6px in others.** The system has exactly one: 8px. |
| 7 | **`map-document.ts` renders raw internal names.** `renderSchemaField` prints the JSON Schema property key and its `type`; `renderExits` prints `edge.condition` verbatim. Both have a natural-language field available and unused — JSON Schema's `title`/`description` on a property, and `edge.description` in `schema/graph.schema.json` ("When this transition happens, in one sentence"), which every real factory graph already fills. |
| 8 | **A page reachable only by knowing its URL is a page that is lost.** `/interview/:id` is linked from nowhere: no list route exists and the board links a `map-design` job to `/jobs/:id`. The interview's state is perfectly durable — the door is what is missing. |
| 9 | **Contrast is measured against the composite**, the tint over the page, never against the page. A state's solid grade is for dots and bars; its `-text` grade is for text on that state's tint. They are not interchangeable. |
| 10 | **The left-edge bar belongs to "waiting on you" and to nothing else.** It is the one signal that survives monochrome, printing and colour blindness, and spending it elsewhere is spending it. |
