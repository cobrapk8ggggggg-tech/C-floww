'use strict';
module.exports=async function withDeadline(ms,send){
 const controller=new AbortController();let timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('provider_deadline'),{name:'AbortError'}));},ms);});
 try{return await Promise.race([send(controller.signal),timeout]);}finally{clearTimeout(timer);}
};
