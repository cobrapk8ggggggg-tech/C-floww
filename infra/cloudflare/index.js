// ZEUS Cloudflare queue coordinator. Intentionally disabled until staging E2E is validated.
const DEFAULT_BACKEND='https://zeus-cfloww-staging.vercel.app';
const DEFAULT_SCRAPER='https://zeus-scraper-staging.vercel.app';
const STEPS={
  v2:'/api/automation/worker/step',
  scrape:'/api/automation/worker/tick',
  pure:'/api/automation/worker/translate-tick',
  smart:'/api/automation/worker/smart-translate-tick'
};
const isEnabled=env=>env.AUTOMATION_ENABLED==='true';

async function runStep(env,kind) {
  if(kind!=='ready'&&!STEPS[kind])throw new Error('Unsupported queue message');
  if(!env.AUTOMATION_SECRET || !env.BACKEND_URL)throw new Error('Coordinator not configured');
  const base=new URL(env.BACKEND_URL);
  if(base.protocol!=='https:')throw new Error('HTTPS is required');
  const url=new URL(kind==='ready'?'/api/automation/worker/ready':STEPS[kind],base);
  const response=await fetch(url,{
    method:'POST',
    headers:{'x-automation-secret':env.AUTOMATION_SECRET},
    signal:AbortSignal.timeout(270000)
  });
  if(!response.ok)throw new Error('Backend step '+kind+' failed: HTTP '+response.status);
  return response.json();
}

async function permit(env,cost){
 const url=new URL('/api/automation/worker/queue-permit',env.BACKEND_URL);
 const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-automation-secret':env.AUTOMATION_SECRET},
  body:JSON.stringify({cost}),signal:AbortSignal.timeout(12000)});
 if(!r.ok)return false;
 return (await r.json()).allowed===true;
}
async function send(env,kind,options){
 if(!await permit(env,3))return false;
 await env.AUTOMATION_QUEUE.send({kind},options);return true;
}

async function authorized(request,env){
 const supplied=request.headers.get('x-automation-secret')||'';
 if(!env.AUTOMATION_SECRET||!supplied||supplied.length>512)return false;
 const algorithm={name:'HMAC',hash:'SHA-256'},enc=new TextEncoder(),data=enc.encode('ZEUS coordinator wake');
 const expected=await crypto.subtle.importKey('raw',enc.encode(env.AUTOMATION_SECRET),algorithm,false,['sign']);
 const actual=await crypto.subtle.importKey('raw',enc.encode(supplied),algorithm,false,['verify']);
 const signature=await crypto.subtle.sign('HMAC',expected,data);
 return crypto.subtle.verify('HMAC',actual,signature,data);
}
async function wake(env){
 const ready=await runStep(env,'ready');
 const kinds=[...new Set(ready.kinds||[])].filter(k=>STEPS[k]).slice(0,2);
 for(const kind of kinds)await send(env,kind);
}

export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path==='/wake'&&request.method==='POST'){
      if(!await authorized(request,env))return new Response('Unauthorized',{status:401});
      if(!isEnabled(env))return Response.json({ok:true,disabled:true});
      try{await wake(env);return Response.json({ok:true});}catch{return Response.json({ok:false},{status:503});}
    }
    if(request.method!=='GET')return new Response('Method Not Allowed',{status:405});
    if(path==='/health')return Response.json({
      service:'zeus-automation-coordinator',status:'ok',enabled:isEnabled(env),
      queueConfigured:Boolean(env.AUTOMATION_QUEUE)
    });
    if(path==='/check'){
      try{
        const [backend,scraper]=await Promise.all([
          fetch((env.BACKEND_URL || DEFAULT_BACKEND)+'/api/automation/health',{signal:AbortSignal.timeout(12000)}),
          fetch((env.SCRAPER_URL || DEFAULT_SCRAPER)+'/health',{signal:AbortSignal.timeout(12000)})
        ]);
        const state=await backend.json().catch(()=>({}));
        const ready=backend.ok&&scraper.ok&&state.databaseConfigured===true && state.databaseConnected===true &&
          state.databaseIsolated===true && state.firestoreConfigured===true && state.automationConfigured===true;
        return Response.json({
          service:'zeus-automation-coordinator',backend:backend.status,scraper:scraper.status,
          databaseConfigured:state.databaseConfigured===true,ready
        },{status:ready?200:503});
      }catch{
        return Response.json({ready:false},{status:503});
      }
    }
    return new Response('Not Found',{status:404});
  },
  async scheduled(_event,env,ctx){
    if(!isEnabled(env)){
      console.log('ZEUS coordinator paused (AUTOMATION_ENABLED is false)');
      return;
    }
    if(!env.AUTOMATION_QUEUE)throw new Error('AUTOMATION_QUEUE is not bound');
    ctx.waitUntil(wake(env));
  },
  async queue(batch,env){
    for(const message of batch.messages){
      if(!isEnabled(env)){
        message.ack();
        continue;
      }
      const kind=message.body?.kind;
      if(!STEPS[kind]){message.ack();continue;}
      try{
        const result=await runStep(env,kind);
        // Continue promptly when work was completed. Idle or backoff states
        // pause this chain; the periodic cron acts as a recovery watchdog.
        if(result && !result.idle && !result.disabled && !result.retry &&
           !result.paused && result.progressed!==false && !result.stale && result.ok!==false) {
          await send(env,kind,{delaySeconds:5});
        }
        message.ack();
      }catch(e){
        console.error('ZEUS queue step failed:',kind,e.message);
        try{if(await permit(env,1))message.retry({delaySeconds:60});else message.ack();}
        catch{message.ack();} // MongoDB watchdog recovers after backend/quota outage.
      }
    }
  }
};
