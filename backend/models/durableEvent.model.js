'use strict';
const m=require('mongoose');
const schema=new m.Schema({jobId:{type:m.Schema.Types.ObjectId,required:true},chapter:Number,
 stage:String,code:String,type:{type:String,default:'info'},durationMs:Number},{timestamps:true,versionKey:false});
schema.index({jobId:1,_id:1});
module.exports=m.models.DurableEvent||m.model('DurableEvent',schema);
