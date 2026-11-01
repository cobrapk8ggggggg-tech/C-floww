'use strict';
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const net=require('node:net');
const run=promisify(execFile);
async function start(){
 const jar=process.env.FIRESTORE_EMULATOR_JAR||path.join(os.tmpdir(),'zeus-firestore-1.22.0.jar');
 const expected='9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c';
 const valid=()=>fs.existsSync(jar)&&crypto.createHash('sha256').update(fs.readFileSync(jar)).digest('hex')===expected;
 if(!valid())await run('curl',['--fail','--location','--silent','--show-error','https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.22.0.jar','--output',jar],{timeout:180000});
 if(!valid())throw Error('Firestore emulator checksum mismatch');
 const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
 const output=fs.openSync(path.join(os.tmpdir(),'zeus-firestore-test.log'),'w');
 const child=spawn('java',['-jar',jar,'--host=127.0.0.1','--port='+port,'--project_id=demo-zeus-automation'],{stdio:['ignore',output,output]});
 let exited=false;child.once('exit',()=>{exited=true;});
 try{
  const deadline=Date.now()+30000;
  while(Date.now()<deadline&&!exited){
   try{const r=await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(500)});await r.body?.cancel();return {host:'127.0.0.1:'+port,stop:()=>{child.kill('SIGTERM');fs.closeSync(output);}};}catch{await new Promise(r=>setTimeout(r,200));}
  }
  throw Error('Firestore emulator did not start');
 }catch(e){child.kill('SIGTERM');fs.closeSync(output);throw e;}
}
module.exports={start};
