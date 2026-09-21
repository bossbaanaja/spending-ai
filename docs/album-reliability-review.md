# Album reliability: implementation and scrutiny ledger

Each step is reviewed before its separate commit. “Ship” means the local
change is ready to commit; it does not mean production has been deployed.

## Step 1 — database safeguards

Intent: make album work recoverable and expense writes replay-safe.

Simpler alternative considered: rely on the bank reference and the existing
batch state. Rejected: OCR permits NULL references, and a permanent batch claim
cannot recover after a worker exits.

First pass: fix-then-ship. A numeric source item ID can be reused after album
housekeeping; changed transaction identity to user + media group + message.
Housekeeping now deletes new child records in order and retains unfinished jobs.

Trace: `saveAlbumItem` in `src/db/repo.ts` -> transactional D1 batch -> transaction,
receipt, item outcome. The receipt prevents replay after user deletion. Claims
expire, and `finishAlbumJob` verifies the owner and acknowledges only the version
it processed. `activateQuestion` and `consumeQuestion` use conditional writes.

Verification: migration preserves an existing expense; concurrent NULL-reference
saves create one expense; receipt failure rolls back the expense; wrong-user
writes do nothing; reference dedup remains; stale lease owners cannot acknowledge;
new arrivals remain due; question revisions have one winner; cleanup preserves
unfinished work and cannot collide with a subsequently reused numeric item ID.

Verdict: ship — seven deterministic SQLite tests and TypeScript checking pass;
the database safeguards are additive and existing handler behavior is unchanged.
