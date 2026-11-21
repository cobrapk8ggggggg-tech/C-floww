'use strict';
const {Catalog,CatalogChapter,catalogId}=require('../../models/automationCatalog.model');
const Novel=require('../../models/novel.model');
const Receipt=require('../../models/importChapter.model');
const deadline=require('./deadline');
const LIMIT=2000;

function parseScrapeSelection(spec,missingOnly=false){
 if(typeof spec!=='string'||spec.length>1200)throw Object.assign(Error('invalid_scrape_selection'),{status:400});
 const ranges=spec.trim()?spec.trim().split(/[,،]/).map(entry=>{
  const match=entry.trim().match(/^(\d{1,7})(?:\s*-\s*(\d{1,7}|!|آخر|last|end))?$/i);
  if(!match)throw Object.assign(Error('invalid_scrape_selection'),{status:400});
  const first=Number(match[1]),last=match[2]===undefined?first:/^\d+$/.test(match[2])?Number(match[2]):null;
  if(!first||first>1_000_000||(last!==null&&(!last||last>1_000_000)))throw Object.assign(Error('invalid_scrape_selection'),{status:400});
  return last===null?[first,null]:[Math.min(first,last),Math.max(first,last)];
 }):[];
 if(!ranges.length||ranges.some(([,last])=>last===null)||missingOnly)return {chapters:[],catalogPlan:{ranges,missingOnly:true}};
 const numbers=new Set();
 for(const [first,last] of ranges){
  if(last-first>=LIMIT)throw Object.assign(Error('scrape_selection_too_large'),{status:400});
  for(let n=first;n<=last;n++)numbers.add(n);
  if(numbers.size>LIMIT)throw Object.assign(Error('scrape_selection_too_large'),{status:400});
 }
 return {chapters:[...numbers].sort((a,b)=>a-b)};
}

async function chaptersFromCatalog(job,firestore){
 const id=catalogId(job.sourceUrl,job.id);
 if(!await Catalog.exists({_id:id,ready:true}))throw Object.assign(Error('catalog_not_saved'),{code:'catalog_not_saved'});
 const {ranges,missingOnly}=job.config.catalogPlan;
 const query={catalogId:id};
 if(ranges.length)query.$or=ranges.map(([first,last])=>({number:{$gte:first,...(last===null?{}:{$lte:last})}}));
 if(missingOnly){
  const novel=await Novel.findOne({sourceUrl:job.sourceUrl}).select('_id chapters.number').lean();
  if(novel){
   const known=new Set((novel.chapters||[]).map(c=>c.number));
   for(const n of await Receipt.distinct('number',{novelId:novel._id,persisted:true}))known.add(n);
   if(!firestore)throw Object.assign(Error('firestore_not_configured'),{code:'firestore_not_configured',blocked:true});
   const refs=await deadline(20000,()=>firestore.collection('novels').doc(String(novel._id)).collection('chapters').listDocuments());
   for(const ref of refs)if(/^[1-9]\d{0,6}$/.test(ref.id))known.add(Number(ref.id));
   if(known.size)query.number={$nin:[...known]};
  }
 }
 const result=(await CatalogChapter.find(query).select('number -_id').sort({number:1}).limit(LIMIT+1).lean()).map(c=>c.number);
 if(result.length>LIMIT){
  if(job.config.watchSweep)return result.slice(0,LIMIT);
  throw Object.assign(Error('scrape_selection_too_large'),{code:'scrape_selection_too_large',blocked:true});
 }
 return result;
}
module.exports={parseScrapeSelection,chaptersFromCatalog};
