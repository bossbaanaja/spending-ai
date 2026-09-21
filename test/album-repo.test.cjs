const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { database, loader, fixture, slip } = require('./support.cjs');
const repo = loader()('src/db/repo.ts');

test('migration upgrades the previous schema without changing existing expenses', async () => {
  const schema = fs.readFileSync('src/db/schema.sql', 'utf8');
  const previous = schema.split('-- Durable album scheduling.')[0].replace(/^.*source_item_id.*\n/m, '');
  const db = database(previous);
  const { user } = await fixture(db, repo);
  const tx = await repo.insertTransaction(db, user.id, slip(), 'old');
  db.sqlite.exec(fs.readFileSync('src/db/migrations/0001_album_reliability.sql', 'utf8'));
  assert.equal((await repo.getTransaction(db, tx.id, user.id)).note, 'old');
  await repo.wakeAlbum(db, 1);
  assert.equal((await repo.getAlbumJob(db, 1)).desired_version, 1);
});

test('same photo saves once with NULL reference, including after transaction deletion', async () => {
  const db = database();
  const { user, batch, item } = await fixture(db, repo);
  await Promise.all([repo.saveAlbumItem(db, user.id, item.id, slip(), 'one'), repo.saveAlbumItem(db, user.id, item.id, slip(), 'two')]);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
  const [saved] = await repo.listBatchItems(db, batch.id);
  assert.equal(saved.outcome, 'saved');
  db.sqlite.exec('DELETE FROM transactions');
  await repo.saveAlbumItem(db, user.id, item.id, slip(), 'replay');
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM transactions').get().n, 0);
});

test('bank reference dedup and wrong-user protections still apply', async () => {
  const db = database();
  const { user, batch, item } = await fixture(db, repo);
  await repo.insertTransaction(db, user.id, slip('ref'), 'existing');
  await repo.saveAlbumItem(db, 999, item.id, slip('ref'), 'wrong user');
  assert.equal((await repo.listBatchItems(db, batch.id))[0].outcome, 'queued');
  await repo.saveAlbumItem(db, user.id, item.id, slip('ref'), 'new');
  assert.equal((await repo.listBatchItems(db, batch.id))[0].outcome, 'duplicate');
});

test('lease expiry permits takeover; stale owner cannot finish or acknowledge a newer arrival', async () => {
  const db = database();
  const { batch } = await fixture(db, repo);
  const now = Date.now();
  await repo.wakeAlbum(db, batch.id, now);
  const old = await repo.claimAlbumJob(db, batch.id, 'old', now, 1000);
  assert.equal(await repo.claimAlbumJob(db, batch.id, 'blocked', now, 1000), null);
  const current = await repo.claimAlbumJob(db, batch.id, 'new', now + 1001, 5000);
  await repo.wakeAlbum(db, batch.id, now + 1002);
  await repo.finishAlbumJob(db, old, 'old', null);
  assert.equal((await repo.getAlbumJob(db, batch.id)).lease_token, 'new');
  await repo.finishAlbumJob(db, current, 'new', null);
  const final = await repo.getAlbumJob(db, batch.id);
  assert.ok(final.desired_version > final.completed_version);
});

test('question ownership is monotonic and only one reply consumes a revision', async () => {
  const db = database();
  const { user } = await fixture(db, repo);
  await repo.activateQuestion(db, user.id, 'album', 2, 20);
  await repo.activateQuestion(db, user.id, 'album', 1, 10);
  const question = await repo.getActiveQuestion(db, user.id);
  assert.equal(question.target_id, 2);
  const results = await Promise.all([repo.consumeQuestion(db, question), repo.consumeQuestion(db, question)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await repo.getActiveQuestion(db, user.id)).kind, 'none');
});

test('save transaction rolls back if recording its receipt fails', async () => {
  const db = database();
  const { user, batch, item } = await fixture(db, repo);
  db.sqlite.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON album_receipts BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await assert.rejects(repo.saveAlbumItem(db, user.id, item.id, slip(), 'note'), /injected/);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM transactions').get().n, 0);
  assert.equal((await repo.listBatchItems(db, batch.id))[0].outcome, 'queued');
});

test('cleanup respects foreign keys and preserves unfinished jobs', async () => {
  const db = database();
  const { user, batch, item } = await fixture(db, repo);
  await repo.saveAlbumItem(db, user.id, item.id, slip(), 'saved');
  await repo.wakeAlbum(db, batch.id);
  db.sqlite.exec("UPDATE slip_batches SET created_at = datetime('now', '-8 days')");
  assert.equal(await repo.deleteOldBatches(db), 0);
  const job = await repo.claimAlbumJob(db, batch.id, 'owner', Date.now(), 10000);
  await repo.finishAlbumJob(db, job, 'owner', null);
  assert.equal(await repo.deleteOldBatches(db), 1);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
  const next = await repo.claimBatch(db, user.id, 'different-album', 1, null);
  await repo.addBatchItem(db, next.id, 2, 'new-file');
  const [newItem] = await repo.listBatchItems(db, next.id);
  await repo.saveAlbumItem(db, user.id, newItem.id, slip(), 'new');
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM transactions').get().n, 2);
});
