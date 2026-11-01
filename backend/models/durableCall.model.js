'use strict';
const m=require('mongoose');
const schema=new m.Schema({_id:String,jobId:m.Schema.Types.ObjectId,taskId:m.Schema.Types.ObjectId,
 operation:String,intent:String,account:String,state:{type:String,enum:['started','received','rejected'],required:true},
 reply:String,context:m.Schema.Types.Mixed,code:String,providerId:String,requestId:String,
 attempt:{type:Number,default:0},costMicros:{type:Number,default:0}}, {timestamps:true,versionKey:false});
schema.index({jobId:1,taskId:1});
schema.index({taskId:1,intent:1,state:1});
module.exports=m.models.DurableCall||m.model('DurableCall',schema);
