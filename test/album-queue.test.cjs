const { test } = require('node:test');
const assert = require('node:assert/strict');
const { timingSafeEqual } = require('node:crypto');
const { database, loader, slip } = require('./support.cjs');

async function setup(options = {}) {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const parsed = [], downloads = [], messages = [], queue = [];
  let hook, sendCalls = 0;
  const load = loader({
    'src/services/telegramFile.ts': { downloadPhotoBase64: async (_, file) => { downloads.push(file); return file; } },
    'src/services/slipParser.ts': { parseSlip: async (image, caption, env, timer, opts) => {
      parsed.push({ image, caption, cached: opts.cachedOcr, startIndex: opts.startIndex });
      if (!opts.cachedOcr) await opts.onOcr('cached OCR for ' + image);
      if (hook) { const fn = hook; hook = null; await fn(); }
      if (options.failParse) throw Error('temporary NIM failure');
      if (options.slow) now += 20000;
      return slip(options.noRef ? null : image || opts.cachedOcr);
    } },
    'src/services/albumTelegram.ts': { AlbumTelegramError: class extends Error {}, albumMessage: async (_, chat, text, id) => {
      sendCalls++;
      if (options.failTelegram || options.failFirstSend && sendCalls === 1) throw Error('Telegram unavailable');
      messages.push(text); return id ?? sendCalls;
    } },
    'src/bot/bot.ts': { getBot: () => { throw Error('queued intake must not initialize bot'); } },
  }, { Date: Clock, crypto: { randomUUID: () => crypto.randomUUID(), subtle: { timingSafeEqual } }, console: { error() {}, log() {} } });
  const repo = load('src/db/repo.ts'), worker = load('src/bot/albumWorker.ts');
  const db = database();
  const user = await repo.upsertUser(db, 1, 'Test', 'local', 'member');
  const env = { DB: db, ALBUM_QUEUE_USERS: '*', WEBHOOK_SECRET: 'test-secret',
    ALBUM_QUEUE: { async send(body, opts) { if (options.failPublish) throw Error('Queue unavailable'); queue.push({ body, opts }); } } };
  const intake = (id, caption = 'lunch', group = 'g') => worker.intakeQueuedAlbum(env, user, {
    chatId: 1, messageId: id, mediaGroupId: group, fileId: 'file' + id, caption, generation: id,
  });
  const batch = () => repo.getBatchByGroup(db, user.id, 'g');
  const run = async () => { now += 20000; await worker.processAlbumJob(env, (await batch()).id); };
  const drain = async () => {
    for (let n = 0; n < 25; n++) {
      const j = await repo.getAlbumJob(db, (await batch()).id);
      if (j.desired_version === j.completed_version) return;
      await run();
    }
    throw Error('did not drain');
  };
  return { options, load, repo, worker, db, user, env, intake, batch, run, drain, parsed, downloads, messages, queue,
    hook(fn) { hook = fn; }, advance(ms) { now += ms; }, now: () => now };
}

test('ten slow slips finish across deliveries without a shared album deadline', async () => {
  const h = await setup({ slow: true });
  for (let i = 1; i <= 10; i++) await h.intake(i);
  await h.drain();
  assert.equal(h.db.sqlite.prepare('SELECT count(*) AS n FROM transactions').get().n, 10);
  assert.equal(h.parsed.length, 10);
  assert.deepEqual(h.parsed.slice(0, 2).map(p => p.startIndex), [0, 1]);
  assert.equal((await h.batch()).state, 'done');
});

test('photos arriving during reading and after the final summary are processed', async () => {
  const h = await setup();
  await h.intake(1); await h.intake(2);
  h.hook(() => h.intake(3));
  await h.drain();
  assert.equal(h.parsed.length, 3);
  await h.intake(4);
  await h.drain();
  assert.equal(h.parsed.length, 4);
  assert.equal(h.db.sqlite.prepare('SELECT count(*) AS n FROM transactions').get().n, 4);
});

test('redelivery is idempotent even after completion and with no bank reference', async () => {
  const h = await setup({ noRef: true });
  await h.intake(1);
  await h.drain();
  const before = (await h.repo.getAlbumJob(h.db, (await h.batch()).id)).desired_version;
  await h.intake(1);
  await h.drain();
  assert.equal(h.parsed.length, 1);
  assert.equal((await h.repo.getAlbumJob(h.db, (await h.batch()).id)).desired_version, before);
});

test('failed queue publishing leaves durable work which cron republishes', async () => {
  const h = await setup({ failPublish: true });
  await h.intake(1);
  assert.equal(h.queue.length, 0);
  h.options.failPublish = false;
  h.advance(4000);
  await h.load('src/services/albumQueue.ts').recoverAlbumJobs(h.env);
  assert.equal(h.queue.length, 1);
  await h.drain();
  assert.equal(h.parsed.length, 1);
});

