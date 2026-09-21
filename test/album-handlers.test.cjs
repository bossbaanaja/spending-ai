const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, loader, fixture, slip } = require('./support.cjs');

async function setup() {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const load = loader({
    'src/services/telegramFile.ts': { downloadPhotoBase64: async (_, file) => file },
    'src/services/slipParser.ts': { parseSlip: async file => slip(file) },
  }, { Date: Clock, setTimeout: (fn, ms) => { now += ms; queueMicrotask(fn); }, console: { error() {} } });
  const repo = load('src/db/repo.ts');
  const handler = load('src/bot/batch.ts');
  const db = database();
  const user = await repo.upsertUser(db, 1, 'Test', 'local', 'member');
  const messages = [];
  const api = { async sendMessage(chat, text) { messages.push(text); return { message_id: messages.length }; },
    async editMessageText(chat, id, text) { messages.push(text); } };
  return { load, repo, handler, db, user, messages, api, env: { DB: db } };
}

test('a temporary save failure cannot poison later captioned slips', async () => {
  const h = await setup();
  const real = h.repo.saveAlbumItem;
  let count = 0;
  h.repo.saveAlbumItem = async (...args) => { if (++count === 1) throw Error('temporary'); return real(...args); };
  await Promise.all([1, 2, 3].map(id => h.handler.handleAlbumPhoto(h.api, h.env, h.user,
    { chatId: 1, messageId: id, mediaGroupId: 'g', fileId: 'f' + id, caption: 'lunch', generation: id })));
  const b = await h.repo.getBatchByGroup(h.db, h.user.id, 'g');
  const items = await h.repo.listBatchItems(h.db, b.id);
  assert.equal(items.filter(i => i.outcome === 'saved').length, 2);
  assert.equal(items.filter(i => i.outcome === 'queued' && i.parsed_json).length, 1);
  await h.repo.resumeAlbumQuestion(h.db, h.user.id, b.id);
  await h.handler.completeBatchWithNote(h.api, h.env, h.user, b, 'lunch');
  assert.equal((await h.repo.listBatchItems(h.db, b.id)).filter(i => i.outcome === 'saved').length, 3);
});

test('two simultaneous note replies save a NULL-reference photo once with first note', async () => {
  const h = await setup();
  const { batch, item } = await fixture(h.db, h.repo);
  await h.repo.setItemsParsed(h.db, [{ itemId: item.id, parsedJson: JSON.stringify(slip()), outcome: 'queued' }]);
  await h.repo.setBatchState(h.db, batch.id, 'awaiting_note');
  await h.repo.activateQuestion(h.db, h.user.id, 'album', batch.id, 10);
  await Promise.all(['first', 'second'].map(note => h.handler.completeBatchWithNote(h.api, h.env, h.user, batch, note)));
  const rows = h.db.sqlite.prepare('SELECT * FROM transactions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, 'first');
  assert.equal(await h.repo.getActiveBatch(h.db, h.user.id), null);
});

test('answering a newer album never reactivates the older album; explicit resume does', async () => {
  const h = await setup();
  for (const id of [1, 2]) {
    await h.handler.handleAlbumPhoto(h.api, h.env, h.user,
      { chatId: 1, messageId: id, mediaGroupId: 'g' + id, fileId: 'f' + id, caption: null, generation: id });
  }
  const newer = await h.repo.getActiveBatch(h.db, h.user.id);
  assert.equal(newer.media_group_id, 'g2');
  await h.handler.completeBatchWithNote(h.api, h.env, h.user, newer, 'new note');
  assert.equal(await h.repo.getActiveBatch(h.db, h.user.id), null);
  const older = await h.repo.getBatchByGroup(h.db, h.user.id, 'g1');
  await h.repo.resumeAlbumQuestion(h.db, h.user.id, older.id);
  assert.equal((await h.repo.getActiveBatch(h.db, h.user.id)).id, older.id);
});

test('competing per-slip notes and skip advance one cursor only', async () => {
  const h = await setup();
  const { batch, item } = await fixture(h.db, h.repo);
  await h.repo.saveAlbumItem(h.db, h.user.id, item.id, slip(), null);
  await h.repo.setBatchState(h.db, batch.id, 'asking');
  await h.repo.activateQuestion(h.db, h.user.id, 'album', batch.id, 10);
  const result = await Promise.all([
    h.repo.commitWalkAnswer(h.db, h.user.id, batch.id, 0, 'first'),
    h.repo.commitWalkAnswer(h.db, h.user.id, batch.id, 0, 'second'),
    h.repo.commitWalkAnswer(h.db, h.user.id, batch.id, 0, null),
  ]);
  assert.equal(result.filter(Boolean).length, 1);
  assert.equal((await h.repo.getBatch(h.db, batch.id, h.user.id)).ask_index, 1);
  assert.equal(h.db.sqlite.prepare('SELECT note FROM transactions').get().note, 'first');
});
