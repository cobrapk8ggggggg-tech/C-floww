'use strict';
const m=require('mongoose');
const schema=new m.Schema({_id:String,used:{type:Number,default:0}},{versionKey:false});
module.exports=m.models.AutomationQueueBudget||m.model('AutomationQueueBudget',schema);
