// Cloudflare Cron coordinator for ZEUS. Disabled by default.
const BACKEND='https://c-flow-backend.vercel.app';
const SCRAPER='https://zeus-novel-scraper.vercel.app';

async function tick(env) {
  if (env.AUTOMATION_ENABLED !== 'true') return {disabled:true};
  if (!env.AUTOMATION_SECRET || !env.BACKEND_URL) throw new Error('Missing coordinator configuration');
  const url = new URL('/api/automation/worker/tick',env.BACKEND_URL);
  if (url.protocol !== 'https:') throw new Error('HTTPS backend required');
  const response = await fetch(url,{
    method:'POST',
    headers:{'x-automation-secret':env.AUTOMATION_SECRET},
    signal:AbortSignal.timeout(115000)
  });
  if (!response.ok) throw new Error('Backend tick failed: '+response.status);
  return response.json();
}

export default {
  async fetch(request,env) {
    if (request.method !== 'GET') return new Response('Method Not Allowed',{status:405});
    const pathname = new URL(request.url).pathname;
    if (pathname === '/health') return Response.json({
      service:'zeus-automation-coordinator',status:'ok',enabled:env.AUTOMATION_ENABLED==='true'
    });
    if (pathname === '/check') {
      try {
        const [backend,scraper] = await Promise.all([
          fetch(BACKEND+'/api/novels',{signal:AbortSignal.timeout(12000)}),
          fetch(SCRAPER+'/health',{signal:AbortSignal.timeout(12000)})
        ]);
        return Response.json({service:'zeus-automation-coordinator',backend:backend.status,scraper:scraper.status},
          {status:backend.ok&&scraper.ok?200:502});
      } catch {
        return Response.json({healthy:false},{status:502});
      }
    }
    return new Response('Not Found',{status:404});
  },
  async scheduled(_event,env,ctx) {
    ctx.waitUntil(tick(env).then(result=>console.log(JSON.stringify({event:'tick',result})))
      .catch(error=>console.error(JSON.stringify({event:'tick_error',message:error.message}))));
  }
};
