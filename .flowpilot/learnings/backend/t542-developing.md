### t542 (developing, unverified)

- POST /v1/jobs/:id/transitions is a POST (not PATCH) and answers 200 (not 201) — differs from the sibling POST /v1/jobs (201) and PATCH /v1/sessions/:id/finish (200); worth checking the route file rather than assuming a convention.
