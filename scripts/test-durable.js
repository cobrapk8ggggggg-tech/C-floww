'use strict';
const {MongoMemoryReplSet}=require('../backend/node_modules/mongodb-memory-server');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
(async()=>{
 const db=await MongoMemoryReplSet.create({replSet:{count:1}});let firestore;
 try{
  if(!process.env.FIRESTORE_EMULATOR_HOST&&process.env.ZEUS_TEST_FIRESTORE!=='false')firestore=await require('./firestore-test-emulator').start();
  const files=process.argv.slice(2);
  const chosen=files.length?files:fs.readdirSync('tests').filter(p=>p.endsWith('.test.js')).map(p=>'tests/'+p);
  const child=spawn(process.execPath,['--test',...chosen],{stdio:'inherit',env:{...process.env,
   ...(firestore?{FIRESTORE_EMULATOR_HOST:firestore.host}:{}),AUTOMATION_TEST_MONGO_URI:db.getUri(),AUTOMATION_TEST_REPLICA_URI:db.getUri()}});
  const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});process.exitCode=code||0;
 }finally{firestore?.stop();await db.stop();}
})().catch(()=>{console.error('Isolated storage tests failed to start');process.exitCode=1;});
