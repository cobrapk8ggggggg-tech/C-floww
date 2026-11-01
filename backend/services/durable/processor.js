'use strict';
const S=require('./store');
const Publication=require('../../models/durablePublication.model');
const Novel=require('../../models/novel.model');
const Glossary=require('../../models/glossary.model');
const Import=require('../../models/importChapter.model');
const Mirror=require('../../models/chapterContentMirror.model');
const Conversation=require('../../models/providerConversation.model');
const AccountState=require('../../models/durableAccountState.model');
const {splitSource,parseCoveredReply}=require('../completeTranslation.service');
const problem=(code,blocked=true)=>Object.assign(Error(code),{code,blocked});
const artifactId=(c,kind)=>`${c.task.id}:${kind}`;
async function read(id){const a=await S.Artifact.findById(id);if(!a||S.hash(a.text)!==a.hash)throw problem('checkpoint_missing_or_corrupt');return a.text;}
function parseTerms(text){
 let t=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 if(/^json\s*[\r\n]/i.test(t))t=t.replace(/^json\s*/i,'');
 const parsed=JSON.parse(t),terms=Array.isArray(parsed)?parsed:parsed.terms||parsed.newTerms;
 if(!Array.isArray(terms))throw problem('invalid_terms',false);
 return terms.map(x=>{
  const term=x.term||x.name,translation=x.translation;
  if(typeof term!=='string'||!term.trim()||typeof translation!=='string'||!translation.trim())throw problem('invalid_terms',false);
  const cats={character:'characters',location:'locations',item:'items',rank:'ranks'};
  const raw=cats[x.category]||x.category;
  return {term:term.trim(),translation:translation.trim(),category:['characters','locations','items','ranks','other'].includes(raw)?raw:'other',description:typeof x.description==='string'?x.description:''};
 });
}
function classify(err){
 const status=err.response?.status||err.status;
 if(err.blocked)return {code:err.code||'blocked',blocked:true};
 if(status===401||status===403||/AuthError/i.test(err.name||''))return {code:'provider_auth',blocked:false,definitive:true};
 if(status===429||/RateLimited|RateLimit/i.test(err.name||''))return {code:'provider_rate_limit',blocked:false,definitive:true,delayMs:Math.min(86400000,Math.max(30000,Number(err.response?.headers?.['retry-after']||30)*1000))};
 if(status>=500)return {code:'provider_unavailable',blocked:false,definitive:true};
 return {code:err.code==='invalid_terms'?'invalid_terms':'provider_result_unknown',blocked:false};
}
function createProcessor(deps={}){
 const ai=()=>deps.ai||require('../../routes/translatorRoutes')._ai;
 const firestore=()=>deps.firestore||require('../../config/firebaseAdmin').db;
 async function route(job){
  if(deps.route)return deps.route(job);
  const settings=await ai().getGlobalSettings();
  const providers=(settings?.translationProviders||[]).slice().sort((a,b)=>(a.priority||0)-(b.priority||0));
  const routes=job.config.routes||[job.config];
  let index=job.config.routeIndex||0,slot=job.config.keyIndex||0;
  for(;index<routes.length;index++,slot=0){
   const selected=routes[index],provider=providers.find(p=>p.providerId===selected.providerId);
   if(!provider)continue;
   if(!deps.longWorker&&(process.env.AUTOMATION_LONG_PROVIDER_IDS||'').split(',').includes(provider.providerId))throw Object.assign(problem('long_worker_required',false),{requiresLongWorker:true});
   if(selected.providerSignature&&require('../../routes/durableRoutes').providerSignature(provider)!==selected.providerSignature)throw problem('provider_settings_changed');
   let keys=ai().getProviderAuthKeys(provider);
   const qwen=ai().isQwenProvider(provider);
   const stored=qwen?(settings.qwenAutoAccounts||[]):[];
   if(qwen)keys=[...new Set([...keys,...stored.filter(a=>a.providerId===provider.providerId).map(a=>a.token)])];
   if(qwen&&!keys.length&&process.env.AUTOMATION_QWEN_ACCOUNT_SETUP==='true'){
    if(!(process.env.AUTOMATION_FREE_PROVIDER_IDS||'').split(',').includes(provider.providerId))throw problem('budget_approval_required');
    throw Object.assign(problem('account_setup_required',false),{accountSetupProviderId:provider.providerId});
   }
   if(!keys.length&&ai().isGeminiWebProvider(provider)&&provider.allowGuestFallback)keys=[ai().GUEST_TOKEN_SENTINEL];
   for(;slot<keys.length;slot++){
    const key=keys[slot],account=S.hash(`${provider.providerId}:${key}`);
    const owned=stored.find(a=>a.token===key);
    if(owned&&(owned.providerId!==provider.providerId||owned.dead||(owned.rateLimitedUntil&&new Date(owned.rateLimitedUntil)>new Date())))continue;
    const state=await AccountState.findById(account);
    if(state&&(state.dead||state.until>new Date()))continue;
    const allowed=(process.env.AUTOMATION_FREE_PROVIDER_IDS||'').split(',').filter(Boolean);
    if(!allowed.includes(provider.providerId))throw problem('budget_approval_required');
    const next=slot+1<keys.length?{routeIndex:index,keyIndex:slot+1}:index+1<routes.length?{routeIndex:index+1,keyIndex:0}:null;
    return {provider,key,model:selected.model,free:true,next,account};
   }
   if(qwen&&process.env.AUTOMATION_QWEN_ACCOUNT_SETUP==='true'){
    if(!(process.env.AUTOMATION_FREE_PROVIDER_IDS||'').split(',').includes(provider.providerId))throw problem('budget_approval_required');
    throw Object.assign(problem('account_setup_required',false),{accountSetupProviderId:provider.providerId});
   }
  }
  throw problem('provider_routes_exhausted');
 }
 async function providerCall(c,operation,prompt,purpose){
  async function commitContexts(call){
   await S.transaction(async session=>{
    await S.assertOwned(c,session);
    for(const w of call.context?.writes||[])await Conversation.updateOne({key:w.key},{$set:{context:w.value,expiresAt:new Date(Date.now()+30*86400000)}},{upsert:true,session});
   });
  }
  const intent=artifactId(c,'generation:'+c.task.generation+':'+operation+':'+S.hash(prompt));
  const saved=await S.Call.findOne({taskId:c.task._id,intent,state:'received'}).sort({attempt:-1,createdAt:-1});
  if(saved){
   if(saved.account)await S.resource(c,'account:'+saved.account);
   await commitContexts(saved);return saved.reply;
  }

  const r=await route(c.job);
  if(!r.free)throw problem('budget_approval_required');
  await S.resource(c,'account:'+r.account);
  const base=artifactId(c,'account:'+r.account+':generation:'+c.task.generation+':'+operation+':'+S.hash(prompt));
  // A stored response is reused even when the worker died before stage commit.
  const calls=await S.Call.find({taskId:c.task._id,operation:base}).sort({attempt:-1});
  const received=calls.find(x=>x.state==='received');
  if(received){await commitContexts(received);return received.reply;}
  const latest=calls[0];
  let attempt=latest?latest.attempt+1:0;
  if(latest?.state==='started'&&attempt>1)throw problem('ambiguous_retry_exhausted');
  if(latest?.state==='rejected'&&attempt>=5)throw problem('provider_attempts_exhausted');
  const id=base+':'+attempt;
  await S.transaction(async session=>{
   await S.assertOwned(c,session);
   await S.Call.create([{_id:id,jobId:c.job._id,taskId:c.task._id,operation:base,intent,account:r.account,state:'started',attempt,providerId:r.provider.providerId}],{session});
  });
  const contextKey='durable:'+c.job.id;
  const previous=await S.Call.findOne({jobId:c.job._id,state:'received',context:{$exists:true}}).sort({createdAt:-1});
  const serialized=previous?.context?.maps||{};
  const contexts=Object.fromEntries(['chapters','glossary','chapter_review'].map(k=>[k,new Map(serialized[k]||[])]));
  const writes=[];
  const available=c.deadline?Math.max(1,c.deadline-Date.now()-60000):180000;
  if(available<1000)throw problem('execution_budget_exhausted',false);
  const options={timeout:deps.longWorker?500000:Math.min(180000,available),durableSingleCall:true,deepSeekJobId:c.job.id,
   conversationPurpose:purpose,conversationBatchKey:Math.floor(c.task.ordinal/100),
   conversationScopeKey:ai().getTokenConversationScope?.(r.provider,r.key,0)||r.account,
   conversationContexts:contexts,stateStore:{
    get:async key=>{const pending=previous?.context?.writes?.find(x=>x.key===key);return pending?.value||(await Conversation.findOne({key}).lean())?.context;},
    set:async(key,value)=>writes.push({key,value})
   }};
  try{
   const reply=await require('./deadline')(deps.requestTimeoutMs||options.timeout,async signal=>{
    options.signal=signal;
    return deps.provider?deps.provider(prompt,{...r,options,operation}):ai().callTranslationProvider(r.provider,r.model,r.key,prompt,options);
   });
   if(typeof reply!=='string'||!reply.trim())throw problem('empty_provider_response',false);
   // Save raw replies before parsing or updating job state. No secret/provider object is persisted.
   const context={maps:Object.fromEntries(Object.entries(contexts).map(([k,m])=>[k,[...m]])),writes};
   await S.Call.updateOne({_id:id,state:'started'},{$set:{state:'received',reply,context}},{writeConcern:{w:'majority'}});
   await commitContexts({context});
   return reply;
  }catch(err){
   if(err.code==='stale_lease')throw err;
   const verdict=classify(err);
   if(verdict.code==='provider_auth'){
    await AccountState.updateOne({_id:r.account},{$set:{dead:true}},{upsert:true});
    if(/^qwen(?:_|$)/i.test(r.provider.providerId))await require('../../models/settings.model').updateMany({'qwenAutoAccounts.token':r.key},{$set:{'qwenAutoAccounts.$[a].dead':true}},{arrayFilters:[{'a.token':r.key,'a.providerId':r.provider.providerId}]});
   }
   if(['provider_auth','provider_unavailable'].includes(verdict.code)&&r.next)verdict.rotate=r.next;
   if(verdict.code==='provider_auth'&&!r.next&&!(/^qwen(?:_|$)/i.test(r.provider.providerId)&&process.env.AUTOMATION_QWEN_ACCOUNT_SETUP==='true'))verdict.blocked=true;
   if(verdict.code==='provider_rate_limit'){
    if(/^qwen(?:_|$)/i.test(r.provider.providerId)){verdict.delayMs=86400000;
     await require('../../models/settings.model').updateMany({'qwenAutoAccounts.token':r.key},{$set:{'qwenAutoAccounts.$[a].rateLimitedUntil':new Date(Date.now()+86400000)}},{arrayFilters:[{'a.token':r.key,'a.providerId':r.provider.providerId}]});
    }
    await AccountState.updateOne({_id:r.account},{$set:{until:new Date(Date.now()+(verdict.delayMs||30000))}},{upsert:true});
    c.cooldown={key:'account:'+r.account,until:new Date(Date.now()+(verdict.delayMs||30000))};if(r.next)verdict.rotate=r.next;
    if(/^qwen(?:_|$)/i.test(r.provider.providerId)&&process.env.AUTOMATION_QWEN_ACCOUNT_SETUP==='true')verdict.delayMs=30000;}
   if(verdict.definitive)await S.Call.updateOne({_id:id,state:'started'},{$set:{state:'rejected',code:verdict.code}},{writeConcern:{w:'majority'}});
   throw Object.assign(Error(verdict.code),verdict);
  }
 }
 async function step(c){
  const {job,task}=c;
  if(!task)throw problem('missing_task_manifest');
  if(job.kind==='scrape'){
   await S.resource(c,'source:'+new URL(job.sourceUrl).hostname);
   const result=deps.scrape?await deps.scrape(job,task):await (async()=>{
    const base=process.env.SCRAPER_SERVICE_URL?.replace(/\/+$/,'');
    if(!base||!process.env.SCRAPER_API_SECRET)throw problem('scraper_not_configured');
    const res=await fetch(base+'/automation/scrape-chapter',{method:'POST',headers:{'content-type':'application/json',authorization:process.env.SCRAPER_API_SECRET,'x-automation-ingest-secret':process.env.AUTOMATION_INGEST_SECRET||''},
     body:JSON.stringify({sourceUrl:job.sourceUrl,chapterNumber:task.number,jobId:job.id}),signal:AbortSignal.timeout(80000)});
    if(!res.ok)throw Object.assign(Error('scraper_unavailable'),{code:'scraper_unavailable',requiresLongWorker:res.status===504,blocked:[400,401,403,422].includes(res.status)});
    return res.json();
   })();
   if(!result.ok||result.chapterNumber!==task.number||!result.receiptId)throw problem('invalid_scraper_receipt',false);
   if(!deps.trustTestScrape){
    const receipt=await Import.findById(result.receiptId);
    if(!receipt?.persisted||receipt.number!==task.number||receipt.sourceUrl!==job.sourceUrl)throw problem('unverified_scraper_receipt',false);
   }
   return S.advance(c,{state:'verified',stage:'done',publicationId:result.receiptId});
  }
  if(task.stage==='account_prepare'){
   if(!deps.longWorker)throw Object.assign(problem('long_worker_required',false),{requiresLongWorker:true});
   await (deps.accountSetup||require('./accountSetup'))(job.config.setupProviderId);
   return S.advance(c,{stage:job.config.resumeStage||'generate'});
  }
  if(task.stage==='source'){
   let original=deps.source?await deps.source(job,task):await Import.findOne({novelId:job.novelId,number:task.number});
   if(!original&&!deps.source){
    const db=firestore();if(!db)throw problem('firestore_not_configured');
    const snap=await db.collection('novels').doc(String(job.novelId)).collection('chapters').doc(String(task.number)).get();
    if(snap.exists){const d=snap.data();if(typeof d.originalContent==='string')original={content:d.originalContent};
     else if(job.sourceSelection==='current_content')original={content:d.content};}
   }
   const text=typeof original==='string'?original:original?.content;
   if(!text?.trim())throw problem('source_missing');
   if(original?.contentHash&&S.hash(text)!==original.contentHash)throw problem('source_corrupt');
   const units=splitSource(text,job.config.chunkSize||2400);
   if(!units.length)throw problem('source_missing');
   const terms=job.kind==='pure_translate'?JSON.parse(await read(job.id+':glossary')):
    deps.glossary?await deps.glossary(job):await Glossary.find({novelId:job.novelId}).select('term translation -_id').lean();
   return S.advance(c,{stage:job.kind==='glossary_extract'?'extract':'generate',sourceHash:S.hash(text),units:units.length,glossaryRef:artifactId(c,'glossary')},[
    {id:artifactId(c,'source'),text,kind:'original'},
    {id:artifactId(c,'glossary'),text:JSON.stringify(terms),kind:'glossary_snapshot'}]);
  }
  const source=await read(artifactId(c,'source'));
  const units=splitSource(source,job.config.chunkSize||2400);
  const glossary=JSON.parse(await read(task.glossaryRef));
  const glossaryText=glossary.map(x=>`${x.term}: ${x.translation}`).join('\n');
  if(task.stage==='generate'){
   const unit=units[task.unit],nonce=S.hash(task.id+':'+task.unit).slice(0,12);
   const marked=`[[${nonce}_${unit.id}]]\n${unit.text}`;
   const prompt=`${job.config.prompt||'Translate the complete supplied text into Arabic.'}\nGLOSSARY:\n${glossaryText}\n`+
    `Preserve every paragraph, dialogue and non-language separator. Never summarize or omit content.\n`+
    `Keep the marker exactly once and output ONLY its full Arabic translation, then [[END_${nonce}]].\n${marked}`+
    (task.repair?'\nPrevious reply was incomplete or invalid. Repair this unit fully.':'');
   const reply=await providerCall(c,`translate:${task.unit}:repair:${task.repair}`,prompt,'chapters');
   let translated;
   try{[translated]=parseCoveredReply(reply,[unit],nonce);}catch{
    if(task.repair>=2)throw problem('translation_quality_failed');
    return S.advance(c,{repair:task.repair+1});
   }
   return S.advance(c,{stage:'check_unit'},[
    {id:artifactId(c,'candidate:'+task.unit+':'+task.repair+':'+task.generation),text:translated,kind:'candidate'}]);
  }
  if(['check_unit','residue','review'].includes(task.stage)){
   const unit=units[task.unit];
   const candidateId=artifactId(c,'candidate:'+task.unit+':'+task.repair+':'+task.generation);
   let text=await read(candidateId);
   const fixed=await S.Artifact.findById(candidateId+':fixed');if(fixed)text=fixed.text;
   const validation=ai().validateTranslatedChapter(text,unit.text);
   const send=async(_provider,_model,_key,prompt)=>providerCall(c,task.stage+':'+task.unit+':'+task.repair,prompt,'chapter_review');
   if(task.stage==='check_unit'){
    if(validation.residues?.length)return S.advance(c,{stage:'residue'});
    if(!validation.ok&&unit.text.length>=200)return S.advance(c,{stage:'review'});
   }else if(task.stage==='residue'){
    text=await ai().translateResiduesOnly({},job.config.model,undefined,text,validation.residues,{callProvider:send,durableSingleCall:true});
    return S.advance(c,{stage:'review'},[{id:candidateId+':fixed',text,kind:'residue_repair'}]);
   }else if(!validation.ok){
    const review=await ai().reviewQuestionableChapter({},job.config.model,undefined,text,unit.text,validation,{callProvider:send,durableSingleCall:true});
    if(review.decision!=='accept'||validation.residues?.length){
     if(task.repair>=2)throw problem('translation_quality_failed');
     return S.advance(c,{stage:'generate',repair:task.repair+1});
    }
   }
   const next=task.unit+1;
   return S.advance(c,{unit:next,repair:0,stage:next===units.length?'quality':'generate'},[
    {id:artifactId(c,'unit:'+task.unit),text,kind:'translated_unit'}]);
  }
  if(task.stage==='quality'){
   const pieces=await Promise.all(units.map((_,i)=>read(artifactId(c,'unit:'+i))));
   const text=pieces.join('\n\n'),validation=ai().validateTranslatedChapter(text,source);
   if(!validation.ok)throw problem('chapter_quality_failed');
   return S.advance(c,{stage:job.kind==='smart_translate'?'extract':'publish'},[{id:artifactId(c,'translation'),text,kind:'translation'}]);
  }
  if(task.stage==='extract'){
   const i=task.extractionUnit,unit=units[i];
   const arabic=job.kind==='smart_translate'?await read(artifactId(c,'unit:'+i)):'';
   const prompt=`${job.config.extractPrompt||'Extract novel terminology: characters, locations, items, ranks and concepts; translate into Arabic.'}\n`+
    `Return ONLY a JSON array of {term,translation,category,description}. An empty array is valid when no terms exist.\n`+
    `SOURCE:\n${unit.text}\nARABIC:\n${arabic}`;
   const reply=await providerCall(c,'extract:'+i+':repair:'+task.repair,prompt,'glossary');
   let terms;try{terms=parseTerms(reply);}catch{
    if(task.repair>=2)throw problem('glossary_quality_failed');
    return S.advance(c,{repair:task.repair+1});
   }
   const next=i+1;
   return S.advance(c,{extractionUnit:next,repair:0,stage:next===units.length?'glossary_commit':'extract'},[
    {id:artifactId(c,'terms:'+i),text:JSON.stringify(terms),kind:'terms'}]);
  }
  if(task.stage==='glossary_commit'){
   const terms=(await Promise.all(units.map((_,i)=>read(artifactId(c,'terms:'+i)).then(JSON.parse)))).flat();
   return S.advance(c,{stage:job.kind==='glossary_extract'?'done':'publish',...(job.kind==='glossary_extract'?{state:'verified'}:{})},[],async session=>{
    for(const t of terms){
     // Never replace a manually curated translation; duplicates/retries are harmless.
     await Glossary.updateOne({novelId:job.novelId,term:t.term},{$setOnInsert:{...t,novelId:job.novelId,autoGenerated:true}},{upsert:true,session});
    }
   });
  }
  if(task.stage==='publish'){
   const text=await read(artifactId(c,'translation'));
   if(Buffer.byteLength(text)>900000)throw problem('publication_too_large');
   return S.advance(c,{stage:'verify',publicationId:artifactId(c,'translation')},[],async session=>{
    await Publication.findOneAndUpdate({_id:`${job.novelId}:${task.number}`},
     {$set:{artifactId:artifactId(c,'translation'),jobId:job._id,hash:S.hash(text)},$inc:{version:1}},{upsert:true,session});
   });
  }
  if(task.stage==='verify'){
   const pub=await Publication.findById(`${job.novelId}:${task.number}`);
   if(!pub||pub.artifactId!==task.publicationId)throw problem('publication_superseded');
   const text=await read(pub.artifactId),db=firestore();
   if(!db)throw problem('firestore_not_configured');
   await S.assertOwned(c);
   const ref=db.collection('novels').doc(String(job.novelId)).collection('chapters').doc(String(task.number));
   await db.runTransaction(async tx=>{
    const old=await tx.get(ref),data=old.exists?old.data():{};
    if((data.automationVersion||0)>pub.version)throw problem('publication_superseded');
    if(data.automationVersion===pub.version&&data.automationHash!==pub.hash)throw problem('publication_conflict');
    if(data.automationVersion===pub.version&&data.automationHash===pub.hash&&typeof data.content==='string'&&S.hash(data.content)===pub.hash)return;
    tx.set(ref,{content:text,automationVersion:pub.version,automationHash:pub.hash,lastUpdated:new Date()},{merge:true});
   });
   const snap=await ref.get();
   if(!snap.exists||snap.data().automationHash!==pub.hash||S.hash(snap.data().content)!==pub.hash)throw problem('publication_readback_failed',false);
   return S.advance(c,{state:'verified',stage:'done'},[],async session=>{
    await Mirror.updateOne({novelId:String(job.novelId),number:task.number},{$set:{content:text,updatedAt:new Date()}},{upsert:true,session});
    await Novel.updateOne({_id:job.novelId,'chapters.number':{$ne:task.number}},{$push:{chapters:{number:task.number,title:`الفصل ${task.number}`,views:0,createdAt:new Date()}}},{session});
    await Novel.updateOne({_id:job.novelId,status:'خاصة'},{$set:{status:'مستمرة'}},{session});
   });
  }
  throw problem('unknown_stage');
 }
 async function tick(kinds=['scrape','smart_translate','pure_translate','glossary_extract']){
  const invokedAt=Date.now();
  if(await require('./legacyState').active())return {ok:true,disabled:true,code:'legacy_jobs_require_reconciliation'};
  const c=await S.claim(kinds,{longWorker:deps.longWorker===true});
  if(!c){
   const waiting=await S.Job.find({engineVersion:2,kind:{$in:kinds},status:{$in:['queued','running','retry_wait']},...(deps.longWorker?{}:{workerClass:{$ne:'long'}})}).select('nextRunAt leaseUntil').sort({nextRunAt:1}).limit(50);
   const times=waiting.map(j=>Math.max(+j.nextRunAt,+j.leaseUntil)-Date.now()).filter(ms=>ms>0);
   return {ok:true,idle:true,...(times.length?{retryAfterMs:Math.min(...times)}:{})};
  }
  const start=Date.now();c.deadline=deps.longWorker?undefined:invokedAt+240000;let lost=false;
  const timer=setInterval(()=>S.heartbeat(c).catch(()=>{lost=true;}),20000);timer.unref?.();
  try{
   const r=await step(c);
   return {ok:true,progressed:true,completed:r?.completed===true,jobId:c.job.id,chapterNumber:c.task?.number,stage:c.task?.stage,durationMs:Date.now()-start};
  }catch(err){
   if(err.code==='stale_lease'||lost)return {ok:false,stale:true};
   if(err.accountSetupProviderId){
    await S.advance(c,{stage:'account_prepare'},[],session=>S.Job.updateOne(S.owned(c),{$set:{workerClass:'long','config.setupProviderId':err.accountSetupProviderId,'config.resumeStage':c.task.stage}},{session}));
    return {ok:true,progressed:false,requiresLongWorker:true};
   }
   if(!deps.longWorker&&(err.requiresLongWorker||(c.job.kind==='scrape'&&['TimeoutError','AbortError'].includes(err.name)))){
    await S.advance(c,{},[],session=>S.Job.updateOne(S.owned(c),{$set:{workerClass:'long'}},{session}));
    return {ok:true,progressed:false,requiresLongWorker:true};
   }
   const code=err.code||'step_temporarily_unavailable';
   try{await S.settle(c,code,{blocked:err.blocked===true,rotate:err.rotate,delayMs:err.delayMs||(code==='resource_busy'?5000:0)||Math.min(3600000,30000*2**Math.min(c.job.attempts,7))});}
   catch(e){if(e.code!=='stale_lease')throw e;}
   return {ok:false,jobId:c.job.id,code,retry:!err.blocked,retryAfterMs:code==='resource_busy'?5000:30000};
  }finally{clearInterval(timer);await S.release(c);}
 }
 return {tick,step,providerCall};
}
module.exports={createProcessor,parseTerms,problem,classify};
