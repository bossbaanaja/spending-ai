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

## Step 3 — durable intake and resumable processing

Intent: every received photo has recoverable processing independent of the
webhook lifetime, including late arrivals and abandoned workers.

Simpler alternative considered: raise the debounce or parse budget. Rejected:
neither provides a continuation after the invocation dies. One queue consumer
with two concurrent reads bounds queued-album load without adding Durable Objects.

First pass: fix-then-ship. Moved question selection into the registration
transaction (a crash between the two writes must not lose the question), fenced
expense/checkpoint writes against expired owners, and filtered queue-owned jobs
before applying the recovery scan limit (legacy jobs must not starve recovery).

Trace: `src/index.ts` verifies the webhook secret and registration ->
`registerQueuedPhoto` atomically stores photo/question/outbox -> queue publish.
Database failure returns 503 before isolate dedup; publish failure leaves the D1
outbox for minute cron. `processAlbumJob` claims an expiring lease, processes at
most two photos, checkpoints OCR and parsed JSON, saves through fenced receipts,
then renders from stored outcomes. Only its captured version is acknowledged;
late arrivals stay dirty. Queue ownership persists when rollout is disabled.

Verification: 20 regression tests cover ten slow slips over several deliveries,
late arrivals during/after reading, duplicate webhooks with missing references,
failed publishing recovered by cron, failed first status send, expired claims,
fenced stale writes, cached OCR retries/exhaustion, accepted notes for late photos,
rollout disable/drain, and 503 followed by successful retry of the same update.
Typechecking and Wrangler's local deployment dry run pass. Provider retry delays
remain bounded and Typhoon honours Retry-After without exceeding its deadline.

Verdict: ship — durable delivery and database idempotency hold across the tested
pipeline. Production resources and canary activation belong to rollout, not this
commit. Telegram does not provide an idempotent send key: a crash after a successful
message send but before its ID is stored can duplicate a notification, never an expense.

## Step 4 — queue-driven note walk and stale callback fencing

Intent: ensure albums processed via background queues can transition into per-slip note walks seamlessly, fence against stale or duplicate inline keyboard button presses, and verify end-to-end runtime behavior across Cloudflare D1 and Queues.

Simpler alternative considered: handle the per-slip note walk exclusively through synchronous bot replies and unindexed skip callbacks. Rejected: users tapping skip twice in rapid succession or tapping an old message's skip button would skip the wrong slip, and queue-intake albums without an automatic first prompt would stall waiting for the initial question.

First pass: fix-then-ship. Added queue transition in `startNoteWalk` to wake and publish the album, automatic first-slip prompt trigger in `albumWorker.ts` when all remaining items finish under `note_mode === 'each'`, and index-fenced skip callbacks (`bnote:skip:<batchId>:<index>`) verified against `batch.ask_index` in `edit.ts`. Added baseline database migration (`0000_initial.sql`) and a Miniflare-based Worker runtime test (`test/album-runtime.cjs`).

Trace: `startNoteWalk` in `src/bot/batch.ts` -> checks `isQueuedAlbum` -> sets mode to `each`, wakes album, and publishes to queue -> `processAlbumJob` in `src/bot/albumWorker.ts` -> completes remaining items -> prompts Slip 1 of N with `batchAskKeyboard(batchId, 0)` -> enters `asking` state -> user taps Skip -> `edit.ts` verifies `batch.ask_index === index` -> `advanceNoteWalk` -> message edited in place. Stale or duplicated taps are rejected with an answered alert.

Verification: unit tests cover late caption absorption without asking redundant notes, queue-driven individual note walk cursor retirement upon late photo arrivals, and notification exhaustion avoiding duplicate OCR or rollbacks. Full Miniflare runtime test (`npm run test:runtime`) passes with migrated D1 schema, queue batch processing, late photo handling, and shared note delivery. Full typechecking (`tsc --noEmit`) and all 23 unit tests pass.

Verdict: ship — queued note walk, stale button fencing, and runtime test harness verified.

