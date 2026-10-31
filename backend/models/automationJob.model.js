'use strict';
const mongoose = require('mongoose');

// Persistent, bounded chapter scraping jobs. All state resides in MongoDB.
const schema = new mongoose.Schema({
  kind: {type:String,enum:['scrape'],default:'scrape'},
  sourceUrl: {type:String,required:true,maxlength:2048},
  adminEmail: {type:String,default:'system@auto',maxlength:254},
  chapters: {type:[Number],required:true},
  cursor: {type:Number,default:0,min:0},
  successCount: {type:Number,default:0,min:0},
  status: {type:String,enum:['queued','running','paused','completed','failed','cancelled'],default:'queued'},
  attempts: {type:Number,default:0,min:0},
  nextRunAt: {type:Date,default:Date.now},
  leaseUntil: {type:Date,default:()=>new Date(0)},
  leaseToken: {type:String,default:''},
  lastError: {type:String,default:''},
  lastChapter: {type:Number,default:null},
  finishedAt: Date
},{timestamps:true,versionKey:false});
schema.index({status:1,nextRunAt:1,leaseUntil:1});
module.exports = mongoose.models.AutomationJob || mongoose.model('AutomationJob',schema);
