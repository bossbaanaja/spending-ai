// Regression cases reproduced during the split-panel review.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const { database, loader, slip } = require('./support.cjs');
const token = '123:review-only';
const repo = loader()('src/db/repo.ts');
const globals = { URLSearchParams, TextDecoder };
function signedIdentity() {
  const data = new URLSearchParams({ user: JSON.stringify({ id: 1 }), auth_date: String(Math.floor(Date.now() / 1000)) });
  data.sort();
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  data.set('hash', createHmac('sha256', key).update([...data].map(([k,v]) => k + '=' + v).join('\n')).digest('hex'));
  return data.toString();
}
async function setup(edit = async () => true) {
  const db = database();
  const user = await repo.upsertUser(db, 1, 'Review', 'review', 'member');
  const tx = await repo.insertTransaction(db, user.id, {...slip(), amount: 2800}, 'Original expense');
  const load = loader({'src/services/telegram.ts': { editTelegramCard: edit }}, globals);
  const link = await load('src/services/splitPanelAuth.ts').createSplitPanelToken(token, 1, tx.id, 42, await repo.getVersionedTransaction(db,tx.id,user.id));
  const handle = load('src/web/splitPanelHandler.ts').handleSplitPanel;
  const call = (action, amount = '2280') => handle(new Request('https://test.local/split-panel/' + action, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({ token: link, initData: signedIdentity(), amount }),
  }), {DB: db, BOT_TOKEN: token});
  return {db,user,tx,call,load};
}
function gate() { let release; const promise = new Promise(r => release = r); return {promise,release}; }

test('an old panel must not change a new expense that reused a deleted row ID', async () => {
  const s = await setup();
  await s.call('load');
  await repo.deleteTransaction(s.db,s.tx.id,s.user.id);
  const replacement = await repo.insertTransaction(s.db,s.user.id,{...slip(),amount:5000},'Different expense');
  assert.equal(replacement.id,s.tx.id,'SQLite reused the deleted highest ID');
  const result = await s.call('save');
  const after = await repo.getTransaction(s.db,replacement.id,s.user.id);
  console.log(JSON.stringify({case:'reused ID',status:result.status,replacementAmount:after.amount,expected:5000}));
  assert.equal(after.amount,5000);
});

test('a retried Save must not reverse a later Undo split', async () => {
  const s = await setup();
  assert.equal((await s.call('save')).status,200);
  await repo.undoSplit(s.db,s.tx.id,s.user.id);
  const result = await s.call('save');
  const after = await repo.getTransaction(s.db,s.tx.id,s.user.id);
  console.log(JSON.stringify({case:'retry after undo',status:result.status,amount:after.amount,expected:2800}));
  assert.equal(after.amount,2800);
});

