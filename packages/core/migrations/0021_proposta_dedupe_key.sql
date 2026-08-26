-- 0021_proposta_dedupe_key — a repeated signal strengthens the pending proposal (t246, D21).
--
-- `POST /v1/proposals` wrote a new `pending` row on every call, asking nothing.
-- The two lenses that exist run by hand and may run more than once over the
-- same signal — the cost one said so out loud in its own comment
-- (`packages/topografo-custo/src/cli.ts`): "it does not deduplicate. Running
-- twice over the same telemetry creates repeated proposals". D21
-- (`DECISIONS.md`) closes that gap in the one place that can hold for every
-- caller at once, which is the control plane.
--
-- - `dedupe_key` is the canonicalized sha256 of the triple `[lens,
--   target_version, operations]` (`src/domain/hash.ts`, `proposalDedupeKey`).
--   What computes it is ALWAYS the server: the key is not accepted in the body,
--   not read from there and not returned in the response. `lens` comes out of
--   `evidence.lens`, which is where the cost lens has carried it since t255;
--   whoever sends no lens at all falls into the `null` bucket, which is the
--   same "do not clone an identical repeat" rule holding for them too, free of
--   charge.
-- - **`graph_id` is not part of the key**, and that is not an oversight:
--   `target_version` is the content hash of ONE version of ONE graph, so it
--   already scopes the proposal on its own. One more dimension would only give
--   the impression of a scope that is already there.
-- - **The order of the operations counts**, and it is not normalized before the
--   hash: two lists with the same operations in a different order are two
--   proposals. The order decides which intermediate document is valid halfway
--   through the application, and collapsing it would conflate diffs that are
--   not equivalent.
--
-- The index is PARTIAL, and that is where the decision's semantics live: what
-- cannot exist twice is the same PENDING triple. A triple that has already been
-- rejected, applied or reverted blocks nothing — resubmitting the same signal
-- after that opens a new proposal, `201`, because the earlier decision is past
-- and the signal is present. The alternative (an index over the whole table)
-- would make a rejection permanent and silent, which D21 asks for nowhere.
--
-- Nullable and without backfill, like `output` in 0020 and `rejection_reason`
-- in 0010: the development database is recreated (D20), there is no production
-- data, and SQLite itself treats NULL as always distinct in a unique index —
-- several old rows with a NULL `dedupe_key` never collide with each other.
-- There is no value to invent for a proposal written before anybody was
-- deduplicating, and inventing one would be recording in the database a fact
-- nobody computed.
--
-- The column is internal bookkeeping: it does not enter the `Proposal`
-- interface of `src/repositories/proposals.ts` and does not leave through
-- `toProposal()`.
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

ALTER TABLE proposal ADD COLUMN dedupe_key TEXT;  -- NULL = written before this migration, or with no lens in the evidence

CREATE UNIQUE INDEX proposal_dedupe_key_pending_unique
  ON proposal (dedupe_key)
  WHERE status = 'pending';
