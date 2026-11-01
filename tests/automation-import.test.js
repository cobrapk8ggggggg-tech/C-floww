'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('../backend/node_modules/express');
const mongoose=require('../backend/node_modules/mongoose');
const Receipt=require('../backend/models/importChapter.model');
const Novel=require('../backend/models/novel.model');
const Mirror=require('../backend/models/chapterContentMirror.model');
const mount=require('../backend/routes/automationImportRoutes');
const uri=process.env.AUTOMATION_TEST_MONGO_URI;

test('durable import survives partial writes, duplicates, private novels and corrupt storage', {skip:!uri},async()=>{
  const old=process.env.SCRAPER_API_SECRET;
  const oldIngest=process.env.AUTOMATION_INGEST_SECRET;process.env.AUTOMATION_INGEST_SECRET='isolated-ingest-test';
  process.env.SCRAPER_API_SECRET='isolated-import-test';
  let failWrite=false,failRead=false;
  const docs=new Map();
  const firestore={
    collection:()=>({doc:novel=>({collection:()=>({doc:number=>{
      const key=novel+':'+number;
      return {key,get:async()=>{if(failRead)throw Error('read unavailable');
        return {exists:docs.has(key),data:()=>docs.get(key)};}};
    }})})}),
    runTransaction:async fn=>{if(failWrite)throw Error('write unavailable');
      await fn({get:ref=>ref.get(),create:(ref,value)=>docs.set(ref.key,value)});}
  };
  let server;
  try {
    await mongoose.connect(uri,{dbName:'zeus_automation_import_'+Date.now()});
    await Promise.all([Receipt.init(),Mirror.init(),Novel.init()]);
    const app=express();app.use(express.json());mount(app,{Receipt,Novel,Mirror,firestore});
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const send=async(path,body,authorized=true)=>{
      const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/automation/chapters/'+path,{
        method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:process.env.SCRAPER_API_SECRET,'x-automation-ingest-secret':authorized==='legacy-only'?'':process.env.AUTOMATION_INGEST_SECRET}:{})},
        body:JSON.stringify(body)});
      return {status:r.status,body:await r.text().then(t=>{try{return JSON.parse(t)}catch{return t}})};
    };
    const input={sourceUrl:'https://novelfire.net/isolated',novelData:{title:'Test'},
      chapter:{number:1,title:'First',content:'A complete original chapter.'}};
    const identity={sourceUrl:input.sourceUrl,chapterNumber:1};
    assert.equal((await send('import',input,false)).status,403);
    assert.equal((await send('import',input,'legacy-only')).status,403);
    failWrite=true;
    assert.equal((await send('import',input)).status,503);
    assert.equal((await Receipt.findOne()).persisted,false);
    assert.equal((await send('check',identity)).body.persisted,false);
    failWrite=false;
    const saved=await send('import',input);assert.equal(saved.body.persisted,true);
    assert.equal((await send('check',identity)).body.persisted,true);
    assert.equal((await Novel.findOne()).status,'خاصة');
    // Redelivery with changed source text must not replace the immutable original.
    input.chapter.content='Changed upstream text';
    await Promise.all(Array.from({length:4},()=>send('import',input)));
    assert.equal(await Receipt.countDocuments(),1);assert.equal(await Novel.countDocuments(),1);
    assert.equal(await Mirror.countDocuments(),1);
    assert.equal((await Receipt.findOne()).content,'A complete original chapter.');
    assert.equal([...docs.values()][0].content,'A complete original chapter.');
    // Already translated text must not be overwritten by a scrape retry.
    [...docs.values()][0].content='النص المترجم المحفوظ';
    assert.equal((await send('import',input)).body.persisted,true);
    assert.equal([...docs.values()][0].content,'النص المترجم المحفوظ');
    failRead=true;assert.equal((await send('check',identity)).status,503);failRead=false;
    [...docs.values()][0].content='';
    assert.equal((await send('check',identity)).body.persisted,false);
    assert.equal((await send('import',input)).status,503);
    // Different sources with the same title cannot collide.
    input.sourceUrl='https://novelfire.net/different';
    assert.equal((await send('import',input)).body.persisted,true);
    assert.equal(await Novel.countDocuments(),2);
    const legacy=await Novel.create({title:'Existing private source',author:'Owner',status:'خاصة',
      sourceUrl:'https://novelfire.net/existing',chapters:[]});
    input.sourceUrl=legacy.sourceUrl;
    const adopted=await send('import',input);
    assert.equal(adopted.body.novelId,String(legacy._id));
    assert.equal(await Novel.countDocuments(),3);
    await Novel.create({title:'Ambiguous duplicate',author:'Owner',sourceUrl:legacy.sourceUrl});
    assert.equal((await send('import',input)).status,503);

  } finally {
    if(server)await new Promise(r=>server.close(r));
    await mongoose.connection.dropDatabase();await mongoose.disconnect();
    if(oldIngest===undefined)delete process.env.AUTOMATION_INGEST_SECRET;else process.env.AUTOMATION_INGEST_SECRET=oldIngest;
    if(old===undefined)delete process.env.SCRAPER_API_SECRET;else process.env.SCRAPER_API_SECRET=old;
  }
});
