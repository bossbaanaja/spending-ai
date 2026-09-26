const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHmac } = require('node:crypto');
const { Miniflare } = require('miniflare');
const { sqlStatements } = require('./support.cjs');

test('actual Worker: callback to signed panel to D1 save and original card refresh', {timeout:60000}, async () => {
  const calls=[];
  let blockedSend = null;
  const botToken='123:runtime-review-only';
  const mf=new Miniflare({modules:true,scriptPath:'scratch/album-worker-build/index.js',
    compatibilityDate:'2026-07-04',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
    bindings:{BOT_TOKEN:botToken,WEBHOOK_SECRET:'review-secret',ALBUM_QUEUE_USERS:''},
    outboundService:async request=>{
      const url=new URL(request.url);
      assert.equal(url.hostname,'api.telegram.org');
      if(url.pathname.endsWith('/getMe')) return Response.json({ok:true,result:{id:999,is_bot:true,first_name:'Test',username:'test_bot'}});
      const body=await request.json();calls.push({method:url.pathname.split('/').pop(),...body});
      if (blockedSend && body.chat_id === 1 && body.text?.startsWith('✅ Saved')) {
        const held = blockedSend; blockedSend = null; held.entered(); await held.release;
      }
      return Response.json({ok:true,result:url.pathname.endsWith('/answerCallbackQuery')?true:{message_id:body.message_id??42,chat:{id:1,type:'private'},date:1,text:body.text}});
    }});
  try {
    const db=await mf.getD1Database('DB');
    const schema=fs.readFileSync('src/db/schema.sql','utf8');
    for(const statement of sqlStatements(schema)) await db.prepare(statement).run();
    await db.prepare("INSERT INTO users (id,telegram_id,role,token) VALUES (1,1,'member','review')").run();
    await db.prepare("INSERT INTO transactions (id,user_id,amount,category,note) VALUES (1,1,2800,'Food','Dinner')").run();
    const callback=async (id,data,type='private')=>{
      const response=await mf.dispatchFetch('https://review.local/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'review-secret'},body:JSON.stringify({update_id:id,callback_query:{id:String(id),from:{id:1,is_bot:false,first_name:'Review'},chat_instance:'review',data,message:{message_id:42,date:1,chat:{id:type==='private'?1:-1,type},text:'Original'}}})});
      assert.equal(response.status,200);
    };
    await callback(1,'split:1');
    const menu=calls.find(c=>c.reply_markup?.inline_keyboard?.flat().some(b=>b.web_app));
    assert.ok(menu,'actual Split callback emitted Web App button');
    const launch=menu.reply_markup.inline_keyboard.flat().find(b=>b.web_app).web_app.url;
    const page=await mf.dispatchFetch(launch);
    assert.equal(page.status,200);assert.match(await page.text(),/Save my share/);
    const init=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:1,first_name:'Review'})});init.sort();
    const key=createHmac('sha256','WebAppData').update(botToken).digest();
    init.set('hash',createHmac('sha256',key).update([...init].map(([k,v])=>k+'='+v).join('\n')).digest('hex'));
    const call=async(action,amount,panel=launch)=>mf.dispatchFetch('https://review.local/split-panel/'+action,{method:'POST',headers:{'content-type':'application/json',origin:'https://review.local'},body:JSON.stringify({token:new URL(panel).searchParams.get('token'),initData:init.toString(),amount})});
    assert.equal((await call('load')).status,200);
    const saved=await call('save','2800 - 520');
    assert.equal(saved.status,200);assert.equal((await saved.json()).cardUpdated,true);
    assert.equal((await db.prepare('SELECT amount FROM transactions WHERE id=1').first()).amount,2280);
    const card=calls.at(-1);assert.equal(card.chat_id,1);assert.equal(card.message_id,42);assert.match(card.text,/Saved ฿2,280/);
    assert.equal((await call('save','2280')).status,200);
    assert.equal((await db.prepare('SELECT revision FROM transaction_versions WHERE tx_id=1').first()).revision,1);
    await callback(2,'unsplit:1');
    assert.equal((await db.prepare('SELECT amount FROM transactions WHERE id=1').first()).amount,2800);
    assert.equal((await call('save','2280')).status,409);
    await callback(3,'split:1','group');
    assert.ok(calls.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='splitc:1'));
    // Keep an earlier Telegram edit in flight while a newly-opened panel saves again.
    const latestPanel=()=>calls.filter(c=>c.reply_markup?.inline_keyboard?.flat().some(b=>b.web_app)).at(-1)
      .reply_markup.inline_keyboard.flat().find(b=>b.web_app).web_app.url;
    await callback(5,'split:1');
    let entered, release;
    const held=new Promise(r=>entered=r), resume=new Promise(r=>release=r);
    blockedSend={entered,release:resume};
    const firstSave=call('save','2200',latestPanel());
    await held;
    await callback(6,'split:1');
    const secondSave=await call('save','1000',latestPanel());
    assert.equal(secondSave.status,200);assert.equal((await secondSave.json()).cardUpdated,false);
    release();assert.equal((await firstSave).status,200);
    assert.match(calls.at(-1).text,/Saved ฿1,000/);
    assert.equal((await db.prepare('SELECT amount FROM transactions WHERE id=1').first()).amount,1000);
    await callback(7,'splitm:1:2');
    assert.equal((await db.prepare('SELECT sum(amount) AS total FROM transactions').first()).total,1000);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM transactions').first()).n,2);
    await callback(8,'unsplit:1');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM transactions').first()).n,1);
    assert.equal((await db.prepare('SELECT amount FROM transactions WHERE id=1').first()).amount,2800);
    console.log('Real runtime passed: private callback, signed URL, auth, save expression, original-card update, undo callback, group fallback.');
    await callback(4,'del:1');
    const replacement=await db.prepare("INSERT INTO transactions (user_id,amount,category,note) VALUES (1,5000,'Food','Different expense') RETURNING id").first();
    const response=await call('save','2280');
    const after=await db.prepare('SELECT amount FROM transactions WHERE id=?').bind(replacement.id).first();
    console.log(JSON.stringify({case:'real D1 deleted ID reuse',replacementId:replacement.id,oldPanelStatus:response.status,replacementAmount:after.amount}));
    assert.equal(after.amount,5000,'old panel must not modify the replacement expense');
  }finally{await mf.dispose();}
});
