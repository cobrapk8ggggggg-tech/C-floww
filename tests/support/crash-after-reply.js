'use strict';
const mongoose=require('../../backend/node_modules/mongoose');
const S=require('../../backend/services/durable/store');
const {createProcessor}=require('../../backend/services/durable/processor');
(async()=>{
 if(!/^zeus_automation_/.test(process.env.ZEUS_TEST_DB||''))throw Error('isolated test only');
 await mongoose.connect(process.env.AUTOMATION_TEST_REPLICA_URI,{dbName:process.env.ZEUS_TEST_DB});
 const p=createProcessor({ai:{getTokenConversationScope:()=> 'test'},route:async()=>({provider:{providerId:'test'},model:'test',free:true,account:'test-account'}),
  provider:async prompt=>{const m=prompt.match(/\[\[([a-f0-9]{12})_(\d{6})\]\]/);return `[[${m[1]}_${m[2]}]]\n${'هذه ترجمة كاملة للفصل تحافظ على جميع الأحداث والحوار دون حذف أو اختصار. '.repeat(20)}\n[[END_${m[1]}]]`;}});
 const claim=await S.claim(['pure_translate']);
 S.advance=async()=>process.exit(73); // Abrupt process death after MongoDB raw-response commit.
 await p.step(claim);
 throw Error('Crash boundary not reached');
})().catch(()=>process.exit(74));
