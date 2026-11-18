### t1282 (developing, unverified)

- runner-and-controller.md's table intro said 'Eight failures'; changed to 'Nine' with the new row, plus one explanatory paragraph.
- The pre-session classifier parses engine/level/variable back out of the refusal message with a regex tied to the format 'capability unmapped: <engine> <level> (set <VAR>)'. If that message shape changes, update pre-session-failure.ts too (AT24 pins it).
- A node-level capability that is present but not general/advanced resolves to undefined and does NOT fall back to the graph's value (the node spoke; the dispatch does not guess). A null node capability does fall through, since `??` treats it as absent.
- Under load (load average ~110) the full suite had one red, t960 AT4 in process-lifecycle.test.ts (slow-boot watchdog, a 20s timing test). It passes alone and the next full run was fully green: the known contention pattern.
