'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const deadline=require('../backend/services/durable/deadline');
test('provider deadline aborts underlying work rather than waiting beyond the function budget',async()=>{
 let aborted=false;
 await assert.rejects(()=>deadline(5,signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('transport aborted'));}))),/abort|deadline/);
 assert.equal(aborted,true);
 assert.equal(await deadline(100,async()=> 'saved'),'saved');
});
