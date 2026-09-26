// Full bundled Worker + real local workerd/D1/Queues; only remote providers are mocked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Miniflare } = require('miniflare');
const { sqlStatements } = require('./support.cjs');

test('real Worker runtime: migrated D1, queue delivery, late photo and shared note', { timeout: 60000 }, async () => {
  let messageId = 1000;
  const telegram = [];
  const mf = new Miniflare({
    modules: true, scriptPath: 'scratch/album-worker-build/index.js',
    compatibilityDate: '2026-07-04', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], queueProducers: { ALBUM_QUEUE: 'albums-test' },
    queueConsumers: { 'albums-test': { maxBatchSize: 1, maxBatchTimeout: 0, retryDelay: 1 } },
    bindings: { BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'test-secret', ALBUM_QUEUE_USERS: '*',
      NIM_MODELS: 'test-model-a,test-model-b', TYPHOON_OCR_API_KEY: 'fake', NVIDIA_API_KEY: 'fake' },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'api.telegram.org') {
        if (url.pathname.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 999, is_bot: true, first_name: 'Test', username: 'test_bot' } });
        if (url.pathname.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'photo.jpg' } });
        if (url.pathname.includes('/file/')) return new Response('fake photo');
        const body = await request.json();
        telegram.push(body);
        return Response.json({ ok: true, result: { message_id: body.message_id ?? ++messageId, chat: { id: 1 }, date: 1, text: body.text } });
      }
      if (url.hostname === 'api.opentyphoon.ai') return Response.json({ choices: [{ message: { content: 'THB 100, merchant Test' } }] });
      if (url.hostname === 'integrate.api.nvidia.com') return Response.json({ choices: [{ message: { content: JSON.stringify({
        amount: 100, currency: 'THB', category: 'Other', confidence: 1, trans_ref: null,
      }) } }] });
      throw Error('Unexpected external request: ' + url.hostname);
    },
  });
  try {
    const db = await mf.getD1Database('DB');
    const exec = async sql => {
      for (const statement of sqlStatements(sql)) await db.prepare(statement).run();
    };
    const fresh = fs.readFileSync('src/db/schema.sql', 'utf8');
    const old = fresh.split('-- Durable album scheduling.')[0].replace(/^.*source_item_id.*\n/m, '');
    await exec(old);
    await exec(fs.readFileSync('src/db/migrations/0001_album_reliability.sql', 'utf8'));
    await exec(fs.readFileSync('src/db/migrations/0002_album_queue.sql', 'utf8'));
    await exec(fs.readFileSync('src/db/migrations/0003_split_panel_safety.sql', 'utf8'));
    await db.prepare("INSERT INTO users (id, telegram_id, role, token) VALUES (1, 1, 'member', 'test')").run();
    const from = { id: 1, is_bot: false, first_name: 'Test' };
    const post = async message => {
      const response = await mf.dispatchFetch('https://test.local/webhook', {
        method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
        body: JSON.stringify({ update_id: message.message_id, message: { date: Math.floor(Date.now() / 1000), from, chat: { id: 1, type: 'private' }, ...message } }),
      });
      assert.equal(response.status, 200);
    };
    const photo = (id, caption, group = 'g') => post({ message_id: id, media_group_id: group,
      photo: [{ file_id: 'photo-' + id, file_unique_id: 'unique-' + id, width: 100, height: 100 }], ...(caption ? { caption } : {}) });
    const until = async (query, count) => {
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        if ((await db.prepare(query).first()).n === count) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('Timed out waiting for ' + query);
    };
    await Promise.all([photo(1, 'lunch'), photo(2), photo(3)]);
    await until('SELECT count(*) AS n FROM transactions', 3);
    await until('SELECT count(*) AS n FROM album_jobs WHERE desired_version > completed_version', 0);
    await photo(4);
    await until('SELECT count(*) AS n FROM transactions', 4);
    await photo(4); // redelivery
    await photo(5, null, 'g2');
    await until("SELECT count(*) AS n FROM slip_batches WHERE state = 'awaiting_note'", 1);
    await post({ message_id: 6, text: 'dinner' });
    await until('SELECT count(*) AS n FROM transactions', 5);
    await until('SELECT count(*) AS n FROM album_jobs WHERE desired_version > completed_version', 0);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM transactions WHERE note = 'lunch'").first()).n, 4);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM transactions WHERE note = 'dinner'").first()).n, 1);
    assert.ok(telegram.some(m => m.text?.includes('Logged')));
  } finally {
    await mf.dispose();
  }
});
