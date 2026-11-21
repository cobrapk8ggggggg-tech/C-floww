'use strict';
const {randomUUID}=require('node:crypto');
const mongoose=require('mongoose');
const Novel=require('../../models/novel.model');
const Job=require('../../models/automationJob.model');
const User=require('../../models/user.model');
const key='watchlist';
const schema=new mongoose.Schema({
 _id:String,enabled:{type:Boolean,default:false},intervalMinutes:{type:Number,default:60},
 nextRunAt:Date,actorId:String,manualActorId:String,
 sweep:{id:String,cursor:mongoose.Schema.Types.ObjectId,actorId:String,manual:Boolean},
 leaseToken:String,leaseUntil:{type:Date,default:()=>new Date(0)}
},{versionKey:false});
const Schedule=mongoose.models.AutomationWatchSchedule||mongoose.model('AutomationWatchSchedule',schema);
const settings=()=>Schedule.findById(key);
const view=row=>({enabled:row?.enabled===true,intervalMinutes:row?.intervalMinutes||60,nextRunAt:row?.nextRunAt,
 inProgress:Boolean(row?.sweep?.id||row?.manualActorId)});

async function configure({enabled,intervalMinutes},actorId,now=new Date()){
 if(typeof enabled!=='boolean'||!Number.isSafeInteger(intervalMinutes)||intervalMinutes<10||intervalMinutes>1440){
  throw Object.assign(Error('invalid_watch_interval'),{status:400});
 }
 const before=await settings();
 const changed=!before?.enabled||before.intervalMinutes!==intervalMinutes;
 const nextRunAt=enabled&&changed?new Date(+now+intervalMinutes*60000):before?.nextRunAt;
 return Schedule.findOneAndUpdate({_id:key},{$set:{enabled,intervalMinutes,actorId,...(nextRunAt?{nextRunAt}:{})}},
  {upsert:true,new:true,setDefaultsOnInsert:true});
}
async function requestSweep(actorId){
 return Schedule.findOneAndUpdate({_id:key},{$set:{manualActorId:actorId}},{upsert:true,new:true,setDefaultsOnInsert:true});
}

async function tick(enqueue,now=new Date()){
 const active=await Job.countDocuments({engineVersion:2,'config.watchSweep':true,status:{$in:['queued','running','retry_wait']}});
 if(active>=12)return;
 const leaseToken=randomUUID();
 const lease=await Schedule.findOneAndUpdate({_id:key,leaseUntil:{$lte:now},$or:[
  {'sweep.manual':true},{manualActorId:{$type:'string'}},{enabled:true,nextRunAt:{$lte:now}}
 ]},{$set:{leaseToken,leaseUntil:new Date(+now+40000)}},{new:true});
 if(!lease)return;
 const owned={_id:key,leaseToken};
 try{
  let sweep=lease.sweep;
  if(!sweep?.id){
   const manual=Boolean(lease.manualActorId);
   sweep={id:randomUUID(),actorId:lease.manualActorId||lease.actorId,manual};
   await Schedule.updateOne(owned,{$set:{sweep},...(manual?{$unset:{manualActorId:1}}:{})});
  }
  const actor=mongoose.isValidObjectId(sweep.actorId)&&await User.findOne({_id:sweep.actorId,role:'admin'}).select('_id email');
  const batch=actor?await Novel.find({isWatched:true,sourceUrl:{$type:'string',$ne:''},...(sweep.cursor?{_id:{$gt:sweep.cursor}}:{})})
   .select('_id sourceUrl').sort({_id:1}).limit(Math.min(4,12-active)).lean():[];
  for(const novel of batch){
   try{await enqueue(novel,{id:actor.id,email:actor.email,admin:true},'watch:'+sweep.id+':'+novel._id);}
   catch(error){if(![400,404,409].includes(error.status)&&error.message!=='Invalid sourceUrl')throw error;}
   await Schedule.updateOne(owned,{$set:{'sweep.cursor':novel._id}});
  }
  if(batch.length<Math.min(4,12-active)){
   await Schedule.updateOne(owned,{$unset:{sweep:1},$set:{nextRunAt:new Date(+now+lease.intervalMinutes*60000)}});
  }
 }finally{await Schedule.updateOne(owned,{$set:{leaseUntil:new Date(0)},$unset:{leaseToken:1}});}
}
module.exports={settings,view,configure,requestSweep,tick};
