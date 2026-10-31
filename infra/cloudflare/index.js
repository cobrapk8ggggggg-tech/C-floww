// ZEUS Cloudflare queue coordinator. Intentionally disabled until staging E2E is validated.
const DEFAULT_BACKEND='https://zeus-cfloww-staging.vercel.app';
const DEFAULT_SCRAPER='https://zeus-scraper-staging.vercel.app';
const STEPS={
  scrape:'/api/automation/worker/tick',
  pure:'/api/automation/worker/translate-tick',
  smart:'/api/automation/worker/smart-translate-tick'
};
const isEnabled=env=>env.AUTOMATION_ENABLED==='true';

async function runStep(env,kind) {
  if(!STEPS[kind])throw new Error('Unsupported queue message');
  if(!env.AUTOMATION_SECRET || !env.BACKEND_URL)throw new Error('Coordinator not configured');
  const base=new URL(env.BACKEND_URL);
  if(base.protocol!=='https:')throw new Error('HTTPS is required');
  const url=new URL(STEPS[kind],base);
  const response=await fetch(url,{
    method:'POST',
    headers:{'x-automation-secret':env.AUTOMATION_SECRET},
    signal:AbortSignal.timeout(270000)
  });
  if(!response.ok)throw new Error('Backend step '+kind+' failed: HTTP '+response.status);
  return response.json();
}

export default {
  async fetch(request,env) {
    if(request.method!=='GET')return new Response('Method Not Allowed',{status:405});
    const path=new URL(request.url).pathname;
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
    ctx.waitUntil(Promise.all(Object.keys(STEPS).map(kind=>
      env.AUTOMATION_QUEUE.send({kind}))));
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
          await env.AUTOMATION_QUEUE.send({kind},{delaySeconds:5});
        }
        message.ack();
      }catch(e){
        console.error('ZEUS queue step failed:',kind,e.message);
        message.retry({delaySeconds:60});
      }
    }
  }
};
