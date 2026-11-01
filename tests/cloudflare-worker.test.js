'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

async function loadWorker(){
  const js=fs.readFileSync(path.join(__dirname,'../infra/cloudflare/index.js'),'utf8');
  const uri='data:text/javascript;base64,'+Buffer.from(js).toString('base64');
  return (await import(uri)).default;
}
test('Cloudflare Queue is fail-closed while automation is disabled',async()=>{
  const worker=await loadWorker();
  let dispatches=0,acked=0;
  const env={AUTOMATION_ENABLED:'false',AUTOMATION_QUEUE:{send:async()=>dispatches++}};
  const health=await worker.fetch(new Request('https://example.net/health'),env);
  assert.equal(health.status,200);
  assert.equal((await health.json()).enabled,false);
  await worker.scheduled({},env,{waitUntil:()=>{throw Error('must not schedule')}});
  await worker.queue({messages:[{body:{kind:'scrape'},ack(){acked++},retry(){throw Error('not expected')}}]},env);
  assert.equal(dispatches,0);
  assert.equal(acked,1);
});
test('Cloudflare Queue chains a successful authorized step and retries transient errors',async()=>{
  const worker=await loadWorker();
  const originalFetch=global.fetch;
  const sent=[],calls=[];
  const env={AUTOMATION_ENABLED:'true',AUTOMATION_SECRET:'test-only-secret',
    BACKEND_URL:'https://staging.example',
    AUTOMATION_QUEUE:{send:async(body,options)=>sent.push({body,options})}};
  let acked=0,retried=0;
  try{
    global.fetch=async(url,options)=>{
      if(String(url).endsWith('/queue-permit'))return {ok:true,json:async()=>({allowed:true})};
      calls.push({url:String(url),method:options.method,secret:options.headers['x-automation-secret']});
      return {ok:true,json:async()=>String(url).endsWith('/ready')?{ok:true,kinds:['pure','smart']}:{ok:true,completed:false}};
    };
    await worker.queue({messages:[{body:{kind:'smart'},ack(){acked++},retry(){retried++}}]},env);
    assert.equal(acked,1);
    assert.equal(retried,0);
    assert.equal(calls[0].url,'https://staging.example/api/automation/worker/smart-translate-tick');
    assert.equal(calls[0].secret,'test-only-secret');
    assert.deepEqual(sent[0].body,{kind:'smart'});
    assert.equal(sent[0].options.delaySeconds,5);
    let pending;
    await worker.scheduled({},env,{waitUntil:promise=>{pending=promise;}});
    await pending;
    assert.deepEqual(sent.slice(1).map(x=>x.body.kind).sort(),['pure','smart']);
    global.fetch=async url=>{if(String(url).endsWith('/queue-permit'))return {ok:true,json:async()=>({allowed:true})};throw Error('upstream failure')};
    await worker.queue({messages:[{body:{kind:'scrape'},ack(){acked++},retry(x){retried++;assert.equal(x.delaySeconds,60)}}]},env);
    assert.equal(retried,1);
  }finally{global.fetch=originalFetch}
});

test('successor send failure retries before acknowledgement; no-progress results stop chaining',async()=>{
  const worker=await loadWorker(), original=global.fetch;
  let acked=0,retried=0;
  const env={AUTOMATION_ENABLED:'true',AUTOMATION_SECRET:'test-only',BACKEND_URL:'https://staging.example',
    AUTOMATION_QUEUE:{send:async()=>{throw Error('queue unavailable')}}};
  const batch={messages:[{body:{kind:'scrape'},ack(){acked++},retry(){retried++}}]};
  try {
    global.fetch=async url=>({ok:true,json:async()=>String(url).endsWith('/queue-permit')?{allowed:true}:{ok:true}});
    await worker.queue(batch,env);
    assert.equal(acked,0);assert.equal(retried,1);
    global.fetch=async()=>({ok:true,json:async()=>({ok:true,progressed:false})});
    await worker.queue(batch,env);
    assert.equal(acked,1);assert.equal(retried,1);
  } finally {global.fetch=original;}
});

test('readiness checks configured backend and rejects configured but disconnected MongoDB',async()=>{
  const worker=await loadWorker(), original=global.fetch, urls=[];
  try {
    global.fetch=async url=>{urls.push(String(url));return {ok:true,status:200,
      json:async()=>({databaseConfigured:true,databaseConnected:false,databaseIsolated:true})};};
    const r=await worker.fetch(new Request('https://worker.example/check'),{BACKEND_URL:'https://custom.example'});
    assert.equal(r.status,503);
    assert.equal(urls[0],'https://custom.example/api/automation/health');
  } finally {global.fetch=original;}
});
test('cron emits no idle messages, and wake endpoint requires the existing secret',async()=>{
 const worker=await loadWorker(),original=global.fetch;let sent=0;
 const env={AUTOMATION_ENABLED:'true',AUTOMATION_SECRET:'test-wake',BACKEND_URL:'https://staging.example',AUTOMATION_QUEUE:{send:async()=>sent++}};
 try{
  global.fetch=async()=>({ok:true,json:async()=>({kinds:[]})});
  let pending;await worker.scheduled({},env,{waitUntil:p=>{pending=p;}});await pending;assert.equal(sent,0);
  const denied=await worker.fetch(new Request('https://worker.example/wake',{method:'POST'}),env);assert.equal(denied.status,401);
  const allowed=await worker.fetch(new Request('https://worker.example/wake',{method:'POST',headers:{'x-automation-secret':'test-wake'}}),env);
  assert.equal(allowed.status,200);assert.equal(sent,0);
 }finally{global.fetch=original;}
});
