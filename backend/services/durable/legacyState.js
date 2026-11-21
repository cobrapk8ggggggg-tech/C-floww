'use strict';
const names=['translationJob','pureTranslationJob','glossaryExtractionJob','chapterScraperJob'];
const Novel=require('../../models/novel.model');
const Job=require('../../models/automationJob.model');
const model=name=>require('../../models/'+name+'.model');
const legacyScrape={engineVersion:{$ne:2},status:{$in:['queued','running']}};
async function report(){
 const rows=await Promise.all(names.map(async name=>({kind:name,jobs:await require('../../models/'+name+'.model').find({status:'active'}).select('_id novelId targetChapters currentChapter').limit(100).lean()})));
 const source=await Job.find(legacyScrape).select('_id novelId chapters cursor').limit(100).lean();
 rows.push({kind:'legacyScrape',jobs:source.map(j=>({...j,currentChapter:j.chapters[j.cursor]??null,targetChapters:j.chapters.slice(j.cursor)}))});
 return {safeToEnable:rows.every(x=>x.jobs.length===0),collections:rows.map(x=>({kind:x.kind,jobs:x.jobs.map(j=>({id:String(j._id),novelId:String(j.novelId),remainingKnown:j.targetChapters?.length??null,currentChapter:j.currentChapter??null}))}))};
}
async function active(){
 const checks=names.map(name=>require('../../models/'+name+'.model').exists({status:'active'}));
 checks.push(Job.exists(legacyScrape));
 return (await Promise.all(checks)).some(Boolean);
}
async function executionPolicy(kinds){
 const [oldScrape,oldTitleScrape,...activeTranslations]=await Promise.all([
  Job.exists(legacyScrape),
  model('chapterScraperJob').exists({status:'active'}),
  ...names.slice(0,3).map(name=>model(name).distinct('novelId',{status:'active'}))
 ]);
 if(oldScrape||oldTitleScrape)return {kinds:[],scope:{}};
 const novelIds=[...new Set(activeTranslations.flat().map(String))];
 if(!novelIds.length)return {kinds,scope:{}};
 // Leave new translations paused until reconciliation. Allow scrapes on
 // unrelated novels, including jobs whose novelId will be discovered on import.
 const sourceUrls=await Novel.distinct('sourceUrl',{_id:{$in:novelIds},sourceUrl:{$type:'string'}});
 return {kinds:kinds.filter(kind=>kind==='scrape'),scope:{
  novelId:{$nin:novelIds},sourceUrl:{$nin:sourceUrls}
 }};
}
module.exports={report,active,executionPolicy};
