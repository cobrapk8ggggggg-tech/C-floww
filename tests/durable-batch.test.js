'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {run}=require('../scripts/run-durable-batch');
test('batch drain does not claim another step after SIGTERM and exits when idle or retrying',async()=>{
 let stop=false,calls=0;
 assert.equal(await run({tick:async()=>{calls++;stop=true;return {ok:true};},stop:()=>stop,report:()=>{}}),1);
 assert.equal(calls,1);
 assert.equal(await run({tick:async()=>({idle:true}),stop:()=>false,report:()=>{}}),0);
 assert.equal(await run({tick:async()=>({retry:true}),stop:()=>false,report:()=>{}}),1);
});
test('one blocked job does not stop independent work and scheduled idle waits do not busy-poll',async()=>{
 const replies=[{ok:false,retry:false},{ok:true,progressed:true},{idle:true,retryAfterMs:5},{idle:true}];const waits=[];
 const steps=await run({tick:async()=>replies.shift(),stop:()=>false,wait:async ms=>waits.push(ms),report:()=>{}});
 assert.equal(steps,2);assert.deepEqual(waits,[5]);assert.equal(replies.length,0);
});
