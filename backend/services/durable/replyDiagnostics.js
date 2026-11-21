'use strict';
const S=require('./store');
const {durableUnits,parseCoveredReply,parseDurableReply}=require('../completeTranslation.service');

async function replyDiagnostics(job){
 const task=await S.Task.findOne({jobId:job._id,state:'pending'}).sort({ordinal:1});
 if(!task)return null;
 const source=await S.Artifact.findById(task.id+':source').select('text').lean();
 const unit=source&&durableUnits(source.text,job.config?.chunkSize||2400,task.groupFrom)[task.unit];
 if(!unit)return {chapter:task.number,stage:task.stage,unit:task.unit+1};
 const nonce=S.hash(task.id+':'+task.unit).slice(0,12);
 const start=`[[${nonce}_${unit.id}]]`,end=`[[END_${nonce}]]`;
 const replies=await S.Call.find({taskId:task._id,state:'received',operation:{$regex:`:translate:${task.unit}:repair:`}})
  .select('providerId reply').sort({createdAt:-1}).limit(6).lean();
 return {chapter:task.number,stage:task.stage,unit:task.unit+1,units:task.units,sourceCharacters:unit.text.length,
  sourceIsCjk:/\p{Script=Han}/u.test(unit.text),replies:replies.map(({providerId,reply})=>{
   const value=String(reply||'').trim();
   let coverage='accepted';
   try{parseCoveredReply(value,[unit],nonce);}catch(error){
    coverage=error.message.startsWith('Missing translation end')?'missing_end':error.message.startsWith('Missing, repeated')?'invalid_units':
     error.message.startsWith('Unexpected text')?'unexpected_prefix':'incomplete_text';
   }
   let recoverable=false;
   try{parseDurableReply(value,unit,nonce);recoverable=true;}catch{/* The reply stays private. */}
   return {providerId,characters:value.length,arabicWords:(value.match(/[\u0621-\u064a]+/g)||[]).length,recoverable,
    correctStart:value.includes(start),correctEnd:value.includes(end),allInsideFence:/^```[^\r\n]*\r?\n[\s\S]+\r?\n```$/.test(value),
    markupLike:/\[\[|```|<\/?\w+>/.test(value),protocolWord:/END[_ ]|NNNNNN/i.test(value),coverage};
  })};
}

module.exports=replyDiagnostics;
