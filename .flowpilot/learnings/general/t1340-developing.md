### t1340 (developing, unverified)

- Every dispatch now reads the spool (find only) before resolving anything. A test that does not pass artifactSpoolRoot reads the shared <tmpdir>/cartografo-artifact-spool. No existing test fails an upload without a root, so nothing writes there, but any new test that makes an upload fail must set artifactSpoolRoot or it will leak entries keyed by job id into other runs.
- AT7, AT21, AT25 and AT28 passed before the implementation (they pin existing behaviour; prune already ignores any directory that is not ticket-<id>-<hex>). Everything else failed first for the right reason; the spool tests use the loadModule pattern so a missing module is an assertion, not an import error.
- options.ts is now 593 lines, close to the 600-line dispatch budget. blocks.ts is 544 and dispatch.ts 742 (+5 net), because the MCP output writer moved into pending-uploads.ts's externalOutputWriterFor, which both paths share.
