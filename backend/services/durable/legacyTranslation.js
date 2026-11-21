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

function hasForeignSource(text){
 if(typeof text!=='string')return false;
 const letters=text.match(/\p{Letter}/gu)?.length||0;
 const arabic=text.match(/\p{Script=Arabic}/gu)?.length||0;
 return letters>=50&&arabic<letters*0.2;
}

// Legacy functions wrote Firestore and the chapter index before recording job progress.
// Recover at most the first pending chapter from persisted translation evidence.
async function recoverSavedFirst(job,novel,chapters,firestore){
 if(!firestore||!chapters.length)return null;
 const number=chapters[0],published=novel?.chapters?.find(c=>c.number===number);
 if(!published||!job.logs?.length)return null;
 const started=+new Date(job.startTime||job.createdAt);
 if(!Number.isFinite(started))return null;
 const ref=firestore.collection('novels').doc(String(novel._id)).collection('chapters').doc(String(number));
 const snapshot=await deadline(6000,()=>ref.get());
 if(!snapshot.exists)return null;
 const saved=snapshot.data();
 const time=+new Date(saved.lastUpdated?.toDate?.()||saved.lastUpdated);
 const text=saved.content;
 if(typeof text!=='string')return null;
 const letters=text.match(/\p{Letter}/gu)?.length||0;
 const arabic=text.match(/\p{Script=Arabic}/gu)?.length||0;
 if(arabic<50||arabic<letters*0.7)return null;
 // Verify an earlier completed publication if a separate foreign original
 // survives. Its date can predate the interrupted attempt.
 const original=await Receipt.findOne({novelId:novel._id,number,persisted:true}).select('content').lean();
 if(original?.content===text||saved.originalContent===text)return null;
 if(hasForeignSource(original?.content)||hasForeignSource(saved.originalContent))return number;
 const reference=new RegExp(`(?:الفصل|فصل)\\s+${number}(?!\\d)`);
 const confirmedByLog=job.logs.some(log=>log.type==='success'&&reference.test(log.message||'')&&
  /تم (?:إضافة|تحديث|إنجاز|حفظ)/.test(log.message||'')&&+new Date(log.timestamp)>=started);
 const indexedDuringJob=+new Date(published.createdAt)>=started;
 if(Number.isFinite(time)&&time>=started&&(confirmedByLog||indexedDuringJob))return number;
 // Some legacy imports have no original receipt. Corroborate their saved
 // publication with the attempt log and the language of the next chapter.
 const attempted=job.logs.findIndex(log=>reference.test(log.message||'')&&+new Date(log.timestamp)>=started);
 const translated=attempted>=0&&job.logs.slice(attempted+1).some(log=>log.type==='success'&&
  /نجحت الترجمة والمراجعة/.test(log.message||''));
 if(translated&&chapters.length>1){
  const next=await deadline(6000,()=>firestore.collection('novels').doc(String(novel._id))
   .collection('chapters').doc(String(chapters[1])).get());
  const source=next.exists?next.data().content:null;
  if(typeof source==='string'&&hasForeignSource(source)&&
   (source.match(/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length||0)>=50)return number;
 }
 return null;
}
module.exports={staleAfterMs,wasInterrupted,configuredProviders,recoverSavedFirst};
