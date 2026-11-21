'use strict';
const mongoose = require('mongoose');

// Persistent, bounded chapter scraping jobs. All state resides in MongoDB.
const schema = new mongoose.Schema({
  engineVersion:{type:Number,default:1},
  workerClass:{type:String,enum:['function','long'],default:'function'},
  label:{type:String,maxlength:300},
  ownerId:String,requestKey:String,requestHash:String,novelKey:String,sourceKey:String,
  sourceSelection:{type:String,enum:['verified_original','current_content'],default:'verified_original'},
  novelId:{type:mongoose.Schema.Types.ObjectId,ref:'Novel'},
  config:mongoose.Schema.Types.Mixed,
  fence:{type:Number,default:0},
  retryCount:{type:Number,default:0},
  blockedCode:String,
  kind: {type:String,enum:['scrape','smart_translate','pure_translate','glossary_extract'],default:'scrape'},
  sourceUrl: {type:String,required:function(){return this.kind==='scrape';},maxlength:2048},
  adminEmail: {type:String,default:'system@auto',maxlength:254},
  chapters: {type:[Number],required:true},
  cursor: {type:Number,default:0,min:0},
  successCount: {type:Number,default:0,min:0},
  status: {type:String,enum:['queued','running','paused','completed','failed','cancelled','retry_wait','blocked'],default:'queued'},
  attempts: {type:Number,default:0,min:0},
  nextRunAt: {type:Date,default:Date.now},
  leaseUntil: {type:Date,default:()=>new Date(0)},
  leaseToken: {type:String,default:''},
  lastError: {type:String,default:''},
  lastChapter: {type:Number,default:null},
  finishedAt: Date
},{timestamps:true,versionKey:false});
schema.index({status:1,nextRunAt:1,leaseUntil:1});
schema.index({requestKey:1},{unique:true,partialFilterExpression:{requestKey:{$type:'string'}}});
schema.index({novelKey:1},{unique:true,partialFilterExpression:{novelKey:{$type:'string'}}});
schema.index({sourceKey:1},{unique:true,partialFilterExpression:{sourceKey:{$type:'string'}}});
module.exports = mongoose.models.AutomationJob || mongoose.model('AutomationJob',schema);