test('failed initial status message does not strand processing', async () => {
  const h = await setup({ failFirstSend: true });
  await h.intake(1);
  await h.drain();
  assert.equal((await h.batch()).state, 'done');
  assert.ok(h.messages.some(m => m.includes('Logged 1')));
});

test('abandoned claim recovers and expired owners cannot save or overwrite checkpoints', async () => {
  const h = await setup();
  await h.intake(1); h.advance(4000);
  const b = await h.batch();
  const job = await h.repo.claimAlbumJob(h.db, b.id, 'dead', h.now(), 10000);
  assert.ok(job);
  h.advance(10001);
  await h.drain();
  const [item] = await h.repo.listBatchItems(h.db, b.id);
  await h.repo.checkpointAlbumItem(h.db, item.id, 'dead', { parsed: '{}', outcome: 'failed' });
  await h.repo.saveAlbumItem(h.db, h.user.id, item.id, slip(), 'stale', 'dead');
  assert.equal((await h.repo.listBatchItems(h.db, b.id))[0].outcome, 'saved');
  assert.equal(h.db.sqlite.prepare('SELECT note FROM transactions').get().note, 'lunch');
});

test('retry resumes cached OCR, and exhaustion is visible', async () => {
  const h = await setup({ failParse: true });
  await h.intake(1);
  await h.drain();
  assert.equal(h.parsed.length, 3);
  assert.equal(h.downloads.length, 1);
  assert.ok(h.parsed[1].cached);
  assert.equal((await h.repo.listBatchItems(h.db, (await h.batch()).id))[0].outcome, 'failed');
  assert.ok(h.messages.some(m => m.includes("couldn't be read")));
});

test('accepted shared note also applies to a later photo; disabled rollout drains existing jobs', async () => {
  const h = await setup();
  await h.intake(1, null); await h.drain();
  await h.load('src/bot/batch.ts').completeBatchWithNote(h.api, h.env, h.user, await h.batch(), 'dinner');
  await h.drain();
  h.env.ALBUM_QUEUE_USERS = '';
  assert.equal(await h.intake(2, null), true);
  await h.drain();
  const rows = h.db.sqlite.prepare('SELECT note FROM transactions').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.note === 'dinner'));
  assert.equal(await h.intake(3, null, 'new-album'), false);
});

test('queued webhook returns 503 on persistence failure and accepts the same update on retry', async () => {
  const h = await setup();
  const index = h.load('src/index.ts').default;
  const update = { update_id: 99, message: { message_id: 1, date: 1, media_group_id: 'g', from: { id: 1 }, chat: { id: 1 }, photo: [{ file_id: 'file1' }], caption: 'lunch' } };
  const request = () => new Request('https://example.test/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-secret' }, body: JSON.stringify(update) });
  const real = h.db.batch;
  h.db.batch = async () => { throw Error('DB unavailable'); };
  assert.equal((await index.fetch(request(), h.env, {})).status, 503);
  h.db.batch = real;
  assert.equal((await index.fetch(request(), h.env, {})).status, 200);
  await h.drain();
  assert.equal(h.parsed.length, 1);
});

test('late caption is picked up after OCR, without an unnecessary note question', async () => {
  const h = await setup();
  await h.intake(1, null);
  h.hook(() => h.intake(2, 'late caption'));
  await h.drain();
  const rows = h.db.sqlite.prepare('SELECT note FROM transactions').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.note === 'late caption'));
  assert.equal((await h.batch()).state, 'done');
});

test('individual notes save through queue; a late photo retires the old cursor', async () => {
  const h = await setup();
  await h.intake(2, null); await h.intake(3, null); await h.drain();
  const handler = h.load('src/bot/batch.ts');
  await handler.startNoteWalk({}, h.env, h.user, await h.batch());
  await h.drain();
  const b = await h.batch();
  assert.equal(b.state, 'asking');
  assert.ok(h.messages.some(m => m.includes('Slip 1 of 2')));
  await h.repo.commitWalkAnswer(h.db, h.user.id, b.id, 0, 'first note');
  await h.intake(1, null);
  assert.equal((await h.batch()).state, 'awaiting_note');
  assert.equal(await h.repo.commitWalkAnswer(h.db, h.user.id, b.id, 1, 'stale answer'), false);
  await h.drain();
  assert.equal(h.db.sqlite.prepare('SELECT count(*) AS n FROM transactions').get().n, 3);
  assert.equal((await h.repo.getActiveQuestion(h.db, h.user.id)).kind, 'none');
});

test('notification exhaustion does not repeat OCR or undo expenses', async () => {
  const h = await setup({ failTelegram: true });
  await h.intake(1);
  await h.drain();
  assert.equal(h.parsed.length, 1);
  assert.equal(h.db.sqlite.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
  assert.equal((await h.repo.getAlbumJob(h.db, (await h.batch()).id)).delivery_attempts, 6);
});
