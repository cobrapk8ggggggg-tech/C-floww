'use strict';
const S=require('../services/durable/store');
const {createProcessor}=require('../services/durable/processor');
const Novel=require('../models/novel.model');
const User=require('../models/user.model');
const Glossary=require('../models/glossary.model');
const {chapterNumbers,sourceUrl,validCoordinatorSecret}=require('./automationRoutes').__test;
const KINDS=['scrape','smart_translate','pure_translate','glossary_extract'];
const idOK=v=>typeof v==='string'&&/^[a-f\d]{24}$/i.test(v);
function providerSignature(p){return S.hash({providerId:p.providerId,baseUrl:p.baseUrl||'',selectedModel:p.selectedModel,
 taskConversations:typeof p.toObject==='function'?p.toObject({flattenMaps:true}).taskConversations:p.taskConversations,
 thinkingEnabled:p.thinkingEnabled,searchEnabled:p.searchEnabled,deepSeekModelType:p.deepSeekModelType});}
function view(j){return {id:j.id,jobId:j.id,title:j.label||j.sourceUrl||'',novelId:j.novelId,sourceUrl:j.sourceUrl,kind:j.kind,status:j.status,total:j.chapters.length,completed:j.successCount,
 remaining:j.chapters.length-j.successCount,attempts:j.attempts,retries:j.retryCount,nextRunAt:j.nextRunAt,
 lastError:j.lastError,blockedCode:j.blockedCode,updatedAt:j.updatedAt,finishedAt:j.finishedAt,engineVersion:2,workerClass:j.workerClass};}
