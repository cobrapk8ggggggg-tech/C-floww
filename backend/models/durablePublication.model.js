'use strict';
const m=require('mongoose');
const schema=new m.Schema({_id:String,version:{type:Number,default:0},artifactId:String,jobId:m.Schema.Types.ObjectId,hash:String},{timestamps:true,versionKey:false});
module.exports=m.models.DurablePublication||m.model('DurablePublication',schema);
