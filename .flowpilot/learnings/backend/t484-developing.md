### t484 (developing, unverified)

- A rendered route hitting an upstream that returns a shape checkPage/route() can't parse (e.g. {} instead of a runners array) still ends up with cache-control: no-store either way: it either succeeds via checkPage's own no-store header or throws and lands on failurePage's no-store header — so AC4's assertion holds even against a minimal fake upstream.
