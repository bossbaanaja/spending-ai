const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { database, loader, slip } = require('./support.cjs');
const BOT_TOKEN = '123:test-only-token';
const globals = { URLSearchParams, TextDecoder };
const auth = loader({}, globals)('src/services/splitPanelAuth.ts');
const repo = loader()('src/db/repo.ts');

function initData(id = 1, age = 0) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - age),
    query_id: 'test', user: JSON.stringify({ id, first_name: 'Test' }), signature: 'telegram-signature' });
  params.sort();
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const check = [...params].map(([k, v]) => `${k}=${v}`).join('\n');
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

async function setup(cardUpdated = true) {
  const db = database();
  const user = await repo.upsertUser(db, 1, 'Test', 'test', 'member');
  const tx = await repo.insertTransaction(db, user.id, { ...slip(), amount: 2800 }, 'Dinner');
  const token = await auth.createSplitPanelToken(BOT_TOKEN, 1, tx.id, 42, await repo.getVersionedTransaction(db, tx.id, user.id));
  const edits = [];
  const handle = loader({ 'src/services/telegram.ts': { editTelegramCard: async (...args) => { edits.push(args); return cardUpdated; } } }, globals)('src/web/splitPanelHandler.ts').handleSplitPanel;
  const call = (action, extra = {}, customHeaders = {}) => handle(new Request(`https://bot.example/split-panel/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...customHeaders },
    body: JSON.stringify({ token, initData: initData(), ...extra }),
  }), { DB: db, BOT_TOKEN });
  return { db, user, tx, token, edits, call, handle };
}

test('Telegram identity requires a valid fresh signature, including all signed fields', async () => {
  assert.equal(await auth.verifyMiniAppUser(BOT_TOKEN, initData()), 1);
  assert.equal(await auth.verifyMiniAppUser(BOT_TOKEN, initData().replace('Test', 'Other')), null);
  assert.equal(await auth.verifyMiniAppUser(BOT_TOKEN, initData(1, 3601)), null);
  assert.equal(await auth.verifyMiniAppUser(BOT_TOKEN, initData(1, -60)), null);
  assert.equal(await auth.verifyMiniAppUser(BOT_TOKEN, initData() + '&user=%7B%22id%22%3A2%7D'), null);
  assert.equal(await auth.verifyMiniAppUser('wrong-token', initData()), null);
});

test('launch link binds owner, transaction and message; rejects tampering and expiry', async () => {
  const token = await auth.createSplitPanelToken(BOT_TOKEN, 1, 2, 42, {identity:'a'.repeat(32),revision:0});
  assert.equal((await auth.verifySplitPanelToken(BOT_TOKEN, token)).messageId, 42);
  assert.equal(await auth.verifySplitPanelToken(BOT_TOKEN, token.replace('1:2:42:', '1:3:42:')), null);
  const payload = `1:2:42:${Math.floor(Date.now() / 1000) - 1}:${'a'.repeat(32)}:0:${crypto.randomUUID()}`;
  const expired = payload + ':' + createHmac('sha256', BOT_TOKEN).update('split-panel:' + payload).digest('hex');
  assert.equal(await auth.verifySplitPanelToken(BOT_TOKEN, expired), null);
});

test('load, save expression, retry, refresh original card, and undo preserve the full amount', async () => {
  const s = await setup();
  const loaded = await (await s.call('load')).json();
  assert.equal(loaded.totalLabel, '฿2,800');
  assert.equal(loaded.note, 'Dinner');
  for (let i = 0; i < 2; i++) {
    const response = await s.call('save', { amount: '2,800 - 520' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).cardUpdated, true);
  }
  const updated = await repo.getTransaction(s.db, s.tx.id, s.user.id);
  assert.equal(updated.amount, 2280);
  assert.equal(updated.original_amount, 2800);
  assert.equal(s.edits[0][1], 1);
  assert.equal(s.edits[0][2], 42);
  assert.match(s.edits[0][3], /2,280/);
  assert.equal((await repo.undoSplit(s.db, s.tx.id, s.user.id)).amount, 2800);
});

test('reject wrong owner, cross-origin, missing auth, excessive amount and malformed amounts without writing', async () => {
  const s = await setup();
  assert.equal((await s.call('save', { amount: '50', initData: initData(2) })).status, 401);
  assert.equal((await s.call('save', { amount: '50', initData: '' })).status, 401);
  assert.equal((await s.call('save', { amount: '50' }, { origin: 'https://other.example' })).status, 403);
  for (const amount of ['0', '-1', '2800.01', 'Infinity', 'abc', '1'.repeat(101)]) {
    assert.equal((await s.call('save', { amount })).status, 400);
  }
  const other = await repo.upsertUser(s.db, 2, 'Other', 'other', 'member');
  const otherTx = await repo.insertTransaction(s.db, other.id, slip(), 'private');
  const otherToken = await auth.createSplitPanelToken(BOT_TOKEN, 1, otherTx.id, 42, await repo.getVersionedTransaction(s.db, otherTx.id, other.id));
  assert.equal((await s.call('load', { token: otherToken })).status, 404);
  assert.equal((await repo.getTransaction(s.db, s.tx.id, s.user.id)).amount, 2800);
  assert.equal(s.edits.length, 0);
});

test('a month split or deleted transaction cannot be overwritten by an open panel', async () => {
  const s = await setup();
  await repo.splitByMonths(s.db, s.tx.id, s.user.id, 2);
  assert.equal((await s.call('save', { amount: '50' })).status, 409);
  assert.equal(await repo.splitByCustom(s.db, s.tx.id, s.user.id, 50), null);
  await repo.deleteTransaction(s.db, s.tx.id, s.user.id);
  assert.equal((await s.call('load')).status, 404);
});

test('card refresh failure reports saved state; oversized requests and invalid routes fail safely', async () => {
  const s = await setup(false);
  const result = await (await s.call('save', { amount: '๒๒๘๐.๕๐' })).json();
  assert.equal(result.cardUpdated, false);
  assert.match(result.message, /Saved your share/);
  assert.equal((await repo.getTransaction(s.db, s.tx.id, s.user.id)).amount, 2280.5);
  assert.equal((await s.call('load', { padding: 'x'.repeat(17000) })).status, 413);
  assert.equal((await s.call('unknown')).status, 404);
  const page = await s.handle(new Request('https://bot.example/split-panel'), { BOT_TOKEN });
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /Save my share/);
});
