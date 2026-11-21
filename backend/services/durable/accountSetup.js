'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
module.exports=async function setup(providerId){
 if(process.env.AUTOMATION_QWEN_ACCOUNT_SETUP!=='true')throw Object.assign(Error('account_setup_disabled'),{blocked:true,code:'account_setup_disabled'});
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.resolve(__dirname,'../../../scripts/provision-qwen.js'),providerId],{env:process.env,stdio:'ignore'});
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Object.assign(Error('account_setup_timeout'),{code:'account_setup_timeout',blocked:true}));},180000);
  child.once('error',()=>{clearTimeout(timer);reject(Object.assign(Error('account_setup_failed'),{code:'account_setup_failed',blocked:true}));});
  child.once('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Object.assign(Error('account_setup_failed'),{code:'account_setup_failed',blocked:true}));});
 });
};