module.exports=function mount(app,verifyAdmin,deps={}){
 const enabled=()=>process.env.DURABLE_ENGINE_V2==='true';
 const processor=deps.processor||createProcessor();
 const identity=deps.identity||async function(req){
  if(!idOK(req.user?.id))throw Object.assign(Error('Unauthorized'),{status:401});
  const user=await User.findById(req.user.id).lean();
  if(!user||!['admin','contributor'].includes(user.role))throw Object.assign(Error('Forbidden'),{status:403});
  return {id:String(user._id),admin:user.role==='admin',email:user.email};
 };
 const scope=user=>user.admin?{}:{ownerId:user.id};
 const wrap=fn=>async(req,res,next)=>{try{await fn(req,res,next);}catch(e){res.status(e.status||503).json({error:e.status?e.message:'Durable operation unavailable'});}};
 async function create(body,user,key){
  const kind=body.kind||'scrape';if(!KINDS.includes(kind))throw Object.assign(Error('Invalid kind'),{status:400});
  const chapters=chapterNumbers(body);
  const sourceSelection=body.sourceSelection||'verified_original';
  if(!['verified_original','current_content'].includes(sourceSelection))throw Object.assign(Error('Invalid source selection'),{status:400});
  const payload={kind,chapters,sourceSelection,adminEmail:user.email||'system@auto'};
  if(key&&(!/^[\x21-\x7e]{1,128}$/.test(key)))throw Object.assign(Error('Invalid Idempotency-Key'),{status:400});
  const requestedSource=kind==='scrape'?sourceUrl(body.sourceUrl):undefined;
  const fingerprint=S.hash({kind,chapters,sourceSelection,...(kind==='scrape'?{sourceUrl:requestedSource}:{novelId:body.novelId})});
  if(key){const old=await S.Job.findOne({requestKey:S.hash(user.id+':'+key)});if(old){
   if(old.requestHash!==fingerprint)throw Object.assign(Error('idempotency_conflict'),{status:409});
   return {job:old,created:false};
  }}
  let novel;
  if(kind==='scrape'){
   payload.sourceUrl=sourceUrl(body.sourceUrl);
   novel=await Novel.findOne({sourceUrl:payload.sourceUrl});
  }else{
   if(!idOK(body.novelId))throw Object.assign(Error('Invalid novelId'),{status:400});
   novel=await Novel.findById(body.novelId);
   if(!novel)throw Object.assign(Error('Novel not found'),{status:404});
  }
  if(novel&&!user.admin&&String(novel.authorId)!==user.id)throw Object.assign(Error('Forbidden'),{status:403});
  payload.label=String(novel?.title||payload.sourceUrl||'').slice(0,300);
  if(novel)payload.novelId=novel._id;
  if(kind!=='scrape'&&novel?.sourceUrl&&await S.Job.exists({kind:'scrape',sourceUrl:novel.sourceUrl,status:{$nin:['completed','cancelled','failed']}}))throw Object.assign(Error('source_job_active'),{status:409});
  let config={},glossary;
  if(kind!=='scrape'){
   for(const name of ['translationJob','pureTranslationJob','glossaryExtractionJob']){
    if(await require('../models/'+name+'.model').exists({novelId:novel._id,status:'active'}))
     throw Object.assign(Error('legacy_job_active'),{status:409});
   }
   const settings=deps.settings?await deps.settings():await require('./translatorRoutes')._ai.getGlobalSettings();
   const ordered=(settings?.translationProviders||[]).slice().sort((a,b)=>(a.priority||0)-(b.priority||0));
   const provider=ordered[0];
   if(!provider)throw Object.assign(Error('provider_missing'),{status:400});
   config={providerId:provider.providerId,model:provider.selectedModel||provider.models?.[0]?.modelId,
    providerSignature:providerSignature(provider),routes:ordered.map(p=>({providerId:p.providerId,model:p.selectedModel||p.models?.[0]?.modelId,providerSignature:providerSignature(p)})),routeIndex:0,prompt:settings.customPrompt||'',extractPrompt:settings.extractPrompt||'',chunkSize:2400,keyIndex:0};
   if((process.env.AUTOMATION_LONG_PROVIDER_IDS||'').split(',').includes(provider.providerId))payload.workerClass='long';
   if(!config.model)throw Object.assign(Error('provider_model_missing'),{status:400});
   if(kind==='pure_translate')glossary=await Glossary.find({novelId:novel._id}).select('term translation -_id').lean();
  }
  const result=await S.createJob({payload,config,glossary,ownerId:user.id,idempotencyKey:key,requestFingerprint:fingerprint,
   novelKey:novel?'novel:'+novel.id:'source:'+S.hash(payload.sourceUrl)});
  const coordinator=process.env.AUTOMATION_COORDINATOR_URL;
  if(coordinator&&process.env.AUTOMATION_SECRET){
   try{const url=new URL('/wake',coordinator);if(url.protocol!=='https:')throw Error('HTTPS required');
    await fetch(url,{method:'POST',headers:{'x-automation-secret':process.env.AUTOMATION_SECRET},signal:AbortSignal.timeout(3000)});
   }catch{/* The MongoDB job remains discoverable by cron. */}
  }
  return result;
 }
 app.get('/api/automation/migration-report',verifyAdmin,wrap(async(req,res)=>{
  if(!(await identity(req)).admin)return res.sendStatus(403);
  res.json(await require('../services/durable/legacyState').report());
 }));
 app.post('/api/automation/jobs',verifyAdmin,wrap(async(req,res,next)=>{
  if(!enabled())return next();
  const key=req.get('idempotency-key');if(key&&(!/^[\x21-\x7e]{1,128}$/.test(key)))return res.status(400).json({error:'Invalid Idempotency-Key'});
  let result;try{result=await create(req.body||{},await identity(req),key);}catch(e){if(!e.status&&/Invalid|Provide/.test(e.message))e.status=400;throw e;}
  res.status(result.created?201:200).json(view(result.job));
 }));
 app.get('/api/automation/jobs',verifyAdmin,wrap(async(req,res,next)=>{
  if(!enabled())return next();const user=await identity(req);
  const q={engineVersion:2,...scope(user)};
  if(req.query.before){if(!idOK(req.query.before))return res.sendStatus(400);q._id={$lt:req.query.before};}
  const jobs=await S.Job.find(q).sort({_id:-1}).limit(50);res.json(jobs.map(view));
 }));
 app.get('/api/automation/jobs/:id',verifyAdmin,wrap(async(req,res,next)=>{
  if(!idOK(req.params.id))return res.sendStatus(400);
  const job=await S.Job.findOne({_id:req.params.id,engineVersion:2,...scope(await identity(req))});
  if(!job)return enabled()?res.sendStatus(404):next();
  const current=await S.Task.findOne({jobId:job._id,state:'pending'}).sort({ordinal:1});
  const failed=await S.Task.countDocuments({jobId:job._id,state:'failed'});
  res.json({...view(job),currentChapter:current?.number||null,stage:current?.stage||null,failed,
   blocked:job.status==='blocked'?1:0,ratePerMinute:job.successCount/Math.max(1/60,(Date.now()-job.createdAt)/60000)});
 }));
 for(const collection of ['chapters','events'])app.get(`/api/automation/jobs/:id/${collection}`,verifyAdmin,wrap(async(req,res)=>{
  if(!idOK(req.params.id))return res.sendStatus(400);
  const job=await S.Job.exists({_id:req.params.id,engineVersion:2,...scope(await identity(req))});if(!job)return res.sendStatus(404);
  const q={jobId:req.params.id};if(req.query.after){if(!idOK(req.query.after))return res.sendStatus(400);q._id={$gt:req.query.after};}
  const rows=await (collection==='chapters'?S.Task:S.Event).find(q).sort({_id:1}).limit(100).lean();res.json(rows);
 }));
 app.post('/api/automation/jobs/:id/:action',verifyAdmin,wrap(async(req,res,next)=>{
  if(!idOK(req.params.id)||!['pause','resume','cancel'].includes(req.params.action))return res.sendStatus(400);
  const q=scope(await identity(req));
  const exists=await S.Job.exists({_id:req.params.id,engineVersion:2,...q});if(!exists)return enabled()?res.sendStatus(404):next();
  const job=await S.transition(req.params.id,req.params.action,q);return job?res.json(view(job)):res.status(409).json({error:'Invalid transition'});
 }));
 app.post('/api/automation/worker/step',wrap(async(req,res)=>{
  if(!validCoordinatorSecret(req))return res.sendStatus(401);
  if(!enabled())return res.json({ok:true,disabled:true});
  return res.json(await processor.tick());
 }));
 const privateAuth=(req,res)=>{if(!validCoordinatorSecret(req)){res.sendStatus(401);return false;}return true;};
 async function externalClaim(body){
  if(!idOK(body.jobId)||!idOK(body.taskId)||typeof body.token!=='string'||!Number.isSafeInteger(body.fence))throw Object.assign(Error('Invalid claim'),{status:400});
  const job=await S.Job.findOne({_id:body.jobId,engineVersion:2,kind:'scrape',leaseToken:body.token,fence:body.fence});
  const task=job&&await S.Task.findOne({_id:body.taskId,jobId:job._id,state:'pending'});
  if(!job||!task)throw Object.assign(Error('Stale claim'),{status:409});
  return {job,task,token:body.token,fence:body.fence};
 }
 app.post('/api/automation/worker/scrape/claim',wrap(async(req,res)=>{
  if(!privateAuth(req,res))return;
  if(!enabled())return res.json({ok:true,disabled:true});
  if(await require('../services/durable/legacyState').active())return res.json({ok:true,disabled:true,code:'legacy_jobs_require_reconciliation'});
  const c=await S.claim(['scrape'],{longWorker:true});if(!c)return res.json({ok:true,idle:true});
  try{await S.resource(c,'source:'+new URL(c.job.sourceUrl).hostname);}
  catch{await S.settle(c,'source_busy');await S.release(c);return res.json({ok:true,idle:true});}
  res.json({ok:true,jobId:c.job.id,taskId:c.task.id,token:c.token,fence:c.fence,sourceUrl:c.job.sourceUrl,chapterNumber:c.task.number});
 }));
 app.post('/api/automation/worker/scrape/heartbeat',wrap(async(req,res)=>{
  if(!privateAuth(req,res))return;const c=await externalClaim(req.body);await S.heartbeat(c);res.json({ok:true,status:c.job.status});
 }));
 app.post('/api/automation/worker/scrape/complete',wrap(async(req,res)=>{
  if(!privateAuth(req,res))return;const c=await externalClaim(req.body);
  try{
   const receipt=await require('../models/importChapter.model').findById(req.body.receiptId);
   if(!receipt?.persisted||receipt.sourceUrl!==c.job.sourceUrl||receipt.number!==c.task.number||S.hash(receipt.content)!==receipt.contentHash)return res.status(409).json({error:'Unverified receipt'});
   const db=require('../config/firebaseAdmin').db;if(!db)return res.sendStatus(503);
   const saved=await db.collection('novels').doc(String(receipt.novelId)).collection('chapters').doc(String(receipt.number)).get();
   if(!saved.exists||saved.data().importHash!==receipt.contentHash||!saved.data().content?.trim())return res.status(409).json({error:'Readback failed'});
   await S.advance(c,{state:'verified',stage:'done',publicationId:receipt.id});res.json({ok:true});
  }finally{await S.release(c);}
 }));
 app.post('/api/automation/worker/scrape/fail',wrap(async(req,res)=>{
  if(!privateAuth(req,res))return;const c=await externalClaim(req.body);
  try{await S.settle(c,'scraper_step_failed',{blocked:req.body.permanent===true});res.json({ok:true});}finally{await S.release(c);}
 }));
 app.post('/api/automation/worker/queue-permit',wrap(async(req,res)=>{
  if(!validCoordinatorSecret(req))return res.sendStatus(401);
  const Budget=require('../models/automationQueueBudget.model');
  const cost=req.body?.cost;
  if(![1,3].includes(cost))return res.sendStatus(400);
  const day=new Date().toISOString().slice(0,10),limit=Math.max(0,Math.min(8000,Number(process.env.AUTOMATION_QUEUE_DAILY_BUDGET||8000)));
  await Budget.updateOne({_id:day},{$setOnInsert:{used:0}},{upsert:true});
  const granted=await Budget.findOneAndUpdate({_id:day,used:{$lte:limit-cost}},{$inc:{used:cost}},{new:true});
  res.json({ok:true,allowed:!!granted});
 }));
 app.post('/api/automation/worker/ready',wrap(async(req,res)=>{
  if(!validCoordinatorSecret(req))return res.sendStatus(401);
  const kinds=[];
  if(enabled()&&await S.Job.exists({engineVersion:2,workerClass:{$ne:'long'},status:{$in:['queued','running','retry_wait']},leaseUntil:{$lte:new Date()},nextRunAt:{$lte:new Date()}}))kinds.push('v2');
  if(await S.Job.exists({engineVersion:{$ne:2},status:{$in:['queued','running']},leaseUntil:{$lte:new Date()},nextRunAt:{$lte:new Date()}}))kinds.push('scrape');
  for(const [flag,name,kind] of [['DURABLE_PURE_TRANSLATION','pureTranslationJob','pure'],['DURABLE_SMART_TRANSLATION','translationJob','smart']]){
   if(process.env[flag]==='true'&&await require('../models/'+name+'.model').exists({durableMode:true,status:'active',leaseUntil:{$lte:new Date()},nextRunAt:{$lte:new Date()}}))kinds.push(kind);
  }
  res.json({ok:true,kinds:kinds.slice(0,2)});
 }));
 // Existing frontend starts retain their response shape; only the opt-in mode is routed here.
 for(const [prefix,kind] of [['/api/translator','smart_translate'],['/api/pure-translate','pure_translate'],['/api/glossary-ai','glossary_extract']]){
  const legacyView=async j=>({...view(j),_id:j.id,status:['queued','running','retry_wait'].includes(j.status)?'active':j.status,
   novelId:j.novelId,totalToTranslate:j.chapters.length,totalToExtract:j.chapters.length,translatedCount:j.successCount,processedCount:j.successCount,
   targetChapters:(await S.Task.find({jobId:j._id,state:{$ne:'verified'}}).sort({ordinal:1})).map(t=>t.number),logs:[]});
  app.post(prefix+'/start',verifyAdmin,wrap(async(req,res,next)=>{
   if(!enabled())return next();const user=await identity(req);
   if(req.body.jobId){
    const j=await S.Job.findOne({_id:req.body.jobId,kind,engineVersion:2,...scope(user)});if(!j)return res.status(409).json({error:'legacy_job_requires_reconciliation'});
    const resumed=await S.transition(j.id,'resume',scope(user));return resumed?res.json({jobId:j.id,message:'Job resumed'}):res.status(409).json({error:'Invalid transition'});
   }
   let body={...req.body,kind,sourceSelection:req.body.sourceSelection||'current_content'};
   if(body.chapters==='all'||body.chapters===undefined){
    if(!idOK(body.novelId))return res.sendStatus(400);
    const original=require('../models/importChapter.model');
    const novel=await Novel.findById(body.novelId);
    if(!novel)return res.sendStatus(404);
    if(!user.admin&&String(novel.authorId)!==user.id)return res.sendStatus(403);
    const numbers=new Set([...(novel.chapters||[]).map(x=>x.number),...(await original.find({novelId:body.novelId}).select('number')).map(x=>x.number)]);
    const db=require('../config/firebaseAdmin').db;
    if(db){const refs=await db.collection('novels').doc(body.novelId).collection('chapters').listDocuments();for(const ref of refs){if(/^[1-9]\d*$/.test(ref.id))numbers.add(Number(ref.id));}}
    body.chapters=[...numbers].filter(n=>!body.resumeFrom||n>=body.resumeFrom);
   }
   const r=await create(body,user,req.get('idempotency-key'));res.json({jobId:r.job.id,message:'Durable job queued'});
  }));
  app.get(prefix+'/jobs',verifyAdmin,wrap(async(req,res,next)=>{
   if(!enabled())return next();const jobs=await S.Job.find({engineVersion:2,kind,...scope(await identity(req))}).sort({_id:-1}).limit(50);
   res.json(await Promise.all(jobs.map(legacyView)));
  }));
  app.get(prefix+'/jobs/:id',verifyAdmin,wrap(async(req,res,next)=>{
   if(!idOK(req.params.id))return res.sendStatus(400);
   const j=await S.Job.findOne({_id:req.params.id,engineVersion:2,kind,...scope(await identity(req))});if(!j)return next();res.json(await legacyView(j));
  }));
  app.post(prefix+'/jobs/:id/pause',verifyAdmin,wrap(async(req,res,next)=>{
   if(!idOK(req.params.id))return res.sendStatus(400);const q=scope(await identity(req));
   const j=await S.Job.findOne({_id:req.params.id,engineVersion:2,kind,...q});if(!j)return next();
   const result=await S.transition(j.id,'pause',q);res.status(result?200:409).json({message:result?'Job paused':'Invalid transition'});
  }));
  app.delete(prefix+'/jobs/:id',verifyAdmin,wrap(async(req,res,next)=>{
   if(!idOK(req.params.id))return res.sendStatus(400);const q=scope(await identity(req));
   const j=await S.Job.findOne({_id:req.params.id,engineVersion:2,kind,...q});if(!j)return next();
   await S.transition(j.id,'cancel',q);res.json({message:'Job cancelled; saved results retained'});
  }));
 }
};
module.exports.providerSignature=providerSignature;
