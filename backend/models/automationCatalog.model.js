'use strict';
const m=require('mongoose');
const schema=new m.Schema({_id:String,sourceUrl:String,jobId:String,metadata:m.Schema.Types.Mixed,total:Number,ready:{type:Boolean,default:false}},{timestamps:true,versionKey:false});
const chapter=new m.Schema({catalogId:{type:String,required:true},number:{type:Number,required:true},title:String,url:String},{versionKey:false});
chapter.index({catalogId:1,number:1},{unique:true});
module.exports={Catalog:m.models.AutomationCatalog||m.model('AutomationCatalog',schema),CatalogChapter:m.models.AutomationCatalogChapter||m.model('AutomationCatalogChapter',chapter)};
