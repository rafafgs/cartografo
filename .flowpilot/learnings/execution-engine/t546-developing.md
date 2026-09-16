### t546 (developing, unverified)

- The ticket's FR5 says the `--job` filter already covers `session.finished`. It does not: `session.finished`, `input_request.answered` and `input_request.auto_resolved` carry no `job_id`, and `watch.ts`'s own doc comment says so. There is also no `job.completed` event. The interview becomes `done` when the `deliver` session finishes, so a wait filtered only by job never wakes on that. interview.ts adds those three types to its own wake filter.
