### t1311 (developing, unverified)

- The dispatch.test.ts stub answers only {id, session_id, name}, not the full core record, to keep that file from growing; the full record shape is covered in upload-artifacts.test.ts's recorder.
- In the full npm test run, cli-watch AT6 and three docker-image.e2e cases failed under load, and all passed when their files were re-run alone (15/15). Nothing in this diff touches them.
