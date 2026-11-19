### t1338 (developing, unverified)

- AT2, AT3, AT4 and AT8 passed before the implementation, because they pin existing behaviour. AT1, AT5, AT6, AT7 and AT9 failed first for the right reason: the status was 201 where 200 was expected, or there were two rows where one was expected.
- No file outside the ticket's declared surface was touched, apart from the new test file the ticket itself named.
