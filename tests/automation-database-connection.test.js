'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const create=require('../backend/services/databaseConnection.service');
test('requests share a connection attempt, recover from failure and reconnect after disconnect',async()=>{
  let attempts=0,resolve;
  const db={connection:{readyState:0},connect:(_uri,options)=>{
    attempts++;assert.equal(options.dbName,'zeus_automation_test');
    return new Promise(r=>{resolve=()=>{db.connection.readyState=1;r(db)};});
  }};
  const connect=create(db,{uri:'local-test',dbName:'zeus_automation_test'});
  const a=connect(),b=connect();assert.equal(attempts,1);resolve();
  assert.deepEqual(await Promise.all([a,b]),[db,db]);
  await connect();assert.equal(attempts,1);
  db.connection.readyState=0;
  db.connect=async()=>{attempts++;throw Error('temporarily unavailable')};
  await assert.rejects(connect());
  db.connect=async()=>{attempts++;db.connection.readyState=1;return db;};
  assert.equal(await connect(),db);assert.equal(attempts,3);
  assert.equal(await create(db,{})(),null);
});
