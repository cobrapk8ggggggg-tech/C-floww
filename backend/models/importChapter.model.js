'use strict';
const {createHash} = require('node:crypto');
const mongoose = require('mongoose');
// The deterministic _id is the idempotency key; raw text survives partial imports.
const schema = new mongoose.Schema({
  _id: String, sourceUrl: {type:String,required:true}, number: {type:Number,required:true},
  novelId: {type:mongoose.Schema.Types.ObjectId,required:true},
  title: {type:String,required:true}, content: {type:String,required:true},
  contentHash: {type:String,required:true}, persisted: {type:Boolean,default:false}
},{timestamps:true,versionKey:false});
schema.statics.idForSource = (source, number) =>
  createHash('sha256').update(source + '\n' + number).digest('hex');
module.exports = mongoose.models.ImportChapter || mongoose.model('ImportChapter',schema);
