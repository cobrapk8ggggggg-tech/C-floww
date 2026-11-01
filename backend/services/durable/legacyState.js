'use strict';
const names=['translationJob','pureTranslationJob','glossaryExtractionJob','chapterScraperJob'];
async function report(){
 const rows=await Promise.all(names.map(async name=>({kind:name,jobs:await require('../../models/'+name+'.model').find({status:'active'}).select('_id novelId targetChapters currentChapter').limit(100).lean()})));
 return {safeToEnable:rows.every(x=>x.jobs.length===0),collections:rows.map(x=>({kind:x.kind,jobs:x.jobs.map(j=>({id:String(j._id),novelId:String(j.novelId),remainingKnown:j.targetChapters?.length??null,currentChapter:j.currentChapter??null}))}))};
}
async function active(){const r=await Promise.all(names.map(name=>require('../../models/'+name+'.model').exists({status:'active'})));return r.some(Boolean);}
module.exports={report,active};
