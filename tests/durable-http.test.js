'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('../backend/node_modules/mongoose');
const express=require('../backend/node_modules/express');
const S=require('../backend/services/durable/store');
const Novel=require('../backend/models/novel.model');
const {Catalog,CatalogChapter}=require('../backend/models/automationCatalog.model');
const uri=process.env.AUTOMATION_TEST_REPLICA_URI;
test('durable HTTP authorization, idempotency, catalogue snapshot and queue budget', {skip:!uri},async()=>{
 await mongoose.connect(uri,{dbName:'zeus_automation_http_'+Date.now()});
 await Promise.all([S.Job,S.Task,Novel,Catalog,CatalogChapter].map(m=>m.init()));
 const old={DURABLE_ENGINE_V2:process.env.DURABLE_ENGINE_V2,AUTOMATION_SECRET:process.env.AUTOMATION_SECRET,SCRAPER_API_SECRET:process.env.SCRAPER_API_SECRET,AUTOMATION_INGEST_SECRET:process.env.AUTOMATION_INGEST_SECRET,AUTOMATION_QUEUE_DAILY_BUDGET:process.env.AUTOMATION_QUEUE_DAILY_BUDGET};
 Object.assign(process.env,{DURABLE_ENGINE_V2:'true',AUTOMATION_SECRET:'test-coordinator',SCRAPER_API_SECRET:'test-scraper',AUTOMATION_INGEST_SECRET:'test-ingest',AUTOMATION_QUEUE_DAILY_BUDGET:'3'});
 let server;
 try{
  const app=express();app.use(express.json());
  const identity=async req=>({id:req.get('x-test-owner')||'owner-a',admin:req.get('x-test-admin')==='true',email:'test@example.invalid'});
  require('../backend/routes/durableRoutes')(app,(_req,_res,next)=>next(),{identity});
  require('../backend/routes/automationCatalogRoutes')(app);
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const send=async(path,body,headers={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});let data;try{data=await r.json();}catch{}return {status:r.status,data};};
  const input={kind:'scrape',sourceUrl:'https://novelfire.net/test',startChapter:1,endChapter:3};
  const first=await send('/api/automation/jobs',input,{'idempotency-key':'same'});assert.equal(first.status,201);
  const id=first.data.id;
  await Novel.create({title:'Imported after enqueue',author:'Owner',sourceUrl:input.sourceUrl});
  assert.equal((await send('/api/automation/jobs',input,{'idempotency-key':'same'})).data.id,id);
  assert.equal((await send('/api/automation/jobs',{...input,endChapter:4},{'idempotency-key':'same'})).status,409);
  assert.equal((await send('/api/automation/jobs/'+id,undefined,{'x-test-owner':'owner-b'})).status,404);
  assert.equal((await send('/api/automation/jobs/'+id+'/pause',{}, {'x-test-owner':'owner-b'})).status,404);
  assert.equal((await send('/api/automation/jobs/'+id+'/chapters')).data.length,3);
  const listed=(await send('/api/automation/jobs')).data;assert.equal(listed.length,1);assert.equal(listed[0].config,undefined);
  const unauthorized=await send('/api/automation/worker/step',{});assert.equal(unauthorized.status,401);
  const internal={'x-automation-secret':'test-coordinator'};
  assert.deepEqual((await send('/api/automation/worker/ready',{},internal)).data.kinds,['v2']);
  assert.equal((await send('/api/automation/worker/queue-permit',{cost:3},internal)).data.allowed,true);
  assert.equal((await send('/api/automation/worker/queue-permit',{cost:1},internal)).data.allowed,false);
  assert.equal((await send('/api/automation/worker/queue-permit',{cost:0},internal)).status,400);
  const cat={sourceUrl:input.sourceUrl,jobId:id,metadata:{title:'Test'},total:2};
  const auth={authorization:'test-scraper','x-automation-ingest-secret':'test-ingest'};
  assert.equal((await send('/api/automation/catalog/save',{...cat,chapters:[{number:1,title:'First',url:'https://novelfire.net/1'}]},auth)).data.ready,false);
  assert.equal((await send('/api/automation/catalog/check',{...cat,chapterNumber:1},auth)).data.ready,false);
  assert.equal((await send('/api/automation/catalog/save',{...cat,chapters:[{number:2,title:'Second',url:'https://novelfire.net/2'}]},auth)).data.ready,true);
  const cached=(await send('/api/automation/catalog/check',{...cat,chapterNumber:2},auth)).data;
  assert.equal(cached.chapter.number,2);assert.equal(cached.metadata.title,'Test');
  assert.equal((await send('/api/automation/catalog/save',{...cat,total:3,chapters:[]},auth)).status,409);
  await send('/api/automation/jobs/'+id+'/cancel',{});
  assert.deepEqual((await send('/api/automation/worker/ready',{},internal)).data.kinds,[]);
 }finally{
  if(server)await new Promise(r=>server.close(r));
  await mongoose.connection.dropDatabase();await mongoose.disconnect();
  for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
});
