'use strict';
const crypto=require('node:crypto');
const auth=require('../services/automationIngestAuth');
const prepareScrapedNovel=require('../services/scrapedNovel.service');
const {Catalog,CatalogChapter}=require('../models/automationCatalog.model');
const Job=require('../models/automationJob.model');
const Novel=require('../models/novel.model');
const {sourceUrl}=require('./automationRoutes').__test;
const catalogId=(url,job)=>crypto.createHash('sha256').update(url+'\n'+(job==='legacy'?'legacy:'+Math.floor(Date.now()/300000):job)).digest('hex');
module.exports=function(app){
 for(const action of ['check','save'])app.post('/api/automation/catalog/'+action,auth,async(req,res)=>{
  try{
   const source=sourceUrl(req.body.sourceUrl),job=req.body.jobId||'legacy';
   if(typeof job!=='string'||!/^(legacy|[a-f\d]{24})$/i.test(job))return res.sendStatus(400);
   const id=catalogId(source,job);
   if(action==='check'){
    const c=await Catalog.findById(id);
    if(!c?.ready)return res.json({ok:true,ready:false});
    const n=req.body.chapterNumber;
    if(!Number.isSafeInteger(n)||n<1)return res.sendStatus(400);
    const chapter=await CatalogChapter.findOne({catalogId:id,number:n}).select('number title url -_id').lean();
    return res.json({ok:true,ready:true,metadata:c.metadata,chapter});
   }
   const {metadata,chapters,total}=req.body;
   if(!metadata||typeof metadata.title!=='string'||!metadata.title.trim()||!Number.isSafeInteger(total)||total<1||total>100000||
     !Array.isArray(chapters)||chapters.length>100||!chapters.every(c=>Number.isSafeInteger(c.number)&&c.number>0&&typeof c.url==='string'&&c.url.length<=2048))return res.sendStatus(400);
   const current=await Catalog.findById(id);if(current&&current.total!==total)return res.status(409).json({error:'Catalog count conflict'});if(current?.ready)return res.json({ok:true,ready:true});
   await Catalog.updateOne({_id:id},{$setOnInsert:{sourceUrl:source,jobId:job,metadata,total,ready:false}},{upsert:true});
   if(chapters.length)await CatalogChapter.bulkWrite(chapters.map(c=>({updateOne:{filter:{catalogId:id,number:c.number},update:{$setOnInsert:{number:c.number,title:String(c.title||'').slice(0,1000),url:c.url,catalogId:id}},upsert:true}})));
   const count=await CatalogChapter.countDocuments({catalogId:id});
   const ready=count===total;
   if(count>total)return res.status(409).json({error:'Catalog identity conflict'});
   if(count>0&&job!=='legacy'){
    const owner=await Job.findOne({_id:job,engineVersion:2,kind:'scrape',sourceUrl:source,status:{$in:['queued','running','retry_wait']}});
    if(owner&&(!owner.novelId||owner.label===source)){
     const snapshot=current?.metadata||metadata;
     const novelId=await prepareScrapedNovel(Novel,source,snapshot,owner);
     await Job.updateOne({_id:owner._id},{$set:{novelId,label:snapshot.title.slice(0,300)}},{writeConcern:{w:'majority'}});
    }
   }
   if(ready)await Catalog.updateOne({_id:id,total},{$set:{ready:true}});
   return res.json({ok:true,ready});
  }catch{return res.status(503).json({error:'Catalog persistence unavailable'});}
 });
};
