'use strict';
// Synthetic 300-chapter soak test with a real disposable MongoDB (GitHub Actions service).
// No novel websites, credentials, or paid AI calls.
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const express=require('../backend/node_modules/express');
const mongoose=require('../backend/node_modules/mongoose');
const Job=require('../backend/models/automationJob.model');
const mount=require('../backend/routes/automationRoutes');
const uri=process.env.AUTOMATION_TEST_MONGO_URI;

const start=server=>new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port));
});
const stop=server=>new Promise(resolve=>server.close(resolve));
test('300 chapters complete through stateless ticks, temporary failures and a backend restart',
  {skip:!uri,timeout:180000},async()=>{
  const previous={AUTOMATION_SECRET:process.env.AUTOMATION_SECRET,
    SCRAPER_SERVICE_URL:process.env.SCRAPER_SERVICE_URL,
    SCRAPER_API_SECRET:process.env.SCRAPER_API_SECRET};
  const secret='synthetic-queue-test-only';
  let server, scraper;
  const seen=new Map();
  let completed=0,failures=0;
  try {
    await mongoose.connect(uri,{dbName:'zeus_load_'+Date.now(),serverSelectionTimeoutMS:10000});
    scraper=http.createServer((req,res)=>{
      let raw='';
      req.on('data',b=>raw+=b);
      req.on('end',()=>{
        const n=JSON.parse(raw).chapterNumber;
        const count=(seen.get(n)||0)+1;seen.set(n,count);
        res.setHeader('Content-Type','application/json');
        if(n%75===0 && count===1){res.statusCode=503;res.end(JSON.stringify({error:'transient'}));}
        else {res.end(JSON.stringify({ok:true,status:'saved',receiptId:'test-receipt',chapterNumber:n}));}
      });
    });
    process.env.SCRAPER_SERVICE_URL=await start(scraper);
    process.env.SCRAPER_API_SECRET='synthetic-scraper-test-only';
    process.env.AUTOMATION_SECRET=secret;
    const boot=async()=>{
      const app=express();app.use(express.json());mount(app,(_req,_res,next)=>next());
      server=http.createServer(app);return start(server);
    };
    let url=await boot();
    const post=async(path,data,auth)=>{
      const response=await fetch(url+path,{method:'POST',
        headers:{'Content-Type':'application/json',...(auth?{'x-automation-secret':secret}:{})},
        body:JSON.stringify(data),signal:AbortSignal.timeout(12000)});
      return response.json();
    };
    const created=await post('/api/automation/jobs',{sourceUrl:'https://novelfire.net/fiction',
      startChapter:1,endChapter:300},false);
    assert.equal(created.total,300);
    const id=created.id;
    let restarted=false;
    for(let n=0;n<325;n++){
      if(!restarted && completed>=150){
        await stop(server);url=await boot();restarted=true;
      }
      const result=await post('/api/automation/worker/tick',{},true);
      if(result.retry){
        failures++;
        await Job.updateOne({_id:id},{$set:{nextRunAt:new Date(0)}});
      }else if(result.chapterNumber){
        completed++;
        assert.equal(result.chapterNumber,completed);
      }else if(result.idle){
        break;
      }else throw Error('Unexpected tick response: '+JSON.stringify(result));
    }
    const state=await Job.findById(id);
    assert.equal(state.status,'completed');
    assert.equal(state.cursor,300);
    assert.equal(state.successCount,300);
    assert.equal(completed,300);
    assert.equal(failures,4);
    assert.equal(restarted,true);
    assert.equal(seen.size,300);
  }finally{
    if(server?.listening)await stop(server);
    if(scraper?.listening)await stop(scraper);
    try{await mongoose.connection.dropDatabase()}catch{}
    await mongoose.disconnect();
    for(const [key,value] of Object.entries(previous))
      if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});
