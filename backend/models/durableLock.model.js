'use strict';
const m=require('mongoose');
const schema=new m.Schema({_id:String,token:String,jobId:m.Schema.Types.ObjectId,
 until:{type:Date,required:true},fence:{type:Number,default:0}}, {versionKey:false});
module.exports=m.models.DurableLock||m.model('DurableLock',schema);
