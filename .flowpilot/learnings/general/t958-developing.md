### t958 (developing, unverified)

- The ticket's mechanical checks 1-3 (grep, git diff --stat, no src change) all hold: exactly the two declared test files changed, four lines each side.
- macOS BSD sed needs `sed -i ''` (explicit empty backup suffix); GNU-style `sed -i` fails with 'invalid command code'.
- Running `node --import tsx --test` in packages/runner fails to load the test files here; plain `node --test <file>` (as the package's own test script does) works.
- A full npm test under load (avg ~17-20) again showed cli-watch AT1/AT5 and t400 red; both pass alone, so judge them by an isolated re-run.
