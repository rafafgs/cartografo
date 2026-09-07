### t459 (developing, unverified)

- Line numbers in the ticket body (e.g. pages.ts:501/522, :1832-1846) point at a pre-t458 pages.ts — t458 landed on this branch's base and collapsed the inline STYLE constant into public/style.css, shifting everything below it. Functions/constants are still named the same; only line numbers moved.
- jobHref() is defined ~1300 lines above INTERVIEW_ENTRY_NODE's declaration and references it by name — valid JS/TS (the const is initialized by the time any request handler runs), but worth knowing if a future edit reorders top-level declarations expecting them read top-to-bottom.
