### t542 (developing, unverified)

- GET /v1/jobs/:id/events, /v1/sessions, /v1/input-requests, /v1/jobs/:id/artifacts each return a wrapped envelope ({events:[]}, {sessions:[]}, {input_requests:[]}, {artifacts:[]}) while GET /v1/jobs/:id returns the bare job object — the `job <id>` --json aggregate has to forward each raw body untouched under its own key rather than re-normalizing shapes, or the 'untouched wire body' contract in the ticket breaks silently.
- Backticks inside the USAGE template literal (`marked with `>>> ``) silently truncate the string at the nested backtick and produce unrelated-looking TS2362/TS2363 arithmetic errors elsewhere in the file — a good reminder to grep for embedded backticks before typechecking a big USAGE edit.
