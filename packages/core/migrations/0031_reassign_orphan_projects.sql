-- 0031_reassign_orphan_projects — the rows the write-side gap already produced
-- go back to a project that exists (t417, FR7).
--
-- Number provisional and kept that way: `ticket-359` already claims 0029 and
-- t422's refinement reserved 0030, both unmerged at the time this was written.
-- `src/db/migrate.ts` fails loudly on a repeated number, so renumbering at the
-- merge is mandatory rather than cosmetic — the same note the headers of 0003,
-- 0005, 0017, 0019, 0022, 0026, 0027 and 0028 already carry.
--
-- ## What this repairs
--
-- D25 partitions the database by project. Its READ side landed in three
-- tickets (t410, t411, t412); its WRITE side did not, so `POST /v1/jobs`,
-- `POST /v1/intake` and `POST /v1/webhooks` accepted any integer as
-- `project_id` while the paired reads had already begun refusing an undeclared
-- one with `404 unknown_project`. Every row written through that gap answers to
-- a partition nothing can name: created, and unreadable.
--
-- t417 closes the gap. This file deals with what came through it before the
-- gate existed, in the three tables whose write routes that ticket hardens.
--
-- ## Why UPDATE and never DELETE
--
-- Nothing is ever removed (D2, D15): a row written wrong is corrected, not
-- erased, and the log that recorded its creation stays true either way. The
-- destination is project `1` — seeded as `default` by
-- `0026_project_partition.sql`, and there is no route that removes a project,
-- so it is the one scope guaranteed to be there when this runs.
--
-- ## Why `intake_draft` is here, when its own READS stay unscoped
--
-- t417 closes intake's WRITE side only; `GET /v1/intake` remains as unscoped as
-- it is today, by that ticket's own Out of Scope. A pending draft is included
-- all the same, and not for symmetry: `confirmDraft` hands `draft.project_id`
-- to `createJob`, which from t417 onwards refuses a project that does not
-- exist. Leaving those drafts alone would make them newly UNCONFIRMABLE — a
-- regression introduced by the fix, which this statement is what prevents.
--
-- `lease` and `setting` are deliberately absent. Their write routes are not
-- hardened by t417 (neither has a read that enforces project existence, so
-- there is no asymmetry to close), and reassigning rows of a table whose rule
-- did not change would be a decision nobody recorded.

UPDATE job
   SET project_id = 1
 WHERE project_id NOT IN (SELECT id FROM project);

UPDATE webhook_subscription
   SET project_id = 1
 WHERE project_id NOT IN (SELECT id FROM project);

UPDATE intake_draft
   SET project_id = 1
 WHERE project_id NOT IN (SELECT id FROM project);
