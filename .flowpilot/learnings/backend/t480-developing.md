### t480 (developing, unverified)

- The Question interface in prompt.ts gained `options` as a REQUIRED field, not optional. Nothing in src constructs a Question (session-spec.ts casts the API JSON), so the only cost was one line in prompt.test.ts's own fixture — but a future hand-written Question anywhere else has to supply `options: null` explicitly.
- `isFieldList` deliberately requires length > 0 and EVERY item Field-shaped. An empty `options: []` is a flat list of labels with nothing in it, never a form with no fields — both parse-input-request.ts and prompt.ts route it to the legacy branch, and AT8/AT17 pin that.
- prettier --check is NOT clean on this repository's baseline (dispatch.ts and session-spec.ts fail it untouched) and is not part of `npm run lint`. Running `prettier --write` over a file you touched would reformat unrelated lines and inflate the diff; the real style gate is eslint plus the ~100-column convention, which I matched by hand.
