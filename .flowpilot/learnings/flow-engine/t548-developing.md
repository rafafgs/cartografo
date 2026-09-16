### t548 (developing, unverified)

- Beyond the MCP-suggestion catalogue the ticket named, the CLI has four more known gaps: the progress panel (the CLI never calls POST /v1/graphs/validate on a draft; it prints only `step N of M`), the text a step writes mid-turn (`conversation.partial`; `interview` waits silently), a list of the interviews still open, and the board's `step N/M · role` map position (`jobs` and `job` show the raw node). The MCP side lacks the progress panel and map position, but has partial text through conversationDigest.
