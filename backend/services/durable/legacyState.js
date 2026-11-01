'use strict';
const names=['translationJob','pureTranslationJob','glossaryExtractionJob','chapterScraperJob'];
async function report(){
 const rows=await Promise.all(names.map(async name=>({kind:name,jobs:await require('../../models/'+name+'.model').find({status:'active'}).select('_id novelId targetChapters currentChapter').limit(100).lean()})));
 const source=await require('../../models/automationJob.model').find({engineVersion:{$ne:2},status:{$in:['queued','running']}}).select('_id novelId chapters cursor').limit(100).lean();
 rows.push({kind:'legacyScrape',jobs:source.map(j=>({...j,currentChapter:j.chapters[j.cursor]??null,targetChapters:j.chapters.slice(j.cursor)}))});
 return {safeToEnable:rows.every(x=>x.jobs.length===0),collections:rows.map(x=>({kind:x.kind,jobs:x.jobs.map(j=>({id:String(j._id),novelId:String(j.novelId),remainingKnown:j.targetChapters?.length??null,currentChapter:j.currentChapter??null}))}))};
}
async function active(){
 const checks=names.map(name=>require('../../models/'+name+'.model').exists({status:'active'}));
 checks.push(require('../../models/automationJob.model').exists({engineVersion:{$ne:2},status:{$in:['queued','running']}}));
 return (await Promise.all(checks)).some(Boolean);
}
module.exports={report,active};
