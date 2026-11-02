### t957 (developing, unverified)

- Red state: the command.test.ts and codex-command.test.ts files failed to load, with a SyntaxError for the missing ARGV_INLINE_LIMIT_POSIX_BYTES export. That is the missing implementation, not a fixture error. copilot-command.test.ts passed before and after, as the ticket expected, since it only pins existing behaviour.
- Existing tests that use ARGV_INLINE_LIMIT_BYTES (boundary, accented, oversized-content) were left on the platform constant on purpose. They stay self-consistent on any host. Only the three 'equals 64 KiB' assertions moved to the POSIX constant. The copilot test file now imports both constants.
- Both command modules keep their own duplicated copy of the limit values; no shared module was introduced, per the standing precedent in codex-adapter.ts:12-17.
- The runner's other engine tests that call buildCommand did not need changes. The new trailing `platform` parameter defaults to process.platform, and the adapters' commandBuilder defaults still work unmodified.
- The Windows spawn was not exercised, because the host is macOS. The win32 behaviour is tested only through the explicit platform argument. The operator still owes the real-Windows proof: the reporter's objectify case on Windows 11 (issue #3), and a Codex node with 30-64 KiB of content, which has no field evidence yet.
