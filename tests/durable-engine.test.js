'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('../backend/node_modules/mongoose');
const S=require('../backend/services/durable/store');
const {createProcessor,parseTerms}=require('../backend/services/durable/processor');
const Novel=require('../backend/models/novel.model');
const Glossary=require('../backend/models/glossary.model');
const models=[S.Job,S.Task,S.Artifact,S.Call,S.Lock,S.Event,Novel,Glossary,require('../backend/models/durablePublication.model'),require('../backend/models/chapterContentMirror.model'),require('../backend/models/providerConversation.model')];
const uri=process.env.AUTOMATION_TEST_REPLICA_URI;
const {splitSource}=require('../backend/services/completeTranslation.service');
function fakeFirestore(){
 const docs=new Map();let down=false;
 return {docs,setDown:v=>down=v,
 collection:()=>({doc:novel=>({collection:()=>({doc:n=>{const key=novel+':'+n;return {key,get:async()=>{if(down)throw Error('unavailable');return {exists:docs.has(key),data:()=>docs.get(key)};}};}})})}),
 runTransaction:async fn=>{if(down)throw Error('unavailable');await fn({get:r=>r.get(),set:(r,data)=>docs.set(r.key,{...docs.get(r.key),...data})});}
 };
}
const arabic='هذه ترجمة عربية كاملة تروي أحداث الفصل وتحافظ على الحوار والوصف دون اختصار أو حذف أي شيء من الحكاية. '.repeat(8);
const original='The traveler entered the ancient city and met his companions. '.repeat(8);
const ai={validateTranslatedChapter:()=>({ok:true,residues:[]}),getTokenConversationScope:()=> 'scope'};
async function novel(){return Novel.create({title:'Isolated test novel',author:'Owner',status:'خاصة'});}
async function make(kind,n,chapters=[1],key){return (await S.createJob({payload:{kind,novelId:n._id,chapters},ownerId:'owner',novelKey:'novel:'+n.id,
 idempotencyKey:key,config:{providerId:'test',model:'test',chunkSize:2400},glossary:kind==='pure_translate'?[]:undefined})).job;}
function processor(db,extra={}){return createProcessor({firestore:db,ai,route:async()=>({provider:{providerId:'test'},model:'test',key:'test',free:true,account:'test-account'}),
 source:async()=>original,provider:async(prompt)=>{
  if(prompt.includes('JSON array'))return JSON.stringify([{term:'traveler',translation:'المسافر',category:'characters'}]);
  const marker=prompt.match(/\[\[([a-f0-9]{12})_(\d{6})\]\]/);
  return `[[${marker[1]}_${marker[2]}]]\n${arabic}\n[[END_${marker[1]}]]`;
 },...extra});}
async function run(p,j,max=100){for(let i=0;i<max;i++){const job=await S.Job.findById(j._id);if(['completed','blocked','failed','cancelled'].includes(job.status))return job;await S.Job.updateOne({_id:j._id},{$set:{nextRunAt:new Date(0)}});await p.tick();}throw Error('did not finish');}

