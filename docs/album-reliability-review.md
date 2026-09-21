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

## Step 2 — independent saves and explicit questions

Intent: a failed expense save must not stop its neighbours, and only the current
question may consume a reply.

Simpler alternative considered: clear all old albums when a new one finishes.
Rejected: finishing order differs from arrival order and would discard recoverable
unnoted slips. The explicit pointer preserves older albums behind Resume.

First pass: fix-then-ship. Releasing the shared save promise was insufficient:
simultaneous notes could still run completion together. Added a processing claim,
persisted the first accepted note, and made per-slip note/skip cursor changes
transactional. Single-slip arrival also clears an obsolete pending record in the
same transaction so a reply during its OCR cannot save the previous photo.

Trace: `handleAlbumPhoto` / `registerSlip` -> `activateQuestion`; plain text ->
`getActiveBatch` -> `completeBatchWithNote` -> accepted note / claim -> independent
`saveAlbumItem` operations -> explicit question clear. `startNoteWalk`, answer,
skip and Resume use the same user-scoped records. Retries read saved counts back
from D1 and cannot resurrect older questions.

Verification: handler replay with the first captioned save failing still saves
the other two, then Resume saves the remaining photo. Two simultaneous notes for
a NULL-reference photo produce one expense with the first note. Completing the
newer album leaves no active older album; Resume restores it explicitly. Competing
individual notes and skip advance only one cursor. All 11 tests and typechecking pass.

Verdict: ship — save isolation and question ownership hold across the tested
handler paths. Automatic background recovery is the next step, not claimed here.
