### t485 (developing, unverified)

- AT-4, AT-5 and AT-6 pass before the implementation and that is the honest state, not a broken red. AT-4 pins the boundary the fix must not cross, and AT-5/AT-6 pin the two functions the ticket itself says need no code change. The real red is AT-1, AT-2 and the amended t148 assertion — judge red/green by those three.
- The fix also changes behaviour for a frame that has `message.content[]` but NO `type` at all: it used to yield its text, it now passes through raw. FR2 requires this and no real `claude` frame lacks `type`, but a hand-written test fixture that omits `type` would silently stop being decoded. Nothing in the suite does that today.
- AT-1's forbidden-substring list includes `tools`, which is short enough to appear inside ordinary prose by accident. It does not in this fixture (checked), but a future fixture with English prose about tooling would fail AT-1 for the wrong reason.
