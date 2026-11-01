'use strict';
const crypto=require('node:crypto');
const mongoose=require('mongoose');
const Job=require('../../models/automationJob.model');
const Task=require('../../models/durableTask.model');
const Artifact=require('../../models/durableArtifact.model');
const Call=require('../../models/durableCall.model');
const Lock=require('../../models/durableLock.model');
const Event=require('../../models/durableEvent.model');
const LEASE_MS=120000;
class StaleLease extends Error{constructor(){super('stale_lease');this.code='stale_lease';}}
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
async function transaction(fn){const session=await mongoose.startSession();try{return await session.withTransaction(()=>fn(session),{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary',timeoutMS:20000,maxCommitTimeMS:10000});}finally{await session.endSession();}}
function owned(c){return {_id:c.job._id,engineVersion:2,status:'running',leaseToken:c.token,fence:c.fence,leaseUntil:{$gt:new Date()}};}
async function assertOwned(c,session){if(!await Job.exists(owned(c)).session(session||null))throw new StaleLease();}
async function immutable(id,text,meta={},session){
 if(Buffer.byteLength(text)>950000)throw Object.assign(Error('artifact_too_large'),{code:'artifact_too_large',blocked:true});
 await Artifact.updateOne({_id:id},{$setOnInsert:{text,hash:hash(text),...meta}},{upsert:true,session});
 const a=await Artifact.findById(id).session(session||null);
 if(a.hash!==hash(text))throw Object.assign(Error('artifact_conflict'),{blocked:true,code:'artifact_conflict'});
 return a;
}
async function createJob(input){
 const requestHash=input.requestFingerprint||hash(input.payload);
 const requestKey=input.idempotencyKey?hash(input.ownerId+':'+input.idempotencyKey):undefined;
 if(requestKey){const old=await Job.findOne({requestKey});if(old){if(old.requestHash!==requestHash)throw Object.assign(Error('idempotency_conflict'),{status:409});return {job:old,created:false};}}
 try{return await transaction(async session=>{
  const [job]=await Job.create([{...input.payload,engineVersion:2,ownerId:input.ownerId,requestKey,requestHash,
   novelKey:input.novelKey,...(input.payload.kind==='scrape'?{sourceKey:hash(input.payload.sourceUrl)}:{}),config:input.config,status:'queued'}],{session});
  await Task.insertMany(job.chapters.map((number,ordinal)=>({jobId:job._id,number,ordinal})),{session});
  if(input.glossary!==undefined)await immutable(job.id+':glossary',JSON.stringify(input.glossary),{jobId:job._id,kind:'glossary_snapshot'},session);
  return {job,created:true};
 });}catch(e){if(e.code===11000){if(requestKey){const j=await Job.findOne({requestKey});if(j&&j.requestHash===requestHash)return {job:j,created:false};}throw Object.assign(Error('novel_busy_or_idempotency_conflict'),{status:409});}throw e;}
}
async function claim(kinds,{longWorker=false}={}){
 await Lock.bulkWrite(['global:0','global:1','ai:0'].map(_id=>({updateOne:{filter:{_id},update:{$setOnInsert:{until:new Date(0)}},upsert:true}})));
 const started=Date.now();
 const candidates=await Job.find({engineVersion:2,...(longWorker?{}:{workerClass:{$ne:'long'}}),kind:{$in:kinds},status:{$in:['queued','running','retry_wait']},
  nextRunAt:{$lte:new Date()},leaseUntil:{$lte:new Date()}}).sort({nextRunAt:1,createdAt:1}).limit(50);
 for(const candidate of candidates){
  if(Date.now()-started>10000)break;
  try{const c=await transaction(async session=>{
   const now=new Date(),token=crypto.randomUUID(),until=new Date(Date.now()+LEASE_MS);
   const job=await Job.findOneAndUpdate({_id:candidate._id,status:{$in:['queued','running','retry_wait']},leaseUntil:{$lte:now},nextRunAt:{$lte:now}},
    {$set:{status:'running',leaseToken:token,leaseUntil:until},$inc:{fence:1}},{new:true,session});
   if(!job)return null;
   const global=await Lock.findOneAndUpdate({_id:{$in:['global:0','global:1']},until:{$lte:now}},{$set:{token,jobId:job._id,until},$inc:{fence:1}},{new:true,session});
   if(!global)throw Error('busy');
   if(job.kind!=='scrape'){
    const ai=await Lock.findOneAndUpdate({_id:'ai:0',until:{$lte:now}},{$set:{token,jobId:job._id,until},$inc:{fence:1}},{new:true,session});
    if(!ai)throw Error('busy');
   }
   const task=await Task.findOne({jobId:job._id,state:'pending'}).sort({ordinal:1}).session(session);
   return {job,task,token,fence:job.fence};
  });if(c)return c;}catch(e){if(e.message!=='busy')throw e;}
 }
 return null;
}
async function heartbeat(c){return transaction(async session=>{
 const until=new Date(Date.now()+LEASE_MS);
 const r=await Job.updateOne({...owned(c),status:{$in:['running','queued','paused','cancelled']}},{$set:{leaseUntil:until}},{session});
 if(r.modifiedCount!==1)throw new StaleLease();
 await Lock.updateMany({token:c.token,until:{$gt:new Date()}},{$set:{until}},{session});
});}
async function resource(c,key){return transaction(async session=>{
 await assertOwned(c,session);
 try{await Lock.findOneAndUpdate({_id:key,$or:[{until:{$lte:new Date()}},{token:c.token}]},
  {$set:{token:c.token,jobId:c.job._id,until:new Date(Date.now()+LEASE_MS)},$inc:{fence:1}},{upsert:true,session,new:true});}
 catch(e){if(e.code===11000)throw Object.assign(Error('resource_busy'),{code:'resource_busy'});throw e;}
});}
async function advance(c,patch={},artifacts=[],sideEffect){return transaction(async session=>{
 await assertOwned(c,session);
 if(!c.task)throw Error('missing_task');
 for(const a of artifacts)await immutable(a.id,a.text,{jobId:c.job._id,taskId:c.task._id,kind:a.kind},session);
 if(sideEffect)await sideEffect(session);
 await Task.updateOne({_id:c.task._id,jobId:c.job._id},{$set:patch},{session});
 const done=await Task.countDocuments({jobId:c.job._id,state:'verified'}).session(session);
 const total=await Task.countDocuments({jobId:c.job._id}).session(session);
 let completed=done===c.job.chapters.length&&total===done;
 if(completed){
  const numbers=(await Task.find({jobId:c.job._id}).select('number').session(session)).map(t=>t.number).sort((a,b)=>a-b);
  if(numbers.some((n,i)=>n!==c.job.chapters[i]))throw Object.assign(Error('manifest_mismatch'),{code:'manifest_mismatch',blocked:true});
 }
 const committed=await Job.updateOne(owned(c),{$set:{successCount:done,cursor:done,status:completed?'completed':'queued',
  attempts:0,lastError:'',leaseToken:'',leaseUntil:new Date(0),nextRunAt:new Date(),...(completed?{finishedAt:new Date()}: {})},
  ...(completed?{$unset:{novelKey:1,sourceKey:1}}:{})},{session});
 if(committed.modifiedCount!==1)throw new StaleLease();
 await Event.create([{jobId:c.job._id,chapter:c.task.number,stage:c.task.stage,code:completed?'completed':'stage_committed'}],{session});
 return {completed};
});}
async function settle(c,code,{blocked=false,delayMs=30000,rotate}={}){return transaction(async session=>{
 await assertOwned(c,session);
 await Job.updateOne(owned(c),{$set:{status:blocked?'blocked':'retry_wait',blockedCode:blocked?code:'',lastError:code,
  nextRunAt:new Date(Date.now()+delayMs),leaseToken:'',leaseUntil:new Date(0),...(rotate?{'config.routeIndex':rotate.routeIndex,'config.keyIndex':rotate.keyIndex}:{})},$inc:{attempts:1,retryCount:1}},{session});
 if(blocked&&c.task)await Task.updateOne({_id:c.task._id},{$set:{code}},{session});
 await Event.create([{jobId:c.job._id,chapter:c.task?.number,stage:c.task?.stage,code,type:blocked?'error':'warning'}],{session});
});}
async function release(c){
 const cooldown=c.cooldown||{key:'',until:new Date(0)};
 await Lock.updateMany({token:c.token},[{$set:{token:'',until:{$cond:[{$eq:['$_id',cooldown.key]},cooldown.until,
  {$cond:[{$regexMatch:{input:'$_id',regex:'^source:'}},new Date(Date.now()+5000),new Date()]}]}}}]);
}
async function transition(id,action,scope={}){
 const states=action==='resume'?['paused','blocked','failed']:['queued','running','retry_wait','paused','blocked','failed'];
 const status=action==='resume'?'queued':action==='pause'?'paused':'cancelled';
 return transaction(async session=>{
  const job=await Job.findOneAndUpdate({_id:id,engineVersion:2,...scope,status:{$in:states}},
   {$set:{status,nextRunAt:new Date(),blockedCode:''},...(action==='cancel'?{$unset:{novelKey:1,sourceKey:1}}:{})},{new:false,session});
  if(!job)return null;
  if(action==='resume'&&['translation_quality_failed','translation_residues','glossary_quality_failed'].includes(job.blockedCode)){
   await Task.updateOne({jobId:job._id,state:'pending'},{$inc:{generation:1},$set:{repair:0,stage:job.kind==='glossary_extract'?'extract':job.blockedCode==='glossary_quality_failed'?'extract':'generate'}},{session});
  }
  return Job.findById(id).session(session);
 });
}

module.exports={Job,Task,Artifact,Call,Lock,Event,hash,transaction,immutable,createJob,claim,owned,assertOwned,heartbeat,resource,advance,settle,release,transition,StaleLease};
