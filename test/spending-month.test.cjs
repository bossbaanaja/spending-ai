const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { database, loader, slip } = require('./support.cjs');
const load = loader();
const repo = load('src/db/repo.ts');
async function setup() {
  const db = database();
  const user = await repo.upsertUser(db, 1, 'Test', 'local', 'member');
  const tx = await repo.insertTransaction(db, user.id, {...slip('hotel'), amount:3000, datetime:'2026-09-28 12:00'}, 'Hotel');
  const current = () => repo.getVersionedTransaction(db, tx.id, user.id);
  const set = async month => repo.setSpendingMonth(db, user.id, await current(), month);
  return {db,user,tx,current,set};
}

test('full amount moves once; summaries, future lists, daily records, and undo agree', async () => {
  const s = await setup();
  assert.equal(await s.set('2099-11'), true);
  assert.equal((await repo.getMonthSummary(s.db,s.user.id,'2026-09')).total,0);
  const summary = await repo.getMonthSummary(s.db,s.user.id,'2099-11');
  assert.equal(summary.total,3000); assert.equal(summary.byCategory[0].total,3000);
  assert.equal(summary.topReceivers[0].total,3000);
  assert.equal(summary.byDay[0].day,'unspecified');
  const filters={spendingMonth:'2099-11'};
  assert.equal((await repo.listTransactions(s.db,s.user.id,filters)).length,1);
  assert.equal((await repo.sumTransactions(s.db,s.user.id,filters)).total,3000);
  assert.equal((await repo.getDailyUserSummaries(s.db,'2026-09-28'))[0].totals[0].total,3000);
  assert.equal((await s.current()).slip_datetime,'2026-09-28 12:00');
  assert.equal(await repo.insertTransaction(s.db,s.user.id,slip('hotel'),'again'),'duplicate');
  await s.set('2099-12');
  assert.equal((await repo.getMonthSummary(s.db,s.user.id,'2099-11')).count,0);
  await s.set('2026-09');
  assert.equal((await s.current()).spending_month,null);
  assert.equal((await repo.getMonthSummary(s.db,s.user.id,'2026-09')).total,3000);
  assert.equal(s.db.sqlite.prepare('SELECT count(*) AS n FROM transactions').get().n,1);
  await assert.rejects(repo.sumTransactions(s.db,s.user.id,{spendingMonth:'2026-11',dateTo:'2026-11-30'}));
});

test('replay, concurrent saves, wrong owner and deleted identities cannot overwrite current state', async () => {
  const s=await setup(), old=await s.current();
  const results=await Promise.all(['2026-11','2026-12'].map(m=>repo.setSpendingMonth(s.db,s.user.id,old,m)));
  assert.equal(results.filter(Boolean).length,1);
  const revision=(await s.current()).revision;
  assert.equal(await repo.setSpendingMonth(s.db,s.user.id,old,'2027-01'),false);
  assert.equal((await s.current()).revision,revision);
  assert.equal(await repo.setSpendingMonth(s.db,999,await s.current(),'2027-01'),false);
  await repo.deleteTransaction(s.db,s.tx.id,s.user.id);
  const replacement=await repo.insertTransaction(s.db,s.user.id,slip(),'new');
  assert.equal(await repo.setSpendingMonth(s.db,s.user.id,old,'2027-01'),false);
  assert.equal((await repo.getTransaction(s.db,replacement.id,s.user.id)).spending_month,null);
});

test('share changes preserve month; amortization conflicts are guarded in both directions', async () => {
  const s=await setup();
  await s.set('2026-11');
  await repo.splitByPeople(s.db,s.tx.id,s.user.id,3);
  assert.equal((await s.current()).amount,1000);
  assert.equal((await s.current()).spending_month,'2026-11');
  assert.equal(await repo.splitByMonths(s.db,s.tx.id,s.user.id,3),null);
  await repo.undoSplit(s.db,s.tx.id,s.user.id);
  assert.equal((await s.current()).spending_month,'2026-11');
  await s.set(null);
  await repo.splitByMonths(s.db,s.tx.id,s.user.id,3);
  assert.equal(await s.set('2026-11'),false);
});

test('month assignment racing amortization produces exactly one valid outcome', async () => {
  for (const first of ['defer','split']) {
    const s=await setup(), expected=await s.current();
    const ops={defer:()=>repo.setSpendingMonth(s.db,s.user.id,expected,'2026-11'),split:()=>repo.splitByMonths(s.db,s.tx.id,s.user.id,3)};
    await Promise.all([ops[first](),ops[first==='defer'?'split':'defer']()]);
    const tx=await s.current();
    assert.ok(tx.spending_month ? tx.split_kind!=='month' : tx.split_kind==='month');
    assert.equal(s.db.sqlite.prepare('SELECT sum(amount) AS total FROM transactions').get().total,3000);
  }
});

