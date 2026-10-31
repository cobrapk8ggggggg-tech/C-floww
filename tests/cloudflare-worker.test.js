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
      calls.push({url:String(url),method:options.method,secret:options.headers['x-automation-secret']});
      return {ok:true,json:async()=>({ok:true,completed:false})};
    };
    await worker.queue({messages:[{body:{kind:'smart'},ack(){acked++},retry(){retried++}}]},env);
    assert.equal(acked,1);
    assert.equal(retried,0);
    assert.equal(calls[0].url,'https://staging.example/api/automation/worker/smart-translate-tick');
    assert.equal(calls[0].secret,'test-only-secret');
    assert.deepEqual(sent[0].body,{kind:'smart'});
    assert.equal(sent[0].options.delaySeconds,5);
    await worker.scheduled({},env,{waitUntil:promise=>promise});
    assert.deepEqual(sent.slice(1).map(x=>x.body.kind).sort(),['pure','scrape','smart']);
    global.fetch=async()=>{throw Error('upstream failure')};
    await worker.queue({messages:[{body:{kind:'scrape'},ack(){acked++},retry(x){retried++;assert.equal(x.delaySeconds,60)}}]},env);
    assert.equal(retried,1);
  }finally{global.fetch=originalFetch}
});
