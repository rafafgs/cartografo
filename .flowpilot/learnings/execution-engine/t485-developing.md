### t485 (developing, unverified)

- No single Interview #5 session contains two assistant TEXT frames — each turn emits exactly one thinking frame and one text frame, and the envelope always precedes both. So 'prose, envelope, prose' cannot be one contiguous slice of one session; the fixture is two CONSECUTIVE turns (sessions 23 and 24) with the elided lines being session 23's trailing rate_limit/result and session 24's second thinking_tokens frame. Real lines, real order, documented in the test.
