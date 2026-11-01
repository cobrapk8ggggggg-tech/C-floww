'use strict';
const m=require('mongoose');
// Immutable checkpoint, one bounded unit per document. Never expires automatically.
const schema=new m.Schema({_id:String,jobId:m.Schema.Types.ObjectId,taskId:m.Schema.Types.ObjectId,
 kind:String,text:{type:String,required:true},hash:{type:String,required:true}}, {timestamps:true,versionKey:false});
schema.index({jobId:1,taskId:1});
module.exports=m.models.DurableArtifact||m.model('DurableArtifact',schema);
