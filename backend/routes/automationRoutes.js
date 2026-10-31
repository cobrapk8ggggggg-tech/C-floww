'use strict';
const crypto = require('node:crypto');
const AutomationJob = require('../models/automationJob.model');

const MAX_CHAPTERS = 2000;
const MAX_ATTEMPTS = 5;
const STEP_TIMEOUT_MS = 90_000;
const LEASE_MS = 150_000;
const RETRY_DELAYS = [30_000,120_000,300_000,900_000,1_800_000];

function validCoordinatorSecret(req) {
  const configured = process.env.AUTOMATION_SECRET;
  const provided = req.get('x-automation-secret') || '';
  if (!configured || !provided) return false;
  const a = Buffer.from(provided), b = Buffer.from(configured);
  return a.length === b.length && crypto.timingSafeEqual(a,b);
}
function chapterNumbers(body) {
  let chapters = body.chapters;
  if (!Array.isArray(chapters) && Number.isSafeInteger(body.startChapter) && Number.isSafeInteger(body.endChapter)) {
    const len = body.endChapter - body.startChapter + 1;
    if (len < 1 || len > MAX_CHAPTERS) throw new Error('Invalid chapter range');
    chapters = Array.from({length:len}, (_,i)=>body.startChapter+i);
  }
  if (!Array.isArray(chapters) || !chapters.length || chapters.length > MAX_CHAPTERS ||
      !chapters.every(n=>Number.isSafeInteger(n)&&n>0&&n<=1_000_000))
    throw new Error('Provide 1 to 2000 positive integer chapter numbers');
  return [...new Set(chapters)].sort((a,b)=>a-b);
}
function sourceUrl(value) {
  if (typeof value !== 'string' || value.length>2048) throw new Error('Invalid sourceUrl');
  let url;
  try {url = new URL(value);} catch {throw new Error('Invalid sourceUrl');}
  if (!['https:','http:'].includes(url.protocol) || !url.hostname.includes('.') ||
      url.username || url.password || url.port || url.hash ||
      /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url.hostname))
    throw new Error('Invalid sourceUrl');
  return url.toString();
}
function publicJob(job) {
  return {id:job.id,kind:job.kind,sourceUrl:job.sourceUrl,status:job.status,
    total:job.chapters.length,completed:job.successCount,currentChapter:job.chapters[job.cursor]??null,
    cursor:job.cursor,attempts:job.attempts,nextRunAt:job.nextRunAt,
    lastError:job.lastError,updatedAt:job.updatedAt,finishedAt:job.finishedAt};
}

