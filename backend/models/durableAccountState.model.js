'use strict';
const m=require('mongoose');
// Credential hashes only. Cooldowns/dead credentials survive process restarts.
const schema=new m.Schema({_id:String,dead:{type:Boolean,default:false},until:{type:Date,default:()=>new Date(0)}},{timestamps:true,versionKey:false});
module.exports=m.models.DurableAccountState||m.model('DurableAccountState',schema);
