const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, loader, slip } = require('./support.cjs');
const load = loader({ 'src/bot/cardRefresh.ts': { flushTransactionCard: async () => true } });
const repo = load('src/db/repo.ts');

for (const note of [123, '123', 0, '00123', 'lunch']) {
  for (const pending of [false, true]) {
    test(`/undo deletes note ${JSON.stringify(note)} (${typeof note}), pending split=${pending}`, async () => {
      const db = database();
      const user = await repo.upsertUser(db, 1, 'Test', 'test', 'member');
      const tx = await repo.insertTransaction(db, user.id, slip(), note);
      if (pending) await repo.setPendingCustomSplit(db, user.id, tx.id, 10);
      const commands = {}, callbacks = [], middleware = [];
      load('src/bot/handlers/edit.ts').registerEdit({
        command: (name, fn) => { commands[name] = fn; },
        callbackQuery: (pattern, fn) => callbacks.push({ pattern, fn }),
        on: (_, fn) => middleware.push(fn),
      });
      let data;
      const answers = [];
      const ctx = {
        env: { DB: db }, dbUser: user, chat: { id: 1 },
        reply: async (_, options) => { data = options.reply_markup.inline_keyboard[0][0].callback_data; },
        answerCallbackQuery: async answer => answers.push(answer.text),
        editMessageText: async () => true,
      };
      await commands.undo(ctx);
      ctx.callbackQuery = { data, message: { message_id: 20 } };
      const callback = callbacks.find(c => typeof c.pattern !== 'string' && c.pattern.test(data));
      ctx.match = data.match(callback.pattern);
      await middleware[0](ctx, () => callback.fn(ctx));
      assert.equal(await repo.getTransaction(db, tx.id, user.id), null);
      assert.equal(await repo.getPendingCustomSplit(db, user.id), null);
      assert.deepEqual(answers, ['Deleted.']);
      assert.equal(await repo.deleteTransaction(db, tx.id, user.id), false);
    });
  }
}

test('deletion preserves unrelated and other users pending splits', async () => {
  const db = database();
  const user = await repo.upsertUser(db, 1, 'Test', 'test', 'member');
  const other = await repo.upsertUser(db, 2, 'Other', 'test', 'member');
  const target = await repo.insertTransaction(db, user.id, slip(), 123);
  const unrelated = await repo.insertTransaction(db, user.id, slip(), 'keep');
  const foreign = await repo.insertTransaction(db, other.id, slip(), 456);
  await repo.setPendingCustomSplit(db, user.id, unrelated.id, 10);
  await repo.setPendingCustomSplit(db, other.id, foreign.id, 11);
  assert.equal(await repo.deleteTransaction(db, foreign.id, user.id), false);
  assert.equal(await repo.deleteTransaction(db, target.id, user.id), true);
  assert.equal((await repo.getPendingCustomSplit(db, user.id)).tx_id, unrelated.id);
  assert.equal((await repo.getPendingCustomSplit(db, other.id)).tx_id, foreign.id);
});

test('month group deletion clears its pending split and returns the number of entries', async () => {
  const db = database();
  const user = await repo.upsertUser(db, 1, 'Test', 'test', 'member');
  const tx = await repo.insertTransaction(db, user.id, slip(), 123);
  const split = await repo.splitByMonths(db, tx.id, user.id, 3);
  await repo.setPendingCustomSplit(db, user.id, tx.id, 10);
  assert.equal(await repo.deleteSplitGroup(db, split.split_group, user.id), 3);
  assert.equal(await repo.getPendingCustomSplit(db, user.id), null);
  assert.equal(await repo.getLatestTransaction(db, user.id), null);
  assert.equal(await repo.deleteSplitGroup(db, split.split_group, user.id), 0);
});
