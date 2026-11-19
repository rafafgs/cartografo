### t1339 (integrating, unverified)

- Since t1338, createArtifact/storeArtifact return the existing row for the same (session_id, name, sha256). A test fake store must return a sha256 derived from the content, not a constant. Otherwise every artifact of one name on one session collapses into one id, and 'a different artifact' tests silently become 'the same artifact' tests.