test('overlapping saves must leave the chat card consistent with stored spending', async () => {
  const entered = gate(), release = gate();
  let count = 0, displayed = '';
  const s = await setup(async (_token,_chat,_message,text) => {
    if (++count === 1) { entered.release(); await release.promise; }
    displayed = text;
    return true;
  });
  const first = s.call('save','2280');
  await entered.promise;
  // A fresh panel opened after the first write is a distinct authorized change.
  const fresh = await s.load('src/services/splitPanelAuth.ts').createSplitPanelToken(token,1,s.tx.id,42,await repo.getVersionedTransaction(s.db,s.tx.id,s.user.id));
  const second = await s.load('src/web/splitPanelHandler.ts').handleSplitPanel(new Request('https://test.local/split-panel/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:fresh,initData:signedIdentity(),amount:'1000'})}),{DB:s.db,BOT_TOKEN:token});
  release.release();
  await first;
  const after = await repo.getTransaction(s.db,s.tx.id,s.user.id);
  console.log(JSON.stringify({case:'reordered card updates',status:second.status,stored:after.amount,displayed:displayed.split('\n')[0]}));
  assert.match(displayed,/Saved ฿1,000/);
});

test('overlapping month split must not silently discard a successful custom share', async () => {
  const s = await setup();
  const entered = gate(), release = gate();
  const heldDb = {...s.db, batch: async statements => { entered.release(); await release.promise; return s.db.batch(statements); }};
  const month = repo.splitByMonths(heldDb,s.tx.id,s.user.id,2);
  await entered.promise;
  assert.equal((await s.call('save','2280')).status,200);
  release.release();
  assert.equal(await month,null);
  const sum = s.db.sqlite.prepare('SELECT sum(amount) AS total FROM transactions').get().total;
  console.log(JSON.stringify({case:'month reads before custom save',total:sum,expected:2280}));
  assert.equal(sum,2280);
});

test('two amounts from the same panel cannot both save; a repeat does not increment its version', async () => {
  const s = await setup();
  const responses = await Promise.all([s.call('save','2000'), s.call('save','1000')]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  const current = await repo.getVersionedTransaction(s.db,s.tx.id,s.user.id);
  assert.equal(current.revision,1);
  assert.equal((await s.call('save',String(current.amount))).status,200);
  assert.equal((await repo.getVersionedTransaction(s.db,s.tx.id,s.user.id)).revision,1);
});

test('migration backfills existing expenses, preserves identity on rerun, and versions external edits', async () => {
  const schema = fs.readFileSync('src/db/schema.sql','utf8').split('-- A separate identity survives')[0];
  const db = database(schema);
  const user = await repo.upsertUser(db,1,'Test','test','member');
  const tx = await repo.insertTransaction(db,user.id,slip(),'existing');
  const migration = fs.readFileSync('src/db/migrations/0003_split_panel_safety.sql','utf8');
  db.sqlite.exec(migration);
  const before = await repo.getVersionedTransaction(db,tx.id,user.id);
  assert.match(before.identity,/^[a-f0-9]{32}$/);
  db.sqlite.exec(migration);
  await repo.updateCategory(db,tx.id,user.id,'Food');
  const after = await repo.getVersionedTransaction(db,tx.id,user.id);
  assert.equal(after.identity,before.identity);
  assert.equal(after.revision,1);
  assert.equal(after.amount,100);
});

test('a failed card send is durable and cron renders the latest state', async () => {
  let fail = true, displayed = '';
  const s = await setup(async (_token,_chat,_message,text) => { if(fail)return false; displayed=text;return true; });
  const response = await s.call('save');
  assert.equal(response.status,200);
  assert.equal((await response.json()).cardUpdated,false);
  // Another change wakes the pending card immediately and cron must use that amount.
  await repo.undoSplit(s.db,s.tx.id,s.user.id);
  fail=false;
  await s.load('src/bot/cardRefresh.ts').recoverTransactionCards({DB:s.db,BOT_TOKEN:token});
  assert.match(displayed,/Saved ฿2,800/);
  const job=await repo.getTransactionCardJob(s.db,1,42);
  assert.equal(job.generation,job.completed_generation);
});

test('abandoned leases recover; a late expired sender cannot mark a newer card complete', async () => {
  const s=await setup();
  const tx=await repo.getVersionedTransaction(s.db,s.tx.id,s.user.id);
  await repo.requestTransactionCard(s.db,tx.id,s.user.id,tx.identity,1,42);
  const expired=await repo.claimTransactionCard(s.db,1,42,'expired',Date.now()-46000);
  assert.ok(expired);
  await s.load('src/bot/cardRefresh.ts').recoverTransactionCards({DB:s.db,BOT_TOKEN:token});
  assert.equal(await repo.finishTransactionCard(s.db,expired,'expired',true),false);
  const pending=await repo.getTransactionCardJob(s.db,1,42);
  assert.ok(pending.generation>pending.completed_generation);
  await s.load('src/bot/cardRefresh.ts').recoverTransactionCards({DB:s.db,BOT_TOKEN:token});
  const repaired=await repo.getTransactionCardJob(s.db,1,42);
  assert.equal(repaired.generation,repaired.completed_generation);
});

test('an edit during a card send causes a fresh render instead of acknowledging the old version', async () => {
  let s, displayed='',calls=0;
  s=await setup(async (_token,_chat,_message,text)=>{
    displayed=text;
    if(++calls===1)await repo.undoSplit(s.db,s.tx.id,s.user.id);
    return true;
  });
  await s.call('save');
  assert.match(displayed,/Saved ฿2,800/);
  assert.equal(calls,2);
});

test('two simultaneous monthly splits produce one group; deleted parents leave no new parts', async () => {
  const s=await setup();
  const entered=gate(),release=gate();
  const held={...s.db,batch:async statements=>{entered.release();await release.promise;return s.db.batch(statements);}};
  const stale=repo.splitByMonths(held,s.tx.id,s.user.id,3);
  await entered.promise;
  assert.ok(await repo.splitByMonths(s.db,s.tx.id,s.user.id,2));
  release.release();assert.equal(await stale,null);
  assert.equal(s.db.sqlite.prepare('SELECT count(*) AS n FROM transactions').get().n,2);
  assert.equal(s.db.sqlite.prepare('SELECT sum(amount) AS n FROM transactions').get().n,2800);
  const another=await setup();const pause=gate(),resume=gate();
  const waiting=repo.splitByMonths({...another.db,batch:async statements=>{pause.release();await resume.promise;return another.db.batch(statements);}},another.tx.id,another.user.id,2);
  await pause.promise;await repo.deleteTransaction(another.db,another.tx.id,another.user.id);
  resume.release();assert.equal(await waiting,null);
  assert.equal(another.db.sqlite.prepare('SELECT count(*) AS n FROM transactions').get().n,0);
});

test('legacy text-share fallback uses the coordinated card sender too', async () => {
  const s=await setup();
  await repo.setPendingCustomSplit(s.db,s.user.id,s.tx.id,42);
  let handler;
  s.load('src/bot/handlers/message.ts').registerMessage({on:(_filter,fn)=>handler=fn});
  const replies=[];
  await handler({dbUser:s.user,env:{DB:s.db,BOT_TOKEN:token},message:{text:'2280'},chat:{id:1},
    reply:async text=>replies.push(text),api:{editMessageText:async()=>assert.fail('must use the shared card sender')}});
  assert.equal((await repo.getTransaction(s.db,s.tx.id,s.user.id)).amount,2280);
  assert.equal(await repo.getPendingCustomSplit(s.db,s.user.id),null);
  assert.match(replies[0],/Saved your share/);
  const job=await repo.getTransactionCardJob(s.db,1,42);
  assert.equal(job.completed_generation,job.generation);
});
