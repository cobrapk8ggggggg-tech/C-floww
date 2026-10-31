'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('../backend/node_modules/express');
const mongoose = require('../backend/node_modules/mongoose');
const AutomationJob = require('../backend/models/automationJob.model');
const mountRoutes = require('../backend/routes/automationRoutes');

const uri = process.env.AUTOMATION_TEST_MONGO_URI;

async function listen(server) {
  await new Promise((resolve,reject) => {
    server.once('error',reject); server.listen(0,'127.0.0.1',resolve);
  });
  return 'http://127.0.0.1:'+server.address().port;
}
async function close(server) {
  if(server.listening) await new Promise(resolve=>server.close(resolve));
}
test('MongoDB durable scraping: retry, checkpoints, leases, pause/resume', {skip: !uri}, async () => {
  const dbName='zeus_automation_'+Date.now();
  const old = {AUTOMATION_SECRET:process.env.AUTOMATION_SECRET,
    SCRAPER_SERVICE_URL:process.env.SCRAPER_SERVICE_URL,
    SCRAPER_API_SECRET:process.env.SCRAPER_API_SECRET};
  const secret = 'unit-test-coordinator-secret-not-for-production';
  process.env.AUTOMATION_SECRET=secret;
  process.env.SCRAPER_API_SECRET='unit-test-scraper-secret-not-for-production';
  let requests = 0;
  const scraper=http.createServer((req,res)=>{
    requests++;
    let raw='';
    req.on('data',b=>raw+=b);
    req.on('end',()=>{
      assert.equal(req.headers.authorization,process.env.SCRAPER_API_SECRET);
      const chapter = JSON.parse(raw).chapterNumber;
      res.setHeader('content-type','application/json');
      if(requests===1){res.statusCode=503;res.end(JSON.stringify({error:'transient'}));}
      else res.end(JSON.stringify({ok:true,status:'saved',chapterNumber:chapter}));
    });
  });
  let backend;
  try {
    await mongoose.connect(uri,{dbName,serverSelectionTimeoutMS:10000});
    const scraperUrl = await listen(scraper);
    process.env.SCRAPER_SERVICE_URL=scraperUrl;
    const app=express();
    app.use(express.json());
    mountRoutes(app,(_req,_res,next)=>next());
    backend = http.createServer(app);
    const base=await listen(backend);
    const send=async(path,body={},headers={})=>{
      const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},
        body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
      return {status:res.status,json:await res.json()};
    };
    const unauth=await send('/api/automation/worker/tick');
    assert.equal(unauth.status,401);
    // Durable translation is disabled by default: cannot start AI work accidentally.
    assert.equal((await send('/api/automation/worker/translate-tick')).status,401);
    assert.equal((await send('/api/automation/worker/smart-translate-tick')).status,401);
    const translated=await send('/api/automation/worker/translate-tick',{},
      {'x-automation-secret':secret});
    assert.equal(translated.json.disabled,true);
    const smart=await send('/api/automation/worker/smart-translate-tick',{},
      {'x-automation-secret':secret});
    assert.equal(smart.json.disabled,true);
    const create=await send('/api/automation/jobs',{sourceUrl:'https://novelfire.net/test',
      chapters:[3,1,2]});
    assert.equal(create.status,201);
    assert.equal(create.json.total,3);
    const id=create.json.id;
    const tick=()=>send('/api/automation/worker/tick',{}, {'x-automation-secret':secret});
    const [first,second]=await Promise.all([tick(),tick()]);
    assert.equal([first.json,second.json].filter(x=>x.idle).length,1);
    assert.equal([first.json,second.json].filter(x=>x.retry).length,1);
    let job=await AutomationJob.findById(id);
    assert.equal(job.successCount,0);
    assert.equal(job.attempts,1);
    assert.equal(job.cursor,0);
    await AutomationJob.updateOne({_id:id},{$set:{nextRunAt:new Date(0)}});
    const next=await tick();
    assert.equal(next.json.chapterNumber,1);
    job=await AutomationJob.findById(id);
    assert.equal(job.cursor,1);
    assert.equal(job.successCount,1);
    const paused=await send('/api/automation/jobs/'+id+'/pause');
    assert.equal(paused.status,200);
    assert.equal((await tick()).json.idle,true);
    const resumed=await send('/api/automation/jobs/'+id+'/resume');
    assert.equal(resumed.status,200);
    assert.equal((await tick()).json.chapterNumber,2);
    // Recover a job left with an expired lease after a crash.
    await AutomationJob.updateOne({_id:id},{$set:{status:'running',
      leaseToken:'stale-worker',leaseUntil:new Date(0),nextRunAt:new Date(0)}});
    assert.equal((await tick()).json.chapterNumber,3);
    job=await AutomationJob.findById(id);
    assert.equal(job.status,'completed');
    assert.equal(job.successCount,3);
    assert.equal(job.cursor,3);
    assert.equal((await tick()).json.idle,true);
    assert.equal(requests,4);
  } finally {
    if(backend) await close(backend);
    await close(scraper);
    try{await mongoose.connection.dropDatabase();}catch{}
    await mongoose.disconnect();
    for(const [key,value] of Object.entries(old))
      if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});
