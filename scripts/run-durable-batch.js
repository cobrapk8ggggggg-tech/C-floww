'use strict';
const mongoose=require('../backend/node_modules/mongoose');
const {createProcessor}=require('../backend/services/durable/processor');
const {mongoDatabase}=require('../backend/config/automationIsolation');
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
async function run({tick,minutes=45,limit=10000,stop=()=>stopping,report=console.log,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const started=Date.now();let steps=0;
 while(!stop()&&steps<limit&&Date.now()-started<(minutes*60-300)*1000){
  const r=await tick();
  if(r.disabled)break;
  if(r.idle){
   if(r.retryAfterMs>0&&r.retryAfterMs<=60000){await wait(r.retryAfterMs);continue;}
   break;
  }
  steps++;
  if(r.retry&&!r.retryAfterMs)break;
  // Blocked jobs are excluded by MongoDB; continue other independent jobs.
 }
 report(JSON.stringify({steps,durationMs:Date.now()-started,rssBytes:process.memoryUsage().rss,cpu:process.cpuUsage()}));
 return steps;
}
if(require.main===module)(async()=>{
 if(process.env.ZEUS_BATCH_ENABLED!=='true')throw Error('ZEUS_BATCH_ENABLED is required');
 if(!process.env.MONGODB_URI)throw Error('MongoDB is not configured');
 await mongoose.connect(process.env.MONGODB_URI,require('../backend/config/mongoOptions')(mongoDatabase()));
 try{await run({tick:createProcessor({longWorker:true,...(process.env.ZEUS_SCRAPER_ROOT?{scrape:require('./python-scrape-step')}:{})}).tick});}finally{await mongoose.disconnect();}
})().catch(()=>{console.error('Batch worker stopped; inspect persisted job error codes');process.exitCode=1;});
module.exports={run};
