'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('../backend/node_modules/mongoose');
const express=require('../backend/node_modules/express');
const S=require('../backend/services/durable/store');
const Novel=require('../backend/models/novel.model');
const Legacy=require('../backend/models/translationJob.model');
const Receipt=require('../backend/models/importChapter.model');
const uri=process.env.AUTOMATION_TEST_REPLICA_URI;

test('the real legacy resume route retains its ID and skips a translated chapter proven saved',{skip:!uri},async()=>{
 await mongoose.connect(uri,{dbName:'zeus_automation_legacy_resume_'+Date.now()});
 const previous=process.env.DURABLE_ENGINE_V2;
 const previousSecret=process.env.AUTOMATION_SECRET;
 process.env.DURABLE_ENGINE_V2='true';
 process.env.AUTOMATION_SECRET='fixture-coordinator';
 let server;
 try{
  const started=new Date(Date.now()-12*60*1000);
  const written=new Date(+started+60000);
  const earlier=new Date(+started-60000);
  const novel=await Novel.create({title:'Legacy novel',author:'Test',chapters:[{number:2,title:'الفصل 2',createdAt:earlier}]});
  const raw='这是一个原始章节。'.repeat(30);
  const translated='هذه ترجمة الفصل المخزنة، وفيها نص عربي كامل لا يتضمن كلمات أجنبية. '.repeat(8);
  await Receipt.create({_id:'test-raw',sourceUrl:'https://novelfire.net/legacy-resume',number:2,novelId:novel._id,title:'raw',content:raw,contentHash:S.hash(raw),persisted:true});
  const old=await Legacy.create({novelId:novel._id,status:'active',startTime:started,lastUpdate:started,updatedAt:written,
   targetChapters:[2,3,4],totalToTranslate:3,translatedCount:0,logs:[
    {type:'warning',message:'جلب محتوى الفصل 2',timestamp:started},
    {type:'success',message:'نجحت الترجمة والمراجعة باستخدام المزوّد',timestamp:written}
   ]});
  await Legacy.collection.updateOne({_id:old._id},{$set:{updatedAt:written}});
  const documents=new Map([['2',{content:translated,lastUpdated:earlier}]]);
  const firestore={collection:()=>({doc:()=>({collection:()=>({doc:number=>({
   number,get:async()=>({exists:documents.has(number),data:()=>documents.get(number)})
  })})})}),runTransaction:async fn=>fn({get:ref=>ref.get(),set:(ref,data)=>documents.set(ref.number,{...documents.get(ref.number),...data})})};
  let calls=0;
  const settings=async()=>({translationProviders:[{providerId:'fixture',selectedModel:'fixture',apiKeys:['synthetic-test-key']}]});
  const processor=require('../backend/services/durable/processor').createProcessor({
   firestore,source:async()=>raw,ai:{validateTranslatedChapter:()=>({ok:true,residues:[]})},
   route:async job=>({provider:{providerId:'fixture'},key:'fixture',model:'fixture',free:false,
    operatorAssigned:job.config.existingProvidersAuthorized,account:'fixture-translation-resume'}),
   provider:async prompt=>{
    calls++;
    if(prompt.includes('JSON array'))return '[]';
    const marker=prompt.match(/\[\[([a-f0-9]{12})_(\d{6})\]\]/);
    return `[[${marker[1]}_${marker[2]}]]\n${translated}\n[[END_${marker[1]}]]`;
   }
  });
  const app=express();app.use(express.json());
  require('../backend/routes/durableRoutes')(app,(_req,_res,next)=>next(),{
   identity:async req=>({admin:req.get('x-test-admin')==='true',id:'a'.repeat(24),email:'test@example.invalid'}),
   settings,firestore,processor
  });
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const root='http://127.0.0.1:'+server.address().port;
  const get=async path=>fetch(root+path,{headers:{'x-test-admin':'true'}});
  const oldView=await (await get('/api/translator/jobs/'+old.id)).json();
  assert.equal(oldView.status,'paused');
  const preview=async()=>(await (await get('/api/translator/jobs/'+old.id+'?resumePreview=1')).json()).resumePreview;
  assert.deepEqual(await preview(),{preservedChapter:2,nextChapter:3});
  await Receipt.deleteOne({_id:'test-raw'});
  assert.deepEqual(await preview(),{preservedChapter:null,nextChapter:2});
  documents.set('3',{content:raw});
  assert.deepEqual(await preview(),{preservedChapter:2,nextChapter:3});
  assert.equal((await Legacy.findById(old.id)).status,'active');
  const post=admin=>fetch(root+'/api/translator/start',{method:'POST',headers:{'content-type':'application/json','x-test-admin':String(admin)},body:JSON.stringify({jobId:old.id})});
  assert.equal((await post(false)).status,404);
  const response=await post(true);
  assert.equal(response.status,200);
  assert.equal((await response.json()).jobId,old.id);
  assert.equal((await post(true)).status,200);
  const current=await S.Job.findById(old.id);
  assert.deepEqual(current.chapters,[3,4]);
  assert.equal(current.config.priorCompleted,1);
  assert.equal((await Legacy.findById(old.id)).status,'paused');
  const resumedView=await (await get('/api/translator/jobs/'+old.id)).json();
  assert.equal(resumedView.totalToTranslate,3);
  assert.equal(resumedView.translatedCount,1);
  assert.equal(resumedView.currentChapter,2);
  assert.equal(resumedView.targetChapters[0],3);
  assert.equal(resumedView.novelMaxChapter,4);
  assert.equal(resumedView.engineVersion,2);
  const rows=await (await get('/api/translator/jobs')).json();
  assert.equal(rows.filter(row=>row.id===old.id).length,1);
  for(let i=0;i<35&&(await S.Job.findById(old.id)).status!=='completed';i++){
   await S.Job.updateOne({_id:old.id},{$set:{nextRunAt:new Date(0)}});
   const step=await fetch(root+'/api/automation/worker/step',{method:'POST',headers:{'x-automation-secret':'fixture-coordinator'}});
   assert.equal(step.status,200);
   assert.notEqual((await step.json()).ok,false);
  }
  const finished=await (await get('/api/translator/jobs/'+old.id)).json();
  assert.equal(finished.status,'completed');
  assert.equal(finished.translatedCount,3);
  assert.equal(finished.targetChapters.length,0);
  assert.equal(calls,4);
  assert.equal(documents.get('2').content,translated);
  assert.equal(documents.get('3').content.trim(),translated.trim());
  assert.equal(documents.get('4').content.trim(),translated.trim());
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(previous===undefined)delete process.env.DURABLE_ENGINE_V2;else process.env.DURABLE_ENGINE_V2=previous;
  if(previousSecret===undefined)delete process.env.AUTOMATION_SECRET;else process.env.AUTOMATION_SECRET=previousSecret;
  await mongoose.connection.dropDatabase();await mongoose.disconnect();
 }
});
