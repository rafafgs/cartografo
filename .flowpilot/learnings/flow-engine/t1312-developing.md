### t1312 (developing, unverified)

- Ticket premise error, corrected in my own AT4 before it passed: the ticket says GET /v1/jobs (the candidate listing) omits a blocked job. It does not and never did. GET /v1/jobs is the whole board, and `cartografo jobs` prints `blocked — <reason>` from it, which is FR9's own claim. Candidacy is the runner client's filter (listReleasedJobs: blocked === false). AT4 now asserts the board row carries blocked: true, and AT12 proves the real runner stops dispatching the job. The test commit 575318f has the original wording; the correction is in dc8803a.
