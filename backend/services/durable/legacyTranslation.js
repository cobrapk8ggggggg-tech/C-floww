'use strict';
const Receipt=require('../../models/importChapter.model');
const deadline=require('./deadline');

const staleAfterMs=6*60*1000;
const wasInterrupted=(job,now=Date.now())=>job.status==='active'&&
 now-+new Date(job.updatedAt||job.lastUpdate||job.startTime)>staleAfterMs;

function configuredProviders(settings){
 const providers=[...(settings?.translationProviders||[])].sort((a,b)=>(a.priority||0)-(b.priority||0));
 if(providers.length||!settings?.translatorApiKeys?.length)return providers;
 const model=settings.translatorModel||'gemini-2.5-flash';
 return [{providerId:'gemini',name:'Gemini (Legacy)',baseUrl:'',selectedModel:model,apiKeys:settings.translatorApiKeys}];
}

// Legacy functions wrote Firestore and the chapter index before recording job progress.
// Recover at most the first pending chapter, and require evidence from the current run.
async function recoverSavedFirst(job,novel,chapters,firestore){
 if(!firestore||!chapters.length)return null;
 const number=chapters[0],published=novel.chapters?.find(c=>c.number===number);
 if(!published||!job.logs?.length)return null;
 const started=+new Date(job.startTime||job.createdAt);
 if(!Number.isFinite(started))return null;
 const ref=firestore.collection('novels').doc(String(novel._id)).collection('chapters').doc(String(number));
 const snapshot=await deadline(6000,()=>ref.get());
 if(!snapshot.exists)return null;
 const saved=snapshot.data();
 const time=+new Date(saved.lastUpdated?.toDate?.()||saved.lastUpdated);
 const text=saved.content;
 if(!Number.isFinite(time)||time<started||typeof text!=='string')return null;
 const letters=text.match(/\p{Letter}/gu)?.length||0;
 const arabic=text.match(/\p{Script=Arabic}/gu)?.length||0;
 if(arabic<50||arabic<letters*0.7)return null;
 const original=await Receipt.findOne({novelId:novel._id,number,persisted:true}).select('content').lean();
 if(original?.content===text||saved.originalContent===text)return null;
 const reference=new RegExp(`(?:الفصل|فصل)\\s+${number}(?!\\d)`);
 const confirmedByLog=job.logs.some(log=>log.type==='success'&&reference.test(log.message||'')&&
  /تم (?:إضافة|تحديث|إنجاز|حفظ)/.test(log.message||'')&&+new Date(log.timestamp)>=started);
 const indexedDuringJob=+new Date(published.createdAt)>=started;
 if(!confirmedByLog&&!indexedDuringJob)return null;
 return number;
}
module.exports={staleAfterMs,wasInterrupted,configuredProviders,recoverSavedFirst};
