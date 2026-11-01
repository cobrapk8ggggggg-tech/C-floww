'use strict';
const crypto = require('node:crypto');
const {sourceUrl} = require('./automationRoutes').__test;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const key = (source, number) => hash(source+'\n'+number);

// Dependency injection also lets the contract run against an isolated MongoDB.
module.exports = function mount(app, deps = {}) {
  const Receipt = deps.Receipt || require('../models/importChapter.model');
  const Novel = deps.Novel || require('../models/novel.model');
  const Mirror = deps.Mirror || require('../models/chapterContentMirror.model');
  const firestore = deps.firestore || require('../config/firebaseAdmin').db;
  function auth(req,res,next) {
    const expected = process.env.SCRAPER_API_SECRET;
    const actual = req.get('authorization') || '';
    if (!expected) return res.status(503).json({error:'Scraper credential not configured'});
    const a=Buffer.from(actual), b=Buffer.from(expected);
    if(a.length!==b.length || !crypto.timingSafeEqual(a,b))return res.sendStatus(403);
    const ingest=process.env.AUTOMATION_INGEST_SECRET, supplied=req.get('x-automation-ingest-secret')||'';
    if(!ingest)return res.status(503).json({error:'Ingest credential not configured'});
    const x=Buffer.from(ingest),y=Buffer.from(supplied);
    if(x.length!==y.length||!crypto.timingSafeEqual(x,y))return res.sendStatus(403);
    if(!firestore)return res.status(503).json({error:'Isolated Firestore unavailable'});
    next();
  }
  const refFor = r => firestore.collection('novels').doc(String(r.novelId))
    .collection('chapters').doc(String(r.number));
  async function verify(r) {
    if(!r || !r.persisted || !r.content.trim() || hash(r.content)!==r.contentHash)return false;
    const snap=await refFor(r).get();
    // A translated document may have a different content, but must retain its import marker.
    return snap.exists && snap.data().importHash===r.contentHash &&
      typeof snap.data().content==='string' && !!snap.data().content.trim();
  }
  async function persistReceipt(r) {
    if(!r || hash(r.content)!==r.contentHash)throw new Error('Invalid original checkpoint');
      const ref=refFor(r);
      await firestore.runTransaction(async tx=>{
        const snap=await tx.get(ref);
        if(snap.exists) {
          if(snap.data().importHash!==r.contentHash)throw new Error('Existing content conflict');
          if(typeof snap.data().content!=='string'||!snap.data().content.trim())throw new Error('Stored content empty');
        } else tx.create(ref,{title:r.title,content:r.content,importHash:r.contentHash,lastUpdated:new Date()});
      });
      const saved=await ref.get();
      if(!saved.exists || saved.data().importHash!==r.contentHash || !saved.data().content?.trim())
        throw new Error('Readback failed');
      await Mirror.updateOne({novelId:String(r.novelId),number:r.number},
        {$set:{content:saved.data().content,updatedAt:new Date()}},{upsert:true,writeConcern:{w:'majority'}});
      await Novel.updateOne({_id:r.novelId},{$max:{sourceChaptersCount:r.number}});
      await Receipt.updateOne({_id:r.id},{$set:{persisted:true}},{writeConcern:{w:'majority'}});
  }
  app.post('/api/automation/chapters/recover',auth,async(req,res)=>{
    try {
      const source=sourceUrl(req.body.sourceUrl),n=req.body.chapterNumber;
      if(!Number.isSafeInteger(n)||n<1||n>1_000_000)return res.sendStatus(400);
      const r=await Receipt.findById(key(source,n));
      if(!r)return res.sendStatus(404);
      await persistReceipt(r);
      res.json({ok:true,persisted:true,chapterNumber:n,receiptId:r.id,novelId:String(r.novelId)});
    }catch{return res.status(503).json({error:'Checkpoint reconciliation unavailable'});}
  });
  app.post('/api/automation/chapters/check',auth,async(req,res)=>{
    try {
      const source=sourceUrl(req.body.sourceUrl), n=req.body.chapterNumber;
      if(!Number.isSafeInteger(n)||n<1||n>1_000_000)return res.sendStatus(400);
      const r=await Receipt.findById(key(source,n));
      return res.json({ok:true,persisted:await verify(r),chapterNumber:n,
        ...(r?{novelId:String(r.novelId),receiptId:r.id}: {})});
    }catch {return res.status(503).json({error:'Persistence verification unavailable'});}
  });
  app.post('/api/automation/chapters/import',auth,async(req,res)=>{
    try {
      const {novelData,chapter}=req.body;
      const source=sourceUrl(req.body.sourceUrl), n=chapter?.number;
      if(!novelData || typeof novelData.title!=='string' || !novelData.title.trim() ||
        !Number.isSafeInteger(n)||n<1||n>1_000_000 || typeof chapter.content!=='string' ||
        !chapter.content.trim() || Buffer.byteLength(chapter.content)>900_000 ||
        typeof chapter.title!=='string' || !chapter.title.trim())return res.sendStatus(400);
      // Do not match by title: different novels/sources may have identical titles.
      const candidates=await Novel.find({sourceUrl:source}).select('_id').limit(2);
      if(candidates.length>1)throw new Error('Ambiguous existing source identity');
      const novelId=candidates[0]?._id || hash('automation-novel\n'+source).slice(0,24);
      const owner=req.body.jobId && /^[a-f\d]{24}$/i.test(req.body.jobId)
        ? await require('../models/automationJob.model').findOne({_id:req.body.jobId,sourceUrl:source,engineVersion:2}) : null;
      await Novel.updateOne({_id:novelId},{$setOnInsert:{title:novelData.title,
        titleEn:novelData.title,author:'System Scraper',authorEmail:'system@scraper',
        ...(owner && /^[a-f\d]{24}$/i.test(owner.ownerId)?{authorId:owner.ownerId}:{}),
        description:novelData.description || '',status:'خاصة',sourceUrl:source,
        isWatched:false,chapters:[]}}, {upsert:true,runValidators:true,writeConcern:{w:'majority'}});
      const id=key(source,n);
      // Concurrent deliveries adopt the same immutable original, never overwrite a translation.
      try {
        await Receipt.updateOne({_id:id},{$setOnInsert:{sourceUrl:source,number:n,novelId,
          title:chapter.title,content:chapter.content,contentHash:hash(chapter.content),persisted:false}},
          {upsert:true,runValidators:true,writeConcern:{w:'majority'}});
      } catch(e) {if(e.code!==11000)throw e;}
      const r=await Receipt.findById(id);
      if(!r || hash(r.content)!==r.contentHash)throw new Error('Invalid original checkpoint');
      await persistReceipt(r);
      if(owner)await require('../models/automationJob.model').updateOne({_id:owner._id},{$set:{label:novelData.title.slice(0,300),novelId:r.novelId}});
      return res.json({ok:true,persisted:true,chapterNumber:n,receiptId:id,novelId:String(r.novelId)});
    }catch {return res.status(503).json({error:'Chapter persistence incomplete; safe to retry'});}
  });
};
module.exports.__test={hash,key};
