### t465 (integrating, unverified)

- The two features share the interview page but not a line of it: t465 writes `conversation.partial` into `#chat` via `thinkingHtml`, t460 adds `renderMapProgress` behind `#map-progress` in the right column and a `progress` field on the fragment. `router.ts:933` destructures `progress` off `readInterviewChat` and `interview.ts` still exports both — both wirings survived the automatic merge intact, and the screen suite covers both at once.