test('strict terminology parsing distinguishes valid empty results from invalid replies',()=>{
 assert.deepEqual(parseTerms('[]'),[]);
 assert.throws(()=>parseTerms('{"unrelated":[]}'));
 assert.throws(()=>parseTerms('[{"term":"x"}]'));
});
test('durable engine with real replica-set transactions', {skip:!uri},async t=>{
 await mongoose.connect(uri,{dbName:'zeus_automation_v2_'+Date.now()});
 await Promise.all(models.map(m=>m.init()));
 try{
  await t.test('immutable target list, idempotent create and payload mismatch',async()=>{
   const n=await novel();const j=await make('pure_translate',n,[1,2],'same');
   const same=await make('pure_translate',n,[1,2],'same');assert.equal(same.id,j.id);
   await assert.rejects(()=>make('pure_translate',n,[1,3],'same'),/idempotency_conflict/);
   await S.transition(j.id,'cancel');
  });
  await t.test('pause retains in-flight fence, stale worker cannot commit; reclaim after expiry',async()=>{
   const n=await novel(),j=await make('pure_translate',n);
   const c=await S.claim(['pure_translate']);assert.equal(c.job.id,j.id);
   await S.transition(j.id,'pause');await S.heartbeat(c);
   await assert.rejects(()=>S.advance(c,{stage:'generate'}),/stale_lease/);
   await S.transition(j.id,'resume');assert.equal(await S.claim(['pure_translate']),null);
   await S.Job.updateOne({_id:j._id},{$set:{leaseUntil:new Date(0)}});await S.release(c);
   const fresh=await S.claim(['pure_translate']);assert.ok(fresh.fence>c.fence);
   await assert.rejects(()=>S.advance(c,{stage:'generate'}),/stale_lease/);
   await S.transition(j.id,'cancel');await S.release(fresh);
  });
  await t.test('smart chapters persist translation, terms and verified projection in order',async()=>{
   const n=await novel(),j=await make('smart_translate',n,[1,2]),db=fakeFirestore(),p=processor(db);
   const done=await run(p,j);assert.equal(done.status,'completed');assert.equal(done.successCount,2);
   assert.equal(await S.Task.countDocuments({jobId:j._id,state:'verified'}),2);
   assert.equal(await Glossary.countDocuments({novelId:n._id}),1);
   assert.equal(db.docs.size,2);
   assert.deepEqual((await S.Task.find({jobId:j._id}).sort({ordinal:1})).map(x=>x.ordinal),[0,1]);
  });
  await t.test('pure translation never writes glossary, and missing source cannot complete',async()=>{
   const n=await novel();await Glossary.create({novelId:n._id,term:'fixed',translation:'ثابت'});
   const before=await Glossary.find({novelId:n._id}).lean();const j=await make('pure_translate',n);
   assert.equal((await run(processor(fakeFirestore()),j)).status,'completed');
   const after=await Glossary.find({novelId:n._id}).lean();assert.deepEqual(after,before);
   const n2=await novel(),missing=await make('pure_translate',n2);
   const blocked=await run(processor(fakeFirestore(),{source:async()=>null}),missing);
   assert.equal(blocked.status,'blocked');assert.equal(blocked.successCount,0);assert.equal(blocked.blockedCode,'source_missing');
   await S.transition(missing.id,'cancel');
  });
  await t.test('Firestore outage resumes publication without paying for another translation',async()=>{
   const n=await novel(),j=await make('pure_translate',n),db=fakeFirestore();let calls=0;
   const p=processor(db,{provider:async prompt=>{calls++;const m=prompt.match(/\[\[([a-f0-9]{12})_(\d{6})\]\]/);return `[[${m[1]}_${m[2]}]]\n${arabic}\n[[END_${m[1]}]]`;}});
   db.setDown(true);
   for(let i=0;i<7;i++){await S.Job.updateOne({_id:j._id},{$set:{nextRunAt:new Date(0)}});await p.tick();}
   assert.equal((await S.Job.findById(j._id)).successCount,0);assert.equal(calls,1);
   db.setDown(false);assert.equal((await run(p,j)).status,'completed');assert.equal(calls,1);
  });
  await t.test('saved AI reply survives a worker crash before stage commit',async()=>{
   const n=await novel(),j=await make('pure_translate',n),db=fakeFirestore();let calls=0;
   const p=processor(db,{provider:async prompt=>{calls++;const m=prompt.match(/\[\[([a-f0-9]{12})_(\d{6})\]\]/);return `[[${m[1]}_${m[2]}]]\n${arabic}\n[[END_${m[1]}]]`;}});
   await p.tick(); // source
   const c=await S.claim(['pure_translate']);
   const advance=S.advance;S.advance=async()=>{throw Error('synthetic crash after reply checkpoint');};
   try{await assert.rejects(()=>p.step(c));}finally{S.advance=advance;}
   await S.Job.updateOne({_id:j._id},{$set:{leaseUntil:new Date(0)}});await S.release(c);
   const withoutCredentials=processor(db,{route:async()=>{throw Error('credential no longer available');},provider:async()=>{throw Error('must not generate again');}});
   assert.equal((await run(withoutCredentials,j)).status,'completed');assert.equal(calls,1);
  });
  await t.test('invalid extraction stays pending and does not publish a smart chapter',async()=>{
   const n=await novel(),j=await make('glossary_extract',n),db=fakeFirestore();
   const blocked=await run(processor(db,{provider:async()=>'{invalid'}),j);
   assert.equal(blocked.status,'blocked');assert.equal(blocked.successCount,0);assert.equal(db.docs.size,0);
   assert.equal(await Glossary.countDocuments({novelId:n._id}),0);await S.transition(j.id,'cancel');
  });
  await t.test('unknown AI outcome retries only once and then blocks',async()=>{
   const n=await novel(),j=await make('pure_translate',n);let calls=0;
   const p=processor(fakeFirestore(),{provider:async()=>{calls++;throw Error('connection lost after request');}});
   const blocked=await run(p,j);assert.equal(calls,2);assert.equal(blocked.status,'blocked');
   assert.equal(blocked.blockedCode,'ambiguous_retry_exhausted');await S.transition(j.id,'cancel');
  });
  await t.test('no budget approval means no provider request',async()=>{
   const n=await novel(),j=await make('pure_translate',n);let calls=0;
   const p=processor(fakeFirestore(),{route:async()=>({free:false}),provider:async()=>{calls++;return ''}});
   const blocked=await run(p,j);assert.equal(calls,0);assert.equal(blocked.blockedCode,'budget_approval_required');await S.transition(j.id,'cancel');
  });
  await t.test('confirmed authentication failure switches provider without repeating a saved result',async()=>{
   const n=await novel(),j=await make('pure_translate',n);
   await S.Job.updateOne({_id:j._id},{$set:{'config.routes':[{providerId:'first',model:'test'},{providerId:'second',model:'test'}]}});
   const old=process.env.AUTOMATION_FREE_PROVIDER_IDS;process.env.AUTOMATION_FREE_PROVIDER_IDS='first,second';
   const used=[];
   const providers=[{providerId:'first',apiKeys:['test-first']},{providerId:'second',apiKeys:['test-second']}];
   const p=createProcessor({firestore:fakeFirestore(),source:async()=>original,
    ai:{...ai,getGlobalSettings:async()=>({translationProviders:providers}),getProviderAuthKeys:p=>p.apiKeys,isQwenProvider:()=>false,isGeminiWebProvider:()=>false},
    provider:async(prompt,r)=>{used.push(r.provider.providerId);if(r.provider.providerId==='first')throw Object.assign(Error('denied'),{response:{status:401}});
     const m=prompt.match(/\[\[([a-f0-9]{12})_(\d{6})\]\]/);return `[[${m[1]}_${m[2]}]]\n${arabic}\n[[END_${m[1]}]]`;}});
   try{const done=await run(p,j);assert.equal(done.status,'completed');assert.deepEqual(used,['first','second']);
    assert.equal(done.config.routeIndex,1);assert.ok(!JSON.stringify(done.config).includes('test-first'));
   }finally{if(old===undefined)delete process.env.AUTOMATION_FREE_PROVIDER_IDS;else process.env.AUTOMATION_FREE_PROVIDER_IDS=old;}
  });

  await t.test('Qwen account setup is handed to an opted-in long worker without HTTP signup loops',async()=>{
   const n=await novel(),j=await make('pure_translate',n);
   await S.Job.updateOne({_id:j._id},{$set:{'config.providerId':'qwen'}});
   const oldFree=process.env.AUTOMATION_FREE_PROVIDER_IDS,oldSetup=process.env.AUTOMATION_QWEN_ACCOUNT_SETUP;
   process.env.AUTOMATION_FREE_PROVIDER_IDS='qwen';process.env.AUTOMATION_QWEN_ACCOUNT_SETUP='true';
   const provider={providerId:'qwen',apiKeys:[]};let setups=0;
   const deps={firestore:fakeFirestore(),source:async()=>original,
    ai:{...ai,getGlobalSettings:async()=>({translationProviders:[provider]}),getProviderAuthKeys:p=>p.apiKeys,isQwenProvider:()=>true,isGeminiWebProvider:()=>false},
    accountSetup:async id=>{assert.equal(id,'qwen');setups++;provider.apiKeys=['synthetic-provisioned-token'];},
    provider:async prompt=>{const m=prompt.match(/\[\[([a-f0-9]{12})_(\d{6})\]\]/);return `[[${m[1]}_${m[2]}]]\n${arabic}\n[[END_${m[1]}]]`;}};
   try{
    const short=createProcessor(deps);await short.tick();await short.tick();
    assert.equal((await S.Job.findById(j._id)).workerClass,'long');assert.equal((await short.tick()).idle,true);assert.equal(setups,0);
    const long=createProcessor({...deps,longWorker:true});assert.equal((await run(long,j)).status,'completed');assert.equal(setups,1);
   }finally{if(oldFree===undefined)delete process.env.AUTOMATION_FREE_PROVIDER_IDS;else process.env.AUTOMATION_FREE_PROVIDER_IDS=oldFree;
    if(oldSetup===undefined)delete process.env.AUTOMATION_QWEN_ACCOUNT_SETUP;else process.env.AUTOMATION_QWEN_ACCOUNT_SETUP=oldSetup;}
  });

  await t.test('a real child process dies after AI checkpoint and another process resumes without another request',async()=>{
   const n=await novel(),j=await make('pure_translate',n),db=fakeFirestore();let calls=0;
   const p=processor(db,{provider:async()=>{calls++;throw Error('must reuse the saved child reply');}});
   await p.tick();
   const {execFile}=require('node:child_process');
   await new Promise((resolve,reject)=>execFile(process.execPath,[require('node:path').join(__dirname,'support/crash-after-reply.js')],
    {env:{...process.env,AUTOMATION_TEST_REPLICA_URI:uri,ZEUS_TEST_DB:mongoose.connection.name}},err=>{if(err?.code===73)resolve();else reject(err||Error('worker did not crash'));}));
   await S.Job.updateOne({_id:j._id},{$set:{leaseUntil:new Date(0),nextRunAt:new Date(0)}});
   await S.Lock.updateMany({jobId:j._id},{$set:{until:new Date(0),token:''}});
   assert.equal((await run(p,j)).status,'completed');assert.equal(calls,0);
   assert.equal(await S.Call.countDocuments({jobId:j._id,state:'received'}),1);
  });

  await t.test('public chapter cache sees another worker publication through the shared mirror revision',async()=>{
   const n=await novel(),mirror=require('../backend/models/chapterContentMirror.model');
   const service=require('../backend/services/chapterMirror.service');let text='Original',reads=0;
   const db={collection:()=>({doc:()=>({collection:()=>({doc:()=>({get:async()=>{reads++;return {exists:true,data:()=>({content:text})};}})})})})};
   assert.equal(await service.fetchChapterContent(db,n.id,1),'Original');
   for(let i=0;i<100&&!await mirror.exists({novelId:n.id,number:1});i++)await new Promise(r=>setTimeout(r,2));
   text='Published by a different worker';
   await mirror.updateOne({novelId:n.id,number:1},{$set:{content:text,updatedAt:new Date(Date.now()+10)}});
   assert.equal(await service.fetchChapterContent(db,n.id,1),text);assert.equal(reads,2);
  });

 }finally{await mongoose.connection.dropDatabase();await mongoose.disconnect();}
});
