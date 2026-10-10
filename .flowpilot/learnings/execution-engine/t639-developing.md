### t639 (developing, unverified)

- A job born on a final node has NOT arrived: `completed` needs the pinned final step's session finished. cli-composition-support.ts openCompleted() does transition -> open session -> PATCH /finish on graph-valid-minimal (core test seeding only; the e2e makes no transition).
- Controller.tick() lets a failed session escape as a DispatchError ('ended as "failed"'); a test that drives ticks to a failing child must catch it and keep ticking. The control plane blocked the failing child after 3 failed sessions, so the `block` fallback in the ticket was not needed.
