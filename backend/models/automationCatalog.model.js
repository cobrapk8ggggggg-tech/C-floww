'use strict';
const m=require('mongoose');
const {createHash}=require('node:crypto');
const schema=new m.Schema({_id:String,sourceUrl:String,jobId:String,metadata:m.Schema.Types.Mixed,total:Number,ready:{type:Boolean,default:false}},{timestamps:true,versionKey:false});
const chapter=new m.Schema({catalogId:{type:String,required:true},number:{type:Number,required:true},title:String,url:String},{versionKey:false});
chapter.index({catalogId:1,number:1},{unique:true});
const catalogId=(source,job)=>createHash('sha256')
 .update(source+'\n'+(job==='legacy'?'legacy:'+Math.floor(Date.now()/300000):job)).digest('hex');
module.exports={Catalog:m.models.AutomationCatalog||m.model('AutomationCatalog',schema),CatalogChapter:m.models.AutomationCatalogChapter||m.model('AutomationCatalogChapter',chapter),catalogId};