test('Bangkok fallback and month validation do not invent usage days', async () => {
  const s=await setup();
  s.db.sqlite.prepare("UPDATE transactions SET slip_datetime=NULL, created_at='2026-09-30 18:00:00' WHERE id=?").run(s.tx.id);
  assert.equal((await repo.getMonthSummary(s.db,s.user.id,'2026-10')).total,3000);
  assert.equal(load('src/spendingMonth.ts').paymentDate(await s.current()),'2026-10-01');
  for (const invalid of ['2026-00','2026-13','1899-12','10000-01','2026-1']) assert.equal(await s.set(invalid),false);
  await s.set('2026-10'); assert.equal((await s.current()).spending_month,null);
});

test('migration preserves historical rows and enforces month format and split compatibility', async () => {
  const old=['0000_initial','0001_album_reliability','0002_album_queue','0003_split_panel_safety']
    .map(name=>fs.readFileSync(`src/db/migrations/${name}.sql`,'utf8')).join('\n');
  const db=database(old);
  db.sqlite.exec("INSERT INTO users(id,telegram_id,token) VALUES(1,1,'test'); INSERT INTO transactions(id,user_id,amount,category) VALUES(1,1,3000,'Other')");
  db.sqlite.exec(fs.readFileSync('src/db/migrations/0004_spending_month.sql','utf8'));
  const tx=await repo.getTransaction(db,1,1);
  assert.equal(tx.amount,3000); assert.equal(tx.spending_month,null);
  assert.throws(()=>db.sqlite.exec("UPDATE transactions SET spending_month='2026-13'"));
  db.sqlite.exec("UPDATE transactions SET spending_month='2026-11'");
  assert.throws(()=>db.sqlite.exec("UPDATE transactions SET split_kind='month'"));
});

test('assistant monthly tool and deterministic fallback use allocations and label payment dates', async () => {
  const s=await setup(); await s.set('2099-11');
  let calls=0, payload;
  const assistant=loader({'src/services/nim.ts': { nimChat:async (_env,messages)=>{
    if (++calls===1) return {content:null,toolCalls:[{id:'read',type:'function',function:{name:'list_transactions',arguments:JSON.stringify({spending_month:'2099-11'})}}]};
    payload=JSON.parse(messages.find(m=>m.role==='tool').content);
    return {content:'',toolCalls:[]};
  }}})('src/bot/assistant.ts');
  const reply=await assistant.runAssistant({DB:s.db},s.user,'List November spending');
  assert.equal(payload.total,3000);
  assert.equal(payload.transactions[0].payment_date,'2026-09-28');
  assert.equal(payload.transactions[0].spending_month,'2099-11');
  assert.equal(payload.transactions[0].usage_day_unspecified,true);
  assert.match(reply.text,/Spending month 2099-11/);
  assert.match(reply.text,/3,000/);
  assert.match(reply.text,/usage day unspecified/);
});

test('picker marks selection, crosses years, fits Telegram callbacks and hides conflicting choices', async () => {
  const s=await setup(); await s.set('2026-11');
  const tx=await s.current();
  const keys=load('src/bot/handlers/spendingMonth.ts').spendingMonthKeyboard(tx,2026).inline_keyboard.flat();
  assert.ok(keys.some(b=>b.text==='✓ Nov'));
  assert.ok(keys.some(b=>b.callback_data.endsWith(':y2027')));
  for (const b of keys) assert.ok(Buffer.byteLength(b.callback_data)<=64);
  const {txKeyboard,splitModeKeyboard}=load('src/bot/keyboards.ts');
  assert.ok(!splitModeKeyboard(tx.id,undefined,true).inline_keyboard.flat().some(b=>b.callback_data?.startsWith('splitm:')));
  assert.ok(!txKeyboard({...tx,split_kind:'month'}).inline_keyboard.flat().some(b=>b.callback_data?.startsWith('month:')));
});

test('failed month card refresh recovers latest assignment without reverting the saved month', async () => {
  const s=await setup(), tx=await s.current();
  let available=false, displayed='';
  const cards=loader({'src/services/telegram.ts':{editTelegramCard:async (_token,_chat,_message,text)=>{
    if (!available) return false;
    displayed=text; return true;
  }}})('src/bot/cardRefresh.ts');
  await repo.requestTransactionCard(s.db,tx.id,s.user.id,tx.identity,1,42);
  await s.set('2026-11');
  assert.equal(await cards.flushTransactionCard({DB:s.db},1,42),false);
  assert.equal((await s.current()).spending_month,'2026-11');
  await s.set('2026-12');
  available=true;
  await cards.recoverTransactionCards({DB:s.db});
  assert.match(displayed,/Counts toward: December 2026/);
  const job=await repo.getTransactionCardJob(s.db,1,42);
  assert.equal(job.generation,job.completed_generation);
});