module.exports = function addAutomationRoutes(app, verifyAdmin) {
  app.post('/api/automation/jobs',verifyAdmin,async(req,res)=>{
    try {
      const chapters = chapterNumbers(req.body||{});
      const url = sourceUrl(req.body?.sourceUrl);
      const email = typeof req.body?.adminEmail==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.adminEmail)
        ? req.body.adminEmail.slice(0,254) : 'system@auto';
      const job = await AutomationJob.create({sourceUrl:url,adminEmail:email,chapters});
      return res.status(201).json(publicJob(job));
    } catch(e) {return res.status(400).json({error:e.message});}
  });
  app.get('/api/automation/jobs',verifyAdmin,async(_req,res)=>{
    const jobs = await AutomationJob.find({}).sort({createdAt:-1}).limit(50);
    return res.json(jobs.map(publicJob));
  });
  app.get('/api/automation/jobs/:id',verifyAdmin,async(req,res)=>{
    if(!/^[a-f\d]{24}$/i.test(req.params.id)) return res.sendStatus(400);
    const job = await AutomationJob.findById(req.params.id);
    return job ? res.json(publicJob(job)) : res.sendStatus(404);
  });
  app.post('/api/automation/jobs/:id/:action',verifyAdmin,async(req,res)=>{
    const {id,action} = req.params;
    if (!/^[a-f\d]{24}$/i.test(id)||!['pause','resume'].includes(action))return res.sendStatus(400);
    const status = action==='pause'?'paused':'queued';
    const from = action==='pause'?['queued','running']:['paused','failed'];
    const job = await AutomationJob.findOneAndUpdate({_id:id,status:{$in:from}},{
      $set:{status,nextRunAt:new Date(),leaseUntil:new Date(0),leaseToken:'',attempts:0}
    },{new:true});
    return job?res.json(publicJob(job)):res.status(409).json({error:'Invalid transition'});
  });

  // Private Cloudflare cron endpoint. Exactly one chapter per invocation.
  app.post('/api/automation/worker/tick',async(req,res)=>{
    if (!validCoordinatorSecret(req)) return res.status(401).json({error:'Unauthorized'});
    const scraperUrl = process.env.SCRAPER_SERVICE_URL?.replace(/\/+$/,'');
    const scraperSecret = process.env.SCRAPER_API_SECRET || process.env.API_SECRET;
    if(!scraperUrl||!scraperSecret) return res.status(503).json({error:'Scraper connection not configured'});
    const now = new Date(), token = crypto.randomUUID();
    const job = await AutomationJob.findOneAndUpdate({
      status:{$in:['queued','running']},nextRunAt:{$lte:now},
      $or:[{leaseUntil:{$lte:now}},{leaseUntil:{$exists:false}}]
    },{
      $set:{status:'running',leaseToken:token,leaseUntil:new Date(Date.now()+LEASE_MS)}
    },{sort:{createdAt:1},new:true});
    if(!job) return res.json({ok:true,idle:true});
    const chapter = job.chapters[job.cursor], filter={_id:job._id,status:'running',leaseToken:token};
    if(chapter===undefined){
      await AutomationJob.updateOne(filter,{$set:{status:'completed',finishedAt:new Date(),leaseToken:''}});
      return res.json({ok:true,completed:true,jobId:job.id});
    }
    try {
      const response = await fetch(scraperUrl+'/automation/scrape-chapter',{
        method:'POST',headers:{'Content-Type':'application/json','Authorization':scraperSecret},
        body:JSON.stringify({sourceUrl:job.sourceUrl,chapterNumber:chapter,adminEmail:job.adminEmail}),
        signal:AbortSignal.timeout(STEP_TIMEOUT_MS)
      });
      const body = await response.json().catch(()=>({}));
      if (!response.ok||body.ok!==true) throw new Error('Scraper '+response.status+': '+String(body.error||'step failed').slice(0,220));
      const next=job.cursor+1,finished=next>=job.chapters.length;
      const changed=await AutomationJob.updateOne(filter,{
        $set:{cursor:next,status:finished?'completed':'queued',lastChapter:chapter,
          lastError:'',attempts:0,leaseToken:'',leaseUntil:new Date(0),nextRunAt:new Date(),
          ...(finished?{finishedAt:new Date()}: {})},
        $inc:{successCount:1}
      });
      return res.json({ok:changed.modifiedCount===1,jobId:job.id,chapterNumber:chapter,completed:finished});
    } catch(e) {
      const tries=job.attempts+1,permanent=tries>=MAX_ATTEMPTS;
      await AutomationJob.updateOne(filter,{$set:{
        attempts:tries,status:permanent?'failed':'queued',
        lastError:String(e.message||e).slice(0,500),
        nextRunAt:new Date(Date.now()+RETRY_DELAYS[Math.min(tries-1,RETRY_DELAYS.length-1)]),
        leaseToken:'',leaseUntil:new Date(0)
      }});
      return res.json({ok:false,jobId:job.id,chapterNumber:chapter,attempts:tries,retry:!permanent});
    }
  });

  // Opt-in durable pure translation: one real chapter per request.
  // Does not change legacy translator or glossary routes.
  app.post('/api/automation/worker/translate-tick',async(req,res)=>{
    if(!validCoordinatorSecret(req))return res.status(401).json({error:'Unauthorized'});
    if(process.env.DURABLE_PURE_TRANSLATION!=='true')
      return res.json({ok:true,disabled:true});
    const PureTranslationJob=require('../models/pureTranslationJob.model');
    const {processPureTranslationJob}=require('./pureTranslatorRoutes');
    const now=new Date(),token=crypto.randomUUID();
    const job=await PureTranslationJob.findOneAndUpdate({
      durableMode:true,status:'active',
      targetChapters:{$exists:true,$ne:[]},
      nextRunAt:{$lte:now},
      leaseUntil:{$lte:now}
    },{$set:{leaseToken:token,leaseUntil:new Date(Date.now()+360000)}},
      {sort:{createdAt:1},new:true});
    if(!job)return res.json({ok:true,idle:true});
    try {
      await processPureTranslationJob(job._id,{oneChapter:true});
    } catch(e) {
      console.error('Durable pure translation step error',e.message);
    }
    // Source worker owns chapter persistence and $pull from targetChapters.
    // Compare remaining chapters, not an in-memory success flag.
    const fresh=await PureTranslationJob.findById(job._id);
    if(!fresh)return res.status(500).json({ok:false,error:'Job disappeared'});
    if(fresh.leaseToken!==token)return res.json({ok:false,stale:true});
    if(fresh.status==='paused') {
      await PureTranslationJob.updateOne({_id:job._id,leaseToken:token},
        {$set:{leaseToken:'',leaseUntil:new Date(0)}});
      return res.json({ok:true,paused:true});
    }
    const before=(job.targetChapters||[]).length;
    const remaining=(fresh.targetChapters||[]).length;
    const progressed=remaining<before;
    const attempts=progressed?0:Math.min((fresh.attempts||0)+1,100);
    const seconds=progressed?0:Math.min(3600,Math.round(30*Math.pow(2,Math.min(attempts,7))));
    await PureTranslationJob.updateOne({_id:job._id,leaseToken:token},{$set:{
      leaseToken:'',leaseUntil:new Date(0),attempts,
      lastError:progressed?'':('No durable chapter progress after attempt '+attempts),
      nextRunAt:new Date(Date.now()+seconds*1000),
      status:remaining===0?'completed':'active'
    }});
    return res.json({ok:true,jobId:job.id,progressed,remaining,retryInSeconds:seconds});
  });

};
module.exports.__test = {chapterNumbers,sourceUrl,validCoordinatorSecret};
