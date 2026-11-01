'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('../backend/node_modules/mongoose');
const admin=require('../backend/node_modules/firebase-admin');
const initializeApp=(...args)=>admin.initializeApp(...args);
const deleteApp=app=>app.delete();
const getFirestore=app=>admin.firestore(app);
const express=require('../backend/node_modules/express');
const S=require('../backend/services/durable/store');
const {createProcessor}=require('../backend/services/durable/processor');
const Novel=require('../backend/models/novel.model');
const Receipt=require('../backend/models/importChapter.model');
const Glossary=require('../backend/models/glossary.model');
const uri=process.env.AUTOMATION_TEST_REPLICA_URI,host=process.env.FIRESTORE_EMULATOR_HOST;
const enabled=uri&&/^127\.0\.0\.1:\d+$/.test(host||'');
test('real Firestore emulator and MongoDB: import/readback, smart publish and restart without another AI call', {skip:!enabled,timeout:60000},async()=>{
 const project='demo-zeus-automation',app=initializeApp({projectId:project},'isolated-'+Date.now());
 const db=getFirestore(app);
 await mongoose.connect(uri,{dbName:'zeus_automation_emulator_'+Date.now()});
 let server,wire;
 const oldFree=process.env.AUTOMATION_FREE_PROVIDER_IDS;process.env.AUTOMATION_FREE_PROVIDER_IDS='test';
 const oldIngest=process.env.AUTOMATION_INGEST_SECRET;process.env.AUTOMATION_INGEST_SECRET='isolated-ingest-test';
 const secret=process.env.SCRAPER_API_SECRET;process.env.SCRAPER_API_SECRET='test-private-import';
 let novelId;
 try{
  const http=express();http.use(express.json());require('../backend/routes/automationImportRoutes')(http,{firestore:db});
  server=http.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const source='https://novelfire.net/isolated-'+Date.now();
  const post=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/automation/chapters/${path}`,{
   method:'POST',headers:{'content-type':'application/json',authorization:process.env.SCRAPER_API_SECRET,'x-automation-ingest-secret':process.env.AUTOMATION_INGEST_SECRET},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
  const content='The traveler entered the ancient city and greeted his companions. '.repeat(8);
  const input={sourceUrl:source,novelData:{title:'Isolated public-domain-style test'},chapter:{number:1,title:'First',content}};
  const saved=await post('import',input);novelId=saved.novelId;
  assert.equal(saved.persisted,true);assert.equal((await post('check',{sourceUrl:source,chapterNumber:1})).persisted,true);
  await post('import',input);assert.equal(await Receipt.countDocuments(),1);
  const novel=await Novel.findById(novelId);
  const j=(await S.createJob({payload:{kind:'smart_translate',novelId:novel._id,chapters:[1]},ownerId:'test',novelKey:'novel:'+novelId,config:{providerId:'test',model:'test'}})).job;
  let calls=0;
  wire=require('node:http').createServer((req,res)=>{
   let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
    calls++;const prompt=JSON.parse(raw).messages[0].content;
    let answer;
    if(prompt.includes('JSON array'))answer='[{"term":"traveler","translation":"المسافر","category":"characters"}]';
    else{const marker=prompt.match(/\[\[([a-f0-9]{12})_(\d{6})\]\]/);
     answer=`[[${marker[1]}_${marker[2]}]]\n${'دخل المسافر المدينة القديمة وحيّا أصدقاءه ثم تابع رحلته وحافظ على وعده ومضى في طريقه. '.repeat(8)}\n[[END_${marker[1]}]]`;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:answer}}]}));
   });
  });
  wire.listen(0,'127.0.0.1');await new Promise(r=>wire.once('listening',r));
  const configured={translationProviders:[{providerId:'test',baseUrl:'http://127.0.0.1:'+wire.address().port,apiKeys:['synthetic-wire-key']}]};
  const realAi=require('../backend/routes/translatorRoutes')._ai;
  const p=createProcessor({firestore:db,ai:{...realAi,getGlobalSettings:async()=>configured}});
  for(let i=0;i<30;i++){
   const fresh=await S.Job.findById(j._id);if(fresh.status==='completed')break;
   assert.notEqual(fresh.status,'blocked',fresh.lastError);await p.tick();
  }
  assert.equal((await S.Job.findById(j._id)).status,'completed');assert.equal(calls,2);
  assert.equal(await Glossary.countDocuments({novelId:novel._id}),1);
  const ref=db.collection('novels').doc(novelId).collection('chapters').doc('1');
  const snap=await ref.get();assert.equal(S.hash(snap.data().content),snap.data().automationHash);
  assert.equal(snap.data().automationVersion,1);
  // A scraper retry after translation cannot overwrite the published Arabic text.
  await post('import',input);assert.equal((await ref.get()).data().automationHash,snap.data().automationHash);
 }finally{
  if(server)await new Promise(r=>server.close(r));
  if(wire)await new Promise(r=>wire.close(r));
  if(novelId)await db.recursiveDelete(db.collection('novels').doc(novelId));
  await db.terminate();await deleteApp(app);
  await mongoose.connection.dropDatabase();await mongoose.disconnect();
  if(oldFree===undefined)delete process.env.AUTOMATION_FREE_PROVIDER_IDS;else process.env.AUTOMATION_FREE_PROVIDER_IDS=oldFree;
  if(oldIngest===undefined)delete process.env.AUTOMATION_INGEST_SECRET;else process.env.AUTOMATION_INGEST_SECRET=oldIngest;
  if(secret===undefined)delete process.env.SCRAPER_API_SECRET;else process.env.SCRAPER_API_SECRET=secret;
 }
});
