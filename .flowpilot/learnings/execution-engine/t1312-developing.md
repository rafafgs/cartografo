### t1312 (developing, unverified)

- AT12's fault is the finish PATCH answering 500 on a job with no graph version. With no resolved node, advance() is skipped, so the job stays on its node and the session stays open. With a graph, a failed finish still lets advance() transition the job, which would move it off the node and hide the run.
