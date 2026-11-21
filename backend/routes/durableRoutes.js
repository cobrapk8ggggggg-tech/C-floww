'use strict';
const S=require('../services/durable/store');
const {createProcessor}=require('../services/durable/processor');
const Novel=require('../models/novel.model');
const User=require('../models/user.model');
const Glossary=require('../models/glossary.model');
const legacyState=require('../services/durable/legacyState');
const watchSchedule=require('../services/durable/watchSchedule');
const {parseScrapeSelection}=require('../services/durable/scrapeSelection');
const {staleAfterMs,wasInterrupted,configuredProviders,recoverSavedFirst}=require('../services/durable/legacyTranslation');
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
 const replaceLegacyStart=()=>enabled()&&(!require('../config/automationIsolation').usesExistingDatabases() ||
  process.env.AUTOMATION_DURABLE_LEGACY_START==='true');
 const processor=deps.processor||createProcessor();
 const identity=deps.identity||async function(req){
  if(!idOK(req.user?.id))throw Object.assign(Error('Unauthorized'),{status:401});
  const user=await User.findById(req.user.id).lean();
  if(!user||!['admin','contributor'].includes(user.role))throw Object.assign(Error('Forbidden'),{status:403});
  return {id:String(user._id),admin:user.role==='admin',email:user.email};
 };
 const scope=user=>user.admin?{}:{ownerId:user.id};
 const wrap=fn=>async(req,res,next)=>{
  try{await fn(req,res,next);}
  catch(error){
   if(!error.status){
    const safeLabel=value=>typeof value==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,80}$/.test(value)?value:undefined;
    console.error('Durable operation failed',{
     route:req.route?.path,name:safeLabel(error.name),code:typeof error.code==='number'?error.code:safeLabel(error.code),
     codeName:safeLabel(error.codeName)
    });
   }
   res.status(error.status||503).json({error:error.status?error.message:'Durable operation unavailable'});
  }
 };
 async function create(body,user,key,{wake=true,watchSweep=false,fromLegacyControl=false,transfer}={}){
  const kind=body.kind||'scrape';if(!KINDS.includes(kind))throw Object.assign(Error('Invalid kind'),{status:400});
  const selection=kind==='scrape'&&body.chapterSpec!==undefined?parseScrapeSelection(body.chapterSpec,watchSweep):null;
  const chapters=selection?.chapters||chapterNumbers(body);
  const sourceSelection=body.sourceSelection||'verified_original';
  if(!['verified_original','current_content'].includes(sourceSelection))throw Object.assign(Error('Invalid source selection'),{status:400});
  const payload={kind,chapters,sourceSelection,adminEmail:user.email||'system@auto',...(transfer?{_id:transfer.old._id}:{})};
  if(key&&(!/^[\x21-\x7e]{1,128}$/.test(key)))throw Object.assign(Error('Invalid Idempotency-Key'),{status:400});
  const requestedSource=kind==='scrape'?sourceUrl(body.sourceUrl):undefined;
  const fingerprint=S.hash({kind,chapters,sourceSelection,...(selection?.catalogPlan?{plan:selection.catalogPlan}:{}),
   ...(kind==='scrape'?{sourceUrl:requestedSource}:{novelId:body.novelId})});
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
  if(kind==='scrape'){
   if(selection?.catalogPlan)config.catalogPlan=selection.catalogPlan;
   if(body.watchRequested===true)config.watchRequested=true;
   if(watchSweep)config.watchSweep=true;
  }
  if(kind!=='scrape'){
   for(const name of ['translationJob','pureTranslationJob','glossaryExtractionJob']){
    if(await require('../models/'+name+'.model').exists({novelId:novel._id,status:'active',...(transfer?{_id:{$ne:transfer.old._id}}:{})}))
     throw Object.assign(Error('legacy_job_active'),{status:409});
   }
   const settings=deps.settings?await deps.settings():await require('./translatorRoutes')._ai.getGlobalSettings();
   const ordered=configuredProviders(settings);
   const provider=ordered[0];
   if(!provider)throw Object.assign(Error('provider_missing'),{status:400});
   config={providerId:provider.providerId,model:provider.selectedModel||provider.models?.[0]?.modelId,
    providerSignature:providerSignature(provider),routes:ordered.map(p=>({providerId:p.providerId,model:p.selectedModel||p.models?.[0]?.modelId,providerSignature:providerSignature(p)})),routeIndex:0,
    prompt:settings.customPrompt||'',extractPrompt:settings.translatorExtractPrompt||settings.extractPrompt||'',chunkSize:2400,keyIndex:0,
    existingProvidersAuthorized:fromLegacyControl,novelTitle:novel.title,cover:novel.cover,
    novelMaxChapter:(novel.chapters||[]).reduce((max,chapter)=>Math.max(max,chapter.number||0),Math.max(0,novel.sourceChaptersCount||0,chapters.at(-1)||0)),
    chapterDelayMs:Math.max(0,Math.min(3600000,Number(body.chapterDelayMs??(kind==='glossary_extract'?3000:2000))||0)),
    ...(transfer?{priorCompleted:transfer.priorCompleted,priorLastChapter:transfer.priorLastChapter}:{} )};
   if((process.env.AUTOMATION_LONG_PROVIDER_IDS||'').split(',').includes(provider.providerId))payload.workerClass='long';
   if(!config.model)throw Object.assign(Error('provider_model_missing'),{status:400});
   if(kind==='pure_translate')glossary=await Glossary.find({novelId:novel._id}).select('term translation -_id').lean();
  }
  const result=await S.createJob({payload,config,glossary,ownerId:user.id,idempotencyKey:key,requestFingerprint:fingerprint,
   retireLegacy:transfer?.retire,
   novelKey:novel?'novel:'+novel.id:'source:'+S.hash(payload.sourceUrl)});
  if(result.created&&config.watchRequested&&novel)await Novel.updateOne({_id:novel._id},{$set:{isWatched:true}});
  if(wake)await wakeCoordinator();
  return result;
 }
 async function wakeCoordinator(){
  const coordinator=process.env.AUTOMATION_COORDINATOR_URL;
  if(coordinator&&process.env.AUTOMATION_SECRET){
   try{const url=new URL('/wake',coordinator);if(url.protocol!=='https:')throw Error('HTTPS required');
    await fetch(url,{method:'POST',headers:{'x-automation-secret':process.env.AUTOMATION_SECRET},signal:AbortSignal.timeout(3000)});
   }catch{/* The MongoDB job remains discoverable by cron. */}
  }
 }
 const queueWatched=(novel,user,key,wake=false)=>create({kind:'scrape',sourceUrl:novel.sourceUrl,chapterSpec:''},user,key,{wake,watchSweep:true});
 app.get('/api/automation/watch-schedule',verifyAdmin,wrap(async(req,res)=>{
  if(!(await identity(req)).admin)return res.sendStatus(403);
  res.json(watchSchedule.view(await watchSchedule.settings()));
 }));
 app.post('/api/automation/watch-schedule',verifyAdmin,wrap(async(req,res)=>{
  const user=await identity(req);if(!user.admin)return res.sendStatus(403);
  res.json(watchSchedule.view(await watchSchedule.configure(req.body||{},user.id)));
 }));
 app.post('/api/automation/watch-refresh',verifyAdmin,wrap(async(req,res)=>{
  const user=await identity(req);if(!user.admin)return res.sendStatus(403);
  if(!enabled())return res.sendStatus(503);
  if(req.body?.novelId===undefined){
   await watchSchedule.requestSweep(user.id);
   await wakeCoordinator();
   return res.status(202).json({queued:true});
  }
  if(!idOK(req.body.novelId))return res.sendStatus(400);
  const novel=await Novel.findOne({_id:req.body.novelId,isWatched:true});
  if(!novel?.sourceUrl)return res.sendStatus(404);
  const result=await queueWatched(novel,user,req.get('idempotency-key'),true);
  res.status(result.created?201:200).json(view(result.job));
 }));
 app.get('/api/automation/migration-report',verifyAdmin,wrap(async(req,res)=>{
  if(!(await identity(req)).admin)return res.sendStatus(403);
  res.json(await legacyState.report());
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
  if(!job)return (await identity(req)).admin?next():res.sendStatus(404);
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
  const exists=await S.Job.exists({_id:req.params.id,engineVersion:2,...q});if(!exists){
   if(!(await identity(req)).admin)return res.sendStatus(404);
   if(enabled()&&req.params.action==='resume')return res.status(409).json({error:'legacy_job_requires_reconciliation'});
   return next();
  }
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
  const policy=await legacyState.executionPolicy(['scrape']);
  if(!policy.kinds.length)return res.json({ok:true,disabled:true,code:'legacy_jobs_require_reconciliation'});
  const c=await S.claim(policy.kinds,{longWorker:true,scope:{...policy.scope,'config.catalogPlan':{$exists:false}}});if(!c)return res.json({ok:true,idle:true});
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
  if(req.body?.verifyStorage===true){
   const db=require('../config/firebaseAdmin').db;
   if(!db)return res.status(503).json({error:'Firestore unavailable'});
   await require('../services/durable/deadline')(8000,()=>db.collection('novels').limit(1).select().get());
   return res.json({ok:true,firestoreReadable:true});
  }
  const kinds=[];
  if(enabled()){
   try{await watchSchedule.tick(queueWatched);}catch{console.error('Watch schedule tick could not advance');}
   const policy=await legacyState.executionPolicy(KINDS);
   if(policy.kinds.length&&await S.Job.exists({engineVersion:2,...policy.scope,kind:{$in:policy.kinds},workerClass:{$ne:'long'},
    status:{$in:['queued','running','retry_wait']},leaseUntil:{$lte:new Date()},nextRunAt:{$lte:new Date()}}))kinds.push('v2');
  }
  if(await S.Job.exists({engineVersion:{$ne:2},status:{$in:['queued','running']},leaseUntil:{$lte:new Date()},nextRunAt:{$lte:new Date()}}))kinds.push('scrape');
  for(const [flag,name,kind] of [['DURABLE_PURE_TRANSLATION','pureTranslationJob','pure'],['DURABLE_SMART_TRANSLATION','translationJob','smart']]){
   if(process.env[flag]==='true'&&await require('../models/'+name+'.model').exists({durableMode:true,status:'active',leaseUntil:{$lte:new Date()},nextRunAt:{$lte:new Date()}}))kinds.push(kind);
  }
  res.json({ok:true,kinds:kinds.slice(0,2)});
 }));
 // Existing frontend starts retain their response shape; only the opt-in mode is routed here.
 for(const [prefix,kind] of [['/api/translator','smart_translate'],['/api/pure-translate','pure_translate'],['/api/glossary-ai','glossary_extract']]){
  const legacyModel=require('../models/'+({'smart_translate':'translationJob','pure_translate':'pureTranslationJob','glossary_extract':'glossaryExtractionJob'}[kind])+'.model');
  const legacyView=async(j,details=false)=>{
   const pending=await S.Task.find({jobId:j._id,state:{$ne:'verified'}}).select('number stage').sort({ordinal:1});
   const previous=j.config?.priorCompleted||0,done=previous+j.successCount,total=previous+j.chapters.length;
   const logs=details?(await S.Event.find({jobId:j._id}).sort({_id:-1}).limit(100)).reverse().map(e=>({
    timestamp:e.createdAt,type:e.code==='completed'?'success':e.type,
    message:e.code==='completed'?'اكتملت المهمة وحُفظت الفصول':e.code==='stage_committed'?`الفصل ${e.chapter}: حُفظ تقدم مرحلة ${e.stage}`:`الفصل ${e.chapter||'—'}: ${e.code}`
   })):[];
   if(details&&j.status==='blocked')logs.push({timestamp:j.updatedAt,type:'error',message:`توقفت المهمة: ${j.blockedCode||j.lastError}. يمكنك الاستئناف بعد معالجة السبب.`});
   else if(details&&pending.length)logs.push({timestamp:j.updatedAt,type:'info',message:`الفصل التالي: ${pending[0].number}.`});
   return {...view(j),_id:j.id,status:['queued','running','retry_wait'].includes(j.status)?'active':j.status==='blocked'?'paused':j.status,
    novelTitle:j.config?.novelTitle||j.label,cover:j.config?.cover,chapterDelayMs:j.config?.chapterDelayMs,
    startTime:j.createdAt,lastUpdate:j.updatedAt,currentChapter:(j.successCount?j.chapters[j.successCount-1]:j.config?.priorLastChapter)||0,
    novelMaxChapter:j.config?.novelMaxChapter||j.chapters.at(-1)||0,
    totalToTranslate:total,totalToExtract:total,translatedCount:done,processedCount:done,
    targetChapters:pending.map(t=>t.number),logs};
  };
  const oldView=j=>{
   const interrupted=replaceLegacyStart()&&wasInterrupted(j);
   return {...j,id:String(j._id),status:interrupted?'paused':j.status,verification:'legacy_unverified',
    ...(interrupted?{logs:[...(j.logs||[]),{timestamp:j.updatedAt,type:'warning',message:'توقف العامل القديم. اضغط استئناف لمتابعة الفصول المتبقية من آخر حفظ.'}]}:{})};
  };
  app.post(prefix+'/start',verifyAdmin,wrap(async(req,res,next)=>{
   if(!replaceLegacyStart())return next();const user=await identity(req);
   if(req.body.jobId){
    if(!idOK(req.body.jobId))return res.sendStatus(400);
    const j=await S.Job.findOne({_id:req.body.jobId,kind,engineVersion:2,...scope(user)});
    if(j){
     if(j.status==='completed')return res.json({jobId:j.id,message:'Job completed'});
     if(['queued','running','retry_wait'].includes(j.status))return res.json({jobId:j.id,message:'Job already scheduled'});
     const resumed=await S.transition(j.id,'resume',scope(user));
     if(resumed)await wakeCoordinator();
     return resumed?res.json({jobId:j.id,message:'Job resumed'}):res.status(409).json({error:'Invalid transition'});
    }
    const old=await legacyModel.findById(req.body.jobId).select('-apiKeys');
    const novel=old&&await Novel.findById(old.novelId);
    if(!novel||(!user.admin&&String(novel.authorId)!==user.id))return res.sendStatus(404);
    const age=Date.now()-+new Date(old.updatedAt||old.lastUpdate||old.startTime);
    if(old.status==='completed')return res.json({jobId:old.id,message:'Job completed'});
    if(!Number.isFinite(age)||age<staleAfterMs)return res.status(409).json({error:'legacy_worker_still_within_deadline'});
    const targets=chapterNumbers({chapters:[...old.targetChapters]});
    const stored=kind==='glossary_extract'?null:await recoverSavedFirst(old,novel,targets,deps.firestore||require('../config/firebaseAdmin').db);
    const remaining=stored===null?targets:targets.slice(1);
    const priorCompleted=Number(kind==='glossary_extract'?old.processedCount:old.translatedCount)||0;
    const filter={_id:old._id,status:old.status,updatedAt:old.updatedAt,targetChapters:old.targetChapters};
    if(!remaining.length){
     const confirmed=await legacyModel.updateOne(filter,{$set:{status:'completed',targetChapters:[],currentChapter:stored,translatedCount:priorCompleted+1,lastUpdate:new Date()},
      $push:{logs:{message:'تأكد حفظ الفصل المتبقي دون إعادة ترجمته.',type:'success',timestamp:new Date()}}});
     return confirmed.modifiedCount?res.json({jobId:old.id,message:'Job completed'}):res.status(409).json({error:'legacy_job_changed'});
    }
    const retire=async session=>{
     const retired=await legacyModel.updateOne(filter,{$set:{status:'paused'},
      $push:{logs:{message:'نُقلت الفصول المتبقية إلى عامل ZEUS المحفوظ.',type:'info',timestamp:new Date()}}},{session});
     if(retired.modifiedCount!==1)throw Object.assign(Error('legacy_job_changed'),{status:409});
    };
    const continued=await create({kind,novelId:String(novel._id),chapters:remaining,sourceSelection:'current_content',chapterDelayMs:old.chapterDelayMs},
     user,'legacy-resume:'+old.id,{fromLegacyControl:true,transfer:{old,retire,priorCompleted:priorCompleted+(stored===null?0:1),priorLastChapter:stored||old.currentChapter}});
    return res.json({jobId:continued.job.id,message:'Durable job resumed'});
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
   const r=await create(body,user,req.get('idempotency-key'),{fromLegacyControl:true});res.json({jobId:r.job.id,message:'Durable job queued'});
  }));
  app.get(prefix+'/jobs',verifyAdmin,wrap(async(req,res,next)=>{
   if(!enabled())return next();const user=await identity(req);
   const jobs=await S.Job.find({engineVersion:2,kind,...scope(user)}).sort({_id:-1}).limit(50);
   const owned=user.admin?null:(await Novel.find({authorId:user.id}).select('_id')).map(n=>n._id);
   const old=await legacyModel.find(user.admin?{}:{novelId:{$in:owned}}).select('-apiKeys').sort({_id:-1}).limit(50).lean();
   const durableIds=new Set(jobs.map(j=>j.id));
   const combined=[...await Promise.all(jobs.map(j=>legacyView(j))),...old.filter(j=>!durableIds.has(String(j._id))).map(oldView)];
   res.json(combined.sort((a,b)=>String(b._id).localeCompare(String(a._id))).slice(0,50));
  }));
  app.get(prefix+'/jobs/:id',verifyAdmin,wrap(async(req,res,next)=>{
   if(!idOK(req.params.id))return res.sendStatus(400);
   const user=await identity(req);
   const j=await S.Job.findOne({_id:req.params.id,engineVersion:2,kind,...scope(user)});
   if(j)return res.json(await legacyView(j,true));
   if(!enabled())return next();
   const old=await legacyModel.findById(req.params.id).select('-apiKeys').lean();
   if(!old||(!user.admin&&!await Novel.exists({_id:old.novelId,authorId:user.id})))return res.sendStatus(404);
   const details=oldView(old);
   if(req.query.resumePreview==='1'&&replaceLegacyStart()&&['active','paused','failed'].includes(old.status)&&old.targetChapters?.length){
    const novel=await Novel.findById(old.novelId).select('chapters');
    const targets=chapterNumbers({chapters:old.targetChapters});
    const stored=kind==='glossary_extract'?null:await recoverSavedFirst(old,novel,targets,deps.firestore||require('../config/firebaseAdmin').db);
    details.resumePreview={preservedChapter:stored,nextChapter:(stored===null?targets[0]:targets[1])??null};
   }
   res.json(details);
  }));
  const legacyControl=async(req,res,next,user)=>{
   if(!enabled())return next();
   const old=await legacyModel.findById(req.params.id).select('novelId').lean();
   if(!old||(!user.admin&&!await Novel.exists({_id:old.novelId,authorId:user.id})))return res.sendStatus(404);
   return next();
  };
  app.post(prefix+'/jobs/:id/delay',verifyAdmin,wrap(async(req,res,next)=>{
   if(!idOK(req.params.id))return res.sendStatus(400);
   const user=await identity(req);
   const where={_id:req.params.id,engineVersion:2,kind,...scope(user)};
   if(!await S.Job.exists(where))return legacyControl(req,res,next,user);
   const delay=Number(req.body?.chapterDelayMs);
   if(!Number.isFinite(delay)||delay<0||delay>3600000)return res.sendStatus(400);
   await S.Job.updateOne(where,{$set:{'config.chapterDelayMs':Math.round(delay)}});
   return res.json({message:'Delay updated',chapterDelayMs:Math.round(delay)});
  }));
  app.post(prefix+'/jobs/:id/pause',verifyAdmin,wrap(async(req,res,next)=>{
   if(!idOK(req.params.id))return res.sendStatus(400);const user=await identity(req),q=scope(user);
   const j=await S.Job.findOne({_id:req.params.id,engineVersion:2,kind,...q});if(!j)return legacyControl(req,res,next,user);
   const result=await S.transition(j.id,'pause',q);res.status(result?200:409).json({message:result?'Job paused':'Invalid transition'});
  }));
  app.delete(prefix+'/jobs/:id',verifyAdmin,wrap(async(req,res,next)=>{
   if(!idOK(req.params.id))return res.sendStatus(400);const user=await identity(req),q=scope(user);
   const j=await S.Job.findOne({_id:req.params.id,engineVersion:2,kind,...q});if(!j)return legacyControl(req,res,next,user);
   await S.transition(j.id,'cancel',q);res.json({message:'Job cancelled; saved results retained'});
  }));
 }
};
module.exports.providerSignature=providerSignature;
