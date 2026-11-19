### t1339 (developing, unverified)

- The checks of pending_artifacts (list shape, completed status, string value in output, x-artifact in the pinned schema) run BEFORE the transcript artifact is stored. A 400 therefore leaves the session open and leaves no orphan transcript row. This meant moving resolveOutputSchema earlier in finishSession; the same schema value is reused further down for the report check.
