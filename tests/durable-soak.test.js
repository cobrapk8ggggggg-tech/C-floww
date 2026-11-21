'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('../backend/node_modules/mongoose');
const S=require('../backend/services/durable/store');
const {createProcessor}=require('../backend/services/durable/processor');
const Novel=require('../backend/models/novel.model');
const {fakeFirestore}=require('./support/durable-fixtures');
const uri=process.env.AUTOMATION_TEST_REPLICA_URI;
const count=Math.max(1,Math.min(1800,Number(process.env.ZEUS_SYNTHETIC_CHAPTERS||50)));
test(`${count} synthetic pure chapters checkpoint across fresh processor instances`,{skip:!uri,timeout:600000},async()=>{
 await mongoose.connect(uri,{dbName:'zeus_automation_soak_'+Date.now()});
 const started=Date.now(),cpu=process.cpuUsage();let calls=0,steps=0;
 try{
  const n=await Novel.create({title:'Synthetic resilience run',author:'Test',status:'خاصة'});
  await Promise.all([S.Job,S.Task].map(m=>m.init()));
  const j=(await S.createJob({payload:{kind:'pure_translate',novelId:n._id,chapters:Array.from({length:count},(_,i)=>i+1)},ownerId:'test',novelKey:'novel:'+n.id,config:{providerId:'synthetic',model:'fixture'},glossary:[]})).job;
  const db=fakeFirestore();
  const deps={firestore:db,source:async()=> 'The traveler entered a quiet city and met his companions. '.repeat(8),
   ai:{validateTranslatedChapter:()=>({ok:true,residues:[]})},
   route:async()=>({provider:{providerId:'synthetic'},model:'fixture',free:true,account:'synthetic'}),
   provider:async prompt=>{calls++;const m=prompt.match(/\[\[([a-f0-9]{12})_(\d{6})\]\]/);return `[[${m[1]}_${m[2]}]]\n${'هذه ترجمة كاملة لأحداث الفصل دون حذف أو اختصار. '.repeat(20)}\n[[END_${m[1]}]]`;}};
  let p=createProcessor(deps);
  for(;steps<count*9;steps++){
   if(steps%17===0)p=createProcessor(deps); // No process-local state is required.
   const r=await p.tick(['pure_translate']);assert.equal(r.ok,true,JSON.stringify(r));
   if(r.completed)break;
  }
  const saved=await S.Job.findById(j._id);
  assert.equal(saved.status,'completed');assert.equal(saved.successCount,count);
  assert.equal(await S.Task.countDocuments({jobId:j._id,state:'verified'}),count);assert.equal(db.docs.size,count);assert.equal(calls,count);
  console.log(JSON.stringify({synthetic:true,chapters:count,verified:saved.successCount,providerCalls:calls,steps:steps+1,
   durationMs:Date.now()-started,cpu:process.cpuUsage(cpu),rssBytes:process.memoryUsage().rss}));
 }finally{await mongoose.connection.dropDatabase();await mongoose.disconnect();}
});
