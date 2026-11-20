### t1340 (developing, unverified)

- POST /v1/sessions/:id/artifact-settlements wants artifact_id as an integer, while uploadOne returns the decimal string the report carries; the resume converts with Number(). The POST route is not project-scoped (no requireProject); the GET is.
- Owed by the flow operator (TDD exception): a real-engine run on an x-artifact node with the artifact route failing once (expect one session, one artifact, a transition on retry), and confirming job 2's rfp-response finalize settles through the retry path on the live board.
