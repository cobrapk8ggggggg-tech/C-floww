'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
module.exports=async function scrape(job,task){
 const root=process.env.ZEUS_SCRAPER_ROOT;
 const backend=process.env.NODE_BACKEND_URL;
 if(!backend||new URL(backend).protocol!=='https:')throw Object.assign(Error('isolated_backend_not_configured'),{blocked:true,code:'isolated_backend_not_configured'});
 if(!root)throw Object.assign(Error('long_scraper_not_configured'),{blocked:true,code:'long_scraper_not_configured'});
 return new Promise((resolve,reject)=>{
  const child=spawn('python',[path.join(root,'worker','one_chapter.py')],{cwd:root,env:{...process.env,API_SECRET:process.env.SCRAPER_API_SECRET},stdio:['pipe','pipe','ignore']});
  let output='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Object.assign(Error('long_scraper_timeout'),{code:'long_scraper_timeout'}));},600000);
  child.stdout.on('data',chunk=>{output=(output+chunk.toString()).slice(-100000);});
  child.once('error',err=>{clearTimeout(timer);reject(err);});
  child.once('exit',code=>{clearTimeout(timer);try{
   const line=output.split('\n').find(l=>l.startsWith('ZEUS_RESULT:'));
   if(code!==0||!line)throw Error('scraper_failed');resolve(JSON.parse(line.slice(12)));
  }catch{reject(Object.assign(Error('long_scraper_failed'),{code:'long_scraper_failed'}));}});
  child.stdin.end(JSON.stringify({sourceUrl:job.sourceUrl,chapterNumber:task.number,jobId:job.id}));
 });
};
