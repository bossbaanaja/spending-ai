const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Miniflare}=require('miniflare');
const {sqlStatements}=require('./support.cjs');

test('actual Worker: month picker, navigation, save, replay, cancel, split conflict and undo', {timeout:60000}, async()=>{
  const calls=[];
  const mf=new Miniflare({modules:true,scriptPath:'scratch/album-worker-build/index.js',
    compatibilityDate:'2026-07-04',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
    bindings:{BOT_TOKEN:'123:month-test',WEBHOOK_SECRET:'test',ALBUM_QUEUE_USERS:''},
    outboundService:async request=>{
      const url=new URL(request.url);
      assert.equal(url.hostname,'api.telegram.org');
      if(url.pathname.endsWith('/getMe')) return Response.json({ok:true,result:{id:999,is_bot:true,first_name:'Test',username:'test_bot'}});
      const body=await request.json();calls.push(body);
      return Response.json({ok:true,result:url.pathname.endsWith('/answerCallbackQuery')?true:{message_id:42,chat:{id:1,type:'private'},date:1,text:body.text}});
    }});
  try {
    const db=await mf.getD1Database('DB');
    for(const statement of sqlStatements(fs.readFileSync('src/db/schema.sql','utf8'))) await db.prepare(statement).run();
    await db.prepare("INSERT INTO users(id,telegram_id,token) VALUES(1,1,'test'),(2,2,'test')").run();
    await db.prepare("INSERT INTO transactions(id,user_id,amount,category,note,slip_datetime) VALUES(1,1,3000,'Other','Hotel','2026-09-28 12:00')").run();
    let update=100;
    const callback=async(data,user=1)=>{
      const id=++update;
      const response=await mf.dispatchFetch('https://test.local/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'test'},body:JSON.stringify({update_id:id,callback_query:{id:String(id),from:{id:user,is_bot:false,first_name:'Test'},chat_instance:'test',data,message:{message_id:42,date:1,chat:{id:user,type:'private'},text:'Saved'}}})});
      assert.equal(response.status,200);
    };
    const buttons=()=>calls.filter(c=>c.reply_markup).at(-1).reply_markup.inline_keyboard.flat();
    const button=suffix=>buttons().find(b=>b.callback_data?.endsWith(suffix)).callback_data;
    const tx=()=>db.prepare('SELECT * FROM transactions WHERE id=1').first();
    await callback('month:1');
    assert.equal(buttons().filter(b=>/:2026-\d\d$/.test(b.callback_data)).length,12);
    await callback(button(':y2027'));
    assert.ok(button(':2027-11'));
    await callback(button(':y2026'));
    const november=button(':2026-11');
    await callback(november,2);
    assert.equal((await tx()).spending_month,null);
    await callback(november);
    assert.equal((await tx()).spending_month,'2026-11');
    assert.match(calls.filter(c=>c.text).at(-1).text,/Counts toward: November 2026/);
    await callback('month:1');
    await callback(button(':2026-12'));
    await callback(november);
    assert.equal((await tx()).spending_month,'2026-12');
    await callback('month:1');
    await callback(button(':c'));
    assert.equal((await tx()).spending_month,'2026-12');
    await callback('splitm:1:3');
    assert.equal((await tx()).split_kind,null);
    await callback('month:1');
    await callback(button(':r'));
    assert.equal((await tx()).spending_month,null);
    await callback('splitm:1:3');
    assert.equal((await tx()).split_kind,'month');
    assert.ok(!buttons().some(b=>b.callback_data?.startsWith('month:')));
  } finally { await mf.dispose(); }
});
